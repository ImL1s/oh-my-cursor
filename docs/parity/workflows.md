# Workflows Parity: Autopilot, Ralph, Ultrawork, Pipeline

## Workflow Mappings

| Workflow | Upstream Analogs | Selected Mechanisms | Disposition | Verification Test |
|---|---|---|---|---|
| `Autopilot Workflow` | {"omc":"omc_autopilot"} | `cursor-plugin-skill, cursor-sdk-local, omcu-domain-layer` | `composed` | `tests/workflows/autopilot.test.ts` |
| `Ralph Iteration Loop` | {"omc":"omc_ralph"} | `cursor-plugin-hook, cursor-sdk-local, omcu-domain-layer` | `composed` | `tests/workflows/ralph.test.ts` |
| `Ultrawork Parallel Execution` | {"omc":"omc_ultrawork"} | `cursor-sdk-subagent, cursor-worktree, omcu-domain-layer` | `composed` | `tests/workflows/ultrawork.test.ts` |
| `UltraQA Dynamic Test Loop` | {"omc":"omc_ultraqa"} | `cursor-plugin-skill, cursor-sdk-subagent, omcu-domain-layer` | `composed` | `tests/workflows/ultraqa.test.ts` |
| `Workflow Cancellation` | {"omc":"omc_cancel"} | `cursor-cli, omcu-domain-layer` | `native` | `tests/workflows/cancel.test.ts` |
| `Socratic Deep Interview` | {"omc":"omc_deep_interview"} | `cursor-plugin-skill, cursor-sdk-local` | `composed` | `tests/workflows/deep-interview.test.ts` |
| `Ralplan Plan Consensus` | {"omc":"omc_ralplan"} | `cursor-plugin-skill, cursor-sdk-subagent` | `composed` | `tests/workflows/ralplan.test.ts` |
| `Autoresearch Workflow` | {"omc":"omc_autoresearch","omx":"omx_autoresearch_goal"} | `cursor-plugin-skill, cursor-sdk-local, omcu-domain-layer` | `composed` | `tests/workflows/autoresearch.test.ts` |
| `Pipeline Orchestrator` | {"omc":"omc_pipeline"} | `cursor-sdk-local, omcu-domain-layer` | `composed` | `tests/workflows/pipeline.test.ts` |
| `Ultragoal Durable Ledger` | {"omx":"omx_ultragoal"} | `cursor-sdk-local, omcu-domain-layer` | `thin-extension` | `tests/workflows/ultragoal.test.ts` |
| `Performance Optimization Workflow` | {"omx":"omx_performance_goal"} | `cursor-sdk-local, omcu-domain-layer` | `composed` | `tests/workflows/performance-goal.test.ts` |
| `Prometheus Strict Ambiguity Gate` | {"omx":"omx_prometheus_strict"} | `cursor-plugin-skill, cursor-sdk-local` | `composed` | `tests/workflows/prometheus-strict.test.ts` |
| `Worktree Orchestration Workflow` | {"omo":"omo_orchestrate"} | `cursor-worktree, cursor-sdk-subagent, omcu-domain-layer` | `composed` | `tests/workflows/worktree-orchestrate.test.ts` |
| `Consensus Review Workflow` | {"omo":"omo_consensus_review"} | `cursor-permissions-auto-review, cursor-sdk-subagent` | `composed` | `tests/workflows/consensus-review.test.ts` |
| `Context Window Utilization Router` | {"omo":"omo_context_router"} | `cursor-router, omcu-domain-layer` | `native` | `tests/workflows/context-router.test.ts` |

### Coordination Design
Workflows operate over Cursor native mechanisms without duplicating host internals. State transitions are journaled in atomic JSON files under `.omcu/workflows/`.
