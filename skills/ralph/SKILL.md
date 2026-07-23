---
name: ralph
description: "Iterate on one scoped objective until verified or genuinely blocked."
---
# Ralph

## Workflow

1. Establish one falsifiable objective and a bounded iteration limit.
2. In each pass: inspect current evidence, make one minimal change, and run the smallest proving check.
3. Record progress through CLI-owned run events only; hooks and prose never set pass or verified state.
4. Stop on verified completion, explicit cancellation, or a concrete blocker.
5. Do not loop on unchanged evidence or auto-submit follow-up turns from hooks.

## Guardrails

- Treat capability probes and command output as evidence; do not invent host support.
- Do not claim sandbox authority or security isolation.
- Redact secrets and keep state mutations on documented CLI paths.

## Output

Return the outcome, evidence, and any remaining blocker or manual seam.
