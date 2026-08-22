# Changelog

All notable changes to OpenCode Control are documented in this file.

The project follows [Semantic Versioning](https://semver.org/). The current release line is
an alpha and may still change its local data model and API before `1.0.0`.

## [0.2.2] - 2026-08-22

### Fixed

- Removed misleading elapsed durations from user messages while preserving exact timestamps.
- Stabilized the project/global configuration save test against React scheduling differences
  on slower CI runners.

## [0.2.1] - 2026-08-22

### Fixed

- Stopped presenting a Session's full lifetime as the duration of one Task run.
- Marked unfinished tools as stopped when a later message supersedes them.
- Bounded superseded message and tool durations by the next message timestamp instead of
  continuously accumulating elapsed time.

## [0.2.0] - 2026-08-22

### Added

- Grouped Task-linked Sessions on both the Tasks and Sessions screens.
- Added a reusable Task Sessions browser with exact creation dates, relative time,
  duration, model, agent, usage, status, direct open, and delete actions.
- Added exact message timestamps and clock times for reasoning, tool, and completion steps.
- Added a compact accessible Task overflow menu for configuration, schedule state, and delete.
- Added localized `stalled` Session/run state and Event Center warnings.

### Changed

- Replaced repeated Session chips on Task cards with a single `Sessions · N` action.
- Separated Task schedule state from individual Session outcomes across every screen.
- Allowed scheduled Task execution settings to move away from removed provider models.
- A scheduled run with no message progress becomes terminal `stalled` without aborting
  its OpenCode execution, so the next cron occurrence remains available.
- A late successful response changes the old run from `stalled` to `completed`.

### Fixed

- Prevented stale synthetic errors and inconsistent status labels after continuation.
- Made scheduled-run recovery atomic and aborted each matching run independently.
- Preserved genuinely running or pending tools regardless of elapsed time.
- Made frontend archive-download tests portable across Node.js Blob implementations.
- Built frontend assets before backend integration tests in clean CI checkouts.

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

### Fixed

- Restored managed projects after Control restart without losing Task or Session history.
- Made macOS project root identity survive APFS device ID changes after reboot while still
  rejecting a replaced workspace root.

### Security

- Restricted the HTTP boundary to loopback host, client, and origin.
- Protected API access with a persistent mode-`0600` runtime token.
- Kept write requests behind browser sessions and CSRF validation.
- Added atomic config writes, rollback, root identity checks, path containment, and
  credential redaction.

[0.1.0]: https://github.com/Enzzo657/Opencode-Control/releases/tag/v0.1.0
[0.2.0]: https://github.com/Enzzo657/Opencode-Control/compare/v0.1.0...v0.2.0
[0.2.1]: https://github.com/Enzzo657/Opencode-Control/compare/v0.2.0...v0.2.1
[0.2.2]: https://github.com/Enzzo657/Opencode-Control/compare/v0.2.1...v0.2.2
