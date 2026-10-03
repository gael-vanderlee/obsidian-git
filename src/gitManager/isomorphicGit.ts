import { createPatch } from "diff";
import type {
    AuthCallback,
    AuthFailureCallback,
    GitHttpRequest,
    GitHttpResponse,
    GitProgressEvent,
    HttpClient,
    StatusRow,
    TreeEntry,
    Walker,
    WalkerEntry,
} from "isomorphic-git";
import git, { Errors, readBlob } from "isomorphic-git";
import { GitIndexManager } from "isomorphic-git/managers";
import { FileSystem } from "isomorphic-git/models";
import { normalizePath, Notice, requestUrl } from "obsidian";
import type ObsidianGit from "../main";
import type {
    BranchInfo,
    FileStatusResult,
    LogEntry,
    PullResult,
    PushResult,
    Status,
    UnstagedFile,
    WalkDifference,
} from "../types";
import { GitConflictError, GitOperation, type DiffFile } from "../types";
import { GeneralModal } from "../ui/modals/generalModal";
import { splitRemoteBranch, worthWalking } from "../utils";
import { GitManager } from "./gitManager";
import { HiddenFileTracker, type HiddenFileStats } from "./hiddenFiles";
import { MyAdapter } from "./myAdapter";
import {
    advertiseReceivePack,
    sendReceivePack,
    type RemoteCredentials,
} from "./smartHttp";
import diff3Merge from "diff3";

export class IsomorphicGit extends GitManager {
    private static readonly MERGE_HEAD = "MERGE_HEAD";
    private static readonly MERGE_MESSAGE = "MERGE_MSG";
    private static readonly MERGE_MODE = "MERGE_MODE";
    private static readonly ORIGINAL_HEAD = "ORIG_HEAD";
    private readonly FILE = 0;
    private readonly HEAD = 1;
    private readonly WORKDIR = 2;
    private readonly STAGE = 3;
    // Mapping from statusMatrix to git status codes based off git status --short
    // See: https://isomorphic-git.org/docs/en/statusMatrix
    private readonly status_mapping: Readonly<Record<string, string>> = {
        "000": "  ",
        "003": "AD",
        "020": "??",
        "022": "A ",
        "023": "AM",
        "100": "D ",
        "101": " D",
        "103": "MD",
        "110": "DA", // Technically, two files: first one is deleted "D " and second one is untracked "??"
        "111": "  ",
        "113": "MM",
        "120": "DA", // Same as "110"
        "121": " M",
        "122": "M ",
        "123": "MM",
    };
    private readonly noticeLength = 999_999;
    private readonly fs = new MyAdapter(this.app.vault, this.plugin);
    /** Use the index and Obsidian's file cache for status instead of a full walk. */
    useFastStatus = true;
    readonly hiddenFiles = new HiddenFileTracker(
        this.app.vault.adapter,
        () => this.scanHiddenFiles(),
        (path) =>
            path === this.getGitDirPath() ||
            path.startsWith(`${this.getGitDirPath()}/`),
        (...data) => this.plugin.log(...data)
    );
    // Files whose content was hashed and matched the index despite changed
    // stats. Kept in memory instead of refreshing the index (see fastStatusRows).
    private readonly verifiedStats = new Map<
        string,
        {
            oid: string;
            mtimeMs: number;
            ctimeSeconds: number;
            size: number;
            verifiedSeconds: number;
        }
    >();
    // Blob oids of the HEAD tree by path, cached per HEAD commit.
    private headTree?: HeadSnapshot;
    // isIgnored results, valid while the .gitignore files are unchanged.
    private ignoredCache?: { signature: string; results: Map<string, boolean> };
    // Branch info and config reads, reused for a few seconds; mutators clear it.
    private infoCache?: {
        expires: number;
        branchInfo?: Promise<BranchInfo & { remote: string }>;
        config: Map<string, Promise<string | undefined>>;
        refs: Map<string, Promise<string>>;
    };
    // File changes between two commit oids; commits never change, so no expiry.
    private readonly changesCache = new Map<string, WalkDifference[]>();
    private headSnapshotLoad?: {
        commit: string;
        promise: Promise<HeadSnapshot>;
    };
    private readonly timers: number[] = [];
    // Set when the server did not understand a push without ref discovery.
    private optimisticPushDisabled = false;
    // Last remote tip seen; lets push reuse the probe made by the preceding pull.
    private remoteTip?: { url: string; ref: string; oid?: string; at: number };

    constructor(plugin: ObsidianGit) {
        super(plugin);
    }

    getRepo(): {
        fs: MyAdapter;
        dir: string;
        gitdir?: string;
        onAuth: AuthCallback;
        onAuthFailure: AuthFailureCallback;
        http: HttpClient;
    } {
        return {
            fs: this.fs,
            dir: this.plugin.settings.basePath || "/",
            gitdir: this.plugin.settings.gitDir
                ? this.getGitDirPath()
                : undefined,
            onAuth: () => {
                return {
                    username:
                        this.plugin.localStorage.getUsername() ?? undefined,
                    password:
                        this.plugin.localStorage.getPassword() ?? undefined,
                };
            },
            onAuthFailure: async () => {
                new Notice(
                    "Authentication failed. Please try with different credentials"
                );
                const username = await new GeneralModal(this.plugin, {
                    placeholder: "Specify your username",
                }).openAndGetResult();
                if (username) {
                    const password = await new GeneralModal(this.plugin, {
                        placeholder:
                            "Specify your password/personal access token",
                        obscure: true,
                    }).openAndGetResult();
                    if (password) {
                        this.plugin.localStorage.setUsername(username);
                        this.plugin.localStorage.setPassword(password);
                        return {
                            username,
                            password,
                        };
                    }
                }
                return { cancel: true };
            },
            http: {
                async request({
                    url,
                    method,
                    headers,
                    body,
                }: GitHttpRequest): Promise<GitHttpResponse> {
                    // We can't stream yet, so collect body and set it to the ArrayBuffer
                    // because that's what requestUrl expects
                    let collectedBody: ArrayBuffer | undefined;
                    if (body) {
                        collectedBody = await asyncIteratorToArrayBuffer(body);
                    }

                    const res = await requestUrl({
                        url,
                        method,
                        // Ask the server not to compress the response. The
                        // packfile parser needs the exact raw bytes; if a
                        // server or proxy gzips the response and the platform
                        // does not transparently inflate it, the packfile is
                        // persisted corrupted and only fails later with
                        // "Packfile payload corrupted".
                        headers: { "Accept-Encoding": "identity", ...headers },
                        body: collectedBody,
                        throw: false,
                    });

                    // Defense in depth: if the response still arrived gzipped
                    // (a server/proxy ignored the request and the platform did
                    // not inflate it), inflate it ourselves. This is keyed on
                    // the gzip magic bytes rather than the `Content-Encoding`
                    // header on purpose: some platforms auto-inflate but leave
                    // the header in place, and trusting it would double-inflate
                    // and corrupt the body.
                    const responseBuffer = await inflateIfGzipped(
                        res.arrayBuffer
                    );

                    return {
                        url,
                        method,
                        headers: res.headers,
                        body: arrayBufferToAsyncIterator(responseBuffer),
                        statusCode: res.status,
                        statusMessage: res.status.toString(),
                    };
                },
            },
        };
    }

    async wrapFS<T>(call: Promise<T>): Promise<T> {
        try {
            const res = await call;
            await this.fs.saveAndClear();
            return res;
        } catch (error) {
            await this.fs.saveAndClear();
            throw error;
        }
    }

    async status(opts?: { path?: string }): Promise<Status> {
        let notice: Notice | undefined;
        const timeout = window.setTimeout(() => {
            notice = new Notice(
                "This takes longer: Getting status",
                this.noticeLength
            );
        }, 20000);
        try {
            const fast = await this.fastStatusRows(opts?.path);
            let rows: StatusRow[];
            if (fast) {
                rows = fast.rows;
            } else {
                const statusOpts = { ...this.getRepo() } as Parameters<
                    typeof git.statusMatrix
                >[0];
                if (opts?.path != undefined) {
                    statusOpts.filepaths = [`${opts.path}/`];
                }
                rows = await this.wrapFS(git.statusMatrix(statusOpts));
            }
            const status = rows.map((row) => this.getFileStatusResult(row));

            let conflicted =
                fast?.conflicted ?? (await this.getConflictedFiles());
            if (opts?.path != undefined) {
                const path = opts.path.replace(/\/$/, "");
                conflicted = conflicted.filter(
                    (file) => file === path || file.startsWith(`${path}/`)
                );
            }

            const changed: FileStatusResult[] = [];
            const staged: FileStatusResult[] = [];
            const all: FileStatusResult[] = [];
            const conflictedPaths = new Set(conflicted);
            for (const file of status) {
                if (
                    file.workingDir !== " " &&
                    !conflictedPaths.has(file.path)
                ) {
                    changed.push(file);
                }
                if (
                    file.index !== " " &&
                    file.index !== "U" &&
                    !conflictedPaths.has(file.path)
                ) {
                    staged.push(file);
                }
                if (file.index != " " || file.workingDir != " ") {
                    all.push(file);
                }
            }
            window.clearTimeout(timeout);
            notice?.hide();
            return {
                all,
                changed,
                staged,
                conflicted,
                stagedOutsideVault: 0,
                conflictedOutsideVault: 0,
            };
        } catch (error) {
            window.clearTimeout(timeout);
            notice?.hide();
            throw error;
        }
    }

