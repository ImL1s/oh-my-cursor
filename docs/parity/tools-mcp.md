# Tools & Model Context Protocol (MCP) Parity

## Tool Inventory

| Tool / Service | Type | Upstream Analogs | Selected Cursor Primitive | Disposition |
|---|---|---|---|---|
| `Event Timeline Tracker` | In-process Tool | {"omc":"omc_tracker","omx":"omx_tracer"} | `cursor-sdk-custom-tools` | `thin-extension` |
| `Git Worktree Runner Tool` | In-process Tool | {"omo":"omo_worktree_runner"} | `cursor-worktree, cursor-sdk-custom-tools` | `native` |
| `Code Navigation & LSP` | In-process Tool | {"omc":"omc_lsp","omx":"omx_lsp"} | `cursor-sdk-custom-tools` | `thin-extension` |
| `Hashline Precision Editing` | In-process Tool | {"omo":"omo_hashline","omx":"omx_hashline"} | `cursor-sdk-custom-tools` | `thin-extension` |
| `AST Pattern Search & Rewrite` | In-process Tool | {"omx":"omx_ast_grep"} | `cursor-sdk-custom-tools` | `native` |
| `Research & Evidence Citation` | In-process Tool | {"omc":"omc_research","omx":"omx_evidence"} | `cursor-sdk-custom-tools` | `composed` |
| `Visual & UI Review Evidence` | In-process Tool | {"omo":"omo_visual","omx":"omx_visual"} | `cursor-sdk-custom-tools` | `composed` |
| `Runtime Domain & State Tools` | In-process Tool | {"omc":"omc_domain","omo":"omo_state"} | `cursor-sdk-custom-tools` | `thin-extension` |

### MCP Infrastructure & Native Tool Runtime
- Native Registration: All tools register inside Cursor's native tool runtime via `@cursor/sdk` `local.customTools`.
- Subagent Visibility: Tools registered under `local.customTools` are exposed through Cursor's built-in `custom-user-tools` MCP server and inherited by nested subagents.
- Central ToolRegistry: Owns canonical names, aliases, input/output schemas, side-effect classifications (`readOnly`, `destructive`, `idempotent`), auto-review integration with `.cursor/permissions.json`, and automatic artifact spill for results exceeding threshold.
- Fail-Closed Invariants:
  - AST operations forbid regex fallback on parser unavailability (`E_AST_PARSER_UNAVAILABLE`).
  - Hashline edits verify line hashes and fail closed on stale edits (`E_STALE_EDIT`).
  - Visual pass verdicts strictly require verified visual capture evidence (`E_VISUAL_EVIDENCE_MISSING`).
  - Research fetches enforce SSRF and private network access protection (`E_UNSAFE_URL`).

