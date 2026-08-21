# Changelog

All notable changes to OpenCode Control are documented in this file.

The project follows [Semantic Versioning](https://semver.org/). The current release line is
an alpha and may still change its local data model and API before `1.0.0`.

## [0.1.0] - 2026-08-17

First release checkpoint for the local-first alpha.

### Added

- Multi-project control plane for managed and external loopback OpenCode servers.
- Session chat with Markdown, tool calls, attachments, permissions, todos, models,
  reasoning variants, Slash Commands, and child subagent Sessions.
- Manual and scheduled Tasks with cron, IANA timezones, run history, reruns, abort,
  pause/resume, and multiple Sessions per Task.
- Project/global management for Agents, Skills, Commands, MCP, providers, secrets,
  `AGENTS.md`, and OpenCode JSON/JSONC configuration.
- Usage dashboard, local full-text Search, Artifacts browser, Git workspace controls,
  and a unified Event Center.
- Responsive Russian and English UI with multiple themes.
- Runtime access token bootstrap through a URL fragment and an `HttpOnly` browser cookie.
- CLI lifecycle commands, isolated scheduler soak runner, and automatic managed-server recovery.
- GitHub Actions for backend, frontend, and clean-wheel smoke tests on Ubuntu and macOS.

### Changed

- Scheduled Task state and per-Session execution outcome are tracked independently.
- A manually continued failed scheduled Session becomes completed only after a later
  assistant response has actually finished.
- macOS project root identity survives APFS device ID changes after reboot while still
  rejecting a replaced workspace root.

### Fixed

- Restored managed projects after Control restart without losing Task or Session history.
- Prevented stale synthetic errors and failed labels after a successful Session continuation.
- Made scheduled-run recovery atomic to prevent premature completion during reconciliation.
- Reported non-terminal `stalled` state after 15 minutes without message progress while
  preserving genuinely running or pending tools and preventing schedule overlap.
- Allowed scheduled Task execution settings to move away from removed provider models.
- Aborted each matching scheduled run independently when several Sessions were active.
- Made frontend archive-download tests portable across Node.js Blob implementations.
- Built frontend assets before backend integration tests in clean CI checkouts.

### Security

- Restricted the HTTP boundary to loopback host, client, and origin.
- Protected API access with a persistent mode-`0600` runtime token.
- Kept write requests behind browser sessions and CSRF validation.
- Added atomic config writes, rollback, root identity checks, path containment, and
  credential redaction.

[0.1.0]: https://github.com/Enzzo657/Opencode-Control/releases/tag/v0.1.0
