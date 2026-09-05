# Artifacts, Compaction & State Persistence

## Artifact Contracts

| Artifact | Persistence Path | Cursor Mechanism | Disposition |
|---|---|---|---|
| `Compaction-Resilient Notepad` | `Maintains durable markdown scratchpad loaded into agent context and preserved on disk` | `cursor-plugin-rule, omcu-domain-layer` | `thin-extension` |
| `Repository Wiki & Memory` | `Maintains durable topic pages and architectural decisions in .omcu/wiki/` | `cursor-plugin-rule, omcu-domain-layer` | `thin-extension` |

### Compaction Resilience
- Context compaction hooks preserve critical state in `.omcu/` state root.
- Re-injected via `AGENTS.md` and `.cursor/rules/` upon new turns.
