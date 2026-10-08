import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, ApiError } from "../src/api.js";
import { downloadAll, downloadOne, fileNameFor, summarise } from "../src/download.js";

const BASE = "https://api.example.test/v1.2/voipstudio";
const REC = { id: 42, timestamp: "2026-07-22 14:04:59", caller: "447854740947", called: "447457410215", size: 5 };

function tempDir() {
    return mkdtempSync(join(tmpdir(), "vs-dl-"));
}

// Stands in for a fetch Response carrying a web ReadableStream body.
function audioResponse(bytes, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        body: new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(bytes));
                controller.close();
            },
        }),
    };
}

function clientReturning(responses) {
    const calls = [];
    let i = 0;
    const fetchImpl = async (url) => {
        calls.push(url);
        const next = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return typeof next === "function" ? next(url) : next;
    };
    return { client: new Client({ baseUrl: BASE, token: "t", fetchImpl }), calls };
}

test("the filename is built client-side, since the API sends no Content-Disposition", () => {
    assert.equal(fileNameFor(REC), "2026-07-22-140459_447854740947-447457410215_42.mp3");
});

test("filename characters illegal on Windows are stripped", () => {
    const name = fileNameFor({ id: 7, timestamp: "2026-01-01 00:00:00", caller: 'a/b:c*d?"', called: "e\\f|g" });
    assert.ok(!/[<>:"/\\|?*]/.test(name), name);
    assert.ok(name.endsWith("_7.mp3"));
});

test("a missing caller or called does not leave a double separator", () => {
    const name = fileNameFor({ id: 9, timestamp: "2026-01-01 00:00:00", caller: "", called: "" });
    assert.ok(!name.includes("__"), name);
    assert.ok(name.endsWith("_9.mp3"));
});

test("the id is always included, so same-second calls between the same parties stay unique", () => {
    const a = fileNameFor({ ...REC, id: 1 });
    const b = fileNameFor({ ...REC, id: 2 });
    assert.notEqual(a, b);
});

test("a successful download writes the file and reports the byte count", async () => {
    const dir = tempDir();
    const { client } = clientReturning([audioResponse([1, 2, 3, 4, 5])]);
    const res = await downloadOne(client, REC, dir);
    assert.equal(res.status, "downloaded");
    assert.equal(res.bytes, 5);
    assert.equal(readFileSync(res.file).length, 5);
});

test("no .part file survives a successful download", async () => {
    const dir = tempDir();
    const { client } = clientReturning([audioResponse([1, 2, 3, 4, 5])]);
    await downloadOne(client, REC, dir);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".part")), []);
});

test("a short transfer is rejected and leaves no file behind", async () => {
    // The record's `size` matches delivered bytes exactly on the real API, so a
    // mismatch means truncation - and because the endpoint ignores Range, a
    // truncated file could never be resumed.
    const dir = tempDir();
    const { client } = clientReturning([audioResponse([1, 2])]);
    await assert.rejects(() => downloadOne(client, REC, dir), /expected 5 bytes but received 2/);
    assert.deepEqual(readdirSync(dir), []);
});

test("a record with no size is accepted rather than failing the length check", async () => {
    const dir = tempDir();
    const { client } = clientReturning([audioResponse([9, 9])]);
    const res = await downloadOne(client, { ...REC, size: undefined }, dir);
    assert.equal(res.status, "downloaded");
    assert.equal(res.bytes, 2);
});

test("--skip-existing skips a file already at the expected size", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, fileNameFor(REC)), Buffer.alloc(5));
    const { client, calls } = clientReturning([audioResponse([1, 2, 3, 4, 5])]);
    const res = await downloadOne(client, REC, dir, { skipExisting: true });
    assert.equal(res.status, "skipped");
    assert.equal(calls.length, 0, "no request should be made for a skipped file");
});

test("--skip-existing re-downloads a file of the wrong size", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, fileNameFor(REC)), Buffer.alloc(2));
    const { client } = clientReturning([audioResponse([1, 2, 3, 4, 5])]);
    const res = await downloadOne(client, REC, dir, { skipExisting: true });
    assert.equal(res.status, "downloaded");
    assert.equal(res.bytes, 5);
});

test("downloadAll creates the destination folder", async () => {
    const dir = join(tempDir(), "nested", "deeper");
    const { client } = clientReturning([audioResponse([1, 2, 3, 4, 5])]);
    await downloadAll(client, [REC], dir);
    assert.ok(existsSync(dir));
});

