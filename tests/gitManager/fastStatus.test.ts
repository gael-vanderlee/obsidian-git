import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import { withCleanup } from "../helpers/cleanup";
import {
    createRepoWithMergeConflict,
    createRepoWithOrigin,
    type TestRepo,
} from "../helpers/gitRepo";
import { createIsomorphicGitManager } from "../helpers/isomorphicGit";
import type { IsomorphicGit } from "../../src/gitManager/isomorphicGit";
import type { FileStatusResult, Status } from "../../src/types";

function write(repo: TestRepo, filePath: string, content: string): void {
    const fullPath = path.join(repo.repoPath, filePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
}

function normalize(status: Status) {
    const files = (list: FileStatusResult[]) =>
        list
            .map((file) => `${file.index}${file.workingDir} ${file.path}`)
            .sort();
    return {
        all: files(status.all),
        changed: files(status.changed),
        staged: files(status.staged),
        conflicted: [...status.conflicted].sort(),
    };
}

async function statusBoth(manager: IsomorphicGit) {
    manager.useFastStatus = false;
    const reference = normalize(await manager.status());
    manager.useFastStatus = true;
    const fast = normalize(await manager.status());
    return { reference, fast };
}

/** Small deterministic PRNG so failures are reproducible. */
function random(seed: number) {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
    };
}

const PATHS = [
    "note.md",
    "a.md",
    "dir/b.md",
    "dir/deep/c.md",
    "dir/deep/d.png",
    ".obsidian/app.json",
    ".obsidian/plugins/p/main.js",
    ".obsidian/plugins/p/data.json",
    "dir/.hidden/e.md",
    ".trash/old.md",
    "build.log",
    ".gitignore",
];

