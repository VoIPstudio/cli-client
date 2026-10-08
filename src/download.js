import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";

import { ApiError } from "./api.js";
import { RESOURCE } from "./recording.js";

// Windows forbids the first set outright; the rest would make shell-unfriendly
// names. Collapsing runs keeps a blank caller from producing "__".
function safe(part) {
    return String(part ?? "")
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

// The API sends no Content-Disposition, so the client has to name the file. The
// id is last and always present, which keeps names unique even when two calls
// share a second and the same parties.
export function fileNameFor(recording) {
    const stamp = safe(recording.timestamp).replace(/:/g, "");
    const parts = [stamp, [safe(recording.caller), safe(recording.called)].filter(Boolean).join("-"), recording.id]
        .filter((p) => p !== "" && p !== undefined && p !== null);
    return `${parts.join("_")}.mp3`;
}

async function sizeOf(path) {
    try {
        return (await stat(path)).size;
    } catch (err) {
        if (err.code === "ENOENT") {
            return null;
        }
        throw err;
    }
}

// Downloads to a .part file and renames on success. /monitors/{id}.mp3 ignores
// Range - it answers 200 with the whole body and no Accept-Ranges - so an
// interrupted download cannot resume; writing in place would leave a truncated
// file that looks complete to the next --skip-existing run.
export async function downloadOne(client, recording, destination, { skipExisting = false } = {}) {
    const name = fileNameFor(recording);
    const target = join(destination, name);
    const expected = typeof recording.size === "number" ? recording.size : null;

    if (skipExisting) {
        const existing = await sizeOf(target);
        if (existing !== null && (expected === null || existing === expected)) {
            return { id: recording.id, file: target, bytes: existing, status: "skipped" };
        }
    }

    const partial = `${target}.part`;
    const res = await client.request(`/${RESOURCE}/${recording.id}.mp3`, { raw: true });
    try {
        await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
    } catch (err) {
        await unlink(partial).catch(() => {});
        throw new ApiError(`recording ${recording.id}: download failed - ${err.message}`);
    }

    const written = await sizeOf(partial);
    // The record's `size` matches the delivered bytes exactly (verified against
    // live data), so a mismatch means a truncated transfer, not a quirk.
    if (expected !== null && written !== expected) {
        await unlink(partial).catch(() => {});
        throw new ApiError(
            `recording ${recording.id}: expected ${expected} bytes but received ${written} - transfer was truncated`,
        );
    }

    await rename(partial, target);
    return { id: recording.id, file: target, bytes: written, status: "downloaded" };
}

// A hand-rolled worker pool rather than chunked Promise.all: chunking stalls on
// the slowest item in each chunk, where workers keep every slot busy.
export async function downloadAll(client, recordings, destination, { concurrency = 4, skipExisting = false, onResult } = {}) {
    await mkdir(destination, { recursive: true });
    const results = new Array(recordings.length);
    let next = 0;

    const worker = async () => {
        while (next < recordings.length) {
            const index = next;
            next += 1;
            const recording = recordings[index];
            try {
                results[index] = await downloadOne(client, recording, destination, { skipExisting });
            } catch (err) {
                results[index] = { id: recording.id, file: null, bytes: 0, status: "failed", error: err.message };
            }
            if (onResult) {
                onResult(results[index], index + 1, recordings.length);
            }
        }
    };

    const slots = Math.max(1, Math.min(concurrency, recordings.length || 1));
    await Promise.all(Array.from({ length: slots }, () => worker()));
    return results;
}

export function summarise(results) {
    const tally = { downloaded: 0, skipped: 0, failed: 0, bytes: 0 };
    for (const r of results) {
        tally[r.status] += 1;
        tally.bytes += r.bytes || 0;
    }
    return tally;
}
