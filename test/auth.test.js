import { test } from "node:test";
import assert from "node:assert/strict";

import { Client, ApiError, resolveApiUrl } from "../src/api.js";
import { CLI_TOKEN_NAME, login, mintCliToken, revokeToken, submit2fa, whoami } from "../src/auth.js";

// Minimal stand-in for fetch: each call is matched by URL substring, and every
// request is recorded so the test can assert on method, headers and body.
function stubFetch(routes) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body });
        const match = Object.keys(routes).find((key) => url.includes(key));
        if (!match) {
            throw new Error(`unexpected request: ${init.method ?? "GET"} ${url}`);
        }
        const { status = 200, body = null } = routes[match];
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => {
                if (body === null) {
                    throw new Error("no body");
                }
                return body;
            },
        };
    };
    return { fetchImpl, calls };
}

const BASE = "https://api.example.test/v1.2/voipstudio";

test("resolveApiUrl prefers --api-url, then the env var, then the named environment", () => {
    assert.equal(resolveApiUrl({ apiUrl: "https://x/api/", processEnv: {} }), "https://x/api");
    assert.equal(resolveApiUrl({ processEnv: { VOIPSTUDIO_API_URL: "https://y" } }), "https://y");
    assert.equal(resolveApiUrl({ env: "dev", processEnv: {} }), "https://api.l7dev.co.cc/v1.2/voipstudio");
    assert.equal(resolveApiUrl({ processEnv: {} }), "https://l7api.com/v1.2/voipstudio");
    assert.throws(() => resolveApiUrl({ env: "staging", processEnv: {} }), /Unknown environment/);
});

test("login returns the session token on 200", async () => {
    const { fetchImpl } = stubFetch({ "/login": { status: 200, body: { user_token: "sess", user_id: 7 } } });
    const result = await login(new Client({ baseUrl: BASE, fetchImpl }), "a@b.c", "pw");
    assert.deepEqual(result, { status: "ok", sessionToken: "sess", userId: 7 });
});

test("login reports a 2FA challenge on 202 instead of treating it as failure", async () => {
    const { fetchImpl } = stubFetch({ "/login": { status: 202, body: { nonce: "n1" } } });
    const result = await login(new Client({ baseUrl: BASE, fetchImpl }), "a@b.c", "pw");
    assert.deepEqual(result, { status: "needs2fa", nonce: "n1" });
});

test("login surfaces the API error message on 401", async () => {
    const { fetchImpl } = stubFetch({
        "/login": { status: 401, body: { errors: [{ message: "Invalid credentials" }] } },
    });
    await assert.rejects(() => login(new Client({ baseUrl: BASE, fetchImpl }), "a@b.c", "bad"), /Invalid credentials/);
});

test("submit2fa exchanges the code and nonce for a session token", async () => {
    const { fetchImpl, calls } = stubFetch({ "/login2fa": { status: 200, body: { user_token: "sess2" } } });
    const result = await submit2fa(new Client({ baseUrl: BASE, fetchImpl }), "123456", "n1");
    assert.equal(result.sessionToken, "sess2");
    assert.deepEqual(JSON.parse(calls[0].body), { code: "123456", nonce: "n1" });
});

test("mintCliToken deletes a same-named token first, since (name, user_id) is unique", async () => {
    const { fetchImpl, calls } = stubFetch({
        "/apitokens?filter=": { status: 200, body: { data: [{ token: "old" }] } },
        "/apitokens/old": { status: 204 },
        "/apitokens": { status: 201, body: { data: { token: "new" } } },
    });
    const token = await mintCliToken(new Client({ baseUrl: BASE, token: "sess", fetchImpl }));
    assert.equal(token, "new");
    assert.ok(calls.some((c) => c.method === "DELETE" && c.url.includes("/apitokens/old")));
    const mint = calls.find((c) => c.method === "POST");
    assert.equal(JSON.parse(mint.body).name, CLI_TOKEN_NAME);
    assert.equal(mint.headers["x-auth-token"], "sess");
});

test("mintCliToken still mints when the pre-delete lookup fails", async () => {
    const { fetchImpl } = stubFetch({
        "/apitokens?filter=": { status: 500, body: null },
        "/apitokens": { status: 201, body: { data: { token: "new" } } },
    });
    assert.equal(await mintCliToken(new Client({ baseUrl: BASE, token: "sess", fetchImpl })), "new");
});

test("mintCliToken rejects a success response that carries no token", async () => {
    const { fetchImpl } = stubFetch({
        "/apitokens?filter=": { status: 200, body: { data: [] } },
        "/apitokens": { status: 201, body: { data: {} } },
    });
    await assert.rejects(
        () => mintCliToken(new Client({ baseUrl: BASE, token: "sess", fetchImpl })),
        /returned no API token/,
    );
});

test("whoami unwraps the data envelope", async () => {
    const { fetchImpl } = stubFetch({ "/me": { status: 200, body: { data: { id: 1, email: "a@b.c" } } } });
    assert.deepEqual(await whoami(new Client({ baseUrl: BASE, token: "t", fetchImpl })), { id: 1, email: "a@b.c" });
});

test("revokeToken reports failure rather than throwing, so logout can still clear local state", async () => {
    const { fetchImpl } = stubFetch({ "/apitokens/dead": { status: 401, body: { message: "Unauthorized" } } });
    const outcome = await revokeToken(new Client({ baseUrl: BASE, token: "dead", fetchImpl }), "dead");
    assert.equal(outcome.revoked, false);
    assert.equal(outcome.status, 401);
});

test("a 204 response is not parsed as JSON", async () => {
    const { fetchImpl } = stubFetch({ "/apitokens/x": { status: 204, body: null } });
    const outcome = await revokeToken(new Client({ baseUrl: BASE, token: "x", fetchImpl }), "x");
    assert.equal(outcome.revoked, true);
});

test("ApiError carries the HTTP status for callers that branch on it", async () => {
    const { fetchImpl } = stubFetch({ "/me": { status: 403, body: { message: "Forbidden" } } });
    await assert.rejects(
        () => new Client({ baseUrl: BASE, token: "t", fetchImpl }).get("/me"),
        (err) => err instanceof ApiError && err.status === 403,
    );
});