describe("IsomorphicGit fast status", () => {
    it.each([
        ["external changes with a full scan before each status", "external"],
        [
            "changes made through Obsidian's adapter, without full scans",
            "adapter",
        ],
    ] as const)(
        "matches statusMatrix across random %s",
        async (_name, mode) => {
            for (let seed = 1; seed <= 12; seed++) {
                const rand = random(seed);
                const pick = <T>(items: T[]) =>
                    items[Math.floor(rand() * items.length)]!;
                const repo = withCleanup(await createRepoWithOrigin());
                const { manager, plugin } = createIsomorphicGitManager(
                    repo.repoPath
                );
                const adapter = plugin.app.vault.adapter;
                const isHidden = (file: string) =>
                    file.split("/").some((part) => part.startsWith("."));
                write(repo, ".gitignore", "*.log\n.trash/\n");
                await repo.git.add(".");
                await repo.git.commit("ignore");
                const sizes = new Map<string, number>();

                for (let step = 0; step < 14; step++) {
                    const file = pick(PATHS);
                    const action = pick([
                        "write",
                        "write",
                        "write",
                        "delete",
                        "stage",
                        "stageAll",
                        "commit",
                        "unstage",
                    ]);
                    const full = path.join(repo.repoPath, file);
                    if (action === "write") {
                        // Grow the file so same-second rewrites change the size.
                        const size = (sizes.get(file) ?? 0) + 1 + step;
                        sizes.set(file, size);
                        const content = "x".repeat(size) + "\n";
                        if (mode === "adapter" && isHidden(file)) {
                            await adapter.write(file, content);
                        } else {
                            write(repo, file, content);
                        }
                    } else if (action === "delete") {
                        if (mode === "adapter" && isHidden(file)) {
                            await adapter.remove(file);
                        } else {
                            rmSync(full, { force: true });
                        }
                    } else if (action === "stage") {
                        await repo.git
                            .raw(["add", "-A", "--", file])
                            .catch(() => {});
                    } else if (action === "stageAll") {
                        await repo.git.add(["-A"]);
                    } else if (action === "commit") {
                        await repo.git.add(["-A"]);
                        await repo.git
                            .commit(`step ${step}`, ["--allow-empty"])
                            .catch(() => {});
                    } else {
                        await repo.git
                            .raw(["reset", "-q", "--", file])
                            .catch(() => {});
                    }
                    if (mode === "external") manager.hiddenFiles.invalidate();
                    const { reference, fast } = await statusBoth(manager);
                    expect(
                        fast,
                        `seed ${seed} step ${step} ${action} ${file}`
                    ).toEqual(reference);
                }
            }
        },
        120_000
    );

    it("keeps reporting a same-size, same-second edit after the index is rewritten", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const { manager } = createIsomorphicGitManager(repo.repoPath);
        write(repo, "other.md", "other\n");
        write(repo, "same.md", "aaaa\n");
        await repo.git.add(".");
        await repo.git.commit("same");
        write(repo, "same.md", "bbbb\n");
        // Touch another tracked file so the next status refreshes and rewrites the index.
        write(repo, "other.md", "other\n");
        // The rewrite then happens in a later second than the edit.
        await new Promise((resolve) => setTimeout(resolve, 2100));

        expect(normalize(await manager.status()).changed).toEqual([
            " M same.md",
        ]);
        // Once the rewritten index is older than the edit's second, stats decide alone.
        await new Promise((resolve) => setTimeout(resolve, 2100));
        expect(normalize(await manager.status()).changed).toEqual([
            " M same.md",
        ]);
    });

    it("reports conflicts like statusMatrix", async () => {
        const repo = withCleanup(await createRepoWithMergeConflict());
        const { manager } = createIsomorphicGitManager(repo.repoPath);

        const { reference, fast } = await statusBoth(manager);

        expect(fast).toEqual(reference);
        expect(fast.conflicted).toEqual(["note.md"]);
    });

    it("only reads files whose stats changed", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        for (let i = 0; i < 20; i++) write(repo, `n/${i}.md`, `${i}\n`);
        write(repo, ".obsidian/plugins/p/main.js", "js\n");
        await repo.git.add(".");
        await repo.git.commit("many");
        const { manager, plugin } = createIsomorphicGitManager(repo.repoPath);
        await manager.status();
        // Let the index become older than the files' mtime second.
        await new Promise((resolve) => setTimeout(resolve, 2100));
        await manager.status();
        const readBinary = vi.spyOn(plugin.app.vault.adapter, "readBinary");
        write(repo, "n/3.md", "changed\n");

        const status = normalize(await manager.status());

        expect(status.changed).toEqual([" M n/3.md"]);
        const workTreeReads = readBinary.mock.calls
            .map(([p]) => p.replace(/^\/+/, ""))
            .filter((p) => !p.startsWith(".git"));
        expect(workTreeReads).toEqual(["n/3.md"]);
    });

    it("supports a repository in a vault subfolder", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        write(repo, ".obsidian/x.json", "{}\n");
        write(repo, "sub/y.md", "y\n");
        const basePath = path.basename(repo.repoPath);
        const { manager } = createIsomorphicGitManager(repo.repoPath, {
            vaultPath: repo.dir,
            basePath,
        });

        const { reference, fast } = await statusBoth(manager);

        expect(fast).toEqual(reference);
        expect(fast.changed).toContain("UU .obsidian/x.json");
    });
});

describe("IsomorphicGit commit diff", () => {
    it("matches git diff --name-status between random commits", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const { manager } = createIsomorphicGitManager(repo.repoPath);
        const rand = random(7);
        const pick = <T>(items: T[]) =>
            items[Math.floor(rand() * items.length)]!;
        const files = [
            "a.md",
            "d/b.md",
            "d/e/c.md",
            "x/y/z.md",
            "t",
            "t2/f.md",
        ];
        const commits = [await repo.head()];
        for (let i = 0; i < 25; i++) {
            const file = pick(files);
            const full = path.join(repo.repoPath, file);
            if (rand() < 0.3) {
                rmSync(full, { recursive: true, force: true });
            } else if (file === "t" && rand() < 0.5) {
                // Replace a file with a folder of the same name.
                rmSync(full, { recursive: true, force: true });
                write(repo, "t/inner.md", `${i}\n`);
            } else {
                rmSync(full, { recursive: true, force: true });
                write(repo, file, `${i}\n`);
            }
            await repo.git.add(["-A"]);
            await repo.git.commit(`c${i}`, ["--allow-empty"]);
            commits.push(await repo.head());
        }
        for (let i = 0; i < 30; i++) {
            const from = pick(commits);
            const to = pick(commits);
            const expected = (
                await repo.raw([
                    "diff",
                    "--no-renames",
                    "--name-status",
                    from,
                    to,
                ])
            )
                .split("\n")
                .filter(Boolean)
                .map((line) => line.replace("\t", " "))
                .sort();
            const actual = (await manager.getFileChangesCount(from, to))
                .map((change) => `${change.type} ${change.path}`)
                .sort();
            expect(actual, `${from}..${to}`).toEqual(expected);
        }
    }, 60_000);
});