    async commitAll({
        message,
        status,
        unstagedFiles,
        amend,
    }: {
        message: string;
        status?: Status;
        unstagedFiles?: UnstagedFile[];
        amend?: boolean;
    }): Promise<number> {
        await this.checkAuthorInfo();
        await this.stageAll({ status, unstagedFiles });
        return this.commit({ message, amend });
    }

    async commit({
        message,
        amend,
    }: {
        message: string;
        amend?: boolean;
    }): Promise<number> {
        return this.withGitOperation(GitOperation.commit, async () => {
            try {
                await this.checkAuthorInfo();
                const formatMessage = await this.formatCommitMessage(message);
                const mergeHeads = await this.getMergeHeads();
                let parent: string[] | undefined = undefined;

                if (mergeHeads.length > 0) {
                    parent = [await this.resolveRef("HEAD"), ...mergeHeads];
                }

                // The new tree is the index, so HEAD vs index is what gets committed.
                let changes: WalkDifference[] | undefined;
                let built:
                    { tree: string; dirs: Map<string, string> } | undefined;
                let index: IndexSnapshot | undefined;
                if (!amend) {
                    const head = await this.getHeadSnapshot();
                    index = await this.readIndexSnapshot();
                    changes = await this.getIndexChanges(head, index);
                    if (
                        head.commit &&
                        !index.hasGitlinks &&
                        !index.hasConflicts
                    ) {
                        built = await this.writeIndexTree(head, index);
                    }
                }
                const oid = await this.wrapFS(
                    git.commit({
                        ...this.getRepo(),
                        message: formatMessage,
                        amend,
                        parent: parent,
                        tree: built?.tree,
                    })
                );
                if (changes && !parent) {
                    const { commit: created } = await git.readCommit({
                        ...this.getRepo(),
                        oid,
                    });
                    if (created.parent.length === 1) {
                        this.rememberChanges(created.parent[0]!, oid, changes);
                    }
                }
                if (built && index) {
                    this.headTree = {
                        commit: oid,
                        files: new Map(
                            [...index.files].map(([path, entry]) => [
                                path,
                                entry.oid,
                            ])
                        ),
                        modes: new Map(
                            [...index.files].map(([path, entry]) => [
                                path,
                                entry.mode,
                            ])
                        ),
                        dirs: built.dirs,
                    };
                }
                const committedFiles =
                    changes?.length ?? (await this.getCommittedFilesCount(oid));
                await this.clearMergeState();
                this.plugin.setPluginState({ mergeInProgress: false });
                return committedFiles;
            } catch (error) {
                if (error instanceof Errors.UnmergedPathsError) {
                    throw new GitConflictError(error.data.filepaths, error);
                }
                throw error;
            }
        });
    }

    async stage(filepath: string, relativeToVault: boolean): Promise<void> {
        const gitPath = this.getRelativeRepoPath(filepath, relativeToVault);
        let vaultPath: string;
        if (relativeToVault) {
            vaultPath = filepath;
        } else {
            vaultPath = this.getRelativeVaultPath(filepath);
        }
        if (await this.app.vault.adapter.exists(vaultPath)) {
            await this.wrapFS(
                git.add({ ...this.getRepo(), filepath: gitPath })
            );
        } else {
            await this.wrapFS(
                git.remove({ ...this.getRepo(), filepath: gitPath })
            );
        }
    }

    async stageAll({
        dir,
        status,
        unstagedFiles,
    }: {
        dir?: string;
        status?: Status;
        unstagedFiles?: UnstagedFile[];
    }): Promise<void> {
        if (status) {
            await this.stageFiles(
                status.changed.map((file) => ({
                    path: file.path,
                    deleted: file.workingDir === "D",
                }))
            );
        } else {
            const filesToStage =
                unstagedFiles ?? (await this.getUnstagedFiles(dir ?? "."));
            await this.stageFiles(
                filesToStage.map(({ path, type }) => ({
                    path,
                    deleted: type === "D",
                }))
            );
        }
    }

    private async stageFiles(
        files: { path: string; deleted: boolean }[]
    ): Promise<void> {
        const results = await this.wrapFS(
            Promise.allSettled(
                files.map((file) =>
                    file.deleted
                        ? git.remove({
                              ...this.getRepo(),
                              filepath: file.path,
                          })
                        : git.add({
                              ...this.getRepo(),
                              filepath: file.path,
                          })
                )
            )
        );

        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
    }

    async unstage(filepath: string, relativeToVault: boolean): Promise<void> {
        filepath = this.getRelativeRepoPath(filepath, relativeToVault);
        await this.wrapFS(
            git.resetIndex({ ...this.getRepo(), filepath: filepath })
        );
    }

    async unstageAll({
        dir,
        status,
    }: {
        dir?: string;
        status?: Status;
    }): Promise<void> {
        let staged: string[];
        if (status) {
            staged = status.staged.map((file) => file.path);
        } else {
            const res = await this.getStagedFiles(dir ?? ".");
            staged = res.map(({ path }) => path);
        }
        await this.wrapFS(
            Promise.all(
                staged.map((file) =>
                    git.resetIndex({ ...this.getRepo(), filepath: file })
                )
            )
        );
    }

    async discard(filepath: string): Promise<void> {
        await this.wrapFS(
            git.checkout({
                ...this.getRepo(),
                filepaths: [filepath],
                force: true,
            })
        );
    }

    async discardAll({
        dir,
        status,
    }: {
        dir?: string;
        status?: Status;
    }): Promise<void> {
        let files: string[];
        if (status) {
            if (dir != undefined) {
                files = status.changed
                    .filter(
                        (file) =>
                            file.workingDir != "U" && file.path.startsWith(dir)
                    )
                    .map((file) => file.path);
            } else {
                files = status.changed
                    .filter((file) => file.workingDir != "U")
                    .map((file) => file.path);
            }
        } else {
            files = (await this.getUnstagedFiles(dir))
                .filter((file) => file.type != "A")
                .map(({ path }) => path);
        }

        await this.wrapFS(
            git.checkout({
                ...this.getRepo(),
                filepaths: files,
                force: true,
            })
        );
    }

    async getUntrackedPaths(opts: {
        path?: string;
        status?: Status;
    }): Promise<string[]> {
        const untrackedPaths: string[] = [];
        if (opts.status) {
            for (const file of opts.status.changed) {
                if (
                    file.index == "U" &&
                    file.workingDir === "U" &&
                    file.path.startsWith(
                        opts.path != undefined ? `${opts.path}/` : ""
                    )
                ) {
                    untrackedPaths.push(file.path);
                }
            }
        } else {
            const status = await this.status({ path: opts?.path });
            for (const file of status.changed) {
                if (file.index === "U" && file.workingDir === "U") {
                    untrackedPaths.push(file.path);
                }
            }
        }
        return untrackedPaths;
    }

    getProgressText(action: string, event: GitProgressEvent): string {
        let out = `${action} progress:`;
        if (event.phase) {
            out = `${out} ${event.phase}:`;
        }
        if (event.loaded) {
            out = `${out} ${event.loaded}`;
            if (event.total) {
                out = `${out} of ${event.total}`;
            }
        }
        return out;
    }

    resolveRef(ref: string): Promise<string> {
        if (/^[0-9a-f]{40}$/.test(ref)) return Promise.resolve(ref);
        const cache = this.getInfoCache();
        let oid = cache.refs.get(ref);
        if (!oid) {
            oid = this.wrapFS(git.resolveRef({ ...this.getRepo(), ref }));
            cache.refs.set(ref, oid);
            oid.catch(() => cache.refs.delete(ref));
        }
        return oid;
    }

    async pull(): Promise<PullResult> {
        return this.withGitOperation(GitOperation.pull, async () => {
            let mergeState:
                { ours: string; theirs: string; message: string } | undefined;
            try {
                if (await this.isMergeInProgress()) {
                    throw new Error(
                        "Cannot pull because a merge is still in progress. Commit or abort it first."
                    );
                }
                const branchInfo = await this.branchInfo();
                if (!branchInfo.current) {
                    throw new Error("No current branch found. Cannot pull.");
                }

                const localCommit = await this.resolveRef(branchInfo.current);

                if (!branchInfo.tracking) {
                    this.plugin.log("No tracking branch found. Ignoring pull.");
                    return { status: "skipped", reason: "no-upstream" };
                }

                if (
                    await this.isUpToDateWithRemote(
                        localCommit,
                        branchInfo.tracking,
                        branchInfo.remote
                    )
                ) {
                    return { status: "up-to-date" };
                }

                await this.fetch();

                await this.checkAuthorInfo();

                const theirs = await this.resolveRef(branchInfo.tracking);
                mergeState = {
                    ours: localCommit,
                    theirs,
                    message: `Merge branch '${branchInfo.tracking}' into ${branchInfo.current}`,
                };

                const mergeRes = await this.wrapFS(
                    git.merge({
                        ...this.getRepo(),
                        ours: branchInfo.current,
                        theirs: branchInfo.tracking,
                        message: mergeState.message,
                        abortOnConflict: false,
                        mergeDriver:
                            this.plugin.settings.mergeStrategy !== "none"
                                ? ({ contents }) => {
                                      const baseContent = contents[0]!;
                                      const ourContent = contents[1]!;
                                      const theirContent = contents[2]!;

                                      const LINEBREAKS = /^.*(\r?\n|$)/gm;
                                      const ours =
                                          ourContent.match(LINEBREAKS) ?? [];
                                      const base =
                                          baseContent.match(LINEBREAKS) ?? [];
                                      const theirs =
                                          theirContent.match(LINEBREAKS) ?? [];
                                      const result = diff3Merge(
                                          ours,
                                          base,
                                          theirs
                                      );
                                      let mergedText = "";
                                      for (const item of result) {
                                          if (item.ok) {
                                              mergedText += item.ok.join("");
                                          }
                                          if (item.conflict) {
                                              mergedText +=
                                                  this.plugin.settings
                                                      .mergeStrategy === "ours"
                                                      ? item.conflict.a.join("")
                                                      : item.conflict.b.join(
                                                            ""
                                                        );
                                          }
                                      }
                                      return { cleanMerge: true, mergedText };
                                  }
                                : undefined,
                    })
                );
                if (!mergeRes.alreadyMerged) {
                    await this.wrapFS(
                        git.checkout({
                            ...this.getRepo(),
                            ref: branchInfo.current,
                            remote: branchInfo.remote,
                        })
                    );
                }
                const upstreamCommit = await this.resolveRef("HEAD");
                const changedFiles = await this.getFileChangesCount(
                    localCommit,
                    upstreamCommit
                );

                if (mergeRes.alreadyMerged) {
                    return { status: "up-to-date" };
                }
                this.warmHeadSnapshot(0);

                return {
                    status: "updated",
                    outsideVault: 0,
                    files: changedFiles.map<FileStatusResult>((file) => ({
                        path: file.path,
                        workingDir: "P",
                        index: "P",
                        vaultPath: this.getRelativeVaultPath(file.path),
                    })),
                };
            } catch (error) {
                if (error instanceof Errors.MergeConflictError) {
                    if (mergeState !== undefined) {
                        await this.writeMergeState(mergeState);
                    }
                    throw new GitConflictError(error.data.filepaths, error);
                }
                throw error;
            }
        });
    }

