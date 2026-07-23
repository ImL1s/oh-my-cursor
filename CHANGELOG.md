# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Changed

- No unreleased changes recorded.

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
