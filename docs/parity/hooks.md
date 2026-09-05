# Lifecycle Hooks Parity

## Registered Hooks

| Hook | Lifecycle Event | Upstream Analogs | Cursor Mechanism | Disposition |
|---|---|---|---|---|
| `Lifecycle Event Hooks` | `Synchronous pre-tool, post-tool, and subagent termination interceptors` | {"omc":"omc_hooks","omx":"omx_subagent_stop"} | `cursor-plugin-hook, omcu-domain-layer` | `native` |
| `Context Compaction Hook` | `Persists active session state to disk prior to LLM context window compaction` | {"omx":"omx_context_compact"} | `cursor-plugin-hook, omcu-domain-layer` | `thin-extension` |
| `Pre-Step Safety Gate Hook` | `Evaluates proposed filesystem edits against destructive command blacklist` | {"omo":"omo_pre_step_gate"} | `cursor-plugin-hook, cursor-permissions-auto-review` | `native` |
| `Post-Step Audit Hook` | `Validates that step edits did not introduce syntax errors or broken tests` | {"omo":"omo_post_step_audit"} | `cursor-plugin-hook, omcu-domain-layer` | `thin-extension` |

### Safety Guardrails
- Hooks run synchronously with strict timeout controls.
- Critical failures in pre-step hooks fail closed to prevent destructive filesystem modifications.
