# vs — VoIPstudio CLI

[![npm version](https://img.shields.io/npm/v/voipstudio.svg)](https://www.npmjs.com/package/voipstudio)
[![node](https://img.shields.io/node/v/voipstudio.svg)](https://www.npmjs.com/package/voipstudio)
[![license](https://img.shields.io/npm/l/voipstudio.svg)](https://github.com/VoIPstudio/cli-client/blob/main/LICENSE)

Command line client for the [VoIPstudio](https://voipstudio.com) API.

> **Status:** early but working. Authentication, and list/download across seven
> entity types. See the [changelog](https://github.com/VoIPstudio/cli-client/blob/main/CHANGELOG.md).

## Install

Published on npm as [**`voipstudio`**](https://www.npmjs.com/package/voipstudio).
Requires Node.js 20 or newer.

```sh
npm install -g voipstudio
```

That installs the `vs` command. Check it worked:

```sh
vs --version
vs --help
```

To run it without installing globally:

```sh
npx voipstudio --help
```

Upgrading later:

```sh
npm update -g voipstudio      # or: npm install -g voipstudio@latest
```

<sup>If `npm install -g voipstudio` resolves to an old version, your npm cache
may be stale — add `--prefer-online`.</sup>

### From source

```sh
git clone https://github.com/VoIPstudio/cli-client.git
cd cli-client
npm install
npm link        # puts `vs` on your PATH
```

`npm link` can be undone with `npm unlink -g voipstudio`. If either command
fails with a permissions error, your global `node_modules` isn't writable by
your user — either use `sudo`, point npm somewhere you own
(`npm config set prefix ~/.local`, then add `~/.local/bin` to `PATH`), or skip
the link entirely and run `node src/cli.js …` from the checkout.

## Usage

```sh
vs auth login       # prompts for email and password, then stores an API token
vs auth whoami      # shows the account the stored token belongs to
vs auth logout      # revokes the stored token and forgets it

vs recording list       # call recordings      (download: MP3)
vs voicemail list       # voicemail messages    (download: MP3)
vs fax list             # sent/received faxes   (download: PDF)
vs invoice list         # billing transactions  (download: PDF)
vs cdr list             # call detail records
vs sms list             # SMS messages
vs conversation list    # conversations
```

Every entity supports `list`; the four with files also support `download`.

Results are printed as JSON on stdout; prompts, progress and warnings go to
stderr. That means you can redirect or pipe without any extra flags:

```sh
vs auth whoami > me.json
vs auth whoami | jq .email
```

Add `--format table` for human-readable output instead:

```console
$ vs auth whoami --format table
id     email              first_name  last_name  customer_id
-----  -----------------  ----------  ---------  -----------
10002  jsmith@example.com John        Smith      2
```

## Entities

| Command | API resource | Date field | Download |
| --- | --- | --- | --- |
| `vs recording` | `monitors` | `timestamp` | `.mp3` |
| `vs voicemail` | `voicemessages` | `origtime` | `.mp3` |
| `vs fax` | `faxes` | `created_at` | `.pdf` |
| `vs invoice` | `transactions` | `created_at` | `.pdf` |
| `vs cdr` | `cdrs` | `calldate` | — |
| `vs sms` | `sms` | `created_at` | — |
| `vs conversation` | `conversations` | `created_at` | — |

`--from` and `--to` are **date bounds on every entity**, resolved against that
entity's own date field — so `vs cdr list --from 2026-09-01` filters on
`calldate` while `vs voicemail list --from …` filters on `origtime`.

Because SMS also has `from`/`to` *numbers*, number filters are named
`--sender` and `--recipient` to avoid the collision. Run
`vs <entity> list --help` for the filters a given entity accepts — they differ,
and only the ones the API actually supports are offered. Fax, for instance, has
no number filter at all: the API rejects `from`/`to` there under every operator.

CDR, SMS and conversation have no per-record file. The API does offer bulk CSV
(`/cdrs.csv` and friends), but those are **asynchronous export jobs** returning
`202` and queueing a task rather than streaming a file, so they are not wired up
here.

## Call recordings

```sh
vs recording list                                  # most recent 25
vs recording list --all                            # every match, paging as needed
vs recording list --from 2026-07-01 --to 2026-07-31
vs recording list --caller 4478 --min-duration 60
vs recording list --type I --format table
```

| Option | Meaning |
| --- | --- |
| `--from` / `--to` | date bounds, `YYYY-MM-DD` or a full `YYYY-MM-DD HH:MM:SS` |
| `--caller` / `--called` | partial match on the number |
| `--min-duration` / `--max-duration` | bounds in seconds |
| `--type` | call type, e.g. `I` for inbound |
| `--limit` | maximum rows, default 25 |
| `--all` | fetch every match, paging automatically |
| `--filter` | raw API filter array, merged with the flags above |

Flags combine with AND. For anything the flags don't cover, `--filter` takes the
API's own filter array and merges it with them:

```sh
vs recording list --filter '[{"property":"duration","operator":"gt","value":60}]'
```

Supported operators are `eq`, `like`, `gt`, `gte`, `lt` and `lte`. Note the API
has **no `between`** operator — a range is a `gte` plus an `lte`, which is what
`--from`/`--to` generate for you. An unsupported operator is rejected locally
rather than being sent and coming back as an opaque `400`.

### Downloading audio

```sh
vs recording download 1052333152 ./recordings          # one, by id
vs recording download ./recordings --all               # everything
vs recording download ./recordings --from 2026-07-01 --type I --concurrency 8
vs recording download ./recordings --all --skip-existing
```

The same filter flags as `list` apply. With **two** positional arguments the
first is a recording id; with **one**, it is the destination folder and the
filter flags choose what to download. The folder is created if missing.

| Option | Meaning |
| --- | --- |
| `--concurrency <n>` | parallel downloads, default 4 |
| `--skip-existing` | leave files already present at the expected size alone |
| `--limit` / `--all` | how many matches to take, as for `list` |

Files are named `<timestamp>_<caller>-<called>_<id>.mp3`, because the API sends
no `Content-Disposition` header. The id is always included, so two calls in the
same second between the same parties cannot collide.

Each download is written to a `.part` file and renamed only once complete. This
matters because the file endpoints **ignore HTTP `Range`** — they always return
the whole body — so an interrupted download cannot be resumed, and a truncated
file left in place would look complete to the next `--skip-existing` run.

Only recordings carry a `size` field, so only they can have their length
verified against the record. For voicemail, fax and invoices a response that is
short but ends cleanly cannot be detected.

PDF downloads are checked to actually begin with `%PDF`. That is not paranoia:
the invoice endpoint answers `200 application/json` with the document
base64-encoded as `{"data":{"base64":…}}` rather than streaming it, and writing
that envelope verbatim produced 25 kB of JSON in a file named `.pdf` which
looked like a perfectly successful download.

An invoice for an incomplete transaction has no PDF yet. That is reported as
**skipped** rather than failed, so a bulk run's exit status stays meaningful.

One failure does not abort a batch: it is reported against that recording and
the rest continue. The exit status is `1` if anything failed.

## Authentication

`vs auth login` asks for your VoIPstudio email and password (and a two-factor
code, if your account has 2FA enabled), then **mints a named, revocable API
token** called `VoIPstudio CLI` and stores that. The login response itself is a
session token that expires after 30 minutes, so it is never what gets saved —
the API token has a 30-day idle expiry that is refreshed on every request, so
regular use never requires logging in again.

You can see and revoke the token at any time under **Settings → API tokens** in
the VoIPstudio web app. Logging in again replaces the existing `VoIPstudio CLI`
token rather than creating a second one.

### Credential storage

Credentials are written to `$XDG_CONFIG_HOME/voipstudio/config.json`
(`~/.config/voipstudio/config.json` by default) with mode `0600`. Your password
is never stored.

The token is resolved in this order:

1. the `VOIPSTUDIO_API_TOKEN` environment variable
2. the profile named by `--profile <name>`
3. the current default profile

Setting `VOIPSTUDIO_API_TOKEN` lets CI authenticate with no config file at all.
Because `vs` did not mint such a token, `vs auth logout` will refuse to revoke
it and tells you so rather than silently doing nothing.

### Multiple accounts

```sh
vs --profile work auth login
vs --profile work auth whoami
```

Each profile remembers the API host it was created against, so a token minted
against one environment is never replayed against another.

## Global options

| Option | Description |
| --- | --- |
| `--profile <name>` | named credential profile to use |
| `--api-url <url>` | full API base URL, overriding `--env` |
| `--env <name>` | API environment: `prod` (default), `dev`, `test` |
| `--format <json\|table>` | output format, default `json` |
| `--insecure` | skip TLS verification — internal hosts with self-signed certificates only |

`VOIPSTUDIO_API_URL` and `VOIPSTUDIO_ENV` are honoured as equivalents of
`--api-url` and `--env`.

## Development

```sh
npm test            # node:test, no test framework dependency
node src/cli.js --help
```

The only runtime dependency is [`commander`](https://github.com/tj/commander.js)
for argument parsing; everything else uses the Node standard library.

## Support

**Questions about your VoIPstudio account, numbers, billing or the platform
itself** go to VoIPstudio support — see
[voipstudio.com/support](https://voipstudio.com/support/):

| Channel | Availability |
| --- | --- |
| **Live chat and phone** | Monday–Friday, 08:00–23:00 UTC. Live chat is opened from inside the dashboard. |
| **Ticket** | Around the clock, every day — usually answered within two hours. Opened from the dashboard. |
| **Remote desktop** | Screen sharing via AnyDesk, on Windows, macOS and Linux. |

Phone: **+44 203 695 8964** (UK) · **+1 414 435 9681** (US). Have your customer
number ready. Sales enquiries: <sales@voipstudio.com>.

**Bugs or feature requests for this CLI** belong on the issue tracker instead,
where they reach the people who maintain the code:
[github.com/VoIPstudio/cli-client/issues](https://github.com/VoIPstudio/cli-client/issues).
Including the output of `vs --version` and the failing command makes them much
quicker to act on.

## License

[MIT](https://github.com/VoIPstudio/cli-client/blob/main/LICENSE)