    async push(): Promise<PushResult> {
        const progressNotice = this.showNotice("Initializing push");
        return this.withGitOperation(GitOperation.push, async () => {
            try {
                const status = await this.branchInfo();
                const trackingBranch = status.tracking;
                const currentBranch = status.current;
                if (!currentBranch) {
                    progressNotice?.hide();
                    return { status: "blocked", reason: "no-branch" };
                }
                if (!trackingBranch) {
                    progressNotice?.hide();
                    this.plugin.log("No tracking branch found. Ignoring push.");
                    return { status: "skipped", reason: "no-upstream" };
                }
                const remote = await this.getCurrentRemote();
                const fastResult = await this.tryFastPush(
                    currentBranch,
                    trackingBranch,
                    remote
                );
                if (fastResult !== undefined) {
                    progressNotice?.hide();
                    return fastResult;
                }

                const numChangedFiles = (
                    await this.getFileChangesCount(
                        currentBranch,
                        trackingBranch
                    )
                ).length;

                await this.wrapFS(
                    git.push({
                        ...this.getRepo(),
                        remote,
                        onProgress: (progress) => {
                            if (progressNotice !== undefined) {
                                progressNotice.setMessage(
                                    this.getProgressText("Pushing", progress)
                                );
                            }
                        },
                    })
                );
                progressNotice?.hide();
                return numChangedFiles === 0
                    ? { status: "up-to-date" }
                    : { status: "pushed", files: numChangedFiles };
            } catch (error) {
                progressNotice?.hide();
                throw error;
            }
        });
    }

    /**
     * statusMatrix-compatible rows (unchanged files omitted) from the index,
     * Obsidian's in-memory file stats and a cached HEAD tree. Only hidden
     * paths, which Obsidian does not track, need file system calls; file
     * contents are hashed only when their stats changed. The index is only
     * read here: writes from outside isomorphic-git's own lock could clobber
     * concurrent index updates.
     */
    private async fastStatusRows(
        path?: string
    ): Promise<{ rows: StatusRow[]; conflicted: string[] } | undefined> {
        if (!this.useFastStatus || this.plugin.settings.gitDir)
            return undefined;
        try {
            const prefix =
                path !== undefined ? `${path.replace(/\/$/, "")}/` : "";
            const [working, head, index] = await Promise.all([
                this.listWorkingTree(),
                this.getHeadTree(),
                this.readIndexForStatus(),
            ]);
            const isIgnored = this.getIgnoreChecker(working);
            const gitlinks = [...index.gitlinks].map((link) => `${link}/`);
            // A file is trusted by its stats only if it was last written at least
            // two seconds before they were recorded (coarse FAT timestamps).
            const settled = (mtimeMs: number, recordedSeconds: number) =>
                Math.floor(mtimeMs / 1000) + 1 < recordedSeconds;
            const sameStats = (
                recorded: {
                    mtimeMs: number;
                    ctimeSeconds: number;
                    size: number;
                },
                stats: WorkingFileStats
            ) =>
                recorded.mtimeMs === Math.floor(stats.mtimeMs) &&
                recorded.ctimeSeconds === Math.floor(stats.ctimeMs / 1000) &&
                recorded.size === stats.size;
            const paths = new Set<string>([
                ...head.keys(),
                ...index.entries.keys(),
                ...working.keys(),
            ]);
            const rows: StatusRow[] = [];
            for (const filepath of [...paths].sort()) {
                if (!filepath.startsWith(prefix)) continue;
                // Never report repositories nested in the working tree.
                if (gitlinks.some((link) => filepath.startsWith(link)))
                    continue;
                if (index.gitlinks.has(filepath)) continue;
                const entry = index.entries.get(filepath);
                const headOid = head.get(filepath);
                const stats = working.get(filepath);
                let workOid: string | undefined;
                if (stats) {
                    const verified = this.verifiedStats.get(filepath);
                    if (
                        entry &&
                        sameStats(entry, stats) &&
                        settled(stats.mtimeMs, index.writtenSeconds)
                    ) {
                        workOid = entry.oid;
                    } else if (
                        entry &&
                        verified?.oid === entry.oid &&
                        sameStats(verified, stats) &&
                        settled(stats.mtimeMs, verified.verifiedSeconds)
                    ) {
                        workOid = entry.oid;
                    } else if (!entry && headOid === undefined) {
                        if (await isIgnored(filepath)) continue;
                        workOid = "untracked";
                    } else {
                        const verifiedSeconds = Math.floor(Date.now() / 1000);
                        workOid = await this.hashWorkingFile(filepath);
                        if (workOid === undefined) {
                            // Gone since it was listed: treat as deleted, rescan.
                            this.hiddenFiles.invalidate();
                        } else if (entry && workOid === entry.oid) {
                            this.verifiedStats.set(filepath, {
                                oid: workOid,
                                mtimeMs: Math.floor(stats.mtimeMs),
                                ctimeSeconds: Math.floor(stats.ctimeMs / 1000),
                                size: stats.size,
                                verifiedSeconds,
                            });
                        }
                    }
                }
                const stageOid = entry?.oid;
                const headCode = headOid !== undefined ? 1 : 0;
                const workCode =
                    workOid === undefined ? 0 : workOid === headOid ? 1 : 2;
                const stageCode =
                    stageOid === undefined
                        ? 0
                        : stageOid === headOid
                          ? 1
                          : stageOid === workOid
                            ? 2
                            : 3;
                if (headCode === 1 && workCode === 1 && stageCode === 1) {
                    continue;
                }
                rows.push([filepath, headCode, workCode, stageCode]);
            }
            return {
                rows,
                conflicted: index.unmerged.filter((file) =>
                    file.startsWith(prefix)
                ),
            };
        } catch (error) {
            this.plugin.log("Fast status failed, using statusMatrix", error);
            return undefined;
        }
    }

    /** A read-only copy of what the fast status needs from the index. */
    private async readIndexForStatus(): Promise<{
        entries: Map<
            string,
            { oid: string; mtimeMs: number; ctimeSeconds: number; size: number }
        >;
        gitlinks: Set<string>;
        unmerged: string[];
        writtenSeconds: number;
    }> {
        const indexPath = normalizePath(`${this.getGitDirPath()}/index`);
        const result = GitIndexManager.acquire(
            {
                fs: new FileSystem(this.fs),
                gitdir: this.getIndexGitdir(),
                cache: {},
            },
            async (rawIndex: unknown) => {
                const index = rawIndex as GitIndexLike;
                const indexStat = await this.fs
                    .stat(indexPath)
                    .catch(() => undefined);
                const entries = new Map<
                    string,
                    {
                        oid: string;
                        mtimeMs: number;
                        ctimeSeconds: number;
                        size: number;
                    }
                >();
                const gitlinks = new Set<string>();
                for (const [filepath, entry] of index.entriesMap) {
                    if (entry.mode === 0o160000) {
                        gitlinks.add(filepath);
                        continue;
                    }
                    entries.set(filepath, {
                        oid: entry.oid,
                        mtimeMs:
                            entry.mtimeSeconds * 1000 +
                            Math.floor(entry.mtimeNanoseconds / 1e6),
                        ctimeSeconds: entry.ctimeSeconds,
                        size: entry.size,
                    });
                }
                return {
                    entries,
                    gitlinks,
                    unmerged: index.unmergedPaths,
                    writtenSeconds: indexStat
                        ? Math.floor(indexStat.mtimeMs / 1000)
                        : 0,
                };
            }
        ) as Promise<{
            entries: Map<
                string,
                {
                    oid: string;
                    mtimeMs: number;
                    ctimeSeconds: number;
                    size: number;
                }
            >;
            gitlinks: Set<string>;
            unmerged: string[];
            writtenSeconds: number;
        }>;
        return this.wrapFS(result);
    }

