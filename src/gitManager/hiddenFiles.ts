import type { DataAdapter } from "obsidian";

export type HiddenFileStats = {
    ctimeMs: number;
    mtimeMs: number;
    size: number;
};

// Adapter methods that change files, with the indexes of their path arguments.
// mkdir is left out: an empty folder holds nothing to track, and files written
// into it later are recorded by write.
const MUTATORS: Record<string, number[]> = {
    write: [0],
    writeBinary: [0],
    append: [0],
    appendBinary: [0],
    process: [0],
    remove: [0],
    trashSystem: [0],
    trashLocal: [0],
    rmdir: [0],
    rename: [0, 1],
    copy: [0, 1],
};

const SAFETY_SCAN_INTERVAL_MS = 30 * 60 * 1000;

function isHiddenPath(path: string): boolean {
    return path.split("/").some((part) => part.startsWith("."));
}

/**
 * Keeps the stats of hidden files (which Obsidian does not index) without
 * scanning them for every status. Writes made through the vault adapter are
 * recorded as they happen; a full scan runs on first use, when the app comes
 * back to the foreground and every 30 minutes, to catch changes made by
 * other apps.
 */
export class HiddenFileTracker {
    private snapshot?: Map<string, HiddenFileStats>;
    private readonly dirty = new Set<string>();
    private needsFullScan = true;
    private scanning?: Promise<void>;
    private rescanRequested = false;
    private cleanups: (() => void)[] = [];

    constructor(
        private readonly adapter: DataAdapter,
        private readonly scan: () => Promise<Map<string, HiddenFileStats>>,
        private readonly isExcluded: (path: string) => boolean,
        private readonly log: (...data: unknown[]) => void
    ) {}

    get installed(): boolean {
        return this.cleanups.length > 0;
    }

    install(): void {
        if (this.installed) return;
        const adapter = this.adapter as unknown as Record<string, unknown>;
        let active = true;
        for (const [name, pathArgs] of Object.entries(MUTATORS)) {
            const original = adapter[name];
            if (typeof original !== "function") continue;
            const record = (args: unknown[]) => {
                if (!active) return;
                for (const index of pathArgs) {
                    const path = args[index];
                    if (typeof path === "string") this.recordChange(path);
                }
            };
            const wrapper = function (this: unknown, ...args: unknown[]) {
                record(args);
                return (original as (...a: unknown[]) => unknown).apply(
                    this,
                    args
                );
            };
            adapter[name] = wrapper;
            this.cleanups.push(() => {
                // Leave another plugin's later wrapper in place; ours goes inert.
                if (adapter[name] === wrapper) adapter[name] = original;
            });
        }
        this.cleanups.push(() => {
            active = false;
        });

        const onVisibility = () => {
            if (activeDocument.visibilityState === "visible") {
                this.scheduleFullScan();
            }
        };
        activeDocument.addEventListener("visibilitychange", onVisibility);
        this.cleanups.push(() =>
            activeDocument.removeEventListener("visibilitychange", onVisibility)
        );
        const interval = window.setInterval(
            () => this.scheduleFullScan(),
            SAFETY_SCAN_INTERVAL_MS
        );
        this.cleanups.push(() => window.clearInterval(interval));
    }

    /** Installs tracking and runs the first full scan in the background shortly after. */
    start(delayMs: number): void {
        if (this.installed) return;
        this.install();
        const timeout = window.setTimeout(() => {
            if (!this.snapshot && !this.scanning) this.scheduleFullScan();
        }, delayMs);
        this.cleanups.push(() => window.clearTimeout(timeout));
    }

    uninstall(): void {
        for (const cleanup of this.cleanups.splice(0)) cleanup();
        this.snapshot = undefined;
        this.needsFullScan = true;
        this.dirty.clear();
    }

    private recordChange(rawPath: string): void {
        const path = rawPath.replace(/^\/+|\/+$/g, "");
        if (isHiddenPath(path) && !this.isExcluded(path)) this.dirty.add(path);
    }

    /** Marks the snapshot stale and refreshes it in the background. */
    scheduleFullScan(): void {
        this.needsFullScan = true;
        if (this.scanning) {
            this.rescanRequested = true;
            return;
        }
        this.fullScan().catch((error) =>
            this.log("Background hidden file scan failed", error)
        );
    }

    /** Marks the snapshot stale; the next getFiles() scans before returning. */
    invalidate(): void {
        this.needsFullScan = true;
    }

    private fullScan(): Promise<void> {
        this.scanning ??= (async () => {
            try {
                do {
                    this.rescanRequested = false;
                    this.needsFullScan = false;
                    // Changes recorded from here on are re-checked afterwards.
                    this.dirty.clear();
                    try {
                        this.snapshot = await this.scan();
                    } catch (error) {
                        this.needsFullScan = true;
                        throw error;
                    }
                } while (this.rescanRequested);
            } finally {
                this.scanning = undefined;
            }
        })();
        return this.scanning;
    }

    /** Current stats of all hidden files, by vault path. */
    async getFiles(): Promise<Map<string, HiddenFileStats>> {
        if (this.scanning) await this.scanning;
        if (!this.snapshot || this.needsFullScan) await this.fullScan();
        const snapshot = this.snapshot!;
        const paths = [...this.dirty];
        this.dirty.clear();
        let folderChanged = false;
        await Promise.all(
            paths.map(async (path) => {
                const stat = await this.adapter.stat(path);
                if (!stat) {
                    snapshot.delete(path);
                    for (const file of [...snapshot.keys()]) {
                        if (file.startsWith(`${path}/`)) snapshot.delete(file);
                    }
                } else if (stat.type === "folder") {
                    folderChanged = true;
                } else {
                    snapshot.set(path, {
                        ctimeMs: stat.ctime,
                        mtimeMs: stat.mtime,
                        size: stat.size,
                    });
                }
            })
        );
        if (folderChanged) {
            // A folder appeared or moved: its contents are unknown.
            this.needsFullScan = true;
            await this.fullScan();
        }
        return this.snapshot!;
    }
}
