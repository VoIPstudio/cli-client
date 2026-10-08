# vs — VoIPstudio CLI

Command line client for the [VoIPstudio](https://voipstudio.com) API.

> **Status:** early development. `vs auth`, `vs recording list` and
> `vs recording download` are implemented; packaging and publishing are next.
> See [L7D-11663](https://level7.atlassian.net/browse/L7D-11663).

## Install

Requires Node.js 20 or newer.

```sh
git clone https://github.com/VoIPstudio/cli-client.git
cd cli-client
npm install
npm link        # puts `vs` on your PATH
```

## Usage

```sh
vs auth login       # prompts for email and password, then stores an API token
vs auth whoami      # shows the account the stored token belongs to
vs auth logout      # revokes the stored token and forgets it

vs recording list       # list call recordings
vs recording download   # download recording audio as MP3
```

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

Each download is written to a `.part` file and renamed only once complete, and
its length is checked against the recording's `size`. This matters because
`/monitors/{id}.mp3` **ignores HTTP `Range`** — it always returns the whole body
— so an interrupted download cannot be resumed, and a truncated file left in
place would look complete to the next `--skip-existing` run.

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

## License

[MIT](LICENSE)
