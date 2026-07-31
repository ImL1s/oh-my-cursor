---
name: doctor
description: "Diagnose Oh My Cursor and Cursor Agent integration with read-only checks."
---
# Doctor

## Workflow

1. Read the pinned capability lock and run `omcu capabilities discover`.
2. Check that the plugin and marketplace manifests parse and all referenced local paths exist.
3. Check that hook commands resolve from `${CURSOR_PLUGIN_ROOT}` and that Node.js is available.
4. Inspect current run state only through `omcu run status` when a run ID is supplied.
5. Keep ordinary doctor observational: never repair, install, or mutate state.
6. Only when the operator explicitly requests owner-record repair, run `omcu doctor --repair-owner`. This may quarantine an invalid regular owner file; report the quarantine path and do not imply broader repair.
7. Return PASS, WARN, or FAIL per check with the exact evidence command.

## Guardrails

- Treat capability probes and command output as evidence; do not invent host support.
- Do not claim sandbox authority or security isolation.
- Redact secrets and keep state mutations on documented CLI paths.
- Never infer repair intent from a failed ordinary doctor; `--repair-owner` is an explicit opt-in exception only.

## Output

Return the outcome, evidence, and any remaining blocker or manual seam.
