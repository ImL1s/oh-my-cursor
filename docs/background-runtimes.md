# Cursor Native Agent Runtimes & Orchestration

OMCU delegates execution authority to Cursor's native agent runtimes (local SDK subagents, Agent Window, cloud agents, and Automations) while providing the coordination contract—roles, dependencies, bounded context, task ledgers, handoffs, acceptance criteria, and evidence.

## 1. Runtime Architecture

```text
┌────────────────────────────────────────────────────────┐
│                   OMCU Coordination                    │
│   (Thin task ledgers, DAG ranks, handoffs, evidence)   │
└──────────┬──────────────────┬─────────────────┬────────┘
           │                  │                 │
           ▼                  ▼                 ▼
   ┌───────────────┐  ┌───────────────┐ ┌───────────────┐
   │ Local Subagent│  │  Cloud Agent  │ │  Automations  │
   │  SDK / Worktree│ │(Isolated PRs) │ │(Cron / Events)│
   └───────────────┘  └───────────────┘ └───────────────┘
```

### Local SDK Subagents (`src/tasks/*`, `src/dag/*`)
- Fast repository-local fan-out and read-only exploration.
- Local implementation tasks in explicit worktrees or mechanically non-overlapping owned paths.
- Local DAG ranks run concurrently; downstream tasks automatically skip if an upstream dependency fails.
- Upstream text stitched into downstream tasks is bounded; full parent transcripts are never default context.
- Interruption cancels active runs and finalizes status cleanly.

### Cloud Orchestration (`src/cloud-orchestration/*`)
- Planner → isolated worker → verifier trees.
- Planners publish structured tasks; they do not code.
- Workers run in isolated cloud environments/branches without sharing mutable state.
- Structured handoff artifacts (`worker -> planner`, `verifier -> planner`) carry meaning while Git branches/PRs carry code.
- Late handoffs trigger replanning without duplicating completed workers.
- Parent cancellation propagates to all active child runs.

### Automations (`src/automations/*`)
- Targets native Cursor Automations first (`.cursor/automations/`).
- If Automations are unavailable in the host environment, an optional local scheduler fallback is supported when explicitly enabled.

### Native Team Supervision (`src/team/*`)
- Native Cursor agents act as workers (`native_cursor_team: true`).
- Status and monitoring are driven by SDK run records, not screen scraping or tmux liveness.
- Tmux remains purely an optional compatibility view, never the task authority.

## 2. CLI Usage

### Tasks
```bash
# Start a task (foreground or background)
omcu task start --agent omcu-worker --runtime local --prompt "Refactor indexing" [--background]

# Inspect and manage tasks
omcu task list
omcu task status <taskId>
omcu task output <taskId>
omcu task cancel <taskId>
omcu task resume <taskId>
```

### DAG Execution
```bash
# Run a DAG definition with optional ASCII Canvas view
omcu dag run --file dag.json [--canvas]
```

### Automations
```bash
# Plan, query, install, and remove automations
omcu automation plan --name "Nightly" --cron "0 0 * * *" --prompt "Run checks"
omcu automation status
omcu automation install --id <autoId>
omcu automation remove --id <autoId>
```

### Native Team
```bash
# Supervise native Cursor agent teams
omcu team start --id myteam --workers-json '[...]' --native
omcu team status --id myteam --native
omcu team monitor --id myteam
omcu team resume --id myteam
omcu team shutdown --id myteam
```
