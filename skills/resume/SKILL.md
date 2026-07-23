---
name: resume
description: "Resume an exact Cursor Agent chat or the latest chat without guessing."
---
# Resume

## Workflow

1. If a chat ID is supplied, validate it and use `omcu session resume --id <chat-id>`.
2. If the user explicitly asks for the latest session, use `omcu session continue`.
3. Do not substitute one session for another when the requested ID is unavailable.
4. Before continuing work, restate the recovered objective and current evidence boundary.

## Guardrails

- Treat capability probes and command output as evidence; do not invent host support.
- Do not claim sandbox authority or security isolation.
- Redact secrets and keep state mutations on documented CLI paths.

## Output

Return the outcome, evidence, and any remaining blocker or manual seam.
