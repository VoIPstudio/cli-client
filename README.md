# vs — VoIPstudio CLI

Command line client for the [VoIPstudio](https://voipstudio.com) API.

> **Status:** early development. Authentication (`vs auth`) is implemented;
> call recording commands (`vs recording list` / `vs recording download`) are
> next. See [L7D-11663](https://level7.atlassian.net/browse/L7D-11663).

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
