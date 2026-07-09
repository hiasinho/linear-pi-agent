# Changelog

## Unreleased

Changes since `v0.1.0`.

### Added

- Linear progress updates for Pi SDK session events, including session start, thinking, tool execution, context compaction, retries, and tool errors.
- A start activity when the service receives a Linear agent session and begins work.
- `POSSIBLE_IMPROVEMENTS.md` with prioritized follow-up ideas for progress reporting and operational polish.
- Recommended hosting guidance and a short roadmap in the README.
- Configurable Pi progress heartbeats through `PI_PROGRESS_HEARTBEAT_MS`.
- Unit tests for progress deduplication, event mapping, sanitization, and heartbeat behavior.

### Changed

- Initialize the Pi SDK theme for non-interactive runs so installed extensions with background widgets do not crash the service.
- Improve tool argument summaries by recognizing `cmd` as well as `command`.
- Upgrade `@earendil-works/pi-coding-agent` to `^0.80.3` and add `undici`.
- Upgrade dependency ranges for `express` to `^4.22.2` and `tsx` to `^4.23.0`.
- Deduplicate pending and already-sent Linear progress updates, stop generic `turn_start` progress spam, sanitize tool progress, and flush pending progress before Pi error or timeout results.

### Security

- Add optional `INSTALL_SECRET` protection for `/linear/install`, accepted through `?install_secret=` or a Bearer token.
- Document public endpoint protections, Linear webhook signature expectations, and deployment security considerations.
- Update transitive dependencies to clear the `qs`/`express` and `esbuild` npm audit findings.

## 0.1.0 - 2026-05-12

Initial public release of Linear Pi Agent.

### Added

- Linear OAuth install flow, webhook endpoint, and agent session handling.
- Pi SDK session execution against a configured repository.
- Local persistence for Linear tokens, OAuth state, and Pi session data.
- Follow-up prompt handling for existing Linear agent sessions.
- Setup, deployment, and systemd documentation.
