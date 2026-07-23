---
name: setup
description: "Set up Oh My Cursor in the current repository without global installation."
---
# Setup

## Workflow

1. Confirm Node.js 20 or newer and a repository-local checkout or package install.
2. Run the repository's existing dependency install only when needed, then build it.
3. Run `omcu capabilities discover`; treat a nonzero result as capability drift, not a setup success.
4. Confirm `.cursor-plugin/plugin.json`, `.cursor-plugin/marketplace.json`, the referenced component paths, and `.mcp.json` parse locally.
5. Do not write to `~/.cursor`, install globally, or enable a marketplace without explicit user action.
6. Report installed, available, unsupported, and manual steps separately.

## Guardrails

- Treat capability probes and command output as evidence; do not invent host support.
- Do not claim sandbox authority or security isolation.
- Redact secrets and keep state mutations on documented CLI paths.

## Output

Return the outcome, evidence, and any remaining blocker or manual seam.
