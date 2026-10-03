import { randomBytes } from "crypto";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitActions } from "../../src/gitActions";
import { withCleanup } from "../helpers/cleanup";
import {
    nodeRequestUrl,
    startGitHttpServer,
    type GitHttpServer,
} from "../helpers/gitHttpServer";
import { createRepoWithOrigin, type TestRepo } from "../helpers/gitRepo";
import { createIsomorphicGitManager } from "../helpers/isomorphicGit";

vi.mock("obsidian", async (importOriginal) => ({
    ...(await importOriginal<typeof import("obsidian")>()),
    requestUrl: (request: Parameters<typeof nodeRequestUrl>[0]) =>
        nodeRequestUrl(request),
}));

let server: GitHttpServer | undefined;

afterEach(async () => {
    await server?.close();
    server = undefined;
});

async function setup(
    options: {
        credentials?: { username: string; password: string };
        requireDiscovery?: boolean;
    } = {}
) {
    const repo = withCleanup(await createRepoWithOrigin());
    server = await startGitHttpServer(repo.dir, options);
    await repo.raw(["remote", "set-url", "origin", `${server.url}/remote.git`]);
    const context = createIsomorphicGitManager(repo.repoPath);
    const credentials = options.credentials ?? {
        username: "user",
        password: "token",
    };
    context.plugin.localStorage = {
        ...context.plugin.localStorage,
        getUsername: () => credentials.username,
        getPassword: () => credentials.password,
    } as typeof context.plugin.localStorage;
    return { repo, server, ...context };
}

