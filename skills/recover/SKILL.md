---
name: recover
description: "Recover from interrupted local work using repository and CLI-owned evidence."
---
# Recover

## Workflow

1. Inspect `git status`, current branch, and relevant working-tree diffs without discarding changes.
2. Read run status through `omcu run status --id <run-id>` when an ID is available.
3. Reconstruct completed, pending, and unverified work from durable evidence; do not infer success from prose.
4. Re-run the smallest validation needed to establish a fresh baseline.
5. Continue the safest reversible branch, or report the exact blocker.

## Guardrails

- Treat capability probes and command output as evidence; do not invent host support.
- Do not claim sandbox authority or security isolation.
- Redact secrets and keep state mutations on documented CLI paths.

## Output

Return the outcome, evidence, and any remaining blocker or manual seam.