test("one failure does not abort the batch, and results keep input order", async () => {
    const dir = tempDir();
    const recs = [
        { ...REC, id: 1, size: 2 },
        { ...REC, id: 2, size: 99 },
        { ...REC, id: 3, size: 2 },
    ];
    const { client } = clientReturning([() => audioResponse([1, 2])]);
    const results = await downloadAll(client, recs, dir, { concurrency: 2 });
    assert.deepEqual(results.map((r) => r.id), [1, 2, 3]);
    assert.deepEqual(results.map((r) => r.status), ["downloaded", "failed", "downloaded"]);
    assert.match(results[1].error, /expected 99 bytes/);
});

test("concurrency is capped at the number of recordings", async () => {
    const dir = tempDir();
    let live = 0;
    let peak = 0;
    const fetchImpl = async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live -= 1;
        return audioResponse([1, 2, 3, 4, 5]);
    };
    const client = new Client({ baseUrl: BASE, token: "t", fetchImpl });
    const recs = [1, 2].map((id) => ({ ...REC, id }));
    await downloadAll(client, recs, dir, { concurrency: 10 });
    assert.ok(peak <= 2, `peak concurrency ${peak} exceeded the 2 recordings`);
});

test("concurrency is respected when there are more recordings than slots", async () => {
    const dir = tempDir();
    let live = 0;
    let peak = 0;
    const fetchImpl = async () => {
        live += 1;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live -= 1;
        return audioResponse([1, 2, 3, 4, 5]);
    };
    const client = new Client({ baseUrl: BASE, token: "t", fetchImpl });
    const recs = [1, 2, 3, 4, 5, 6].map((id) => ({ ...REC, id }));
    await downloadAll(client, recs, dir, { concurrency: 2 });
    assert.ok(peak <= 2, `peak concurrency ${peak} exceeded the limit of 2`);
});

test("an HTTP error becomes a failed result, not a thrown batch", async () => {
    const dir = tempDir();
    const { client } = clientReturning([{ ok: false, status: 404, body: null }]);
    const results = await downloadAll(client, [REC], dir);
    assert.equal(results[0].status, "failed");
    assert.match(results[0].error, /404/);
});

test("summarise tallies statuses and bytes", () => {
    const tally = summarise([
        { status: "downloaded", bytes: 10 },
        { status: "skipped", bytes: 5 },
        { status: "failed", bytes: 0 },
        { status: "downloaded", bytes: 7 },
    ]);
    assert.deepEqual(tally, { downloaded: 2, skipped: 1, failed: 1, bytes: 22 });
});

test("downloading an empty list is a no-op rather than an error", async () => {
    const dir = tempDir();
    const { client } = clientReturning([audioResponse([1])]);
    const results = await downloadAll(client, [], dir);
    assert.deepEqual(results, []);
    assert.deepEqual(summarise(results), { downloaded: 0, skipped: 0, failed: 0, bytes: 0 });
});

test("ApiError from the client propagates with its message intact", async () => {
    const dir = tempDir();
    const { client } = clientReturning([{ ok: false, status: 403, body: null }]);
    await assert.rejects(() => downloadOne(client, REC, dir), (err) => err instanceof ApiError);
});

test("a transport error reports its cause, not a bare 'fetch failed'", async () => {
    // Node's fetch hides the real reason in err.cause. A rate-limit page with
    // malformed headers arrives as HPE_INVALID_HEADER_TOKEN, and reporting only
    // err.message would tell the user nothing at all.
    const dir = tempDir();
    const fetchImpl = async () => {
        const err = new TypeError("fetch failed");
        err.cause = Object.assign(new Error("Invalid header value char"), { code: "HPE_INVALID_HEADER_TOKEN" });
        throw err;
    };
    const client = new Client({ baseUrl: BASE, token: "t", fetchImpl });
    const results = await downloadAll(client, [REC], dir);
    assert.equal(results[0].status, "failed");
    assert.match(results[0].error, /HPE_INVALID_HEADER_TOKEN/);
    assert.match(results[0].error, /rate-limit or error page with malformed headers/);
});

test("a TLS failure points at --insecure", async () => {
    const dir = tempDir();
    const fetchImpl = async () => {
        const err = new TypeError("fetch failed");
        err.cause = Object.assign(new Error("self signed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
        throw err;
    };
    const client = new Client({ baseUrl: BASE, token: "t", fetchImpl });
    const results = await downloadAll(client, [REC], dir);
    assert.match(results[0].error, /--insecure/);
});
