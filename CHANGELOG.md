# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed

- Capability lock refreshed to Cursor Agent `2026.07.23-e383d2b` (help surfaces
  unchanged; prior pin `2026.07.20-8cc9c0b` would fail `verified` on current hosts).

### Fixed

- Install / bootstrap no longer exit `2` when post-install doctor only soft-warns.
  A written receipt is treated as success (`curl | bash` no longer looks failed).
  `omcu doctor` still exits `2` for warnings when run on its own.
- `plugin_dir` doctor check: accepting `--plugin-dir` is a **pass** with an
  explicit note that session skill activation is not proven by `--help` (was a
  permanent warn on every healthy install).
- Clearer `E_OBJECTIVE_REQUIRED` usage hint for `omcu autopilot` / related modes.

## 0.2.1 - 2026-07-24

Release-hygiene patch: no product/runtime changes from 0.2.0 — the tag now
includes the convenience installer and hardened CI that landed on `main` after
0.2.0 was cut.

### Added

- One-line bootstrap installer (`scripts/bootstrap.sh`): `curl -fsSL
  .../scripts/bootstrap.sh | bash` resolves the latest release (or `OMCU_TAG`),
  verifies the checksum before anything executes, and hands off to the packaged
  receipt-based installer.

### Changed

- CI runs a Node 20/22 matrix with read-only permissions, concurrency
  cancellation, and package-surface + version-sync gates.

## 0.2.0 - 2026-07-23

### Added

- **Persistent execution ("the boulder never stops")** — an opt-in loop that
  keeps a completed Cursor turn going instead of idle-stopping, driven by the
  native `stop`/`subagentStop` hooks returning a `followup_message`.
  - `omcu persist start --goal "<goal>" [--max-loops N] [--deadline-min M]`,
    plus `omcu persist status|done|stop` and the read-only `omcu persist decide`
    oracle the hook consults.
  - Bounded three ways — Cursor's `loop_limit` (500), the `--max-loops` ceiling,
    and the `--deadline-min` wall clock. A user abort or a turn error never
    continues; only a clean `completed` status may loop.
  - The follow-up directive re-injects the working goal and never fabricates
    `passes`/`verified`/completion; the CLI verification transition remains the
    only authority. The hook is pure read + decide and fails open to a normal
    stop on any missing/malformed state or CLI problem.

### Fixed

- Hook entrypoint detection now compares realpaths, so the hook still fires
  when invoked through a symlinked path (macOS `/tmp` → `/private/tmp`, npm's
  package symlinks, symlinked homes). The previous `import.meta.url` string
  match silently no-op'd the entire hook in those installs.

### Security

- The persist hook never mutates state: Cursor owns the loop budget and the
  `omcu` CLI owns the goal/ceiling/deadline/done flag. State reads refuse
  symlinks and out-of-bounds or wrong-schema objects (fail-safe = inactive).
- Persist continues ONLY on an explicit `status === 'completed'`; a missing or
  non-string status is treated as a non-completed turn and halts, so an
  incomplete Cursor payload can never re-arm the loop after an abort/error.

## 0.1.0 - 2026-07-23

### Added

- `omcu` CLI for lifecycle checks, pinned capability discovery, Cursor sessions, revisioned run state, events, leases, recovery, compaction, project memory, notification queueing, tracking, wiki rendering, MCP, workflows, modes, worktrees, and experimental tmux coordination.
- Cursor Agent adapter with shell-free bounded arguments, bounded JSON/stream-JSON parsing, redacted diagnostics, and exact session routing.
- Capability lock for Cursor Agent `2026.07.20-8cc9c0b`, with full downgrade on version or help drift.
- Owner-only `.omcu/` project state with atomic writes, optimistic revisions/generations, and explicit SHA-256 verification evidence.
- Receipt-based source and offline-archive install/update/uninstall lifecycle with immutable stages, digest checks, collision preservation, and rollback.
- Cursor plugin packaging for slash commands, Agent Skills, custom subagents, rules, lifecycle hooks, and MCP configuration.
- Immutable workflow definitions, plans, digest-chained receipts, RALPLAN, Ralph, advisory autopilot gates, Git worktree workers, and an experimental tmux supervisor.
- Bounded 900-line JSONL recovery with immutable copies and partial/unknown/broken-chain warnings.
- Disabled-by-default notification service and fixed MCP read/proposal tools that refuse shell and verification authority.
- Release, security, contribution, architecture, installation, CLI, recovery, and live-verification documentation.

### Security

- Hooks and stored values redact common credential fields and inline secret patterns.
- Workflow, subagent, MCP, notification, recovery, and team output cannot self-assert verified state.
- Documentation explicitly distinguishes non-interactive print mode from Ask/Plan read-only modes and makes no native Cursor team, workflow, memory, notification, or isolation claim.