describe("IsomorphicGit incremental commit tree", () => {
    it("builds the same tree as git write-tree across random commits", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const { manager, plugin } = createIsomorphicGitManager(repo.repoPath);
        plugin.localStorage = {
            getHostname: () => null,
        } as unknown as typeof plugin.localStorage;
        plugin.settings.commitDateFormat = "YYYY";
        const commitSpy = vi.spyOn(git, "commit");
        const rand = random(11);
        const pick = <T>(items: T[]) =>
            items[Math.floor(rand() * items.length)]!;
        const files = [
            "a.md",
            "d/b.md",
            "d/e/c.md",
            "d/e/f/g.md",
            "x/y/z.md",
            ".obsidian/p/main.js",
            "run.sh",
        ];
        for (let i = 0; i < 30; i++) {
            for (let n = 0; n < 1 + Math.floor(rand() * 3); n++) {
                const file = pick(files);
                const action = rand();
                if (action < 0.25) {
                    rmSync(path.join(repo.repoPath, file), { force: true });
                } else if (action < 0.35 && path.dirname(file) !== ".") {
                    rmSync(path.join(repo.repoPath, path.dirname(file)), {
                        recursive: true,
                        force: true,
                    });
                } else {
                    write(repo, file, `${i} ${n}\n`);
                }
            }
            if (rand() < 0.3) {
                write(repo, "run.sh", `#!/bin/sh\necho ${i}\n`);
                await repo
                    .raw(["update-index", "--add", "--chmod=+x", "run.sh"])
                    .catch(() => {});
            }
            await repo.git.add(["-A"]);
            const expectedTree = await repo.raw(["write-tree"]);

            await manager.commit({ message: `commit ${i}` });

            expect(
                await repo.raw(["rev-parse", "HEAD^{tree}"]),
                `commit ${i}`
            ).toBe(expectedTree);
        }
        await repo.raw(["fsck", "--full", "--strict"]);
        const withTree = commitSpy.mock.calls.filter(([args]) => args.tree);
        expect(withTree.length).toBe(commitSpy.mock.calls.length);
    }, 60_000);
});

