# CLI reference

English | [简体中文](./cli.zh.md) | [繁體中文](./cli.zh-TW.md)

All commands operate on the current working directory unless a path option says otherwise. Project services write under `<cwd>/.omcu/`. Output is JSON except interactive Cursor sessions, rendered checkpoint text, and direct Cursor output.

```sh
omcu --help
omcu --version
omcu --json-errors <command> ... # structured stderr: code, command_path, token, message, usage
```

## Host launch (interactive / madmax)

OMX-aligned entry:

```sh
omcu                         # interactive cursor-agent (+ --plugin-dir)
omcu "fix the failing tests" # interactive with initial prompt
omcu prompt "workflow"       # explicit one-word prompt
omcu --prompt "workflow"     # explicit prompt flag form
omcu --madmax                # break-glass: --yolo --sandbox disabled
omcu --madmax --direct …     # never wrap tmux
omcu --madmax --tmux …       # require tmux (fail closed if missing)
```

The single-token shorthand is used only when the token is more than two edits from every known OMCU command. Command-like typos fail closed through the CLI parser; use `prompt` or `--prompt` for an unambiguous one-word prompt.

`--madmax` maps to Cursor `--yolo --sandbox disabled` and always loads this package via `--plugin-dir`. Explicit deny rules still apply; `--approve-mcps` / `--trust` remain opt-in when you pass them explicitly (before `--`). Arguments after `--` are opaque. Launch policy: `OMCU_LAUNCH_POLICY` / `--direct` / `--tmux` (auto falls back; explicit `--tmux` fails closed). It is a host launcher, not a mode FSM, and never stamps `verified`.

## Lifecycle and capabilities

| Command | Purpose |
| --- | --- |
| `omcu setup [--source <dir>] [--state-root <dir>] [--init-project-state]` | Install the package source and run doctor; project `.omcu/` initialization is explicit. |
| `omcu update [--source <dir>] [--state-root <dir>] [--init-project-state]` | Stage and switch to source bytes, with rollback on failure. |
| `omcu doctor [--repair-owner]` | Check Cursor, plugin loadability, and local configuration. Owner-record quarantine is explicit and never runs during ordinary doctor. |
| `omcu uninstall [--receipt <file>] [--state-root <dir>] [--purge-project-state]` | Remove receipt-owned paths; defaults to the current receipt. |
| `omcu capabilities discover` | Compare the live Cursor version/help with the pinned lock. |
| `omcu capabilities native-status` | Run `cursor-agent status` and return a JSON envelope. |
| `omcu native-status` | Alias for `capabilities native-status`. |
| `omcu mcp status|install|uninstall [--file <path>]` | Inspect, install, or safely remove project MCP server configuration. |
| `omcu mcp-install [--file <path>]` | Merge an `oh-my-cursor` stdio server into a project MCP JSON file (legacy alias). |
| `omcu mcp-server` | Serve the fixed non-authoritative MCP tool set on stdio. |

The CLI lifecycle path installs from source. For verified offline archives, use `scripts/install.sh` and `dist/src/setup/script-entry.js` as described in [Installation](installation.md).

## Sessions

```sh
omcu session create
omcu session list
omcu session resume --id <chat-id> [--prompt <text>]
omcu session continue [--prompt <text>]
omcu resume --id <chat-id> [--prompt <text>]
```

Without a prompt, list/resume/continue use Cursor's interactive terminal. A prompt uses `--print --output-format json`. Print mode is not read-only on its own.

## Authoritative run state

`state` and `run` are aliases.

```sh
omcu state create --id <run-id> --objective <text>
omcu state status --id <run-id>
omcu state transition --id <run-id> --revision <n> --status active|complete|failed|cancelled
omcu state verify --id <run-id> --revision <n> --evidence-sha256 <64-hex>
omcu state event --id <run-id> --type <type> [--payload-json <json>]
omcu cancel --id <run-id>
```

