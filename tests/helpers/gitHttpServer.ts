import { spawn } from "child_process";
import http from "http";
import type { AddressInfo } from "net";
import path from "path";

export type GitHttpServer = {
    /** Base URL; append the bare repository directory name. */
    url: string;
    /** Requests received, as "METHOD path?query". */
    requests: string[];
    close(): Promise<void>;
};

/**
 * Serves bare repositories below `root` over smart HTTP using
 * `git http-backend`, so tests exercise the real protocol.
 */
export async function startGitHttpServer(
    root: string,
    options: {
        credentials?: { username: string; password: string };
        /** Refuse a push that was not preceded by ref discovery. */
        requireDiscovery?: boolean;
    } = {}
): Promise<GitHttpServer> {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const previous = requests[requests.length - 1];
        requests.push(`${req.method} ${url.pathname}${url.search}`);
        if (
            options.requireDiscovery &&
            req.method === "POST" &&
            url.pathname.endsWith("/git-receive-pack") &&
            !previous?.includes("service=git-receive-pack")
        ) {
            res.writeHead(403);
            res.end();
            return;
        }
        if (options.credentials) {
            const expected = `Basic ${Buffer.from(
                `${options.credentials.username}:${options.credentials.password}`
            ).toString("base64")}`;
            if (req.headers.authorization !== expected) {
                res.writeHead(401, {
                    "WWW-Authenticate": 'Basic realm="test"',
                });
                res.end();
                return;
            }
        }
        const backend = spawn("git", ["http-backend"], {
            env: {
                ...process.env,
                GIT_PROJECT_ROOT: root,
                GIT_HTTP_EXPORT_ALL: "1",
                PATH_INFO: url.pathname,
                QUERY_STRING: url.search.replace(/^\?/, ""),
                REQUEST_METHOD: req.method ?? "GET",
                CONTENT_TYPE: req.headers["content-type"] ?? "",
                REMOTE_USER: "test",
                REMOTE_ADDR: "127.0.0.1",
            },
        });
        req.pipe(backend.stdin);
        const chunks: Buffer[] = [];
        backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        backend.on("close", () => {
            const output = Buffer.concat(chunks);
            const separator = output.indexOf("\r\n\r\n");
            const headerText = output.subarray(0, separator).toString();
            const body = output.subarray(separator + 4);
            let status = 200;
            const headers: Record<string, string> = {};
            for (const line of headerText.split("\r\n")) {
                const index = line.indexOf(":");
                const name = line.slice(0, index).trim();
                const value = line.slice(index + 1).trim();
                if (name.toLowerCase() === "status") {
                    status = parseInt(value, 10);
                } else if (name) {
                    headers[name] = value;
                }
            }
            res.writeHead(status, headers);
            res.end(body);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            ),
    };
}

/** A `requestUrl` replacement for tests that performs real HTTP requests. */
export async function nodeRequestUrl(request: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: ArrayBuffer | string;
}): Promise<{
    status: number;
    headers: Record<string, string>;
    arrayBuffer: ArrayBuffer;
}> {
    const response = await fetch(request.url, {
        method: request.method ?? "GET",
        headers: request.headers,
        body: request.body,
    });
    const arrayBuffer = await response.arrayBuffer();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
        headers[name] = value;
    });
    return { status: response.status, headers, arrayBuffer };
}

export function bareRepoName(remotePath: string): string {
    return path.basename(remotePath);
}
