---
name: team
description: "Coordinate a one-level Cursor-native subagent team with explicit ownership."
---
# Team

## Workflow

1. Use this workflow only when multiple independent lanes materially improve the result.
2. Assign each custom subagent a bounded deliverable and non-overlapping file ownership.
3. Subagents must not spawn nested agents and must report conflicts upward.
4. Never shell out to another agent CLI as a default worker.
5. The parent integrates outputs, runs final tests, and owns all completion claims.
6. If Task is unavailable, execute sequentially and say that native team execution was unavailable.

## Guardrails

- Treat capability probes and command output as evidence; do not invent host support.
- Do not claim sandbox authority or security isolation.
- Redact secrets and keep state mutations on documented CLI paths.

## Output

Return the outcome, evidence, and any remaining blocker or manual seam.