describe("IsomorphicGit hidden file tracking", () => {
    async function setupTracked() {
        const repo = withCleanup(await createRepoWithOrigin());
        write(repo, ".obsidian/plugins/p/data.json", "{}\n");
        write(repo, ".obsidian/app.json", "{}\n");
        await repo.git.add(".");
        await repo.git.commit("hidden");
        const context = createIsomorphicGitManager(repo.repoPath);
        await context.manager.status();
        return { repo, ...context };
    }

    it("sees adapter writes without scanning again", async () => {
        const { manager, plugin } = await setupTracked();
        const adapter = plugin.app.vault.adapter;
        const list = vi.spyOn(adapter, "list");

        await adapter.write(".obsidian/plugins/p/data.json", '{"a":1}\n');
        await adapter.write(".obsidian/new.json", "{}\n");
        await adapter.remove(".obsidian/app.json");
        const status = normalize(await manager.status());

        expect(list).not.toHaveBeenCalled();
        expect(status.changed).toEqual([
            " D .obsidian/app.json",
            " M .obsidian/plugins/p/data.json",
            "UU .obsidian/new.json",
        ]);
    });

    it("sees external changes after a scheduled full scan", async () => {
        const { repo, manager } = await setupTracked();
        // Leave the same-second window, where files are always re-hashed.
        await new Promise((resolve) => setTimeout(resolve, 2100));
        await manager.status();
        write(repo, ".obsidian/app.json", '{"external":true}\n');

        expect(normalize(await manager.status()).changed).toEqual([]);

        manager.hiddenFiles.scheduleFullScan();
        expect(normalize(await manager.status()).changed).toEqual([
            " M .obsidian/app.json",
        ]);
    });

    it("rescans when a hidden folder is renamed through the adapter", async () => {
        const { manager, plugin } = await setupTracked();

        await plugin.app.vault.adapter.rename(
            ".obsidian/plugins/p",
            ".obsidian/plugins/q"
        );
        const status = normalize(await manager.status());

        expect(status.changed).toEqual([
            " D .obsidian/plugins/p/data.json",
            "UU .obsidian/plugins/q/data.json",
        ]);
    });

    it("restores the adapter on unload", async () => {
        const { manager, plugin } = await setupTracked();
        const adapter = plugin.app.vault.adapter as unknown as Record<
            string,
            unknown
        >;
        expect(manager.hiddenFiles.installed).toBe(true);
        const wrapped = adapter.write;

        manager.unload();

        expect(manager.hiddenFiles.installed).toBe(false);
        expect(adapter.write).not.toBe(wrapped);
    });
});

describe("IsomorphicGit index concurrency", () => {
    it("does not drop a file staged while a status is running", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        write(repo, "slow.md", "slow\n");
        await repo.git.add(".");
        await repo.git.commit("slow");
        const { manager, plugin } = createIsomorphicGitManager(repo.repoPath);
        await manager.status();
        await new Promise((resolve) => setTimeout(resolve, 2100));
        // Same content, new mtime: status re-hashes it and refreshes the index.
        write(repo, "slow.md", "slow\n");
        write(repo, "new.md", "new\n");
        const adapter = plugin.app.vault.adapter;
        const readBinary = adapter.readBinary.bind(adapter);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let reached!: () => void;
        const reachedSlow = new Promise<void>((resolve) => (reached = resolve));
        vi.spyOn(adapter, "readBinary").mockImplementation(
            async (p: string) => {
                if (p.endsWith("slow.md")) {
                    reached();
                    await gate;
                }
                return readBinary(p);
            }
        );

        const status = manager.status();
        await reachedSlow;
        // Stage while the status still holds its view of the index.
        const stage = manager.stage("new.md", false);
        await Promise.race([
            stage,
            new Promise((resolve) => setTimeout(resolve, 500)),
        ]);
        release();
        await Promise.all([status, stage]);

        expect(await repo.raw(["ls-files"])).toContain("new.md");
    });
});

describe("IsomorphicGit nested repositories", () => {
    it("never reports or commits files inside nested .git folders", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        write(
            repo,
            ".obsidian/plugins/p/.git/config",
            "[remote]\n\turl = https://user:SECRET@example.com/x.git\n"
        );
        write(repo, "sub/.git/HEAD", "ref: refs/heads/main\n");
        write(repo, "sub/note.md", "note\n");
        const { manager } = createIsomorphicGitManager(repo.repoPath);

        const status = normalize(await manager.status());

        expect(status.changed.join("\n")).not.toContain(".git/");
        expect(status.changed).toContain("UU sub/note.md");

        await manager.commitAll({ message: "all" });
        expect(await repo.raw(["ls-files"])).not.toContain(".git/");
    });

    it("ignores files inside a submodule path", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const head = await repo.head();
        await repo.raw([
            "update-index",
            "--add",
            "--cacheinfo",
            `160000,${head},sub`,
        ]);
        await repo.git.commit("add submodule");
        write(repo, "sub/file.md", "inside the submodule\n");
        const { manager } = createIsomorphicGitManager(repo.repoPath);

        const status = normalize(await manager.status());

        expect(status.all).toEqual([]);
    });
});