function writeFile(repo: TestRepo, filePath: string, content: string): void {
    const fullPath = path.join(repo.repoPath, filePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
}

async function remoteHead(repo: TestRepo): Promise<string> {
    return (await simpleGit(repo.remotePath).raw(["rev-parse", "main"])).trim();
}

async function fsckRemote(repo: TestRepo): Promise<void> {
    await simpleGit(repo.remotePath).raw(["fsck", "--full", "--strict"]);
}

/** Pushes a commit to the remote from a second clone. */
async function pushFromElsewhere(
    repo: TestRepo,
    filePath: string,
    content: string
): Promise<string> {
    const other = path.join(repo.dir, "other");
    rmSync(other, { recursive: true, force: true });
    await simpleGit(repo.dir).clone(repo.remotePath, other);
    const git = simpleGit(other);
    await git.addConfig("user.email", "other@example.com");
    await git.addConfig("user.name", "Other");
    const fullPath = path.join(other, filePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
    await git.add(filePath);
    await git.commit("other change");
    await git.push("origin", "main");
    return (await git.revparse(["HEAD"])).trim();
}

const receivePackOnly = (requests: string[]) =>
    requests.every((request) => !request.includes("upload-pack"));

describe("IsomorphicGit fast push", () => {
    it("pushes new commits without the library and keeps the remote consistent", async () => {
        const { repo, server, manager } = await setup();
        writeFile(repo, "notes/deep/a.md", "a\n");
        writeFile(repo, "notes/b.md", "b\n");
        await repo.git.add(".");
        await repo.git.commit("first");
        writeFile(repo, "notes/deep/a.md", "a2\n");
        repo.remove("note.md");
        await repo.git.add(["-A"]);
        await repo.git.commit("second");
        const pushSpy = vi.spyOn(
            (await import("isomorphic-git")).default,
            "push"
        );

        const result = await manager.push();

        expect(result).toEqual({ status: "pushed", files: 3 });
        expect(pushSpy).not.toHaveBeenCalled();
        expect(await remoteHead(repo)).toBe(await repo.head());
        await fsckRemote(repo);
        expect(await repo.raw(["rev-parse", "origin/main"])).toBe(
            await repo.head()
        );
        expect(server.requests).toEqual([
            "GET /remote.git/info/refs?service=git-receive-pack",
            "POST /remote.git/git-receive-pack",
        ]);
    });

    it("counts files of a single commit, including deletions", async () => {
        const { repo, manager } = await setup();
        writeFile(repo, "dir/x.md", "x\n");
        await repo.git.add(".");
        await repo.git.commit("add dir");
        await repo.git.push();
        repo.remove("dir/x.md");
        writeFile(repo, "new.md", "new\n");
        await repo.git.add(["-A"]);
        await repo.git.commit("delete and add");

        await expect(manager.push()).resolves.toEqual({
            status: "pushed",
            files: 2,
        });
        await fsckRemote(repo);
    });

    it("skips fetching in pull when the remote did not move", async () => {
        const { repo, server, manager } = await setup();
        await repo.appendAndCommit("note.md", "local\n", "local");

        await expect(manager.pull()).resolves.toEqual({
            status: "up-to-date",
        });
        expect(receivePackOnly(server.requests)).toBe(true);
    });

    it("fetches and merges when the remote moved, then fast pushes the merge", async () => {
        const { repo, server, manager, plugin } = await setup();
        plugin.settings.mergeStrategy = "none";
        const theirs = await pushFromElsewhere(repo, "other/file.md", "o\n");
        writeFile(repo, "mine.md", "mine\n");
        await repo.git.add(".");
        await repo.git.commit("mine");

        const pull = await manager.pull();
        expect(pull.status).toBe("updated");
        expect(server.requests.some((r) => r.includes("upload-pack"))).toBe(
            true
        );
        const parents = (await repo.raw(["log", "-1", "--format=%P"])).split(
            " "
        );
        expect(parents).toContain(theirs);

        const libraryPush = vi.spyOn(
            (await import("isomorphic-git")).default,
            "push"
        );
        server.requests.length = 0;
        await expect(manager.push()).resolves.toMatchObject({
            status: "pushed",
        });
        expect(libraryPush).not.toHaveBeenCalled();
        expect(receivePackOnly(server.requests)).toBe(true);
        expect(await remoteHead(repo)).toBe(await repo.head());
        await fsckRemote(repo);
    });

    it("falls back to the regular push when the remote moved after the probe", async () => {
        const { repo, manager } = await setup();
        await repo.appendAndCommit("note.md", "local\n", "local");
        await expect(manager.pull()).resolves.toEqual({
            status: "up-to-date",
        });
        await pushFromElsewhere(repo, "race.md", "race\n");

        await expect(manager.push()).rejects.toThrow();
        expect(await remoteHead(repo)).not.toBe(await repo.head());
        await fsckRemote(repo);
    });

    it("sends credentials as basic auth", async () => {
        const credentials = { username: "me", password: "secret" };
        const { repo, manager } = await setup({ credentials });
        await repo.appendAndCommit("note.md", "local\n", "local");

        await expect(manager.push()).resolves.toEqual({
            status: "pushed",
            files: 1,
        });
        expect(await remoteHead(repo)).toBe(await repo.head());
    });

    it("works from a shallow clone", async () => {
        const { repo, server } = await setup();
        await repo.appendAndCommit("note.md", "two\n", "two");
        await repo.git.push();
        const shallowPath = path.join(repo.dir, "shallow");
        await simpleGit(repo.dir).clone(
            `file://${repo.remotePath}`,
            shallowPath,
            ["--depth", "1"]
        );
        const shallow = simpleGit(shallowPath);
        await shallow.addConfig("user.email", "s@example.com");
        await shallow.addConfig("user.name", "Shallow");
        await shallow.remote(["set-url", "origin", `${server.url}/remote.git`]);
        writeFileSync(path.join(shallowPath, "s.md"), "s\n");
        await shallow.add("s.md");
        await shallow.commit("from shallow");
        const { manager, plugin } = createIsomorphicGitManager(shallowPath);
        plugin.localStorage = {
            getUsername: () => "user",
            getPassword: () => "token",
        } as unknown as typeof plugin.localStorage;
        server.requests.length = 0;

        await expect(manager.pull()).resolves.toEqual({
            status: "up-to-date",
        });
        await expect(manager.push()).resolves.toEqual({
            status: "pushed",
            files: 1,
        });
        expect(receivePackOnly(server.requests)).toBe(true);
        expect(await remoteHead(repo)).toBe(
            (await shallow.revparse(["HEAD"])).trim()
        );
        await fsckRemote(repo);
    });

    it("reports up-to-date when there is nothing to push", async () => {
        const { manager } = await setup();

        await expect(manager.push()).resolves.toEqual({
            status: "up-to-date",
        });
    });
});

describe("commit-and-sync with a direct push", () => {
    async function setupSync(options: { requireDiscovery?: boolean } = {}) {
        const context = await setup(options);
        const { plugin, manager } = context;
        Object.assign(plugin.settings, {
            pullBeforePush: true,
            syncMethod: "merge",
            disablePush: false,
            mergeStrategy: "none",
            commitDateFormat: "YYYY",
        });
        plugin.localStorage = {
            ...plugin.localStorage,
            getHostname: () => null,
        } as typeof plugin.localStorage;
        plugin.updateCachedStatus = () => manager.status();
        plugin.isAllInitialized = vi.fn().mockResolvedValue(true);
        plugin.tools = {
            hasTooBigFiles: vi.fn().mockResolvedValue(false),
        } as unknown as typeof plugin.tools;
        plugin.displayMessage = vi.fn();
        const sync = () =>
            new GitActions(plugin).commitAndSync({
                fromAutoBackup: false,
                commitMessage: "sync",
            });
        return { ...context, sync };
    }

    it("pushes in a single request when the remote did not move", async () => {
        const { repo, server, sync } = await setupSync();
        writeFile(repo, "note.md", "edited\n");

        await expect(sync()).resolves.toMatchObject({
            status: "success",
            value: { status: "synced" },
        });

        expect(server.requests).toEqual(["POST /remote.git/git-receive-pack"]);
        expect(await remoteHead(repo)).toBe(await repo.head());
        await fsckRemote(repo);
    });

    it("pulls and pushes normally when the remote moved", async () => {
        const { repo, server, sync } = await setupSync();
        const theirs = await pushFromElsewhere(repo, "theirs.md", "t\n");
        writeFile(repo, "note.md", "edited\n");

        await expect(sync()).resolves.toMatchObject({
            status: "success",
            value: { status: "synced" },
        });

        expect(server.requests[0]).toBe("POST /remote.git/git-receive-pack");
        expect(server.requests.some((r) => r.includes("upload-pack"))).toBe(
            true
        );
        expect(await remoteHead(repo)).toBe(await repo.head());
        expect(
            (await repo.raw(["log", "-1", "--format=%P"])).split(" ")
        ).toContain(theirs);
        await fsckRemote(repo);
    });

    it("checks the remote first for large pushes and builds the pack once", async () => {
        const { repo, server, sync } = await setupSync();
        // Random bytes don't compress, so the pack stays over the limit.
        const big = randomBytes(400_000).toString("base64");
        writeFile(repo, "attachment.txt", big);
        const isoGit = (await import("isomorphic-git")).default;
        const packObjects = vi.spyOn(isoGit, "packObjects");

        await expect(sync()).resolves.toMatchObject({
            value: { status: "synced" },
        });

        expect(server.requests).toEqual([
            "GET /remote.git/info/refs?service=git-receive-pack",
            "POST /remote.git/git-receive-pack",
        ]);
        expect(packObjects).toHaveBeenCalledTimes(1);
        expect(await remoteHead(repo)).toBe(await repo.head());
        await fsckRemote(repo);
    });

    it("syncs normally when the direct push attempt throws", async () => {
        const { repo, manager, sync } = await setupSync();
        writeFile(repo, "note.md", "edited\n");
        vi.spyOn(manager, "pushIfRemoteUnchanged").mockRejectedValue(
            new Error("boom")
        );

        await expect(sync()).resolves.toMatchObject({
            value: { status: "synced" },
        });
        expect(await remoteHead(repo)).toBe(await repo.head());
    });

    it("stops pushing directly when the server needs ref discovery", async () => {
        const { repo, server, sync } = await setupSync({
            requireDiscovery: true,
        });
        writeFile(repo, "note.md", "first\n");
        await expect(sync()).resolves.toMatchObject({
            value: { status: "synced" },
        });
        expect(await remoteHead(repo)).toBe(await repo.head());

        server.requests.length = 0;
        writeFile(repo, "note.md", "second\n");
        await expect(sync()).resolves.toMatchObject({
            value: { status: "synced" },
        });

        expect(server.requests[0]).toBe(
            "GET /remote.git/info/refs?service=git-receive-pack"
        );
        expect(await remoteHead(repo)).toBe(await repo.head());
        await fsckRemote(repo);
    });
});
