---
name: ulw
description: "Run bounded parallel work using Cursor-native subagents when available."
---
# Ulw

## Workflow

1. Split the objective into independent, non-overlapping deliverables with named file ownership.
2. If Cursor exposes Task, dispatch only the minimum useful set of custom subagents. Never invoke another agent CLI as a worker.
3. Require each result to include files inspected or changed, commands run, and blockers.
4. The parent agent reviews integration and runs final verification.
5. Fall back to sequential execution when Task is absent; do not claim parallelism.

## Guardrails

- Treat capability probes and command output as evidence; do not invent host support.
- Do not claim sandbox authority or security isolation.
- Redact secrets and keep state mutations on documented CLI paths.

## Output

Return the outcome, evidence, and any remaining blocker or manual seam.
