import { test } from "node:test";
import assert from "node:assert/strict";

import { Client, ApiError } from "../src/api.js";
import { buildFilter, listRecordings, TABLE_COLUMNS } from "../src/recording.js";

function byProperty(filter) {
    return Object.fromEntries(filter.map((f) => [`${f.property}:${f.operator}`, f.value]));
}

test("no options produces an empty filter", () => {
    assert.deepEqual(buildFilter({}), []);
});

test("a date range becomes gte + lte, because the API rejects `between`", () => {
    const f = buildFilter({ from: "2026-07-01", to: "2026-07-31" });
    assert.equal(f.length, 2);
    assert.deepEqual(byProperty(f), { "timestamp:gte": "2026-07-01", "timestamp:lte": "2026-07-31" });
    assert.ok(!f.some((e) => e.operator === "between"));
});

test("caller and called use `like`, so partial numbers match", () => {
    const f = buildFilter({ caller: "4478", called: "4474" });
    assert.deepEqual(byProperty(f), { "caller:like": "4478", "called:like": "4474" });
});

test("duration bounds become numbers, not strings", () => {
    const f = buildFilter({ minDuration: "60", maxDuration: "120" });
    assert.deepEqual(byProperty(f), { "duration:gte": 60, "duration:lte": 120 });
});

test("a non-numeric duration is rejected with the flag named", () => {
    assert.throws(() => buildFilter({ minDuration: "abc" }), /--min-duration must be a non-negative number/);
    assert.throws(() => buildFilter({ maxDuration: "-5" }), /--max-duration/);
});

test("--filter merges with the friendly flags rather than replacing them", () => {
    const f = buildFilter({ filter: '[{"property":"type","operator":"eq","value":"I"}]', minDuration: 60 });
    assert.equal(f.length, 2);
    assert.deepEqual(byProperty(f), { "type:eq": "I", "duration:gte": 60 });
});

test("--filter rejects malformed JSON, a non-array, and bad entries", () => {
    assert.throws(() => buildFilter({ filter: "{oops" }), /not valid JSON/);
    assert.throws(() => buildFilter({ filter: '{"property":"x"}' }), /must be a JSON array/);
    assert.throws(() => buildFilter({ filter: '[{"property":"x"}]' }), /needs a property and an operator/);
});

test("--filter rejects an operator the API does not implement", () => {
    // `between` answers HTTP 400 live, so it is caught here rather than round-tripping.
    assert.throws(
        () => buildFilter({ filter: '[{"property":"timestamp","operator":"between","value":["a","b"]}]' }),
        /unsupported filter operator "between"/,
    );
});

function pagedFetch(pages, total) {
    const calls = [];
    const fetchImpl = async (url) => {
        const page = Number(new URL(url).searchParams.get("page"));
        calls.push({ url, page, limit: Number(new URL(url).searchParams.get("limit")) });
        return { ok: true, status: 200, json: async () => ({ data: pages[page - 1] ?? [], total }) };
    };
    return { fetchImpl, calls };
}

const BASE = "https://api.example.test/v1.2/voipstudio";

test("a single page is returned without extra requests", async () => {
    const { fetchImpl, calls } = pagedFetch([[{ id: 1 }, { id: 2 }]], 2);
    const res = await listRecordings(new Client({ baseUrl: BASE, token: "t", fetchImpl }), { limit: 25 });
    assert.equal(res.total, 2);
    assert.equal(res.data.length, 2);
    assert.equal(calls.length, 1);
});

test("--all pages until every row is collected", async () => {
    const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }, { id: 4 }], [{ id: 5 }]];
    const { fetchImpl, calls } = pagedFetch(pages, 5);
    const res = await listRecordings(new Client({ baseUrl: BASE, token: "t", fetchImpl }), { all: true });
    assert.equal(res.data.length, 5);
    assert.deepEqual(res.data.map((r) => r.id), [1, 2, 3, 4, 5]);
    assert.deepEqual(calls.map((c) => c.page), [1, 2, 3]);
});

test("without --all the result is capped at limit even if the page is larger", async () => {
    const { fetchImpl } = pagedFetch([[{ id: 1 }, { id: 2 }, { id: 3 }]], 3);
    const res = await listRecordings(new Client({ baseUrl: BASE, token: "t", fetchImpl }), { limit: 2 });
    assert.equal(res.data.length, 2);
    assert.equal(res.total, 3);
});

test("an empty page stops the walk even when total overstates the rows", async () => {
    // Guards against looping forever if total is wrong or rows vanish mid-walk.
    const { fetchImpl, calls } = pagedFetch([[{ id: 1 }], []], 99);
    const res = await listRecordings(new Client({ baseUrl: BASE, token: "t", fetchImpl }), { all: true });
    assert.equal(res.data.length, 1);
    assert.equal(calls.length, 2);
});

test("onPage reports progress for each page fetched", async () => {
    const { fetchImpl } = pagedFetch([[{ id: 1 }], [{ id: 2 }]], 2);
    const seen = [];
    await listRecordings(new Client({ baseUrl: BASE, token: "t", fetchImpl }), {
        all: true, onPage: (p) => seen.push(p.collected),
    });
    assert.deepEqual(seen, [1, 2]);
});

test("the filter is sent JSON-encoded in the query string", async () => {
    const { fetchImpl, calls } = pagedFetch([[]], 0);
    const filter = buildFilter({ minDuration: 60 });
    await listRecordings(new Client({ baseUrl: BASE, token: "t", fetchImpl }), { filter });
    const sent = JSON.parse(new URL(calls[0].url).searchParams.get("filter"));
    assert.deepEqual(sent, [{ property: "duration", operator: "gte", value: 60 }]);
});

test("table columns stay a readable subset of the ~24-field record", () => {
    assert.deepEqual(TABLE_COLUMNS, ["id", "timestamp", "caller", "called", "duration", "type"]);
});

test("an API error surfaces rather than being swallowed into an empty list", async () => {
    const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ message: "bad filter" }) });
    await assert.rejects(
        () => listRecordings(new Client({ baseUrl: BASE, token: "t", fetchImpl }), {}),
        (err) => err instanceof ApiError && /bad filter/.test(err.message),
    );
});
