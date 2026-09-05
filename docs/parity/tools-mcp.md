# Tools & Model Context Protocol (MCP) Parity

## Tool Inventory

| Tool / Service | Type | Upstream Analogs | Selected Cursor Primitive | Disposition |
|---|---|---|---|---|
| `Event Timeline Tracker` | In-process Tool | {"omc":"omc_tracker","omx":"omx_tracer"} | `cursor-sdk-custom-tools, omcu-domain-layer` | `thin-extension` |
| `Git Worktree Runner Tool` | In-process Tool | {"omo":"omo_worktree_runner"} | `cursor-worktree, cursor-sdk-custom-tools` | `native` |

### MCP Infrastructure
- Host MCP servers registered via `.mcp.json`.
- TypeScript custom tools registered in-process via `@cursor/sdk` `local.customTools`.
