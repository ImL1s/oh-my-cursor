# Project status

Oh My Cursor (`omcu`) is a capability-grounded orchestration foundation for Cursor Agent. Version `0.2.1` prioritizes honest feature detection, bounded local state, repeatable evidence, and conservative recovery over claims of native orchestration.

## Goals

- Wrap documented Cursor Agent session and output surfaces without shell interpolation.
- Pin and live-probe the supported Cursor Agent capability baseline.
- Keep project workflow state owner-only, revisioned, redacted, and CLI-authored.
- Package Cursor commands, skills, agents, rules, hooks, and an MCP definition as one plugin.
- Separate Cursor-backed behavior, experimental local coordination, and unsupported native primitives.
- Make install, update, readback, and uninstall receipt-driven and collision-aware.

## Version scope

| Area | Status | Authority |
| --- | --- | --- |
| Cursor capability discovery | Implemented | Live probe compared with pinned lock |
| Sessions: create, list, resume, continue | Implemented | Cursor Agent |
| Run state, events, and leases | Implemented | `omcu` CLI only |
| Workflow/mode libraries | Implemented | Advisory until explicit run verification |
| Project memory, recovery, compaction, tracker, wiki | Implemented | Local project data; not Cursor-native memory |
| Notifications | Implemented as disabled-by-default service | No network transport configured |
| MCP read/proposal tools | Implemented | Non-authoritative; no shell or verification tools |
| Worktree parallelism | Experimental | Local Git worktrees; not a native Cursor team |
| tmux team supervisor | Experimental | Local tmux; not a native Cursor team |
| Native Cursor team/workflow command | Unsupported | Not advertised by the pinned CLI help |
| Cursor memory/notification CLI | Unsupported as a native claim | Not documented by Cursor |

## Host baseline

The repository pins Cursor Agent `2026.07.23-e383d2b`. A different version is not automatically unsafe, but every locked capability is downgraded until the lock is deliberately refreshed and tested.

Cursor documentation confirms interactive and non-interactive CLI operation, session resume, Ask/Plan modes, plugins, rules, skills, hooks, MCP, subagents, and terminal tools. It does not document a native `team` or general workflow-engine command in the pinned CLI surface. OMCU therefore labels worktree and tmux coordination as local implementations.

## Release acceptance

A release candidate is ready only when:

1. package, plugin, and lock versions agree;
2. `npm ci`, `npm run check`, CLI help, and docs sanity pass;
3. `omcu capabilities discover` succeeds against the pinned live host;
4. install/update/readback/uninstall pass in an isolated temporary home and project;
5. release archive checksums are generated and independently verified;
6. known warnings and external/manual seams are recorded in `TEST_READY.md`.

See [Release process](docs/releasing.md) and [Live verification](docs/live-verification.md).
