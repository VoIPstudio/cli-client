#!/usr/bin/env node
import { Command, Option } from "commander";
import { readFileSync } from "node:fs";
import { Client, ApiError, describeError, resolveApiUrl, ENV_HOSTS } from "./api.js";
import { clearProfile, configPath, resolveCredentials, saveProfile } from "./config.js";
import { login, mintCliToken, revokeToken, submit2fa, whoami } from "./auth.js";
import { ENTITIES } from "./entities.js";
import { buildFilter, listEntity } from "./list.js";
import { downloadAll, summarise } from "./download.js";
import { prompt, promptHidden, requireTty } from "./prompt.js";
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
        const password = await promptHidden("Password: ");

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

// Every entity registers from the same definition, so adding one is a change
// to entities.js rather than another near-copy of this block.
for (const [name, spec] of Object.entries(ENTITIES)) {
    const group = program.command(name).description(`work with ${spec.plural}`);

    const withFilters = (cmd) => {
        cmd.option("--from <date>", `only ${spec.plural} at or after this date (matches ${spec.dateField})`)
           .option("--to <date>", `only ${spec.plural} at or before this date`);
        for (const flag of Object.keys(spec.filters ?? {})) {
            cmd.option(`--${flag} <value>`, `filter on ${spec.filters[flag].property}`);
        }
        return cmd
            .option("--limit <n>", "maximum rows", "25")
            .option("--all", "fetch every match, paging as needed")
            .option("--filter <json>", "raw API filter array, merged with the flags above");
    };

    withFilters(group.command("list").description(`list ${spec.plural}`))
        .action(async (cmdOptions) => {
            const options = program.opts();
            applyInsecure(options);
            const { client } = authenticatedClient(options);
            const { data, total } = await listEntity(client, spec, {
                filter: buildFilter(spec, cmdOptions),
                limit: Number(cmdOptions.limit),
                all: Boolean(cmdOptions.all),
                onPage: ({ collected, total: all }) =>
                    cmdOptions.all && collected < all ? status(`fetched ${collected}/${all} …`) : undefined,
            });
            status(`${data.length} of ${total} ${spec.plural}`);
            emit(data, { format: options.format, columns: spec.columns });
        });

    if (!spec.download) {
        continue;
    }

    const dl = withFilters(
        group.command("download")
            .description(`download ${spec.plural} as files`)
            // Both positionals are optional because commander cannot resolve an
            // optional argument followed by a required one: given a single value
            // it binds it to `id` and then reports `folder` missing.
            .argument("[id]", `a single ${spec.noun} id; omit to download everything matching the filters`)
            .argument("[folder]", "destination folder, created if missing"),
    )
        .option("--concurrency <n>", "parallel downloads", "4")
        .option("--skip-existing", "leave files already present alone");

    dl.addHelpText("after", `
Positional arguments:
  Two values mean "<id> <folder>"; a single value is the folder, and the filter
  options decide what gets downloaded.

Examples:
  vs ${name} download ./${spec.plural} --all
  vs ${name} download ./${spec.plural} --from 2026-07-01 --concurrency 8
${spec.sizeField
    ? "\nEach file's length is checked against the record's size, so a truncated\ntransfer is detected and discarded."
    : `\nNote: a ${spec.noun} record carries no size, so a short-but-complete response\ncannot be detected. Files are still written to .part and renamed only on\nsuccess, so an interrupted download never leaves a file that looks finished.`}`);

    dl.action(async (first, second, cmdOptions) => {
        const options = program.opts();
        applyInsecure(options);
        // One positional means it is the destination; two mean id then folder.
        const id = second === undefined ? undefined : first;
        const folder = second === undefined ? first : second;
        if (!folder) {
            throw new ApiError(`a destination folder is required, e.g. vs ${name} download ./out`);
        }
        const { client } = authenticatedClient(options);

        let records;
        if (id) {
            const body = await client.get(`/${spec.resource}/${encodeURIComponent(id)}`);
            const one = body?.data ?? body;
            if (!one?.id) {
                throw new ApiError(`${spec.noun} ${id} was not found`);
            }
            records = [one];
        } else {
            const { data } = await listEntity(client, spec, {
                filter: buildFilter(spec, cmdOptions),
                limit: Number(cmdOptions.limit),
                all: Boolean(cmdOptions.all),
            });
            records = data;
        }

        if (records.length === 0) {
            status(`No ${spec.plural} matched - nothing to download.`);
            emit({ downloaded: 0, skipped: 0, failed: 0, bytes: 0, files: [] }, { format: options.format });
            return;
        }

        status(`Downloading ${records.length} ${spec.plural} to ${folder} …`);
        const results = await downloadAll(client, spec, records, folder, {
            concurrency: Number(cmdOptions.concurrency),
            skipExisting: Boolean(cmdOptions.skipExisting),
            onResult: (r, done, total) =>
                status(`[${done}/${total}] ${r.status}: ${r.file ?? r.id}${r.error ? ` - ${r.error}` : ""}${r.reason ? ` - ${r.reason}` : ""}`),
        });
        const tally = summarise(results);
        status(`${tally.downloaded} downloaded, ${tally.skipped} skipped, ${tally.failed} failed`);
        emit(options.format === "table" ? results : { ...tally, files: results },
             { format: options.format, columns: ["id", "status", "bytes", "file"] });
        if (tally.failed > 0) {
            process.exitCode = 1;
        }
    });
}

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

program.showHelpAfterError();

try {
    await program.parseAsync(process.argv);
} catch (err) {
    status(`error: ${describeError(err)}`);
    process.exitCode = 1;
}