    /** Repo-relative paths of working tree files with their stats. */
    private async listWorkingTree(): Promise<Map<string, WorkingFileStats>> {
        const base = this.plugin.settings.basePath;
        const prefix = base ? `${base}/` : "";
        const files = new Map<string, WorkingFileStats>();
        for (const file of this.app.vault.getFiles()) {
            if (!file.path.startsWith(prefix)) continue;
            files.set(file.path.slice(prefix.length), {
                ctimeMs: file.stat.ctime,
                mtimeMs: file.stat.mtime,
                size: file.stat.size,
            });
        }
        this.hiddenFiles.install();
        for (const [path, stats] of await this.hiddenFiles.getFiles()) {
            if (path.startsWith(prefix))
                files.set(path.slice(prefix.length), stats);
        }
        return files;
    }

    /**
     * Stats of all files Obsidian does not index (dot-files and everything in
     * dot-folders), by vault path: lists every folder Obsidian knows, then
     * everything below hidden ones.
     */
    private async scanHiddenFiles(): Promise<Map<string, HiddenFileStats>> {
        const gitDir = this.getGitDirPath();
        const base = this.plugin.settings.basePath;
        // Stay inside the repository when it is a vault subfolder.
        const inRepo = (folder: string) =>
            !base ? true : folder === base || folder.startsWith(`${base}/`);
        const files = new Map<string, HiddenFileStats>();
        const queue = this.app.vault
            .getAllLoadedFiles()
            .filter((file) => "children" in file && inRepo(file.path))
            .map((folder) => ({ folder: folder.path, hidden: false }));
        const isHiddenName = (vaultPath: string) =>
            vaultPath.split("/").pop()!.startsWith(".");
        await runLimited(queue, 16, async ({ folder, hidden }) => {
            const listing = await this.app.vault.adapter.list(folder);
            for (const child of listing.folders) {
                if (child === gitDir) continue;
                if (hidden || isHiddenName(child)) {
                    queue.push({ folder: child, hidden: true });
                }
            }
            await Promise.all(
                listing.files
                    .filter((child) => hidden || isHiddenName(child))
                    .map(async (child) => {
                        const stat = await this.app.vault.adapter.stat(child);
                        if (stat?.type === "file") {
                            files.set(child, {
                                ctimeMs: stat.ctime,
                                mtimeMs: stat.mtime,
                                size: stat.size,
                            });
                        }
                    })
            );
        });
        return files;
    }

    /** Blob oids of the HEAD tree by repo path; empty before the first commit. */
    private async getHeadTree(): Promise<Map<string, string>> {
        return (await this.getHeadSnapshot()).files;
    }

    /** HEAD's files, modes and directory tree oids, cached per HEAD commit. */
    private async getHeadSnapshot(): Promise<HeadSnapshot> {
        let commit: string;
        try {
            // Always fresh: status decides what gets committed.
            commit = await this.wrapFS(
                git.resolveRef({ ...this.getRepo(), ref: "HEAD" })
            );
        } catch (error) {
            if (error instanceof Errors.NotFoundError) {
                return {
                    commit: "",
                    files: new Map(),
                    modes: new Map(),
                    dirs: new Map(),
                };
            }
            throw error;
        }
        if (this.headTree?.commit === commit) return this.headTree;
        if (this.headSnapshotLoad?.commit !== commit) {
            const promise = this.loadHeadSnapshot(commit);
            this.headSnapshotLoad = { commit, promise };
            promise.then(
                () => (this.headSnapshotLoad = undefined),
                () => (this.headSnapshotLoad = undefined)
            );
        }
        return this.headSnapshotLoad.promise;
    }

    private async loadHeadSnapshot(commit: string): Promise<HeadSnapshot> {
        const files = new Map<string, string>();
        const modes = new Map<string, number>();
        const dirs = new Map<string, string>([
            [
                "",
                (await git.readCommit({ ...this.getRepo(), oid: commit }))
                    .commit.tree,
            ],
        ]);
        await git.walk({
            ...this.getRepo(),
            trees: [git.TREE({ ref: commit })],
            map: async (filepath, [entry]) => {
                if (filepath === "." || !entry) return;
                const type = await entry.type();
                if (type === "blob") {
                    files.set(filepath, await entry.oid());
                    modes.set(filepath, await entry.mode());
                } else if (type === "tree") {
                    dirs.set(filepath, await entry.oid());
                }
                return type === "tree" ? undefined : null;
            },
        });
        this.headTree = { commit, files, modes, dirs };
        return this.headTree;
    }

    /**
     * Writes the index as a tree, rebuilding only directories that differ
     * from HEAD and reusing HEAD's tree oids for the rest.
     */
    private async writeIndexTree(
        head: HeadSnapshot,
        index: IndexSnapshot
    ): Promise<{ tree: string; dirs: Map<string, string> }> {
        const parentOf = (path: string) => {
            const slash = path.lastIndexOf("/");
            return slash === -1 ? "" : path.slice(0, slash);
        };
        const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
        const dirty = new Set<string>();
        const markDirty = (path: string) => {
            let dir = parentOf(path);
            while (!dirty.has(dir)) {
                dirty.add(dir);
                if (dir === "") break;
                dir = parentOf(dir);
            }
        };
        const files = new Map<string, TreeEntry[]>();
        const subdirs = new Map<string, Set<string>>();
        for (const [path, { oid, mode }] of index.files) {
            const dir = parentOf(path);
            if (!files.has(dir)) files.set(dir, []);
            files.get(dir)!.push({
                mode: mode.toString(8),
                path: nameOf(path),
                oid,
                type: "blob",
            });
            for (let child = dir; child !== ""; child = parentOf(child)) {
                const parent = parentOf(child);
                if (!subdirs.has(parent)) subdirs.set(parent, new Set());
                subdirs.get(parent)!.add(child);
            }
            if (head.files.get(path) !== oid || head.modes.get(path) !== mode) {
                markDirty(path);
            }
        }
        for (const path of head.files.keys()) {
            if (!index.files.has(path)) markDirty(path);
        }
        const dirs = new Map(head.dirs);
        const build = async (dir: string): Promise<string> => {
            if (!dirty.has(dir)) {
                const cached = head.dirs.get(dir);
                if (cached === undefined) {
                    throw new Error(`Missing cached tree for "${dir}"`);
                }
                return cached;
            }
            const entries = [...(files.get(dir) ?? [])];
            for (const child of subdirs.get(dir) ?? []) {
                entries.push({
                    mode: "040000",
                    path: nameOf(child),
                    oid: await build(child),
                    type: "tree",
                });
            }
            const oid = await git.writeTree({
                ...this.getRepo(),
                tree: entries,
            });
            dirs.set(dir, oid);
            return oid;
        };
        const tree = await build("");
        for (const dir of [...dirs.keys()]) {
            if (
                dir !== "" &&
                dirty.has(parentOf(dir)) &&
                !subdirs.get(parentOf(dir))?.has(dir)
            ) {
                dirs.delete(dir);
            }
        }
        return { tree, dirs };
    }

    /** Blob oid of a working tree file, or undefined if it no longer exists. */
    private async hashWorkingFile(
        filepath: string
    ): Promise<string | undefined> {
        const vaultPath = this.getRelativeVaultPath(filepath);
        let content: ArrayBuffer;
        try {
            content = await this.app.vault.adapter.readBinary(vaultPath);
        } catch (error) {
            if (!(await this.app.vault.adapter.exists(vaultPath))) {
                return undefined;
            }
            throw error;
        }
        return (await git.hashBlob({ object: new Uint8Array(content) })).oid;
    }

    /** isIgnored with results cached until a .gitignore file changes. */
    private getIgnoreChecker(
        working: Map<string, WorkingFileStats>
    ): (filepath: string) => Promise<boolean> {
        const signature = [...working]
            .filter(
                ([file]) =>
                    file === ".gitignore" || file.endsWith("/.gitignore")
            )
            .map(([file, stat]) => `${file}:${stat.mtimeMs}:${stat.size}`)
            .sort()
            .join("|");
        if (this.ignoredCache?.signature !== signature) {
            this.ignoredCache = { signature, results: new Map() };
        }
        const results = this.ignoredCache.results;
        return async (filepath) => {
            let ignored = results.get(filepath);
            if (ignored === undefined) {
                ignored = await git.isIgnored({ ...this.getRepo(), filepath });
                results.set(filepath, ignored);
            }
            return ignored;
        };
    }

    protected override async withGitOperation<T>(
        operation: GitOperation,
        fn: () => Promise<T>
    ): Promise<T> {
        // Operations may move refs or change config; never reuse reads across them.
        this.invalidateInfo();
        try {
            return await super.withGitOperation(operation, fn);
        } finally {
            this.invalidateInfo();
        }
    }

    /** Loads the HEAD snapshot in the background so a commit doesn't wait for it. */
    private warmHeadSnapshot(delayMs: number): void {
        this.timers.push(
            window.setTimeout(() => {
                this.getHeadSnapshot().catch((error) =>
                    this.plugin.log("Preloading HEAD failed", error)
                );
            }, delayMs)
        );
    }

    override unload(): void {
        this.hiddenFiles.uninstall();
        for (const timer of this.timers.splice(0)) window.clearTimeout(timer);
        super.unload();
    }

    private getInfoCache(): NonNullable<IsomorphicGit["infoCache"]> {
        if (!this.infoCache || Date.now() > this.infoCache.expires) {
            this.infoCache = {
                expires: Date.now() + 3000,
                config: new Map(),
                refs: new Map(),
            };
        }
        return this.infoCache;
    }

    private invalidateInfo(): void {
        this.infoCache = undefined;
    }

