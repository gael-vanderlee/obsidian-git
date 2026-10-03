import { readdirSync, statSync } from "fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "fs/promises";
import path from "path";
import { vi } from "vitest";
import { IsomorphicGit } from "../../src/gitManager/isomorphicGit";
import { createFakePlugin, type FakePlugin } from "./createFakePlugin";

export type IsomorphicGitTestContext = {
    manager: IsomorphicGit;
    plugin: FakePlugin;
    setPluginState: ReturnType<typeof vi.fn>;
    updateCachedStatus: ReturnType<typeof vi.fn>;
};

function createNodeVault(root: string) {
    const resolve = (vaultPath: string): string =>
        path.join(root, vaultPath.replace(/^\/+/, ""));
    const relative = (vaultPath: string, name: string): string =>
        vaultPath === "/" || vaultPath === "" ? name : `${vaultPath}/${name}`;

    const adapter = {
        exists: async (vaultPath: string) => {
            try {
                await stat(resolve(vaultPath));
                return true;
            } catch {
                return false;
            }
        },
        read: (vaultPath: string) => readFile(resolve(vaultPath), "utf8"),
        readBinary: async (vaultPath: string) => {
            const data = await readFile(resolve(vaultPath));
            return data.buffer.slice(
                data.byteOffset,
                data.byteOffset + data.byteLength
            );
        },
        write: async (vaultPath: string, data: string) => {
            await mkdir(path.dirname(resolve(vaultPath)), { recursive: true });
            await writeFile(resolve(vaultPath), data);
        },
        writeBinary: async (vaultPath: string, data: ArrayBuffer) => {
            await mkdir(path.dirname(resolve(vaultPath)), { recursive: true });
            await writeFile(resolve(vaultPath), new Uint8Array(data));
        },
        stat: async (vaultPath: string) => {
            try {
                const result = await stat(resolve(vaultPath));
                return {
                    type: result.isDirectory() ? "folder" : "file",
                    ctime: result.ctimeMs,
                    mtime: result.mtimeMs,
                    size: result.size,
                };
            } catch {
                return null;
            }
        },
        list: async (vaultPath: string) => {
            const entries = await readdir(resolve(vaultPath), {
                withFileTypes: true,
            });
            return {
                files: entries
                    .filter((entry) => entry.isFile())
                    .map((entry) => relative(vaultPath, entry.name)),
                folders: entries
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => relative(vaultPath, entry.name)),
            };
        },
        mkdir: (vaultPath: string) =>
            mkdir(resolve(vaultPath), { recursive: true }),
        rmdir: (vaultPath: string, recursive = false) =>
            rm(resolve(vaultPath), { recursive, force: true }),
        remove: (vaultPath: string) =>
            rm(resolve(vaultPath), { recursive: true, force: true }),
    };

    // Mirrors Obsidian's in-memory file index, which skips dot-files and dot-folders.
    const loadedFiles = () => {
        const files: {
            path: string;
            stat: { ctime: number; mtime: number; size: number };
        }[] = [];
        const folders: { path: string; children: unknown[] }[] = [
            { path: "/", children: [] },
        ];
        const visit = (vaultPath: string) => {
            for (const entry of readdirSync(resolve(vaultPath), {
                withFileTypes: true,
            })) {
                if (entry.name.startsWith(".")) continue;
                const child = relative(vaultPath, entry.name);
                if (entry.isDirectory()) {
                    folders.push({ path: child, children: [] });
                    visit(child);
                } else if (entry.isFile()) {
                    const result = statSync(resolve(child));
                    files.push({
                        path: child,
                        stat: {
                            ctime: result.ctimeMs,
                            mtime: result.mtimeMs,
                            size: result.size,
                        },
                    });
                }
            }
        };
        visit("/");
        return { files, folders };
    };

    return {
        adapter,
        getFiles: () => loadedFiles().files,
        getAllLoadedFiles: () => {
            const { files, folders } = loadedFiles();
            return [...folders, ...files];
        },
        create: adapter.write,
        createBinary: adapter.writeBinary,
        createFolder: (vaultPath: string) =>
            mkdir(resolve(vaultPath), { recursive: true }),
        getAbstractFileByPath: () => null,
        getFolderByPath: () => null,
    };
}

export function createIsomorphicGitManager(
    repoPath: string,
    options: { vaultPath?: string; basePath?: string } = {}
): IsomorphicGitTestContext {
    const plugin = createFakePlugin();
    plugin.settings = {
        basePath: options.basePath ?? "",
        gitDir: "",
        mergeStrategy: "none",
        listChangedFilesInMessageBody: false,
    } as FakePlugin["settings"];

    const setPluginState = vi.fn();
    const updateCachedStatus = vi.fn();
    plugin.localStorage = {
        getHostname: vi.fn().mockReturnValue(null),
    } as unknown as FakePlugin["localStorage"];
    plugin.setPluginState = setPluginState;
    plugin.updateCachedStatus = updateCachedStatus;
    (plugin.app as unknown as { vault: unknown }).vault = createNodeVault(
        options.vaultPath ?? repoPath
    );

    const manager = new IsomorphicGit(plugin);
    plugin.gitManager = manager;
    return {
        manager,
        plugin,
        setPluginState,
        updateCachedStatus,
    };
}
