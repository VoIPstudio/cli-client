# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- The two-factor login path is implemented but has not been exercised against a
  2FA-enabled account.

[0.1.0]: https://github.com/VoIPstudio/cli-client/releases/tag/v0.1.0
