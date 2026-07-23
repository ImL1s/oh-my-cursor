---
name: autopilot
description: "Complete a clear local task end to end with conservative automation."
---
# Autopilot

## Workflow

1. Confirm the requested result and validation path from existing context.
2. Proceed through safe, reversible inspect-edit-test steps without approval pauses.
3. Ask only for destructive, credentialed, production, or materially branching actions.
4. Use subagents only for bounded independent work when Task exists.
5. Stop only after fresh evidence proves the local result or a blocker is explicit.

## Guardrails

- Treat capability probes and command output as evidence; do not invent host support.
- Do not claim sandbox authority or security isolation.
- Redact secrets and keep state mutations on documented CLI paths.

## Output

Return the outcome, evidence, and any remaining blocker or manual seam.