Every transition clears prior verification. Verification requires status `complete` and rejects non-complete runs (`active`, `failed`, `cancelled`), stale revisions, and malformed evidence digests. `cancel` reads the current revision and performs a fenced cancellation.

Leases coordinate project writers:

```sh
omcu lease acquire --run <run-id> --name <lease> --owner <owner> [--ttl-ms <n>]
omcu lease status --run <run-id> --name <lease>
omcu lease release --run <run-id> --name <lease> --owner <owner> --generation <n>
```

TTL must be between 1,000 and 86,400,000 milliseconds.

## Recovery and checkpoints

```sh
omcu recover --transcript /absolute/path/to/file.jsonl [--id <id>]
omcu recover --project-jsonl /absolute/path/to/file.jsonl [--id <id>]
omcu recover show --id <id>

omcu compact checkpoint --id <id> --generation <n> --payload-json <json>
omcu compact show --id <id>
omcu compact render --id <id> --generation <n>
```

Recovery requires exactly one absolute source and copies only the last 900 lines. Checkpoints use generation fences and a digest chain.

## Project memory

This is OMCU project memory, not a documented Cursor memory CLI.

```sh
omcu memory put --text <text> [--id <id>] [--metadata-json <json>]
omcu memory list
omcu memory show --id <id>
omcu memory search --query <text> [--limit <1-100>]
omcu memory export
omcu memory import --file <bundle.json>
omcu memory rescan
```

Values are redacted before storage. Export writes JSON to stdout; redirect it to a protected file when needed.

## Notifications

```sh
omcu notify status
omcu notify configure --generation <n> [--enable --destination <value>]
omcu notify enqueue --payload-json <json> [--id <id>]
omcu notify show --id <id>
omcu notify dispatch --id <id> --generation <n> --nonce <nonce>
```

Notifications start disabled. OMCU wires a refusing transport in the CLI, so dispatch remains unsupported even after enabling a destination. Queueing and inspection are local only.

## Tracker and wiki

```sh
omcu tracker record --id <subject> --phase created|started|checkpointed|completed|failed|cancelled [--detail-json <json>]
omcu tracker history --id <subject>
omcu wiki render --slug <slug> --generation <n> --title <text> --tracker <subject>
omcu wiki show --slug <slug>
```

Tracker transitions are ordered. Wiki pages are redacted, generation-fenced views of one tracker's history.

## Workflows

Install an immutable versioned definition:

```json
{
  "schema_version": 1,
  "name": "delivery",
  "version": "1",
  "capability_tier": "cursor-backed",
  "stages": [
    { "id": "plan", "prompt": "Produce a plan.", "mode": "plan", "depends_on": [], "max_attempts": 1 },
    { "id": "execute", "prompt": "Implement and test.", "mode": "ask", "depends_on": ["plan"], "max_attempts": 1 }
  ]
}
```

```sh
omcu workflow install --file delivery.json
omcu workflow list
omcu workflow show --name delivery [--version 1]
omcu workflow plan --name delivery [--version 1] --id run-1 --objective "ship safely"
omcu workflow run --id run-1
omcu workflow status --id run-1
omcu workflow replay --id run-1
omcu workflow lease-status --id run-1
omcu workflow lease-reconcile --id run-1 --revision <n> --credential-json '<non-secret acknowledgement JSON>'
```

Definitions are immutable by name/version/digest. Plans and digest-chained receipts live under `.omcu/workflows/`. A completed workflow still reports `verified: false`; only the run-state verification command is authoritative.

`lease-reconcile` uses the exact redacted lease metadata from `lease-status`, the expected `ambiguous` status/reason, and `operator_confirmation: "owner-dead-side-effects-reviewed"`. Never put the raw owner nonce on the command line; it is intentionally not persisted or required for crash reconciliation.

