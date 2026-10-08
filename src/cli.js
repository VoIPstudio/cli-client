#!/usr/bin/env node
import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { Client, ApiError, resolveApiUrl, ENV_HOSTS } from "./api.js";
import { clearProfile, configPath, resolveCredentials, saveProfile } from "./config.js";
import { login, mintCliToken, revokeToken, submit2fa, whoami } from "./auth.js";
import { buildFilter, listRecordings, TABLE_COLUMNS } from "./recording.js";
import { downloadAll, summarise } from "./download.js";
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

const recording = program.command("recording").description("work with call recordings");

recording.command("list")
    .description("list call recordings")
    .option("--from <date>", "only recordings at or after this date (YYYY-MM-DD or full timestamp)")
    .option("--to <date>", "only recordings at or before this date")
    .option("--caller <number>", "partial match on the calling number")
    .option("--called <number>", "partial match on the called number")
    .option("--min-duration <seconds>", "only recordings at least this long")
    .option("--max-duration <seconds>", "only recordings at most this long")
    .option("--type <type>", "call type, e.g. I for inbound")
    .option("--limit <n>", "maximum rows to return", "25")
    .option("--all", "fetch every matching recording, paging as needed")
    .option("--filter <json>", "raw API filter array, merged with the flags above")
    .action(async (cmdOptions) => {
        const options = program.opts();
        applyInsecure(options);
        const { client } = authenticatedClient(options);
        const filter = buildFilter(cmdOptions);
        const { data, total } = await listRecordings(client, {
            filter,
            limit: Number(cmdOptions.limit),
            all: Boolean(cmdOptions.all),
            onPage: ({ collected, total: all }) =>
                cmdOptions.all && collected < all ? status(`fetched ${collected}/${all} …`) : undefined,
        });
        status(`${data.length} of ${total} recording(s)`);
        emit(data, { format: options.format, columns: TABLE_COLUMNS });
    });

const download = recording.command("download")
    .description("download recording audio as MP3")
    // Both positionals are optional because commander cannot resolve an
    // optional argument followed by a required one: given a single value it
    // binds it to `id` and then reports `folder` missing.
    .argument("[id]", "a single recording id; omit to download everything matching the filter flags")
    .argument("[folder]", "destination folder, created if missing")
    .option("--from <date>", "only recordings at or after this date")
    .option("--to <date>", "only recordings at or before this date")
    .option("--caller <number>", "partial match on the calling number")
    .option("--called <number>", "partial match on the called number")
    .option("--min-duration <seconds>", "only recordings at least this long")
    .option("--max-duration <seconds>", "only recordings at most this long")
    .option("--type <type>", "call type, e.g. I for inbound")
    .option("--limit <n>", "maximum recordings to download when filtering", "25")
    .option("--all", "download every match, not just the first --limit")
    .option("--filter <json>", "raw API filter array, merged with the flags above")
    .option("--concurrency <n>", "parallel downloads", "4")
    .option("--skip-existing", "leave files already present at the expected size alone")
    .action(async (first, second, cmdOptions) => {
        const options = program.opts();
        applyInsecure(options);
        // One positional means it is the destination; two mean id then folder.
        const id = second === undefined ? undefined : first;
        const folder = second === undefined ? first : second;
        if (!folder) {
            throw new ApiError("a destination folder is required, e.g. vs recording download ./recordings");
        }
        const { client } = authenticatedClient(options);

        let recordings;
        if (id) {
            const body = await client.get(`/monitors/${encodeURIComponent(id)}`);
            const one = body?.data ?? body;
            if (!one?.id) {
                throw new ApiError(`recording ${id} was not found`);
            }
            recordings = [one];
        } else {
            const { data } = await listRecordings(client, {
                filter: buildFilter(cmdOptions),
                limit: Number(cmdOptions.limit),
                all: Boolean(cmdOptions.all),
            });
            recordings = data;
        }

        if (recordings.length === 0) {
            status("No recordings matched - nothing to download.");
            emit({ downloaded: 0, skipped: 0, failed: 0, bytes: 0, files: [] }, { format: options.format });
            return;
        }

        status(`Downloading ${recordings.length} recording(s) to ${folder} …`);
        const results = await downloadAll(client, recordings, folder, {
            concurrency: Number(cmdOptions.concurrency),
            skipExisting: Boolean(cmdOptions.skipExisting),
            onResult: (r, done, total) =>
                status(`[${done}/${total}] ${r.status}: ${r.file ?? r.id}${r.error ? ` - ${r.error}` : ""}`),
        });
        const tally = summarise(results);
        status(`${tally.downloaded} downloaded, ${tally.skipped} skipped, ${tally.failed} failed`);
        // A table wants one row per file; JSON keeps the tally alongside them.
        emit(options.format === "table" ? results : { ...tally, files: results },
             { format: options.format, columns: ["id", "status", "bytes", "file"] });
        if (tally.failed > 0) {
            process.exitCode = 1;
        }
    });

program.addHelpText("after", `
Examples:
  vs auth login                                  log in and store an API token
  vs recording list --format table               the 25 most recent recordings
  vs recording list --all --min-duration 60      every call longer than a minute
  vs recording download 1052333152 ./recordings  one recording, by id
  vs recording download ./recordings --all       every recording

Results are JSON on stdout; prompts and progress go to stderr, so
"vs recording list > out.json" works without extra flags.

Full documentation: https://github.com/VoIPstudio/cli-client`);

download.addHelpText("after", `
Positional arguments:
  Two values mean "<id> <folder>"; a single value is the folder, and the filter
  options decide what gets downloaded.

Examples:
  vs recording download 1052333152 ./recordings
  vs recording download ./recordings --all --skip-existing
  vs recording download ./recordings --from 2026-07-01 --type I --concurrency 8

Downloads cannot resume: the API ignores HTTP Range, so each file is written to
a .part and renamed only once complete and verified against its recorded size.`);

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
