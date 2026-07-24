# Security policy

## Supported version

Security fixes are provided for the current `0.1.x` line. This repository is pre-1.0; upgrade to the newest patch before reporting a problem.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository. Include:

- affected version and operating system;
- the smallest reproducible case;
- expected and observed authority boundaries;
- whether secrets, project state, install state, or command execution are involved;
- logs with credentials and private paths removed.

Do not include API keys, authentication cookies, Cursor transcripts, or contents of `.omcu/`.

## Security model

Oh My Cursor reduces accidental authority; it is not a security sandbox.

| Tier | Meaning |
| --- | --- |
| Pinned | A live `cursor-agent --version` and `--help` probe matches `omcu_capabilities.lock.json`. |
| Cursor-backed | The feature uses a documented Cursor Agent surface such as sessions, Ask/Plan mode, output formats, plugins, rules, hooks, MCP, or subagents. |
| Experimental local | The feature is implemented locally with Git worktrees or tmux and is explicitly not native Cursor orchestration. |
| Unsupported | The pinned Cursor Agent surface does not advertise the required primitive. |

Important boundaries:

- `cursor-agent --print` is non-interactive, **not** read-only. Cursor documents that print mode has write and shell tools. Use Ask or Plan mode when the task must be read-only, then verify the live capability probe.
- Hooks validate and redact lifecycle input. They do not grant permissions, prove isolation, or mark work complete.
- Workflow receipts, subagent output, MCP proposals, memory records, notifications, and tmux collection never establish acceptance.
- Experimental `omcu team` / `omcu team api` (mailbox/tasks under `.omcu/state/team/`) is local coordination only: `native_cursor_team` remains false and never stamps `verified`.
- Only the `omcu run transition` and `omcu run verify` path may mutate authoritative run completion and verification state. Verification requires a 64-character lowercase SHA-256 evidence digest and a matching revision.
- Project state is owner-only under `<project>/.omcu/`. Installation receipts and immutable release stages live separately under `~/.local/state/oh-my-cursor/` by default.
- Notification delivery is disabled by default, generation-fenced, and has no configured network transport.

See [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters), [Cursor hooks](https://cursor.com/docs/hooks), and [Cursor MCP](https://cursor.com/docs/mcp) for host behavior. Cursor's sandbox and approval controls remain Cursor features and must be configured independently.
