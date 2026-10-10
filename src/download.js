import { createWriteStream } from "node:fs";
import { mkdir, open as openFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, join } from "node:path";

import { ApiError, describeError } from "./api.js";

// Leading bytes every file of this type must have. Only formats with a stable
// signature are listed; mp3 frames vary too much to assert on.
const MAGIC = { pdf: Buffer.from("%PDF") };

// Windows forbids the first set outright; the rest would make shell-unfriendly
// names. Collapsing runs keeps a blank party from producing "__".
function safe(part) {
    return String(part ?? "")
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}

// No endpoint sends Content-Disposition, so the client names the file. Fax is
// the exception: its record carries a filename the dashboard also uses, and
// honouring it keeps the two consistent. The id is always last and always
// present, so two records sharing a second and parties cannot collide.
export function fileNameFor(spec, record) {
    if (spec.filenameField && record[spec.filenameField]) {
        const given = safe(basename(String(record[spec.filenameField])));
        if (given) {
            return given;
        }
    }
    const [when, parties = []] = spec.nameParts ? spec.nameParts(record) : [undefined, []];
    const stamp = safe(when).replace(/:/g, "");
    const who = parties.filter(Boolean).map(safe).filter(Boolean).join("-");
    const parts = [stamp, who, record.id].filter((p) => p !== "" && p !== undefined && p !== null);
    return `${parts.join("_")}.${spec.download.extension}`;
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

// Downloads to a .part file and renames on success. The file endpoints ignore
// Range - they answer 200 with the whole body and no Accept-Ranges - so an
// interrupted download cannot resume; writing in place would leave a truncated
// file that looks complete to the next --skip-existing run.
//
// Only recordings carry a `size` to check the result against. For the others
// a short-but-cleanly-ended response cannot be detected; see the README.
export async function downloadOne(client, spec, record, destination, { skipExisting = false } = {}) {
    const target = join(destination, fileNameFor(spec, record));
    const expected = spec.sizeField && typeof record[spec.sizeField] === "number" ? record[spec.sizeField] : null;

    if (skipExisting) {
        const existing = await sizeOf(target);
        if (existing !== null && (expected === null || existing === expected)) {
            return { id: record.id, file: target, bytes: existing, status: "skipped" };
        }
    }

    const partial = `${target}.part`;
    let res;
    try {
        res = await client.request(spec.download.path(record.id), { raw: true });
    } catch (err) {
        // Some records simply have no file yet - an incomplete transaction has
        // no invoice PDF. That is a state, not a failure, so it must not make a
        // batch exit non-zero.
        if (spec.skipWhen && spec.skipWhen(err.message ?? "")) {
            return { id: record.id, file: null, bytes: 0, status: "skipped", reason: err.message };
        }
        throw err;
    }

    try {
        // Not every file endpoint streams bytes. Invoices answer 200 with
        // application/json wrapping the document as {data:{base64}}, so the
        // envelope has to be decoded rather than written verbatim - otherwise
        // ~25kB of JSON lands in a file named .pdf and looks like a success.
        const contentType = res.headers?.get?.("content-type") ?? "";
        if (contentType.includes("application/json")) {
            const envelope = await res.json();
            const encoded = envelope?.data?.base64;
            if (!encoded) {
                throw new ApiError(
                    `${spec.noun} ${record.id}: server returned JSON with no base64 payload`,
                );
            }
            await writeFile(partial, Buffer.from(encoded, "base64"));
        } else {
            await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
        }
    } catch (err) {
        await unlink(partial).catch(() => {});
        throw err instanceof ApiError
            ? err
            : new ApiError(`${spec.noun} ${record.id}: download failed - ${describeError(err)}`);
    }

    // A content check, because a JSON error page saved as .pdf passed every
    // other test here: size, no exception, file present.
    if (MAGIC[spec.download.extension]) {
        const head = Buffer.alloc(MAGIC[spec.download.extension].length);
        const fh = await openFile(partial, "r");
        await fh.read(head, 0, head.length, 0);
        await fh.close();
        if (!head.equals(MAGIC[spec.download.extension])) {
            await unlink(partial).catch(() => {});
            throw new ApiError(
                `${spec.noun} ${record.id}: response was not a valid ${spec.download.extension.toUpperCase()} ` +
                `(starts with ${JSON.stringify(head.toString("latin1"))})`,
            );
        }
    }

    const written = await sizeOf(partial);
    if (expected !== null && written !== expected) {
        await unlink(partial).catch(() => {});
        throw new ApiError(
            `${spec.noun} ${record.id}: expected ${expected} bytes but received ${written} - transfer was truncated`,
        );
    }

    await rename(partial, target);
    return { id: record.id, file: target, bytes: written, status: "downloaded" };
}

// A hand-rolled worker pool rather than chunked Promise.all: chunking stalls on
// the slowest item in each chunk, where workers keep every slot busy.
export async function downloadAll(client, spec, records, destination, { concurrency = 4, skipExisting = false, onResult } = {}) {
    await mkdir(destination, { recursive: true });
    const results = new Array(records.length);
    let next = 0;

    const worker = async () => {
        while (next < records.length) {
            const index = next;
            next += 1;
            const record = records[index];
            try {
                results[index] = await downloadOne(client, spec, record, destination, { skipExisting });
            } catch (err) {
                results[index] = { id: record.id, file: null, bytes: 0, status: "failed", error: describeError(err) };
            }
            if (onResult) {
                onResult(results[index], index + 1, records.length);
            }
        }
    };

    const slots = Math.max(1, Math.min(concurrency, records.length || 1));
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
