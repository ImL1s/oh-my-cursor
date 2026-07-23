# CLI reference

All commands operate on the current working directory unless a path option says otherwise. Project services write under `<cwd>/.omcu/`. Output is JSON except interactive Cursor sessions, rendered checkpoint text, and direct Cursor output.

```sh
omcu --help
omcu --version
```

## Lifecycle and capabilities

| Command | Purpose |
| --- | --- |
| `omcu setup [--source <dir>] [--state-root <dir>]` | Install the package source, create the current project's `.omcu/`, and run doctor. |
| `omcu update [--source <dir>] [--state-root <dir>]` | Stage and switch to source bytes, with rollback on failure. |
| `omcu doctor` | Check Cursor, plugin loadability, and local configuration. Exit `0`, `2` for warnings, or `1` for failures. |
| `omcu uninstall [--receipt <file>] [--state-root <dir>] [--purge-project-state]` | Remove receipt-owned paths; defaults to the current receipt. |
| `omcu capabilities discover` | Compare the live Cursor version/help with the pinned lock. |
| `omcu capabilities native-status` | Run `cursor-agent status` and return a JSON envelope. |
| `omcu native-status` | Alias for `capabilities native-status`. |
| `omcu mcp-install [--file <path>]` | Merge an `oh-my-cursor` stdio server into a project MCP JSON file. |
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

Every transition clears prior verification. Verification rejects active runs, stale revisions, and malformed evidence digests. `cancel` reads the current revision and performs a fenced cancellation.

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
```

Definitions are immutable by name/version/digest. Plans and digest-chained receipts live under `.omcu/workflows/`. A completed workflow still reports `verified: false`; only the run-state verification command is authoritative.

Before each Cursor invocation the CLI persists a `task_started` intent. If the
process dies before a matching receipt is durable, `status` and `replay` report
`ambiguous`. OMCU will not automatically rerun that task because its edits or
shell effects may already have occurred. Inspect the run record and repository,
manually reconcile the uncertain effects, then create a new run ID if an
explicit rerun is appropriate. There is intentionally no automatic
`ambiguous`-to-retry transition.

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
omcu team status --id <team-id>
omcu team collect --id <team-id>
omcu team stop --id <team-id>
```

`team run` is an alias for `team start`; it does not collect or verify results. The supervisor creates `cursor-agent --print --mode ask` processes, records pane process groups, and reports `native_cursor_team: false`.
