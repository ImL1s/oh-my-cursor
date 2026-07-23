# oh-my-cursor

Capability-grounded orchestration for Cursor Agent.

- Package: `@iml1s/oh-my-cursor`
- CLI: `omcu`
- Version: `0.1.0`
- Node.js: 20+
- Pinned Cursor Agent: `2026.07.20-8cc9c0b`
- Project state: `.omcu/` (owner-only, CLI-authored)

Oh My Cursor wraps documented Cursor Agent capabilities and labels everything else honestly. It supports interactive and headless sessions, Ask/Plan modes, resume/continue, plugins, skills, hooks, MCP, subagents, workflow evidence, and local recovery. It does **not** claim a documented native Cursor team/workflow command, a native memory/notification CLI, or a security-isolation boundary.

> **Important:** Cursor documents `--print` as non-interactive with access to write and shell tools. `--print` is not read-only by itself. Use Ask or Plan mode for read-only agent lanes and keep OS isolation/approval controls separate.

## Quick start

```sh
npm ci
npm run build
npm test
node dist/bin/omcu.js --version
node dist/bin/omcu.js capabilities discover
cursor-agent --plugin-dir "$PWD"
```

The last command loads the plugin for one Cursor invocation and does not modify `~/.cursor`.

## Install

### From source

```sh
npm ci
npm run build
./scripts/install.sh --source "$PWD" --project /absolute/path/to/project
```

This stages immutable package bytes under `~/.local/state/oh-my-cursor/`, creates `~/.local/bin/omcu`, initializes the project's `.omcu/`, and prints a receipt. Add `~/.local/bin` to `PATH` if needed.

### From an offline release

With an existing checkout or extracted release:

```sh
./scripts/install.sh \
  --archive /absolute/path/to/iml1s-oh-my-cursor-0.1.0.tgz \
  --checksums /absolute/path/to/SHA256SUMS \
  --project /absolute/path/to/project
```

For the first offline bootstrap, verify the checksum, extract the `.tgz`, and run `package/scripts/install.sh` from the extracted release. The installer verifies the archive again and rejects unsafe archive paths before its managed extraction. See [Installation and lifecycle](docs/installation.md) for the exact bootstrap, source/release update, manual plugin loading, readback, rollback, and receipt-based uninstall.

## What `omcu` provides

| Area | Commands | Truth boundary |
| --- | --- | --- |
| Host | `capabilities`, `native-status`, `session`, `resume` | Delegates to the pinned Cursor Agent CLI. |
| Authority | `state`/`run`, `cancel`, `lease` | Only this path can mutate run verification. |
| Local services | `recover`, `compact`, `memory`, `notify`, `tracker`, `wiki` | Project-local; not native Cursor services. |
| Plugin/MCP | `mcp-install`, `mcp-server` | Fixed read/proposal MCP tools; no shell or verification authority. |
| Workflows | `workflow`, `ralplan`, `ralph`, `autopilot`, `review`, `qa`, `accept` | Receipts and gates remain advisory and `verified: false`. |
| Persistence | `persist start`/`status`/`done`/`stop` | Opt-in "boulder never stops" loop via the `stop`/`subagentStop` hooks; never fabricates completion. |
| Parallel work | `ulw`, `team` | Worktrees/tmux are experimental local coordination, not native Cursor teams. |

Run `omcu --help` for the command index and read the [full CLI reference](docs/cli.md) for options and examples.

ULW retains every worktree after a worker is invoked so uncommitted edits and
detached commits remain integratable; receipts include the retained path and
Git evidence. Workflow runs with an orphaned `task_started` intent report
`ambiguous` and never automatically rerun uncertain side effects. See the CLI
reference for manual reconciliation and cleanup guidance.

## State and verification

Installation state and project state are deliberately separate:

```text
~/.local/state/oh-my-cursor/   immutable stages, current pointer, receipts
<project>/.omcu/               runs, evidence, workflows, recovery, local services
```

A completed workflow or subagent response is not verified. The authoritative sequence is:

```sh
omcu state create --id release-0.1.0 --objective "verify release"
omcu state transition --id release-0.1.0 --revision 1 --status complete
omcu state verify --id release-0.1.0 --revision 2 --evidence-sha256 <64-hex-digest>
omcu state status --id release-0.1.0
```

Transitions use revision fences and clear earlier verification. Evidence must be a lowercase SHA-256 digest from a fresh, stable result.

## Cursor integration

The plugin bundles commands, skills, custom agents, rules, and hooks. The shipped `.mcp.json` is empty so installation does not silently enable a server; run `omcu mcp-install` only when the project should expose OMCU's local MCP tools.

Cursor's official documentation:

- [CLI overview](https://cursor.com/docs/cli/overview), [usage](https://cursor.com/docs/cli/using), [parameters](https://cursor.com/docs/cli/reference/parameters), and [output formats](https://cursor.com/docs/cli/reference/output-format)
- [Plugins](https://cursor.com/docs/plugins), [rules](https://cursor.com/docs/rules), [skills](https://cursor.com/docs/skills), [subagents](https://cursor.com/docs/subagents), [hooks](https://cursor.com/docs/hooks), and [MCP](https://cursor.com/docs/mcp)
- [Terminal tool](https://cursor.com/docs/agent/tools/terminal)

See [Cursor integration](docs/cursor-integration.md) for capability tiers, session routing, plugin surfaces, worktrees, and tmux compatibility.

## Recovery warning

Native `resume`/`continue` is preferred. The fallback JSONL recovery service accepts one explicit absolute file and copies only the last **900 lines**. It records truncation and partial/unknown/broken-chain warnings. A recovery snapshot may be incomplete and can never establish completion or verification. See [Session recovery](docs/recovery.md).

## Development and release

```sh
npm run check
node dist/bin/omcu.js --help
node dist/bin/omcu.js capabilities discover
```

- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [Project status](PROJECT.md)
- [Test readiness](TEST_READY.md)
- [Live verification](docs/live-verification.md)
- [Release process and assets](docs/releasing.md)
- [Changelog](CHANGELOG.md)

License: [MIT](LICENSE).