    private getCredentials(): RemoteCredentials {
        return {
            username: this.plugin.localStorage.getUsername() ?? undefined,
            password: this.plugin.localStorage.getPassword() ?? undefined,
        };
    }

    /** The remote's URL if this client can talk to it directly (plain http(s)). */
    private async directRemoteUrl(remote: string): Promise<string | undefined> {
        const url = await this.getRemoteUrl(remote);
        if (!url || !/^https?:\/\//.test(url) || new URL(url).username) {
            return undefined;
        }
        return url;
    }

    /** Asks the remote for a branch tip; undefined when it can't be asked directly. */
    private async probeRemoteTip(
        remote: string,
        ref: string,
        maxAgeMs = 0
    ): Promise<{ url: string; oid?: string } | undefined> {
        const url = await this.directRemoteUrl(remote);
        if (!url) return undefined;
        const cached = this.remoteTip;
        if (
            cached?.url === url &&
            cached.ref === ref &&
            Date.now() - cached.at <= maxAgeMs
        ) {
            return cached;
        }
        const advertisement = await advertiseReceivePack(
            url,
            this.getCredentials()
        );
        if (!advertisement) return undefined;
        this.remoteTip = {
            url,
            ref,
            oid: advertisement.refs.get(ref),
            at: Date.now(),
        };
        return this.remoteTip;
    }

    /** True when the remote branch still equals the tracking ref and HEAD contains it. */
    private async isUpToDateWithRemote(
        localCommit: string,
        tracking: string,
        remote: string
    ): Promise<boolean> {
        try {
            const branch = splitRemoteBranch(tracking)[1];
            if (!branch) return false;
            const tip = await this.probeRemoteTip(
                remote,
                `refs/heads/${branch}`
            );
            if (tip?.oid === undefined) return false;
            if (tip.oid !== (await this.resolveRef(tracking))) return false;
            return (
                tip.oid === localCommit ||
                (await git.isDescendent({
                    ...this.getRepo(),
                    oid: localCommit,
                    ancestor: tip.oid,
                    depth: 100,
                }))
            );
        } catch (error) {
            this.plugin.log("Remote probe failed, fetching instead", error);
            return false;
        }
    }

    /** Pushes the new objects directly; undefined means use the regular push. */
    /**
     * Pushes without asking the remote first, assuming it still matches the
     * tracking ref. The server only accepts the update if it does, so success
     * also means there was nothing to pull. Undefined means sync normally.
     */
    override async pushIfRemoteUnchanged(): Promise<PushResult | undefined> {
        if (this.optimisticPushDisabled || this.plugin.state.mergeInProgress) {
            return undefined;
        }
        return this.withGitOperation(GitOperation.push, async () => {
            const { current, tracking, remote } = await this.branchInfo();
            if (!current || !tracking) return undefined;
            return this.tryFastPush(current, tracking, remote, {
                optimistic: true,
            });
        });
    }

    private async tryFastPush(
        currentBranch: string,
        tracking: string,
        remote: string,
        { optimistic = false }: { optimistic?: boolean } = {}
    ): Promise<PushResult | undefined> {
        try {
            const branch = splitRemoteBranch(tracking)[1];
            if (!branch) return undefined;
            const ref = `refs/heads/${branch}`;
            const localOid = await this.resolveRef(currentBranch);
            const trackingOid = await this.resolveRef(tracking);
            const tip = optimistic
                ? await this.directRemoteUrl(remote).then((url) =>
                      url ? { url, oid: trackingOid } : undefined
                  )
                : await this.probeRemoteTip(remote, ref, 60_000);
            if (tip?.oid === undefined || tip.oid !== trackingOid) {
                return undefined;
            }
            if (localOid === trackingOid) return { status: "up-to-date" };

            const commits = await this.commitsSince(localOid, trackingOid);
            if (!commits) return undefined;
            const { oids, changedFiles } =
                await this.collectPushObjects(commits);
            const { packfile } = await git.packObjects({
                ...this.getRepo(),
                oids: [...oids],
            });
            if (!packfile) return undefined;
            this.remoteTip = undefined;
            const result = await sendReceivePack({
                url: tip.url,
                credentials: this.getCredentials(),
                ref,
                oldOid: trackingOid,
                newOid: localOid,
                pack: packfile,
            });
            if (!result.ok) {
                this.plugin.log(`Fast push rejected: ${result.reason}`);
                if (optimistic && result.kind === "protocol") {
                    // This server may need the usual ref discovery first.
                    this.optimisticPushDisabled = true;
                }
                return undefined;
            }
            await git.writeRef({
                ...this.getRepo(),
                ref: `refs/remotes/${remote}/${branch}`,
                value: localOid,
                force: true,
            });
            const files =
                changedFiles ??
                (await this.getFileChangesCount(localOid, trackingOid)).length;
            return files === 0
                ? { status: "up-to-date" }
                : { status: "pushed", files };
        } catch (error) {
            this.plugin.log("Fast push failed, using regular push", error);
            return undefined;
        }
    }

    /** Commits reachable from `head` but not from `stop`, or undefined if that is not a short, complete chain. */
    private async commitsSince(
        head: string,
        stop: string
    ): Promise<{ oid: string; parents: string[] }[] | undefined> {
        const result: { oid: string; parents: string[] }[] = [];
        const queue = [head];
        const seen = new Set<string>();
        while (queue.length > 0) {
            const oid = queue.shift()!;
            if (oid === stop || seen.has(oid)) continue;
            seen.add(oid);
            if (seen.size > 50) return undefined;
            const { commit } = await git.readCommit({ ...this.getRepo(), oid });
            if (commit.parent.length === 0) return undefined;
            result.push({ oid, parents: commit.parent });
            queue.push(...commit.parent);
        }
        return result;
    }

    /**
     * Objects of the given commits that none of their parents has at the same
     * path. Every parent is either the remote tip or one of the commits, so
     * this covers everything the remote is missing.
     */
    private async collectPushObjects(
        commits: { oid: string; parents: string[] }[]
    ): Promise<{ oids: Set<string>; changedFiles?: number }> {
        const oids = new Set<string>();
        const collect = async (
            tree: string,
            parentTrees: (string | undefined)[]
        ): Promise<void> => {
            if (parentTrees.includes(tree)) return;
            oids.add(tree);
            const [entries, ...parentEntries] = await Promise.all([
                this.readTreeEntries(tree),
                ...parentTrees.map((oid) =>
                    oid ? this.readTreeEntries(oid) : Promise.resolve([])
                ),
            ]);
            const parentMaps = parentEntries.map(
                (list) => new Map(list.map((e) => [e.path, e]))
            );
            await Promise.all(
                entries.map(async (entry) => {
                    if (entry.type === "commit") return;
                    const atPath = parentMaps.map((map) => map.get(entry.path));
                    if (atPath.some((p) => p?.oid === entry.oid)) return;
                    if (entry.type === "tree") {
                        await collect(
                            entry.oid,
                            atPath.map((p) =>
                                p?.type === "tree" ? p.oid : undefined
                            )
                        );
                    } else {
                        oids.add(entry.oid);
                    }
                })
            );
        };
        for (const commit of commits) {
            oids.add(commit.oid);
            const [tree, ...parentTrees] = await Promise.all(
                [commit.oid, ...commit.parents].map(
                    async (oid) =>
                        (await git.readCommit({ ...this.getRepo(), oid }))
                            .commit.tree
                )
            );
            await collect(tree!, parentTrees);
        }
        let changedFiles: number | undefined;
        if (commits.length === 1 && commits[0]!.parents.length === 1) {
            changedFiles = (
                await this.getFileChangesCount(
                    commits[0]!.parents[0]!,
                    commits[0]!.oid
                )
            ).length;
        }
        return { oids, changedFiles };
    }

    async getUnpushedCommits(): Promise<number> {
        const status = await this.branchInfo();
        const trackingBranch = status.tracking;
        const currentBranch = status.current;

        if (trackingBranch == null || currentBranch == null) {
            return 0;
        }

        const localCommit = await this.resolveRef(currentBranch);
        const upstreamCommit = await this.resolveRef(trackingBranch);

        const changedFiles = await this.getFileChangesCount(
            localCommit,
            upstreamCommit
        );

        return changedFiles.length;
    }

    async canPush(): Promise<boolean> {
        const status = await this.branchInfo();
        const trackingBranch = status.tracking;
        const currentBranch = status.current;

        if (!currentBranch) {
            this.plugin.log("During canPush check, no current branch found.");
            return false;
        }
        if (!trackingBranch) {
            return false;
        }

        const current = await this.resolveRef(currentBranch);
        const tracking = await this.resolveRef(trackingBranch);

        return current != tracking;
    }

    async checkRequirements(): Promise<"valid" | "missing-repo"> {
        const headExists = await this.plugin.app.vault.adapter.exists(
            normalizePath(`${this.getGitDirPath()}/HEAD`)
        );

        if (headExists && this.useFastStatus && !this.plugin.settings.gitDir) {
            // Have the hidden file and HEAD snapshots ready before the first commit.
            this.hiddenFiles.start(2000);
            this.warmHeadSnapshot(2500);
        }
        return headExists ? "valid" : "missing-repo";
    }

    async branchInfo(): Promise<BranchInfo & { remote: string }> {
        const cache = this.getInfoCache();
        if (!cache.branchInfo) {
            const info = this.readBranchInfo();
            cache.branchInfo = info;
            info.catch(() => {
                if (cache.branchInfo === info) cache.branchInfo = undefined;
            });
        }
        return cache.branchInfo;
    }

