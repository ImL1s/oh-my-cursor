---
name: review
description: "Review a scoped diff for actionable correctness, security, and maintainability issues."
---
# Review

## Workflow

1. Establish the comparison base and read the actual diff plus affected call sites.
2. Prefer the read-only `reviewer` subagent when Task exists; keep final judgment with the parent.
3. Report only reproducible issues introduced by the scoped change, ordered by severity.
4. Include file and line evidence plus a concrete failure mode.
5. If no findings remain, say so and list validation gaps separately.

## Guardrails

- Treat capability probes and command output as evidence; do not invent host support.
- Do not claim sandbox authority or security isolation.
- Redact secrets and keep state mutations on documented CLI paths.

## Output

Return the outcome, evidence, and any remaining blocker or manual seam.
