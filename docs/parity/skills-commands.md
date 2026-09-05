# Skills & Slash Commands Parity

This document analyzes parity between upstream slash commands and Cursor plugin skills.

## Mapped Commands & Skills

| Command / Skill | Upstream Analogs | Cursor Mechanism | Disposition | Status |
|---|---|---|---|---|
| `omcu-skill-ecomode` | {"omc":"omc_ecomode"} | `cursor-router, cursor-plugin-skill` | `native` | `pass` |
| `omcu-skill-ask` | {"omc":"omc_ask"} | `cursor-plugin-skill, cursor-sdk-custom-tools` | `composed` | `pass` |
| `omcu-skill-hud` | {"omc":"omc_hud"} | `cursor-canvas, omcu-domain-layer` | `thin-extension` | `pass` |
| `omcu-skill-code-review` | {"omc":"omc_code_review"} | `cursor-permissions-auto-review, cursor-plugin-agent` | `native` | `pass` |
| `omcu-skill-security-review` | {"omc":"omc_security_review","omx":"omx_security_reviewer"} | `cursor-plugin-agent, cursor-sdk-custom-tools` | `composed` | `pass` |
| `omcu-skill-ai-slop-cleaner` | {"omc":"omc_ai_slop_cleaner"} | `cursor-plugin-skill, cursor-sdk-local` | `composed` | `pass` |
| `omcu-skill-best-practice-research` | {"omc":"omc_best_practice_research"} | `cursor-plugin-skill, cursor-mcp` | `composed` | `pass` |

### Behavioral Invariants
1. Skills are packaged in `skills/<name>/SKILL.md` following official Cursor plugin conventions.
2. Skill invocation grammar matches upstream slash syntax.
3. Execution delegates to native subagents or custom tools.