    private async readBranchInfo(): Promise<BranchInfo & { remote: string }> {
        const current = await git.currentBranch(this.getRepo());

        const branches = await git.listBranches(this.getRepo());

        const remote =
            (current && (await this.getConfig(`branch.${current}.remote`))) ??
            "origin";

        const trackingBranch = current
            ? (await this.getConfig(`branch.${current}.merge`))?.split(
                  "refs/heads"
              )[1]
            : undefined;

        const tracking = trackingBranch ? remote + trackingBranch : undefined;

        return {
            current: current || undefined,
            tracking: tracking,
            branches: branches,
            remote: remote,
        };
    }

    async getCurrentRemote(): Promise<string> {
        const current = (await git.currentBranch(this.getRepo())) || "";

        const remote =
            (await this.getConfig(`branch.${current}.remote`)) ?? "origin";
        return remote;
    }

    async checkout(branch: string, remote?: string): Promise<void> {
        try {
            return await this.withGitOperation(GitOperation.checkout, () =>
                this.wrapFS(
                    git.checkout({
                        ...this.getRepo(),
                        ref: branch,
                        force: !!remote,
                        remote,
                    })
                )
            );
        } finally {
            this.invalidateInfo();
        }
    }

    async createBranch(branch: string): Promise<void> {
        try {
            await this.wrapFS(
                git.branch({ ...this.getRepo(), ref: branch, checkout: true })
            );
        } finally {
            this.invalidateInfo();
        }
    }

    async deleteBranch(branch: string): Promise<void> {
        try {
            await this.wrapFS(
                git.deleteBranch({ ...this.getRepo(), ref: branch })
            );
        } finally {
            this.invalidateInfo();
        }
    }

    branchIsMerged(_: string): Promise<boolean> {
        return Promise.resolve(true);
    }

    async init(): Promise<void> {
        try {
            await this.wrapFS(git.init(this.getRepo()));
        } finally {
            this.invalidateInfo();
        }
    }

    async clone(url: string, dir: string, depth?: number): Promise<void> {
        try {
            const progressNotice = this.showNotice("Initializing clone");
            try {
                await this.wrapFS(
                    git.clone({
                        ...this.getRepo(),
                        dir: dir,
                        url: url,
                        depth: depth,
                        onProgress: (progress) => {
                            if (progressNotice !== undefined) {
                                progressNotice.setMessage(
                                    this.getProgressText("Cloning", progress)
                                );
                            }
                        },
                    })
                );
            } finally {
                progressNotice?.hide();
            }
        } finally {
            this.invalidateInfo();
        }
    }

    async setConfig(
        path: string,
        value: string | number | boolean | undefined
    ): Promise<void> {
        try {
            return await this.wrapFS(
                git.setConfig({
                    ...this.getRepo(),
                    path: path,
                    value: value,
                })
            );
        } finally {
            this.invalidateInfo();
        }
    }

    async getConfig(path: string): Promise<string | undefined> {
        const cache = this.getInfoCache();
        let value = cache.config.get(path);
        if (!value) {
            value = this.readConfig(path);
            cache.config.set(path, value);
            value.catch(() => cache.config.delete(path));
        }
        return value;
    }

    private readConfig(path: string): Promise<string | undefined> {
        return this.wrapFS(
            git.getConfig({
                ...this.getRepo(),
                path: path,
            }) as Promise<string | undefined>
        );
    }

    async fetch(remote?: string): Promise<void> {
        const progressNotice = this.showNotice("Initializing fetch");

        try {
            const args = {
                ...this.getRepo(),
                onProgress: (progress: GitProgressEvent) => {
                    if (progressNotice !== undefined) {
                        progressNotice.setMessage(
                            this.getProgressText("Fetching", progress)
                        );
                    }
                },
                remote: remote ?? (await this.getCurrentRemote()),
            };

            try {
                await this.wrapFS(git.fetch(args));
            } finally {
                this.invalidateInfo();
            }
            progressNotice?.hide();
        } catch (error) {
            progressNotice?.hide();
            throw error;
        }
    }

    async setRemote(name: string, url: string): Promise<void> {
        try {
            await this.wrapFS(
                git.addRemote({
                    ...this.getRepo(),
                    remote: name,
                    url: url,
                    force: true,
                })
            );
        } finally {
            this.invalidateInfo();
        }
    }

    async getRemoteBranches(remote: string): Promise<string[]> {
        let remoteBranches = [];
        remoteBranches.push(
            ...(await this.wrapFS(
                git.listBranches({ ...this.getRepo(), remote: remote })
            ))
        );

        remoteBranches.remove("HEAD");

        //Align with simple-git
        remoteBranches = remoteBranches.map((e) => `${remote}/${e}`);
        return remoteBranches;
    }

    async getRemotes(): Promise<string[]> {
        return (await this.wrapFS(git.listRemotes({ ...this.getRepo() }))).map(
            (remoteUrl) => remoteUrl.remote
        );
    }

    async removeRemote(remoteName: string): Promise<void> {
        try {
            await this.wrapFS(
                git.deleteRemote({ ...this.getRepo(), remote: remoteName })
            );
        } finally {
            this.invalidateInfo();
        }
    }

    async getRemoteUrl(remote: string): Promise<string | undefined> {
        return (
            await this.wrapFS(git.listRemotes({ ...this.getRepo() }))
        ).filter((item) => item.remote == remote)[0]?.url;
    }

    async log(
        _?: string,
        __ = true,
        limit?: number,
        ref?: string
    ): Promise<LogEntry[]> {
        const logs = await this.wrapFS(
            git.log({ ...this.getRepo(), depth: limit, ref: ref })
        );

        return Promise.all(
            logs.map(async (log) => {
                const completeMessage = log.commit.message.split("\n\n");

                return {
                    message: completeMessage[0] ?? "",
                    author: {
                        name: log.commit.author.name,
                        email: log.commit.author.email,
                    },
                    body: completeMessage.slice(1).join("\n\n"),
                    date: new Date(
                        log.commit.committer.timestamp
                    ).toDateString(),
                    diff: {
                        changed: 0,
                        files: (
                            await this.getFileChangesCount(
                                log.commit.parent.first()!,
                                log.oid
                            )
                        ).map<DiffFile>((item) => {
                            return {
                                path: item.path,
                                status: item.type,
                                vaultPath: this.getRelativeVaultPath(item.path),
                                hash: log.oid,
                            };
                        }),
                    },
                    hash: log.oid,
                    refs: [],
                };
            })
        );
    }

    updateBasePath(basePath: string): Promise<void> {
        this.getRepo().dir = basePath;
        return Promise.resolve();
    }

    /**
     * The gitdir string isomorphic-git itself derives from getRepo(). Index
     * locks are keyed by this string, so every index access must use it.
     */
    private getIndexGitdir(): string {
        const { dir, gitdir } = this.getRepo();
        if (gitdir) return gitdir;
        return dir.endsWith("/") ? `${dir}.git` : `${dir}/.git`;
    }

    private getGitDirPath(): string {
        return normalizePath(
            this.getRelativeVaultPath(this.plugin.settings.gitDir || ".git")
        );
    }

    private async getConflictedFiles(): Promise<string[]> {
        const result = GitIndexManager.acquire(
            {
                fs: new FileSystem(this.fs),
                gitdir: this.getIndexGitdir(),
                cache: {},
            },
            (index) => index.unmergedPaths as unknown
        ) as Promise<unknown>;
        const conflicted = await this.wrapFS(result);
        if (
            !Array.isArray(conflicted) ||
            !conflicted.every((path: unknown) => typeof path === "string")
        ) {
            throw new TypeError(
                "isomorphic-git returned invalid unmerged paths"
            );
        }
        return conflicted;
    }

    private getMergeStatePath(filename: string): string {
        return normalizePath(`${this.getGitDirPath()}/${filename}`);
    }

    async isMergeInProgress(): Promise<boolean> {
        return this.app.vault.adapter.exists(
            this.getMergeStatePath(IsomorphicGit.MERGE_HEAD)
        );
    }

    private async getMergeHeads(): Promise<string[]> {
        const path = this.getMergeStatePath(IsomorphicGit.MERGE_HEAD);
        if (!(await this.app.vault.adapter.exists(path))) {
            return [];
        }

        return (await this.app.vault.adapter.read(path))
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
    }

    private async writeMergeState({
        ours,
        theirs,
        message,
    }: {
        ours: string;
        theirs: string;
        message: string;
    }): Promise<void> {
        const adapter = this.app.vault.adapter;
        await adapter.write(
            this.getMergeStatePath(IsomorphicGit.ORIGINAL_HEAD),
            `${ours}\n`
        );
        await adapter.write(
            this.getMergeStatePath(IsomorphicGit.MERGE_MESSAGE),
            `${message}\n`
        );
        await adapter.write(
            this.getMergeStatePath(IsomorphicGit.MERGE_MODE),
            ""
        );
        // MERGE_HEAD is written last because its presence marks the merge as active.
        await adapter.write(
            this.getMergeStatePath(IsomorphicGit.MERGE_HEAD),
            `${theirs}\n`
        );
    }

    private async clearMergeState(): Promise<void> {
        const adapter = this.app.vault.adapter;
        for (const filename of [
            IsomorphicGit.MERGE_HEAD,
            IsomorphicGit.MERGE_MESSAGE,
            IsomorphicGit.MERGE_MODE,
        ]) {
            const path = this.getMergeStatePath(filename);
            if (await adapter.exists(path)) {
                await adapter.remove(path);
            }
        }
    }