Before each Cursor invocation the CLI persists a `task_started` intent. If the
process dies before a matching receipt is durable, `status` and `replay` report
`ambiguous`. OMCU will not automatically rerun that task because its edits or
shell effects may already have occurred. Inspect the run record and repository,
manually reconcile the uncertain effects, then create a new run ID if an
explicit rerun is appropriate. There is intentionally no automatic
`ambiguous`-to-retry transition.

## Persistent execution

```sh
omcu persist start --goal <text> [--max-loops 25] [--deadline-min 120]
omcu persist status
omcu persist done
omcu persist stop
omcu persist decide [--input <json>]
```

`persist` coordinates the opt-in "boulder never stops" continuation loop via Cursor's `stop` and `subagentStop` hooks. Loop ceilings are enforced by OMCU-owned durable state (`.omcu/persist.json`), not solely by host hook counters.
- Continuation limits are strictly monotonic: `consumed_loops` increments atomically under lock before returning a follow-up message.
- Missing, non-integer, negative, non-finite, or decreasing host counters fail closed.
- Duplicate hook events are deduplicated by event/loop identity and consume at most one slot.
- Schema v1 states migrate safely into schema v2 without resetting active loop budgets.
- All decisions run in locked atomic transactions; `persist done` and `persist stop` win concurrent continuation races.

## Cursor-backed modes

```sh
omcu ralplan --objective <text> [--rounds <1-10>]
omcu ralph --objective <text> [--iterations <1-100>]
omcu autopilot --objective <text>
omcu pipeline --gates-json <json>
omcu review --prompt <text> [--format stream-json]
omcu qa --prompt <text> [--format stream-json]
omcu accept --prompt <text> [--format stream-json]
omcu integrate --prompt <text> [--format stream-json]
omcu ask --prompt <text> [--format stream-json]
```

RALPLAN uses Plan mode. Review and acceptance prompts also use Plan mode; other role prompts use Ask mode. Mode output is advisory and never self-verifies.

## Worktree and tmux coordination

Worktree ULW accepts a JSON array:

```sh
omcu ulw --id <run-id> --workers-json '[
  {"id":"docs","objective":"update docs","owned_paths":["docs"]},
  {"id":"tests","objective":"add tests","owned_paths":["tests"]}
]'
```

Each worker receives a uniquely named detached worktree under
`.omcu-worktrees/<run-id>/`. Duplicate worker IDs, overlapping ownership, and
escaping paths are rejected before worktree or Cursor effects.

Once Cursor has been invoked, OMCU retains the worktree even when the worker
fails, because it may contain uncommitted edits or a detached commit. The
receipt reports the worktree path, HEAD OID when observable, dirty state,
status digest, and a cleanup command. Integrate or otherwise preserve the
worker result before running that command. Only failures proven to occur before
worker invocation are eligible for automatic worktree removal.

The experimental tmux supervisor accepts workers with `id`, `objective`, and `owned_paths`; `cwd` is optional and defaults to the current directory:

```sh
omcu team start --id <team-id> --workers-json '<json-array>'
omcu team run --id <team-id> --workers-json '<json-array>'
omcu team status --id <team-id>
omcu team collect --id <team-id>
omcu team stop --id <team-id>
omcu team api <operation> --input '<json>'
omcu team api --help
```

`team run` is an alias for `team start`; it does not collect or verify results. The supervisor creates `cursor-agent --print --mode ask` processes, records pane process groups, initializes `.omcu/state/team/<id>/` (mailbox, tasks, worker `inbox.md`), and reports `native_cursor_team: false`.

`omcu team api` is the OMX-shaped coordination data plane (P0): send/list/ack mailbox messages, create/list/claim/transition/release tasks, get-summary, and write-worker-inbox. It never stamps `verified`. It is not a native Cursor team product — prefer Cursor-native subagents for in-agent parallelism when available.

<!-- OMCU:CLI-REFERENCE:START -->
## Generated CLI reference

Do not edit this block manually; it is generated from `COMMAND_SCHEMAS`.

