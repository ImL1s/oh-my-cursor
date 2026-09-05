---
name: omcu-qa
metadata:
  provenance: omcu
  version: 0.3.0
  canonical_id: omcu-skill-qa
description: "[omcu:0.3.0] Verify behavior with fresh, repeatable evidence."
---
# Qa

## Workflow

1. Restate the claim in falsifiable terms and select the smallest disconfirming test.
2. Use the read-only `qa` or `verifier` subagent when Task exists and independence helps.
3. Run targeted tests first, then typecheck, lint, build, or smoke checks as applicable.
4. Preserve raw command results and separate pre-existing failures.
5. Return VERIFIED, NOT VERIFIED, or INCONCLUSIVE. Do not mutate run verification state from the skill or hook.

## Guardrails

- Treat capability probes and command output as evidence; do not invent host support.
- Do not claim sandbox authority or security isolation.
- Redact secrets and keep state mutations on documented CLI paths.

## Output

Return the outcome, evidence, and any remaining blocker or manual seam.