    async updateUpstreamBranch(remoteBranch: string): Promise<void> {
        try {
            const [remote, branch] = splitRemoteBranch(remoteBranch);
            const branchInfo = await this.branchInfo();

            await this.wrapFS(
                git.push({
                    ...this.getRepo(),
                    remote: remote,
                    remoteRef: branch,
                })
            );

            await this.setConfig(
                `branch.${branchInfo.current}.merge`,
                `refs/heads/${branch}`
            );
        } finally {
            this.invalidateInfo();
        }
    }

    updateGitPath(_: string): Promise<void> {
        // isomorphic-git library has its own git client
        return Promise.resolve();
    }

    private async getCommittedFilesCount(oid: string): Promise<number> {
        const { commit } = await this.wrapFS(
            git.readCommit({ ...this.getRepo(), oid })
        );
        const parent = commit.parent[0];

        if (!parent) {
            return (
                await this.wrapFS(
                    git.listFiles({ ...this.getRepo(), ref: oid })
                )
            ).length;
        }

        return (await this.getFileChangesCount(parent, oid)).length;
    }

    async getFileChangesCount(
        commitHash1: string,
        commitHash2: string
    ): Promise<WalkDifference[]> {
        const [oid1, oid2] = await Promise.all(
            [commitHash1, commitHash2].map((ref) => this.resolveRef(ref))
        );
        const cached = this.changesCache.get(`${oid1}..${oid2}`);
        if (cached) return cached;
        const reverse = this.changesCache.get(`${oid2}..${oid1}`);
        if (reverse) {
            const swap = { A: "D", D: "A", M: "M" } as const;
            return reverse.map(({ path, type }) => ({
                path,
                type: swap[type],
            }));
        }
        const [tree1, tree2] = await Promise.all(
            [oid1!, oid2!].map((oid) => this.getCommitTree(oid))
        );
        const changes: WalkDifference[] = [];
        await this.diffTrees(tree1, tree2, "", changes);
        changes.sort((a, b) => (a.path < b.path ? -1 : 1));
        this.rememberChanges(oid1!, oid2!, changes);
        return changes;
    }

    private rememberChanges(
        from: string,
        to: string,
        changes: WalkDifference[]
    ): void {
        if (this.changesCache.size >= 50) {
            this.changesCache.delete(this.changesCache.keys().next().value!);
        }
        this.changesCache.set(`${from}..${to}`, changes);
    }

    private async getCommitTree(ref: string): Promise<string> {
        const oid = await this.resolveRef(ref);
        return (await git.readCommit({ ...this.getRepo(), oid })).commit.tree;
    }

    private async readTreeEntries(oid: string): Promise<TreeEntry[]> {
        return (await git.readTree({ ...this.getRepo(), oid })).tree;
    }

    /** File changes between two trees, reading only subtrees whose oids differ. */
    private async diffTrees(
        oldTree: string | undefined,
        newTree: string | undefined,
        prefix: string,
        changes: WalkDifference[]
    ): Promise<void> {
        if (oldTree === newTree) return;
        const [oldEntries, newEntries] = await Promise.all([
            oldTree ? this.readTreeEntries(oldTree) : [],
            newTree ? this.readTreeEntries(newTree) : [],
        ]);
        const oldByName = new Map(oldEntries.map((e) => [e.path, e]));
        const newByName = new Map(newEntries.map((e) => [e.path, e]));
        const names = new Set([...oldByName.keys(), ...newByName.keys()]);
        const subtrees: Promise<void>[] = [];
        for (const name of [...names].sort()) {
            const before = oldByName.get(name);
            const after = newByName.get(name);
            if (before?.oid === after?.oid && before?.type === after?.type) {
                continue;
            }
            const path = prefix + name;
            const oldSub = before?.type === "tree" ? before.oid : undefined;
            const newSub = after?.type === "tree" ? after.oid : undefined;
            if (oldSub || newSub) {
                subtrees.push(
                    this.diffTrees(oldSub, newSub, `${path}/`, changes)
                );
            }
            const oldBlob = before?.type === "blob" ? before.oid : undefined;
            const newBlob = after?.type === "blob" ? after.oid : undefined;
            if (oldBlob === newBlob) continue;
            changes.push({
                path,
                type:
                    oldBlob === undefined
                        ? "A"
                        : newBlob === undefined
                          ? "D"
                          : "M",
            });
        }
        await Promise.all(subtrees);
    }

    async walkDifference({
        walkers,
        dir: base,
    }: {
        walkers: Walker[];
        dir?: string;
    }): Promise<WalkDifference[]> {
        return this.wrapFS(
            typedWalk<WalkDifference>({
                ...this.getRepo(),
                trees: walkers,
                map: async function (
                    filepath,
                    [A, B]
                ): Promise<WalkDifference | null | undefined> {
                    if (!worthWalking(filepath, base)) {
                        return null;
                    }

                    const Atype = await A?.type();
                    const Btype = await B?.type();
                    if (Atype === "tree" || Btype === "tree") {
                        // Skip identical subtrees; the root must stay so walk returns an array.
                        if (filepath !== "." && Atype === Btype) {
                            const Aoid = await A?.oid();
                            if (
                                Aoid !== undefined &&
                                Aoid === (await B?.oid())
                            ) {
                                return null;
                            }
                        }
                        return;
                    }

                    // generate ids
                    const Aoid = await A?.oid();
                    const Boid = await B?.oid();

                    // determine modification type
                    let type: WalkDifference["type"] | "equal" = "equal";
                    if (Aoid !== Boid) {
                        type = "M";
                    }
                    if (Aoid === undefined) {
                        type = "A";
                    }
                    if (Boid === undefined) {
                        type = "D";
                    }

                    if (Aoid === undefined && Boid === undefined) {
                        console.log("Something weird happened:");
                        console.log(A);
                        console.log(B);
                    }
                    if (type === "equal") {
                        return;
                    }

                    return {
                        path: filepath,
                        type: type,
                    };
                },
            })
        );
    }

    protected override async getStagedForMessage(): Promise<
        Pick<Status, "staged" | "stagedOutsideVault">
    > {
        const staged = await this.getIndexChanges();
        return {
            staged: staged.map(({ path, type }) => ({
                path,
                vaultPath: this.getRelativeVaultPath(path),
                index: type,
                workingDir: " ",
            })),
            stagedOutsideVault: 0,
        };
    }

    /** Stage-0 index entries by path; gitlinks and conflicts are only flagged. */
    private async readIndexSnapshot(): Promise<IndexSnapshot> {
        const result = GitIndexManager.acquire(
            {
                fs: new FileSystem(this.fs),
                gitdir: this.getIndexGitdir(),
                cache: {},
            },
            (rawIndex: unknown) => {
                const index = rawIndex as GitIndexLike;
                const snapshot: IndexSnapshot = {
                    files: new Map(),
                    hasGitlinks: false,
                    hasConflicts: index.unmergedPaths.length > 0,
                };
                for (const [path, entry] of index.entriesMap) {
                    if (entry.mode === 0o160000) snapshot.hasGitlinks = true;
                    else
                        snapshot.files.set(path, {
                            oid: entry.oid,
                            mode: entry.mode,
                        });
                }
                return snapshot;
            }
        ) as Promise<IndexSnapshot>;
        return this.wrapFS(result);
    }

    /** Differences between HEAD and the index, from the cached HEAD tree. */
    private async getIndexChanges(
        head?: HeadSnapshot,
        index?: IndexSnapshot
    ): Promise<WalkDifference[]> {
        [head, index] = await Promise.all([
            head ?? this.getHeadSnapshot(),
            index ?? this.readIndexSnapshot(),
        ]);
        const changes: WalkDifference[] = [];
        for (const [path, { oid }] of index.files) {
            const headOid = head.files.get(path);
            if (headOid === undefined) changes.push({ path, type: "A" });
            else if (headOid !== oid) changes.push({ path, type: "M" });
        }
        for (const path of head.files.keys()) {
            if (!index.files.has(path)) changes.push({ path, type: "D" });
        }
        return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
    }

    async getStagedFiles(
        dir = "."
    ): Promise<(WalkDifference & { vaultPath: string })[]> {
        const res = await this.walkDifference({
            walkers: [git.TREE({ ref: "HEAD" }), git.STAGE()],
            dir,
        });
        return res.map((file) => {
            return {
                vaultPath: this.getRelativeVaultPath(file.path),
                path: file.path,
                type: file.type,
            };
        });
    }