- `omcu help` | options: none | positionals: command; action
- `omcu version` | options: none | positionals: none
- `omcu setup` | options: --source:string; --state-root:string; --init-project-state:flag | positionals: none
- `omcu update` | options: --source:string; --state-root:string; --init-project-state:flag | positionals: none
- `omcu doctor` | options: --repair-owner:flag; --repair-journals:flag | positionals: none
- `omcu uninstall` | options: --receipt:string; --state-root:string; --purge-project-state:flag | positionals: none
- `omcu capabilities` | options: none | positionals: none
- `omcu capabilities discover` | options: none | positionals: none
- `omcu capabilities native-status` | options: none | positionals: none
- `omcu native-status` | options: none | positionals: none
- `omcu mcp-server` | options: none | positionals: none
- `omcu mcp` | options: none | positionals: none
- `omcu mcp status` | options: --file:string; --receipt:string; --no-probe:flag | positionals: none
- `omcu mcp install` | options: --file:string; --receipt:string; --dry-run:flag; --replace:flag | positionals: none
- `omcu mcp uninstall` | options: --file:string; --receipt:string; --dry-run:flag | positionals: none
- `omcu mcp-install` | options: --file:string; --receipt:string; --dry-run:flag; --replace:flag | positionals: none
- `omcu session` | options: none | positionals: none
- `omcu session create` | options: none | positionals: none
- `omcu session list` | options: none | positionals: none
- `omcu session resume` | options: --id:string required; --prompt:string | positionals: none
- `omcu session continue` | options: --prompt:string | positionals: none
- `omcu resume` | options: --id:string required; --prompt:string | positionals: none
- `omcu state` | options: none | positionals: none
- `omcu state create` | options: --id:string required; --objective:string required | positionals: none
- `omcu state status` | options: --id:string required | positionals: none
- `omcu state transition` | options: --id:string required; --revision:integer required; --status:string required | positionals: none
- `omcu state verify` | options: --id:string required; --revision:integer required; --evidence-sha256:string required | positionals: none
- `omcu state event` | options: --id:string required; --type:string required; --payload-json:json default={} | positionals: none
- `omcu run` | options: none | positionals: none
- `omcu run create` | options: --id:string required; --objective:string required | positionals: none
- `omcu run status` | options: --id:string required | positionals: none
- `omcu run transition` | options: --id:string required; --revision:integer required; --status:string required | positionals: none
- `omcu run verify` | options: --id:string required; --revision:integer required; --evidence-sha256:string required | positionals: none
- `omcu run event` | options: --id:string required; --type:string required; --payload-json:json default={} | positionals: none
- `omcu lease` | options: none | positionals: none
- `omcu lease status` | options: --run:string required; --name:string required | positionals: none
- `omcu lease acquire` | options: --run:string required; --name:string required; --owner:string required; --ttl-ms:integer default=30000 | positionals: none
- `omcu lease release` | options: --run:string required; --name:string required; --owner:string required; --generation:integer required | positionals: none
- `omcu cancel` | options: --id:string required | positionals: none
- `omcu recover` | options: none | positionals: none
- `omcu recover show` | options: --id:string required; --summary:flag | positionals: none
- `omcu recover create` | options: --transcript:string; --project-jsonl:string; --id:string; --summary:flag | positionals: none
- `omcu compact` | options: none | positionals: none
- `omcu compact checkpoint` | options: --id:string required; --generation:integer required; --payload-json:json required | positionals: none
- `omcu compact show` | options: --id:string required | positionals: none
- `omcu compact render` | options: --id:string required; --generation:integer required | positionals: none
- `omcu memory` | options: none | positionals: none
- `omcu memory put` | options: --text:string required; --id:string; --metadata-json:json default={} | positionals: none
- `omcu memory list` | options: none | positionals: none
- `omcu memory show` | options: --id:string required | positionals: none
- `omcu memory search` | options: --query:string required; --limit:integer default=20 | positionals: none
- `omcu memory export` | options: none | positionals: none
- `omcu memory import` | options: --file:string required; --conflict:string default="reject"; --dry-run:flag | positionals: none
- `omcu memory delete` | options: --id:string required; --expected-updated-at:string | positionals: none
- `omcu memory doctor` | options: --repair:flag | positionals: none
- `omcu memory rescan` | options: none | positionals: none
- `omcu notify` | options: none | positionals: none
- `omcu notify status` | options: none | positionals: none
- `omcu notify configure` | options: --generation:integer required; --enable:flag; --destination:string | positionals: none
- `omcu notify enqueue` | options: --payload-json:json required; --id:string | positionals: none
- `omcu notify show` | options: --id:string required | positionals: none
- `omcu notify dispatch` | options: --id:string required; --generation:integer required; --nonce:string required | positionals: none
- `omcu tracker` | options: none | positionals: none
- `omcu tracker record` | options: --id:string required; --phase:string required; --detail-json:json default={} | positionals: none
- `omcu tracker history` | options: --id:string required | positionals: none
- `omcu wiki` | options: none | positionals: none
- `omcu wiki render` | options: --slug:string required; --tracker:string required; --generation:integer required; --title:string required | positionals: none
- `omcu wiki show` | options: --slug:string required | positionals: none
- `omcu workflow` | options: none | positionals: none
- `omcu workflow install` | options: --file:string required | positionals: none
- `omcu workflow list` | options: none | positionals: none
- `omcu workflow show` | options: --name:string required; --version:string default="1" | positionals: none
- `omcu workflow plan` | options: --name:string required; --version:string default="1"; --id:string required; --objective:string; --prompt:string | positionals: objective
- `omcu workflow run` | options: --id:string required | positionals: none
- `omcu workflow status` | options: --id:string required | positionals: none
- `omcu workflow replay` | options: --id:string required | positionals: none
- `omcu workflow lease-status` | options: --id:string required | positionals: none
- `omcu workflow lease-reconcile` | options: --id:string required; --revision:integer required; --credential-json:json required | positionals: none
- `omcu team` | options: none | positionals: none
- `omcu team start` | options: --id:string required; --workers-json:json required | positionals: none
- `omcu team run` | options: --id:string required; --workers-json:json required | positionals: none
- `omcu team status` | options: --id:string required | positionals: none
- `omcu team collect` | options: --id:string required | positionals: none
- `omcu team stop` | options: --id:string required | positionals: none
- `omcu team api` | options: --op:string; --input:json default={}; --help:flag aliases=-h | positionals: operation
- `omcu persist` | options: none | positionals: none
- `omcu persist start` | options: --goal:string required; --max-loops:integer default=25; --deadline-min:integer default=120 | positionals: none
- `omcu persist stop` | options: none | positionals: none
- `omcu persist done` | options: none | positionals: none
- `omcu persist status` | options: none | positionals: none
- `omcu persist decide` | options: --input:json | positionals: none
- `omcu ralplan` | options: --objective:string; --prompt:string; --rounds:integer default=3 | positionals: objective
- `omcu ralph` | options: --objective:string; --prompt:string; --iterations:integer default=5 | positionals: objective
- `omcu ulw` | options: --id:string required; --workers-json:json required | positionals: none
- `omcu autopilot` | options: --objective:string; --prompt:string; --gates-json:json | positionals: objective
- `omcu pipeline` | options: --objective:string; --prompt:string; --gates-json:json | positionals: objective
- `omcu review` | options: --objective:string; --prompt:string; --format:string default="json" | positionals: objective
- `omcu qa` | options: --objective:string; --prompt:string; --format:string default="json" | positionals: objective
- `omcu accept` | options: --objective:string; --prompt:string; --format:string default="json" | positionals: objective
- `omcu integrate` | options: --objective:string; --prompt:string; --format:string default="json" | positionals: objective
- `omcu ask` | options: --objective:string; --prompt:string; --format:string default="json" | positionals: objective
<!-- OMCU:CLI-REFERENCE:END -->
