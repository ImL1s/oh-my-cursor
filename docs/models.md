# Models, Cursor Router, & External Compatibility Adapters

## Overview

Oh My Cursor (OMCU) prioritizes Cursor's native model system and `@cursor/sdk` discovery as its canonical execution runtime. External CLI tools (Claude, Codex, Gemini, Antigravity, Grok, OpenCode) serve exclusively as explicit compatibility adapters and advisors. They are never the default and never replace a failed Cursor model silently.

## Native Cursor Routing Contract

### SDK Model Discovery & Caching
- Models are queried via `Cursor.models.list()` from `@cursor/sdk`.
- Discovered models are recorded with account-visible flags, runtime availability (`local`, `cloud`, or `both`), and capabilities (`reasoning`, `vision`, `tools`).
- Discovery is cached under `.omcu/models-cache.json` with freshness metadata and TTL.
- When live discovery is unavailable (e.g. offline, missing API key), OMCU safely falls back to known Cursor presets and flags `accountVisible: false`.

### Cursor Router `{ id: "auto" }`
Cursor Router dynamically optimizes model selection when exact models are not constrained by role profiles. It is exposed as `{ id: "auto" }` or `--model auto`.

## Semantic Category Presets

OMCU provides 18 semantic policy presets:

| Category | Tier | Reasoning Effort | Vision | Tools | Preferred Model | Fallback Tiers |
|---|---|---|---|---|---|---|
| `visual-engineering` | smart | medium | Yes | Yes | `claude-3-5-sonnet` | `smart`, `reasoning` |
| `ultrabrain` | reasoning | high | No | Yes | `claude-3-7-sonnet-thought` | `reasoning`, `smart` |
| `deep` | reasoning | high | No | Yes | `o3-mini` | `reasoning`, `smart` |
| `artistry` | smart | medium | Yes | Yes | `claude-3-5-sonnet` | `smart`, `fast` |
| `quick` | fast | low | No | Yes | `claude-3-5-haiku` | `fast`, `smart` |
| `unspecified-low` | fast | low | No | Yes | `gpt-4o-mini` | `fast`, `smart` |
| `unspecified-high` | smart | medium | Yes | Yes | `claude-3-5-sonnet` | `smart`, `reasoning` |
| `writing` | smart | low | No | No | `claude-3-5-sonnet` | `smart`, `fast` |
| `architecture` | reasoning | high | No | Yes | `claude-3-7-sonnet-thought` | `reasoning`, `smart` |
| `planning` | reasoning | medium | No | Yes | `claude-3-7-sonnet-thought` | `reasoning`, `smart` |
| `execution` | smart | low | No | Yes | `claude-3-5-sonnet` | `smart`, `fast` |
| `research` | reasoning | medium | No | Yes | `claude-3-7-sonnet-thought` | `reasoning`, `smart` |
| `review` | reasoning | high | No | Yes | `claude-3-7-sonnet-thought` | `reasoning`, `smart` |
| `security` | reasoning | high | No | Yes | `o3-mini` | `reasoning`, `smart` |
| `QA/testing` | smart | medium | No | Yes | `claude-3-5-sonnet` | `smart`, `fast` |
| `product/UX` | smart | medium | Yes | No | `claude-3-5-sonnet` | `smart`, `fast` |
| `documentation` | fast | low | No | Yes | `claude-3-5-haiku` | `fast`, `smart` |
| `data/analysis` | smart | medium | No | Yes | `gpt-4o` | `smart`, `reasoning` |

## Strict 7-Step Cursor-First Resolution Order

1. **Explicit Cursor model/runtime override**: User requested explicit model.
2. **Exact OMCU role/profile requirement**: If exact model is required and unavailable, fails closed (`E_MODEL_UNAVAILABLE`).
3. **Project/user OMCU agent override**: Project-level or user-level role configuration.
4. **Cursor category/router policy**: Preset matching and Cursor Router policy.
5. **Ordered compatible Cursor fallback**: Tiers traversed with capability filtering (e.g. vision or local runtime).
6. **Explicit external provider**: Activated ONLY when explicitly requested. Silent fallback is prohibited.
7. **Unavailable result**: Returns actionable `E_MODEL_UNAVAILABLE` without side effects.

## External Compatibility Adapters

Supported adapters:
- `cursor`: Canonical runtime.
- `claude`: Claude CLI advisor/worker.
- `codex`: Codex CLI advisor/worker.
- `gemini`: Gemini CLI advisor/worker.
- `antigravity`: Antigravity (`agy`) advisor/worker.
- `grok`: Grok / xAI CLI advisor/worker.
- `opencode`: OpenCode (`omo`) compatibility worker.
- `custom`: Bounded user-defined adapter.

### Safety & Isolation
- **Environment Allowlist**: Only explicit provider API keys and standard system variables (`PATH`, `HOME`, `TERM`, `TMPDIR`) are passed.
- **Dangerous Flags**: Flags like `--madmax`, `--yolo`, and `--dangerously-skip-permissions` are rejected (`E_DANGEROUS_FLAG_REJECTED`).
- **Cancellation**: Signal abort terminates spawned processes with graceful SIGTERM escalation to SIGKILL.

## CLI Commands

```bash
# Model listing and cache
omcu models list [--runtime local|cloud] [--json] [--refresh]

# Route explanation
omcu route explain --agent <role> [--category <category>] [--runtime local|cloud]

# External providers readiness probe
omcu providers status [<provider>] [--json]

# Single-provider ask query
omcu ask <provider> --prompt "..." [--model ...]

# Multi-provider compare and consensus
omcu ask --compare cursor,codex,gemini --prompt "..."
```

## Consensus Artifacts

Compare operations generate a typed `ConsensusArtifact` under `.omcu/artifacts/consensus-*.json` with:
- `verdict`: `full_consensus` | `partial_consensus` | `divergent` | `failed`
- `agreementScore`: numeric similarity score (0.0 - 1.0)
- `synthesis`: automated synthesis of points of agreement and disagreement
- Advisory disclaimer: "Provider agreement is advisory evidence, not test/command evidence."
