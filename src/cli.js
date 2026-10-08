#!/usr/bin/env node
import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { Client, ApiError, resolveApiUrl, ENV_HOSTS } from "./api.js";
import { clearProfile, configPath, resolveCredentials, saveProfile } from "./config.js";
import { login, mintCliToken, revokeToken, submit2fa, whoami } from "./auth.js";
import { prompt, requireTty } from "./prompt.js";
import { emit, status } from "./output.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const program = new Command();
program
    .name("vs")
    .description("Command line client for the VoIPstudio API")
    .version(pkg.version)
    .addOption(new Option("--profile <name>", "named credential profile to use"))
    .addOption(new Option("--api-url <url>", "full API base URL, overriding --env"))
    .addOption(new Option("--env <name>", "API environment").choices(Object.keys(ENV_HOSTS)))
    .addOption(new Option("--format <format>", "output format").choices(["json", "table"]).default("json"))
    .addOption(new Option("--insecure", "skip TLS verification (internal hosts with self-signed certs only)"));

// Global TLS state is the only dependency-free way to reach a self-signed
// internal host, so it is applied once, loudly, and never by default.
function applyInsecure(options) {
    if (options.insecure) {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        status("warning: TLS certificate verification is disabled (--insecure)");
    }
}

function baseUrlFor(options) {
    return resolveApiUrl({ apiUrl: options.apiUrl, env: options.env });
}

function authenticatedClient(options) {
    const creds = resolveCredentials({ profile: options.profile });
    if (!creds.token) {
        throw new ApiError(`Not logged in${creds.profile ? ` on profile "${creds.profile}"` : ""} — run "vs auth login".`);
    }
    // A profile remembers the host it was created against, so a token minted on
    // one environment is never replayed against another.
    const overridden = Boolean(options.apiUrl || options.env);
    const baseUrl = overridden ? baseUrlFor(options) : (creds.apiUrl ?? baseUrlFor(options));
    return { client: new Client({ baseUrl, token: creds.token }), creds, baseUrl };
}

const auth = program.command("auth").description("authenticate against VoIPstudio");

auth.command("login")
    .description("log in and store a named API token")
    .option("--email <email>", "account email (prompted when omitted)")
    .action(async (cmdOptions) => {
        const options = program.opts();
        applyInsecure(options);
        const baseUrl = baseUrlFor(options);
        const sessionClient = new Client({ baseUrl });

        requireTty();
        const email = cmdOptions.email ?? (await prompt("Email: "));
        const password = await prompt("Password: ", { hidden: true });

        status(`Authenticating against ${baseUrl} …`);
        let result = await login(sessionClient, email, password);
        if (result.status === "needs2fa") {
            const code = await prompt("Two-factor code: ");
            result = await submit2fa(new Client({ baseUrl }), code, result.nonce);
        }

        sessionClient.token = result.sessionToken;
        status("Minting an API token for the CLI …");
        const token = await mintCliToken(sessionClient);

        const identity = await whoami(new Client({ baseUrl, token }));
        saveProfile(options.profile, { token, apiUrl: baseUrl, email: identity.email ?? email, userId: identity.id });
        status(`Logged in as ${identity.email} — token stored in ${configPath()}`);
        emit(identity, { format: options.format, columns: ["id", "email", "first_name", "last_name", "customer_id"] });
    });

auth.command("whoami")
    .description("show the account the stored token belongs to")
    .action(async () => {
        const options = program.opts();
        applyInsecure(options);
        const { client } = authenticatedClient(options);
        const identity = await whoami(client);
        emit(identity, { format: options.format, columns: ["id", "email", "first_name", "last_name", "customer_id"] });
    });

auth.command("logout")
    .description("revoke the stored API token and forget it")
    .action(async () => {
        const options = program.opts();
        applyInsecure(options);
        const creds = resolveCredentials({ profile: options.profile });
        if (!creds.token) {
            status("Not logged in — nothing to do.");
            return;
        }
        if (creds.source === "VOIPSTUDIO_API_TOKEN") {
            throw new ApiError(
                "The active token comes from VOIPSTUDIO_API_TOKEN, which vs cannot revoke — unset it, or delete the token in VoIPstudio Settings > API tokens.",
            );
        }
        const baseUrl = creds.apiUrl ?? baseUrlFor(options);
        const outcome = await revokeToken(new Client({ baseUrl, token: creds.token }), creds.token);
        clearProfile(options.profile);
        status(
            outcome.revoked
                ? "Token revoked and removed from local config."
                : `Token removed locally; server-side revoke failed (${outcome.reason}).`,
        );
        emit({ revoked: outcome.revoked, profile: creds.profile }, { format: options.format });
    });

program.showHelpAfterError();

const TLS_HINT_CODES = new Set([
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
]);

// Node's fetch reports every transport problem as the bare string "fetch
// failed" and puts the real reason in `cause`, so unwrapping it is the
// difference between an actionable error and a dead end.
function describe(err) {
    const cause = err.cause;
    if (!cause) {
        return err.message;
    }
    const code = cause.code ?? cause.name;
    if (TLS_HINT_CODES.has(code)) {
        return `${err.message}: ${code} — the server's TLS certificate could not be verified. Internal hosts use self-signed certificates; pass --insecure to accept them.`;
    }
    return `${err.message}: ${code ?? cause.message}`;
}

try {
    await program.parseAsync(process.argv);
} catch (err) {
    status(`error: ${describe(err)}`);
    process.exitCode = 1;
}
