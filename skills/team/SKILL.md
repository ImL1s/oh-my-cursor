---
name: team
description: "Coordinate parallel work via Cursor-native subagents, or experimental omcu team tmux + mailbox api."
---
# Team

## Two surfaces (do not conflate)

1. **Cursor-native subagents** (preferred in-agent parallelism): spawn bounded custom subagents with non-overlapping ownership. Depth=1; children must not spawn.
2. **`omcu team`** (experimental local tmux plane): pane spawn/stop plus OMX-shaped durable state under `.omcu/state/team/<team>/` and `omcu team api`. This is **not** a native Cursor team product (`native_cursor_team: false`).

## Cursor-native workflow

1. Use only when multiple independent lanes materially improve the result.
2. Assign each custom subagent a bounded deliverable and non-overlapping file ownership.
3. Subagents must not spawn nested agents and must report conflicts upward.
4. Never shell out to another agent CLI as a default worker.
5. The parent integrates outputs, runs final tests, and owns all completion claims.
6. If Task is unavailable, execute sequentially and say that native team execution was unavailable.

## Experimental `omcu team` / `omcu team api` (P0)

```sh
omcu team start --id <team> --workers-json '...'
omcu team api create-task --input '{"team_name":"<team>","subject":"...","description":"..."}'
omcu team api claim-task --input '{"team_name":"<team>","task_id":"1","worker":"<id>"}'
omcu team api send-message --input '{"team_name":"<team>","from_worker":"...","to_worker":"...","body":"..."}'
omcu team api mailbox-list --input '{"team_name":"<team>","worker":"<id>"}'
```

P0 ops: `send-message`, `mailbox-list`, `mailbox-mark-delivered`, `create-task`, `list-tasks`, `claim-task`, `transition-task-status`, `release-task-claim`, `get-summary`, `write-worker-inbox`.

Inbox files under `.omcu/state/team/<team>/workers/<id>/inbox.md` are the durable prompt surface; send-keys are not the source of truth.

## Guardrails

- Treat capability probes and command output as evidence; do not invent host support.
- Do not claim sandbox authority or security isolation.
- Never stamp `verified` from team collect/api; only the OMCU CLI verification path may.
- Redact secrets and keep state mutations on documented CLI paths.

## Output

Return the outcome, evidence, and any remaining blocker or manual seam.
