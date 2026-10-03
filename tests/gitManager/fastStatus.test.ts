import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
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
    it("matches statusMatrix across random changes", async () => {
        for (let seed = 1; seed <= 12; seed++) {
            const rand = random(seed);
            const pick = <T>(items: T[]) =>
                items[Math.floor(rand() * items.length)]!;
            const repo = withCleanup(await createRepoWithOrigin());
            const { manager } = createIsomorphicGitManager(repo.repoPath);
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
                    write(repo, file, "x".repeat(size) + "\n");
                } else if (action === "delete") {
                    rmSync(full, { force: true });
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
                const { reference, fast } = await statusBoth(manager);
                expect(
                    fast,
                    `seed ${seed} step ${step} ${action} ${file}`
                ).toEqual(reference);
            }
        }
    }, 120_000);

    it("detects a same-size edit in the same second as the index write", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const { manager } = createIsomorphicGitManager(repo.repoPath);
        write(repo, "same.md", "aaaa\n");
        await repo.git.add(".");
        await repo.git.commit("same");
        write(repo, "same.md", "bbbb\n");

        const status = normalize(await manager.status());

        expect(status.changed).toEqual([" M same.md"]);
        expect(await repo.statusPorcelain()).toContain("M same.md");
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
        await new Promise((resolve) => setTimeout(resolve, 1100));
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
