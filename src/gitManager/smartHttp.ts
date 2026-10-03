import { requestUrl } from "obsidian";

// Minimal client for git's smart HTTP receive-pack protocol (protocol v0/v1).
// Used for fast pushes; callers fall back to isomorphic-git on any surprise.

export type RemoteCredentials = { username?: string; password?: string };

export type ReceivePackAdvertisement = {
    refs: Map<string, string>;
    capabilities: Set<string>;
};

export type ReceivePackResult =
    | { ok: true }
    // "rejected": the server refused the update (e.g. the remote moved);
    // "protocol": the exchange itself failed or was not understood.
    | { ok: false; kind: "rejected" | "protocol"; reason: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ZERO_OID = "0".repeat(40);

export function pktLine(line: string): Uint8Array {
    const payload = encoder.encode(line);
    const length = (payload.length + 4).toString(16).padStart(4, "0");
    return concat([encoder.encode(length), payload]);
}

/** Splits pkt-lines; `null` marks a flush packet. */
export function parsePktLines(data: Uint8Array): (string | null)[] {
    const lines: (string | null)[] = [];
    let offset = 0;
    while (offset + 4 <= data.length) {
        const length = parseInt(
            decoder.decode(data.subarray(offset, offset + 4)),
            16
        );
        if (Number.isNaN(length)) {
            throw new Error("Invalid pkt-line length");
        }
        if (length === 0) {
            lines.push(null);
            offset += 4;
            continue;
        }
        if (length < 4 || offset + length > data.length) {
            throw new Error("Truncated pkt-line");
        }
        lines.push(decoder.decode(data.subarray(offset + 4, offset + length)));
        offset += length;
    }
    return lines;
}

function concat(parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
    return data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
    ) as ArrayBuffer;
}

function headers(
    credentials: RemoteCredentials,
    extra: Record<string, string>
): Record<string, string> {
    const result: Record<string, string> = {
        "Accept-Encoding": "identity",
        "User-Agent": "git/isomorphic-git",
        ...extra,
    };
    if (credentials.username !== undefined || credentials.password) {
        const token = `${credentials.username ?? ""}:${credentials.password ?? ""}`;
        result.Authorization = `Basic ${btoa(
            String.fromCharCode(...encoder.encode(token))
        )}`;
    }
    return result;
}

function repoUrl(url: string): string {
    return url.replace(/\/+$/, "");
}

/** Returns undefined when the remote cannot be queried this way (auth, non-200). */
export async function advertiseReceivePack(
    url: string,
    credentials: RemoteCredentials
): Promise<ReceivePackAdvertisement | undefined> {
    const response = await requestUrl({
        url: `${repoUrl(url)}/info/refs?service=git-receive-pack`,
        method: "GET",
        headers: headers(credentials, {}),
        throw: false,
    });
    if (response.status !== 200) return undefined;
    const lines = parsePktLines(new Uint8Array(response.arrayBuffer));
    if (lines[0]?.trimEnd() !== "# service=git-receive-pack") {
        return undefined;
    }
    const refs = new Map<string, string>();
    let capabilities = new Set<string>();
    for (const line of lines.slice(1)) {
        if (line === null) continue;
        const [refPart, capsPart] = line.replace(/\n$/, "").split("\0");
        if (capsPart !== undefined) {
            capabilities = new Set(capsPart.trim().split(" "));
        }
        const [oid, ref] = refPart!.split(" ");
        if (oid && ref && oid !== ZERO_OID) refs.set(ref, oid);
    }
    return { refs, capabilities };
}

/** Updates one ref; `pack` must contain every object the remote lacks. */
export async function sendReceivePack({
    url,
    credentials,
    ref,
    oldOid,
    newOid,
    pack,
}: {
    url: string;
    credentials: RemoteCredentials;
    ref: string;
    oldOid: string;
    newOid: string;
    pack: Uint8Array;
}): Promise<ReceivePackResult> {
    const body = concat([
        pktLine(
            `${oldOid} ${newOid} ${ref}\0report-status agent=obsidian-git\n`
        ),
        encoder.encode("0000"),
        pack,
    ]);
    const response = await requestUrl({
        url: `${repoUrl(url)}/git-receive-pack`,
        method: "POST",
        headers: headers(credentials, {
            "Content-Type": "application/x-git-receive-pack-request",
            Accept: "application/x-git-receive-pack-result",
        }),
        body: toArrayBuffer(body),
        throw: false,
    });
    if (response.status !== 200) {
        return {
            ok: false,
            kind: "protocol",
            reason: `HTTP ${response.status}`,
        };
    }
    const lines = parsePktLines(new Uint8Array(response.arrayBuffer)).filter(
        (line): line is string => line !== null
    );
    const unpack = lines.find((line) => line.startsWith("unpack "));
    if (unpack?.trim() !== "unpack ok") {
        return {
            ok: false,
            kind: "protocol",
            reason: unpack?.trim() ?? "no unpack status",
        };
    }
    const status = lines.find((line) => line.split(" ")[1]?.trim() === ref);
    if (status?.startsWith("ok ")) return { ok: true };
    return status?.startsWith("ng ")
        ? { ok: false, kind: "rejected", reason: status.trim() }
        : {
              ok: false,
              kind: "protocol",
              reason: status?.trim() ?? "no ref status",
          };
}