    async getUnstagedFiles(base = "."): Promise<UnstagedFile[]> {
        let notice: Notice | undefined;
        const timeout = window.setTimeout(() => {
            notice = new Notice(
                "This takes longer: Getting status",
                this.noticeLength
            );
        }, 20000);
        try {
            const repo = this.getRepo();
            const res = await this.wrapFS(
                //Modified from `git.statusMatrix`
                typedWalk<UnstagedFile>({
                    ...repo,
                    trees: [git.WORKDIR(), git.STAGE()],
                    map: async function (
                        filepath,
                        [workdir, stage]
                    ): Promise<UnstagedFile | null | undefined> {
                        // Ignore ignored files, but only if they are not already tracked.
                        if (!stage && workdir) {
                            const isIgnored = await git.isIgnored({
                                ...repo,
                                filepath,
                            });
                            if (isIgnored) {
                                return null;
                            }
                        }
                        // match against base path
                        if (!worthWalking(filepath, base)) {
                            return null;
                        }
                        // Late filter against file names
                        // if (filter) {
                        //     if (!filter(filepath)) return;
                        // }

                        const [workdirType, stageType] = await Promise.all([
                            workdir && workdir.type(),
                            stage && stage.type(),
                        ]);

                        const isBlob = [workdirType, stageType].includes(
                            "blob"
                        );

                        // For now, bail on directories unless the file is also a blob in another tree
                        if (
                            (workdirType === "tree" ||
                                workdirType === "special") &&
                            !isBlob
                        )
                            return;

                        if (stageType === "commit") return null;
                        if (
                            (stageType === "tree" || stageType === "special") &&
                            !isBlob
                        )
                            return;

                        // Figure out the oids for files, using the staged oid for the working dir oid if the stats match.
                        const stageOid =
                            stageType === "blob"
                                ? await stage!.oid()
                                : undefined;
                        let workdirOid;
                        if (workdirType === "blob" && stageType !== "blob") {
                            // We don't actually NEED the sha. Any sha will do
                            workdirOid = "42";
                        } else if (workdirType === "blob") {
                            workdirOid = await workdir!.oid();
                        }
                        if (!workdirOid) {
                            return {
                                path: filepath,
                                type: "D",
                            };
                        }
                        if (!stageOid) {
                            return {
                                path: filepath,
                                type: "A",
                            };
                        }

                        if (workdirOid !== stageOid) {
                            return {
                                path: filepath,
                                type: "M",
                            };
                        }
                        return null;
                        // const entry = [undefined, headOid, workdirOid, stageOid];
                        // const result = entry.map(value => entry.indexOf(value));
                        // result.shift(); // remove leading undefined entry
                        // return [filepath, ...result];
                    },
                })
            );
            window.clearTimeout(timeout);
            notice?.hide();
            return res;
        } catch (error) {
            window.clearTimeout(timeout);
            notice?.hide();
            throw error;
        }
    }

    async getDiffString(
        filePath: string,
        stagedChanges = false,
        hash?: string
    ): Promise<string> {
        const vaultPath = this.getRelativeVaultPath(filePath);

        const map: TypedWalkerMap<Uint8Array> = async (file, [A]) => {
            if (filePath == file) {
                const oid = await A!.oid();
                const contents = await git.readBlob({
                    ...this.getRepo(),
                    oid: oid,
                });
                return contents.blob;
            }
            return undefined;
        };
        if (hash) {
            const commitContent = await readBlob({
                ...this.getRepo(),
                filepath: filePath,
                oid: hash,
            })
                .then((headBlob) => new TextDecoder().decode(headBlob.blob))
                .catch((err) => {
                    if (err instanceof git.Errors.NotFoundError)
                        return undefined;
                    throw err;
                });
            const commit = await git.readCommit({
                ...this.getRepo(),
                oid: hash,
            });

            const parentOid = commit.commit.parent.first();
            let previousContent: string | undefined;
            if (parentOid) {
                previousContent = await readBlob({
                    ...this.getRepo(),
                    filepath: filePath,
                    oid: parentOid,
                })
                    .then((headBlob) => new TextDecoder().decode(headBlob.blob))
                    .catch((err) => {
                        if (err instanceof git.Errors.NotFoundError)
                            return undefined;
                        throw err;
                    });
            }

            const diff = createPatch(
                vaultPath,
                previousContent ?? "",
                commitContent ?? ""
            );
            return diff;
        }

        const stagedBlob = (
            await typedWalk<Uint8Array>({
                ...this.getRepo(),
                trees: [git.STAGE()],
                map,
            })
        ).first();
        const stagedContent = new TextDecoder().decode(stagedBlob);

        if (stagedChanges) {
            const headContent = await this.resolveRef("HEAD")
                .then((oid) =>
                    readBlob({
                        ...this.getRepo(),
                        filepath: filePath,
                        oid: oid,
                    })
                )
                .then((headBlob) => new TextDecoder().decode(headBlob.blob))
                .catch((err) => {
                    if (err instanceof git.Errors.NotFoundError)
                        return undefined;
                    throw err;
                });

            const diff = createPatch(
                vaultPath,
                headContent ?? "",
                stagedContent
            );
            return diff;
        } else {
            let workdirContent: string;
            if (await this.app.vault.adapter.exists(vaultPath)) {
                workdirContent = await this.app.vault.adapter.read(vaultPath);
            } else {
                workdirContent = "";
            }

            const diff = createPatch(vaultPath, stagedContent, workdirContent);
            return diff;
        }
    }

    async show(
        commitHash: string,
        file: string,
        relativeToVault = true
    ): Promise<string> {
        const filepath = this.getRelativeRepoPath(file, relativeToVault);
        const { blob } = await readBlob({
            ...this.getRepo(),
            oid: commitHash,
            filepath,
        });
        return new TextDecoder().decode(blob);
    }

    async getLastCommitTime(): Promise<Date | undefined> {
        const repo = this.getRepo();
        const oid = await this.resolveRef("HEAD");
        const commit = await git.readCommit({ ...repo, oid: oid });
        const date = commit.commit.committer.timestamp;
        return new Date(date * 1000);
    }

    private getFileStatusResult(row: StatusRow): FileStatusResult {
        const statusKey = `${row[this.HEAD]}${row[this.WORKDIR]}${row[this.STAGE]}`;
        const status = this.status_mapping[statusKey];
        if (status === undefined) {
            throw new Error(`Unsupported status matrix row: ${statusKey}`);
        }
        // status will always be two characters
        return {
            index: status[0] == "?" ? "U" : (status[0] ?? " "),
            workingDir: status[1] == "?" ? "U" : (status[1] ?? " "),
            path: row[this.FILE],
            vaultPath: this.getRelativeVaultPath(row[this.FILE]),
        };
    }

    private async checkAuthorInfo(): Promise<void> {
        const name = await this.getConfig("user.name");
        const email = await this.getConfig("user.email");
        if (!name || !email) {
            throw Error(
                "Git author name and email are not set. Please set both fields in the settings."
            );
        }
    }

    private showNotice(message: string, infinity = true): Notice | undefined {
        if (!this.plugin.settings.disablePopups) {
            return new Notice(
                message,
                infinity ? this.noticeLength : undefined
            );
        }
        return undefined;
    }
}

type TypedWalkerMap<T> = (
    filename: string,
    entries: Array<WalkerEntry | null>
) => Promise<T | null | undefined>;

type TypedWalkOptions<T> = Omit<Parameters<typeof git.walk>[0], "map"> & {
    map: TypedWalkerMap<T>;
};

async function typedWalk<T>(options: TypedWalkOptions<T>): Promise<T[]> {
    const result: unknown = await git.walk(options);
    if (!Array.isArray(result)) {
        throw new TypeError("isomorphic-git walk returned a non-array result");
    }
    return result as T[];
}

function arrayBufferToAsyncIterator(
    buffer: ArrayBuffer
): AsyncIterableIterator<Uint8Array> {
    const iterator = [new Uint8Array(buffer)].values();
    return {
        next: () => Promise.resolve(iterator.next()),
        [Symbol.asyncIterator]() {
            return this;
        },
    };
}

async function asyncIteratorToArrayBuffer(
    iterator: AsyncIterableIterator<Uint8Array>
): Promise<ArrayBuffer> {
    const stream = new ReadableStream({
        async start(controller) {
            for await (const chunk of iterator) {
                controller.enqueue(chunk);
            }
            controller.close();
        },
    });

    const response = new Response(stream);
    return await response.arrayBuffer();
}

// If `buffer` starts with the gzip magic bytes (0x1f 0x8b), inflate it and
// return the decompressed bytes; otherwise return it unchanged. A valid git
// smart-HTTP response body never starts with those bytes (it begins with an
// ASCII pkt-line length or "PACK"), so this check is unambiguous. Keyed on the
// content rather than the `Content-Encoding` header because some platforms
// transparently inflate the body while leaving the header in place.
async function inflateIfGzipped(buffer: ArrayBuffer): Promise<ArrayBuffer> {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
        return buffer;
    }
    try {
        const stream = new Blob([buffer])
            .stream()
            .pipeThrough(new DecompressionStream("gzip"));
        return await new Response(stream).arrayBuffer();
    } catch {
        // If decompression is unavailable or fails, fall back to the original
        // bytes so behavior is no worse than before.
        return buffer;
    }
}

type WorkingFileStats = { ctimeMs: number; mtimeMs: number; size: number };

type HeadSnapshot = {
    commit: string;
    files: Map<string, string>;
    modes: Map<string, number>;
    dirs: Map<string, string>;
};

type IndexSnapshot = {
    files: Map<string, { oid: string; mode: number }>;
    hasGitlinks: boolean;
    hasConflicts: boolean;
};

// The parts of isomorphic-git's untyped GitIndex used by the fast status.
type GitIndexLike = {
    entriesMap: Map<
        string,
        {
            oid: string;
            mode: number;
            mtimeSeconds: number;
            mtimeNanoseconds: number;
            ctimeSeconds: number;
            size: number;
        }
    >;
    unmergedPaths: string[];
    insert(entry: {
        filepath: string;
        oid: string;
        stats: Record<string, number>;
    }): void;
};

/** Runs `worker` over a queue that may grow while running, `limit` at a time. */
async function runLimited<T>(
    queue: T[],
    limit: number,
    worker: (item: T) => Promise<void>
): Promise<void> {
    let next = 0;
    let active = 0;
    await new Promise<void>((resolve, reject) => {
        const pump = () => {
            if (next >= queue.length && active === 0) {
                resolve();
                return;
            }
            while (active < limit && next < queue.length) {
                const item = queue[next++]!;
                active++;
                worker(item).then(() => {
                    active--;
                    pump();
                }, reject);
            }
        };
        pump();
    });
}
