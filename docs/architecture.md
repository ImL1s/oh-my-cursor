# Architecture

English | [简体中文](./architecture.zh.md) | [繁體中文](./architecture.zh-TW.md)

Oh My Cursor is a local TypeScript package and Cursor plugin. It delegates agent behavior to Cursor Agent, but keeps its own evidence and lifecycle state separate.

## Boundaries

```text
Cursor Agent
  interactive / --print / Ask / Plan / sessions
             |
             v
src/host + src/capabilities + src/sessions
             |
             v
omcu CLI ------------------> <project>/.omcu/
  |                              owner-only state
  +--> workflow and mode libraries
  +--> local services
  +--> experimental worktrees/tmux

setup lifecycle -----------> ~/.local/state/oh-my-cursor/
                               immutable stages + receipts
```

### Host adapter

`src/host/` constructs bounded argument arrays and invokes `cursor-agent` directly with `shell: false`. JSON and stream-JSON output are size-bounded before parsing. Standard error is redacted.

`src/capabilities/` compares the live `--version` and `--help` surfaces with `omcu_capabilities.lock.json`. Exact mismatch downgrades every capability claim.

`src/sessions/` maps OMCU session commands to `create-chat`, `ls`, `--resume`, and `--continue`. Interactive resume/continue inherits Cursor's terminal UI; a supplied prompt uses JSON print mode.

### State and authority

`src/runtime/` creates owner-only roots, prevents path escapes and symlink roots, performs atomic writes, and redacts sensitive fields.

`src/state/` stores runs, events, and leases beneath `.omcu/`. Run transitions use optimistic revisions. Leases use owner, generation, and expiry fences. A terminal run is not verified until `omcu run verify` records a fresh SHA-256 evidence digest.

Workflow receipts, mode results, team collection, hooks, and MCP proposals deliberately contain `verified: false`. They can supply evidence but cannot accept their own work.

### Workflows and coordination

`src/workflows/` validates immutable workflow definitions, builds dependency-ordered plans, invokes Cursor in Ask or Plan mode, and emits digest-chained events and receipts.

`src/modes/` contains RALPLAN, Ralph, worktree-based ULW, and advisory plan/review/QA/acceptance gates. These are OMCU implementations, not documented native Cursor workflow commands.

`src/team/` supervises an experimental tmux session. It records pane process groups, rejects overlapping path ownership, captures output, and reports `native_cursor_team: false`. Cursor's documented subagent surface remains the preferred in-agent parallelism mechanism.

### Project services

- `src/recovery/`: copies an immutable, redacted tail of an explicitly named JSONL source.
- `src/compaction/`: generation-fenced checkpoints.
- `src/memory/`: redacted project-local records and imports/exports; not native Cursor memory.
- `src/notify/`: disabled-by-default queue and transport boundary; not native Cursor notifications.
- `src/tracker/` and `src/wiki/`: lifecycle history and derived pages.
- `src/mcp/`: fixed read/proposal tools; structurally refuses shell and verification authority.

### Plugin surfaces

`.cursor-plugin/plugin.json` connects slash commands, skills, custom agents, rules, hooks, and `.mcp.json`. The hook implementation validates and redacts input but returns neutral policy responses. The shipped MCP manifest is empty; loading a server requires explicit project configuration.

See [Cursor integration](cursor-integration.md) and [Security policy](../SECURITY.md).
