# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-10-10

Adds list and download across the API's downloadable entities.

### Added

- `vs voicemail list|download` — voicemail messages (`voicemessages`), audio as
  MP3, filterable by `origtime` date range, caller, dialled number, duration
  and folder.
- `vs fax list|download` — faxes as PDF, named with the filename the API
  supplies (matching the dashboard), filterable by status, type and filename.
  No number filters: the API rejects `from`/`to` there under every operator.
- `vs invoice list|download` — billing transactions; the PDF invoice arrives
  base64-encoded in a JSON envelope and is decoded on the way to disk. An
  invoice for an incomplete transaction is reported as skipped, not failed.
- `vs cdr list`, `vs sms list`, `vs conversation list` — list-only; these have
  no per-record file, and the API's bulk `.csv` endpoints are asynchronous
  export jobs rather than downloads.
- `--from`/`--to` resolve against each entity's own date field (`timestamp`,
  `origtime`, `created_at`, `calldate`). SMS number filters are `--sender` and
  `--recipient`, since `--from`/`--to` are dates everywhere.
- PDF downloads are verified to begin with `%PDF`, so a JSON error page can
  never be saved as a plausible-looking `.pdf`.

### Fixed

- Download error responses now surface the server's message; previously a file
  request's failure was reduced to its HTTP status, hiding explanations like
  "This Transaction is not completed yet".

## [0.1.1] — 2026-10-08

Bug fixes found in real-world use. No functional changes.

### Fixed

- **The password prompt was invisible.** `vs auth login` showed the email
  prompt, then a blank line and nothing else. Hidden input used readline with
  `terminal: true`, whose line redraw writes cursor-move and clear-screen
  escapes directly to the output stream — erasing the prompt that had just been
  written. Hidden input is now read from raw mode directly, with no readline
  involved, and handles backspace, Ctrl+C/Ctrl+D, multi-chunk input and
  terminal escape sequences (an arrow key no longer injects `[D` into the
  password).
- **`npm install` left the working tree dirty.** npm chmods `bin` targets to
  755, but `src/cli.js` was recorded `100644`, so every install produced a
  permanent mode-only diff. The file is now committed executable.
- **Transport failures reported nothing useful.** A failed download said only
  `fetch failed`, because Node's fetch hides the real reason in `err.cause`.
  Causes are now unwrapped on every error path, with specific guidance for TLS
  failures and for malformed responses from an error page.

## [0.1.0] — 2026-10-08

First working release. Implements the authentication and call-recording
commands described in L7D-11663.

### Added

- `vs auth login` — logs in with email and password (handling two-factor when
  the account requires it) and stores a named, revocable `VoIPstudio CLI` API
  token. The login response itself is a 30-minute session token and is never
  persisted.
- `vs auth whoami` — shows the account the stored token belongs to.
- `vs auth logout` — revokes the stored token server-side and forgets it
  locally, clearing local state even when the revoke fails.
- `vs recording list` — lists call recordings, with `--from`, `--to`,
  `--caller`, `--called`, `--min-duration`, `--max-duration` and `--type`
  filters that combine with AND, a `--filter` escape hatch for the raw API
  filter array, and `--all` to page through every match.
- `vs recording download` — downloads recording audio as MP3, either a single
  id or everything matching the filter flags, with `--concurrency` and
  `--skip-existing`. Files are written to a `.part` and renamed only once
  complete and verified against the recording's recorded size.
- Named credential profiles (`--profile`), with resolution order
  `VOIPSTUDIO_API_TOKEN` → named profile → default profile.
- `--format json` (default) and `--format table`. Results go to stdout and
  progress to stderr, so output can be redirected or piped without extra flags.

### Notes

- Not published to npm. Install from source; see the README.
- The two-factor login path has been verified end to end against a 2FA-enabled
  account on production: the API answers `202` with a nonce, the emailed code is
  exchanged via `POST /login2fa`, and the resulting session mints the API token
  normally.

[0.2.0]: https://github.com/VoIPstudio/cli-client/releases/tag/v0.2.0
[0.1.1]: https://github.com/VoIPstudio/cli-client/releases/tag/v0.1.1
[0.1.0]: https://github.com/VoIPstudio/cli-client/releases/tag/v0.1.0
