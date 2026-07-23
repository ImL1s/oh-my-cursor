---
name: workflow
description: "Execute a scoped task through an evidence-first Cursor workflow."
---
# Workflow

## Workflow

1. Define the target outcome, constraints, acceptance evidence, and stop condition.
2. Inspect only enough repository context to choose the smallest safe change.
3. Create or read CLI-owned run state only through documented `omcu run` commands.
4. Implement, run targeted validation, then broader checks when applicable.
5. Transition and verify run state only after the evidence exists.
6. Report changes, commands, results, and remaining external seams.

## Guardrails

- Treat capability probes and command output as evidence; do not invent host support.
- Do not claim sandbox authority or security isolation.
- Redact secrets and keep state mutations on documented CLI paths.

## Output

Return the outcome, evidence, and any remaining blocker or manual seam.
