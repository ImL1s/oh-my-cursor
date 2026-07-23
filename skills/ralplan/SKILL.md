---
name: ralplan
description: "Produce a reviewed implementation plan without changing product code."
---
# Ralplan

## Workflow

1. Clarify the objective, scope, invariants, and acceptance tests from repository evidence.
2. Use the `planner` subagent when Cursor exposes Task; otherwise plan in the current agent.
3. Use the `reviewer` subagent for an independent critique when available. Subagents remain one level deep.
4. Reconcile disagreements into one file-level plan with rollback and verification steps.
5. Do not implement or claim approval; return the plan and unresolved decisions.

## Guardrails

- Treat capability probes and command output as evidence; do not invent host support.
- Do not claim sandbox authority or security isolation.
- Redact secrets and keep state mutations on documented CLI paths.

## Output

Return the outcome, evidence, and any remaining blocker or manual seam.
