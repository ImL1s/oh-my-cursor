# Cursor-Native Lifecycle Hooks & SDK Run Events

## Architecture Overview

OMCU integrates directly into Cursor's native hook system and typed SDK run events rather than introducing an external daemon.

```text
Cursor Host Hooks (Synchronous Interceptors):
  sessionStart          -> Session initialization & capability detection
  beforeSubmitPrompt    -> Injected context & rules preparation
  preToolUse            -> Pre-step safety gate (Shell blacklist, write boundaries)
  postToolUse           -> Post-step audit (syntax errors, test failures, spill detection)
  afterAgentResponse    -> Turn completion, verdict, artifact links
  preCompact            -> State checkpoint prior to context compaction
  stop                  -> Persist loop continuation oracle (followup_message)
  subagentStop          -> Subagent termination & single-depth boundary enforcement

Cursor SDK Events (Streaming Observation):
  run.stream()          -> Assistant messages, tool calls, tool results
  run.wait() / cancel() -> Run lifecycle, duration, usage, terminal status

OMCU Domain Events (State Machine & Artifacts):
  workflow transition   -> Phase advancements (plan -> implement -> verify)
  goal/story update     -> Progress milestones
  artifact created      -> Spilled tool results & design documents
  evidence recorded     -> Verification records & test summaries
```

OMCU domain events and SDK stream events are never mislabeled or impersonated as native Cursor hooks.

---

## Execution Tiers

Handlers execute in deterministic order across 5 strict tiers:

| Tier | Tier Name | Responsibilities | Failure Policy |
|---|---|---|---|
| **1** | `safety_permission` | Destructive command blocking, filesystem write boundary checks | `fail_closed` (halts turn on deny) |
| **2** | `input_context` | Session init, AGENTS.md / rules reference injection, pre-compaction checkpoints | `fail_open` |
| **3** | `routing_workflow` | Persist loop continuation oracle (`stop`, `subagentStop`), single-depth subagent rules | `fail_open` |
| **4** | `output_recovery` | Syntax error detection, test runner audit, output spill suggestions | `fail_open` |
| **5** | `trace_notification` | Telemetry recording, background task notifications | `fail_open` |

User and project extensions cannot silently override or precede Tier 1 immutable safety handlers.

---

## Pre-Step Safety Gate (`omcu-hook-pre-step-gate`)

The pre-step safety gate synchronously evaluates proposed commands and tool inputs:

- **Destructive Deletion**: Blocks recursive deletion commands targeting root (`/`), user home (`~`, `$HOME`), or parent directories (`..`).
- **Disk & Device Overwrite**: Blocks `mkfs`, `fdisk`, `dd of=/dev/sd*`.
- **Dangerous Git Operations**: Blocks force-pushes (`git push -f`, `git push --force`) and deletion of protected branches.
- **Credential Leakage**: Blocks reading private keys or credentials (`cat ~/.ssh/id_rsa`, `.aws/credentials`).
- **Path Escapes**: Blocks filesystem write operations attempting to escape the project workspace root.

---

## Post-Step Audit (`omcu-hook-post-step-audit`)

Audits tool execution results:
- Detects TypeScript compiler errors (`TS2345`, etc.) and JavaScript `SyntaxError`.
- Detects test runner failure blocks (`FAIL tests/...`).
- Detects excessive output size (>100KB) and recommends spilling to `.omcu/artifacts/`.
- Generates actionable recovery hints to assist the agent in repairing errors before claiming completion.

---

## Context Compaction Hook (`omcu-hook-context-compact`)

Prior to LLM context window compression, the `preCompact` hook writes a generation-fenced checkpoint containing:
- Active session ID and run metadata
- Active persist goal, max loops, and consumed loops
- Workflow state machine progress

The checkpoint is saved under `.omcu/compaction/` via `CompactionStore`, allowing uninterrupted session recovery.

---

## Persist Loop Continuation Oracle (`omcu-hook-persist-stop`)

Follows Cursor's official `ralph-loop` continuation contract:
- Turns continue only when active persist state exists with status `completed`.
- Injects native `followup_message` back into the agent turn.
- Fenced against concurrent stop, completion (`omcu persist done`), or revision mismatch.
- Hard safety loop cap (500 maximum iterations).

---

## CLI Commands & Diagnostics

### List Handlers
```bash
omcu hooks list [--event <name>] [--json]
```

### Inspect Handler Details
```bash
omcu hooks show <handler-id> [--json]
```

### Run Doctor Diagnostics
```bash
omcu hooks doctor [--live] [--json]
```
Diagnostics distinguish:
- `native_hook_installed`: Configuration present in `hooks/hooks.json`
- `native_hook_observed_live`: Live execution verified via probe nonce
- `sdk_event_observed`: SDK stream projector readiness
- `omcu_domain_event`: Domain event projector readiness
- `unsupported_not_run`: Upstream features not supported natively

### Trace Execution
```bash
omcu hooks trace [--run <run-id>] [--json]
```

### Test Event Hook
```bash
omcu hooks test <event> --fixture '{"tool_name":"Shell","tool_input":{"command":"git status"}}' [--json]
```

### Generate & Verify Configuration
```bash
omcu hooks generate [--check] [--target plugin|project] [--json]
```
