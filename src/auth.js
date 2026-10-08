import { ApiError, Client } from "./api.js";

export const CLI_TOKEN_NAME = "VoIPstudio CLI";
// 30 days, refreshed on every authenticated request, so an active user never
// has to log in again.
export const CLI_TOKEN_EXPIRY_SECONDS = 30 * 24 * 60 * 60;

// POST /login answers 200 with a session token, or 202 with a nonce when the
// account has two-factor enabled.
export async function login(client, email, password) {
    const res = await client.fetchImpl(`${client.baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 202 && body?.nonce) {
        return { status: "needs2fa", nonce: body.nonce };
    }
    if (!res.ok) {
        throw new ApiError(body?.errors?.[0]?.message ?? body?.message ?? `Login failed (HTTP ${res.status})`, {
            status: res.status,
        });
    }
    return { status: "ok", sessionToken: body.user_token, userId: body.user_id };
}

export async function submit2fa(client, code, nonce) {
    const body = await client.post("/login2fa", { code, nonce });
    return { status: "ok", sessionToken: body.user_token, userId: body.user_id };
}

async function deleteTokenNamed(client, name) {
    const filter = [{ property: "name", operator: "eq", value: name }];
    let existing;
    try {
        existing = await client.list("apitokens", { filter });
    } catch {
        return; // A failed lookup is not fatal; the POST below reports a real collision.
    }
    for (const token of existing?.data ?? []) {
        await client.delete(`/apitokens/${token.token}`).catch(() => {});
    }
}

// The stored credential is a named, revocable API token rather than the login
// response itself: that session token expires in 30 minutes, so persisting it
// would leave the CLI working now and broken within the hour. (name, user_id)
// must be unique, so a previous CLI token is removed before minting.
export async function mintCliToken(sessionClient) {
    await deleteTokenNamed(sessionClient, CLI_TOKEN_NAME);
    const body = await sessionClient.post("/apitokens", {
        name: CLI_TOKEN_NAME,
        expiry: CLI_TOKEN_EXPIRY_SECONDS,
    });
    const token = body?.data?.token;
    if (!token) {
        throw new ApiError("VoIPstudio accepted the request but returned no API token");
    }
    return token;
}

export async function whoami(client) {
    const body = await client.get("/me");
    return body?.data ?? body;
}

// Revoking server-side is attempted first, but a token that is already invalid
// must not stop the local credential being cleared, or `vs auth logout` could
// never recover from an expired session.
export async function revokeToken(client, token) {
    try {
        await client.delete(`/apitokens/${token}`);
        return { revoked: true };
    } catch (err) {
        return { revoked: false, reason: err.message, status: err.status ?? null };
    }
}

export function clientFor({ baseUrl, token, fetchImpl }) {
    return new Client({ baseUrl, token, fetchImpl });
}
