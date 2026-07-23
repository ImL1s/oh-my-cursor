---
name: accept
description: "Accept a completed local run only after independent evidence review."
---
# Accept

## Workflow

1. Read the requested outcome, diff, run status, and fresh verification evidence.
2. Confirm targeted tests and applicable build, typecheck, and lint checks succeeded.
3. Confirm no debug leftovers, hidden destructive actions, or unresolved required work remain.
4. If evidence is sufficient, use the documented CLI-owned transition and verification commands with the exact revision and evidence digest.
5. Otherwise refuse acceptance with a concise missing-evidence list. Never have a hook write acceptance or verification.

## Guardrails

- Treat capability probes and command output as evidence; do not invent host support.
- Do not claim sandbox authority or security isolation.
- Redact secrets and keep state mutations on documented CLI paths.

## Output

Return the outcome, evidence, and any remaining blocker or manual seam.
