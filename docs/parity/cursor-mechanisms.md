# Cursor Target Mechanisms Inventory

Cursor provides 18 distinct native primitives that serve as the host runtime target for OMCU. Under OMCU design rules, features must NEVER be labeled "emulated" when Cursor provides an official programmable mechanism.

## Mechanism Directory

### 1. `cursor-sdk-local` (Cursor Local SDK Agent Execution)

- **Surface**: `sdk`
- **Source Evidence**: @cursor/sdk npm package: Agent.prompt, Agent.create, Agent.send
- **Requirements**: Local/Cloud: `local`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: Prompt string, optional tool definitions, system instructions, and configuration options
  - *Output*: Streamed message chunks, tool calls, finished status, and final response text
  - *Lifecycle*: Agent instance lifecycle: created -> active prompt -> tool execution -> completed -> idle
- **Persistence & Identity**: In-process or SQLite session storage identified by unique string session ID
- **Permissions & Tools**: Full access to local custom tools, workspace files, and local shell commands subject to permissions
- **Known Limitations**:
  - Requires local Node.js runtime
  - Local context bound by machine RAM and token budget
- **Support Status**: `live`

### 2. `cursor-sdk-cloud` (Cursor Cloud Agent Dispatch)

- **Surface**: `cloud`
- **Source Evidence**: @cursor/sdk npm package: CloudAgent.create, CloudAgent.status
- **Requirements**: Local/Cloud: `cloud`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: Repository URI, commit hash, goal description, and environment secrets
  - *Output*: Remote execution run ID, streamed telemetry logs, and final git branch/PR URI
  - *Lifecycle*: Queued -> Provisioning remote VM -> Cloning -> Executing -> Generating PR -> Finished
- **Persistence & Identity**: Cursor Cloud persistent run storage with cryptographic run ID
- **Permissions & Tools**: Cloud sandbox isolated containers with internet access and configured secrets
- **Known Limitations**:
  - Network roundtrip latency
  - Requires active Cursor cloud subscription
- **Support Status**: `live`

### 3. `cursor-sdk-resume` (Cursor Conversation Resume & Persistence)

- **Surface**: `sdk`
- **Source Evidence**: @cursor/sdk npm package: Agent.resume, Agent.list, SDK store
- **Requirements**: Local/Cloud: `local`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: Session ID string and optional resumed prompt
  - *Output*: Restored agent state with complete prior message history and active context
  - *Lifecycle*: Lookup stored session -> Rehydrate message state -> Re-attach custom tools -> Ready
- **Persistence & Identity**: Persisted to disk SQLite / JSON conversation store keyed by session UUID
- **Permissions & Tools**: Inherits original session tool definitions and authorization bounds
- **Known Limitations**:
  - State rehydration fails if backing database or files are corrupted or deleted
- **Support Status**: `live`

### 4. `cursor-sdk-subagent` (Cursor Local Subagent Hierarchy)

- **Surface**: `sdk`
- **Source Evidence**: @cursor/sdk npm package: Agent.createChild, DAG task runner pattern
- **Requirements**: Local/Cloud: `local`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: Child role name, specialized system prompt, scoped tool whitelist, and parent context slice
  - *Output*: Structured child task result, telemetry metrics, and parent notification message
  - *Lifecycle*: Parent spawns child -> Child runs independently -> Emits result -> Parent collects -> Teardown
- **Persistence & Identity**: Child session linked hierarchically to parent conversation ID
- **Permissions & Tools**: Strict subset of parent permissions; cannot elevate privileges
- **Known Limitations**:
  - Deep subagent recursion may exhaust process memory or file descriptors
- **Support Status**: `live`

### 5. `cursor-sdk-custom-tools` (Cursor In-Process TypeScript Custom Tools)

- **Surface**: `sdk`
- **Source Evidence**: @cursor/sdk npm package: local.customTools registration API
- **Requirements**: Local/Cloud: `local`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: JSON schema parameters matching registered tool signature
  - *Output*: Arbitrary JSON-serializable output object or string returned to model
  - *Lifecycle*: Registered at startup -> Invoked during agent reasoning loop -> Synchronous/async execution -> Return
- **Persistence & Identity**: Stateless tool handlers bound to host process lifecycle
- **Permissions & Tools**: Can interact with local filesystem, network, and system APIs directly in Node.js
- **Known Limitations**:
  - Tool execution blocks agent loop if asynchronous operations fail to timeout
- **Support Status**: `live`

### 6. `cursor-plugin-skill` (Cursor Plugin Skill Format)

- **Surface**: `plugin`
- **Source Evidence**: cursor/plugins repository: skills/<skill>/SKILL.md standard structure
- **Requirements**: Local/Cloud: `both`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: Slash command invocation (/command <args>) from user or parent agent
  - *Output*: Structured Markdown instructions, prompt expansion, and recommended tool calls
  - *Lifecycle*: Discovered from skills/ directory -> Matched on slash invocation -> Injected into prompt
- **Persistence & Identity**: File-based markdown skill definitions discovered at plugin registration time
- **Permissions & Tools**: Inherits caller environment tool and permission boundaries
- **Known Limitations**:
  - Static instruction format; dynamic logic requires host script or tool execution
- **Support Status**: `live`

### 7. `cursor-plugin-agent` (Cursor Plugin Agent Persona Format)

- **Surface**: `plugin`
- **Source Evidence**: cursor/plugins repository: agents/<agent>.md persona and tool scoping definitions
- **Requirements**: Local/Cloud: `both`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: Target task description and agent invocation tag
  - *Output*: Specialized agent execution under defined persona and restricted toolset
  - *Lifecycle*: Loaded from agents/ -> Spawned as dedicated subagent or primary personality -> Completed
- **Persistence & Identity**: File-based markdown persona definitions with frontmatter role and capabilities
- **Permissions & Tools**: Tools explicitly scoped in frontmatter tools whitelist
- **Known Limitations**:
  - Model selection depends on host support and configured API keys
- **Support Status**: `live`

### 8. `cursor-plugin-rule` (Cursor Persistent Context Rules (AGENTS.md & .cursor/rules))

- **Surface**: `plugin`
- **Source Evidence**: .cursor/rules/*.mdc and repository AGENTS.md conventions
- **Requirements**: Local/Cloud: `both`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: Workspace file pattern match or root directory context loading
  - *Output*: Persistent prompt constraints injected into every turn of every agent
  - *Lifecycle*: Evaluated at each user turn based on glob pattern matches or global root inclusion
- **Persistence & Identity**: Committed repository files under .cursor/rules/ or root AGENTS.md
- **Permissions & Tools**: Context injection only; no direct execution privileges
- **Known Limitations**:
  - Consumes token context window on every turn
- **Support Status**: `live`

### 9. `cursor-plugin-hook` (Cursor Lifecycle Hooks)

- **Surface**: `hook`
- **Source Evidence**: cursor/cookbook: cookbook hooks examples and hooks/hooks.json definitions
- **Requirements**: Local/Cloud: `local`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: Event payload (session start, pre-tool, post-tool, stop) serialized as JSON
  - *Output*: Exit code 0 to permit action, non-zero to block, or modified tool arguments
  - *Lifecycle*: Event fires -> Hook script spawned -> Stdin JSON passed -> Stdout parsed -> Proceed or abort
- **Persistence & Identity**: Configured in hooks/hooks.json or plugin manifest
- **Permissions & Tools**: Executes as external script with host user privileges
- **Known Limitations**:
  - Hook timeouts must be strictly enforced to avoid hanging the interactive UI
- **Support Status**: `live`

### 10. `cursor-mcp` (Cursor Model Context Protocol (MCP) Integration)

- **Surface**: `plugin`
- **Source Evidence**: .mcp.json repository configuration and cursor-sdk plugin MCP integration
- **Requirements**: Local/Cloud: `both`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: JSON-RPC 2.0 requests over stdio or SSE transport
  - *Output*: Structured tool schema definitions, tool execution responses, and resource payloads
  - *Lifecycle*: Host starts MCP server process -> Handshake -> Tool discovery -> Model calls -> Server responds
- **Persistence & Identity**: Configured in .mcp.json or user-level ~/.cursor/mcp.json
- **Permissions & Tools**: Server controls exposed tools; host user approves initial server activation
- **Known Limitations**:
  - Stdio transport requires local binary installed; SSE requires reachable server
- **Support Status**: `live`

### 11. `cursor-permissions-auto-review` (Cursor Permissions & Local Auto-Review Engine)

- **Surface**: `permissions`
- **Source Evidence**: @cursor/sdk npm package: local.autoReview API and permissions.json
- **Requirements**: Local/Cloud: `local`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: Proposed tool invocation, command line string, target file path, and risk level
  - *Output*: Approval decision: allow, deny, or escalate to interactive human confirmation modal
  - *Lifecycle*: Tool call intercepted -> autoReview evaluated against rules -> Policy enforced
- **Persistence & Identity**: Configured via policy files or programmable handler function
- **Permissions & Tools**: Authoritative gatekeeper preventing unauthorized shell or filesystem writes
- **Known Limitations**:
  - Cannot prevent side effects of pre-approved commands
- **Support Status**: `live`

### 12. `cursor-cli` (Cursor Host CLI Interface)

- **Surface**: `cli`
- **Source Evidence**: cursor / cursor-agent binary CLI help and omcu_capabilities.lock.json
- **Requirements**: Local/Cloud: `local`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: CLI arguments: --mode plan|ask, --print, --output-format json|stream-json, create-chat, ls, --resume
  - *Output*: Standard output JSON streams, session metadata, or interactive terminal session
  - *Lifecycle*: Invoked by user or script -> Runs agent loop -> Flushes output -> Exits with code
- **Persistence & Identity**: Interacts with host local session database
- **Permissions & Tools**: Runs with user terminal privileges and environment variables
- **Known Limitations**:
  - Interactive terminal mode cannot be easily scripted without headless flags
- **Support Status**: `live`

### 13. `cursor-agent-window` (Cursor Multi-Agent Window & Tabs)

- **Surface**: `sdk`
- **Source Evidence**: Cursor IDE native Multi-Chat and Agent Window architecture
- **Requirements**: Local/Cloud: `local`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: User message or agent invocation in dedicated chat tab
  - *Output*: Rendered conversational stream with integrated diff viewers and file link badges
  - *Lifecycle*: Tab opened -> Agent assigned -> Concurrent turns executed -> Tab closed/archived
- **Persistence & Identity**: GUI state backed by IDE workspace storage
- **Permissions & Tools**: Access to IDE editor buffers, active selections, and terminal panes
- **Known Limitations**:
  - GUI surface requires running Cursor desktop application
- **Support Status**: `live`

### 14. `cursor-worktree` (Cursor Git Worktree Workspace Isolation)

- **Surface**: `worktree`
- **Source Evidence**: cursor-team-kit and cookbook worktree execution patterns
- **Requirements**: Local/Cloud: `local`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: Branch name and target checkout directory
  - *Output*: Isolated filesystem working tree sharing underlying .git repository objects
  - *Lifecycle*: git worktree add -> Agent operates in worktree -> Branch committed -> Merged or pruned
- **Persistence & Identity**: Git repository worktree metadata under .git/worktrees/
- **Permissions & Tools**: Full filesystem access within the worktree boundary
- **Known Limitations**:
  - Requires clean git repository state; simultaneous writes to same file handled via git branches
- **Support Status**: `live`

### 15. `cursor-automation` (Cursor Background Automations)

- **Surface**: `automation`
- **Source Evidence**: Cursor docs: background automations, scheduled runs, and event triggers
- **Requirements**: Local/Cloud: `cloud`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: Cron trigger or webhook event + workflow automation specification
  - *Output*: Autonomous headless agent execution run and pull request / notification output
  - *Lifecycle*: Scheduled event triggers -> Cloud runner spins up -> Executes task -> Emits report
- **Persistence & Identity**: Cursor Cloud automation dashboard and run histories
- **Permissions & Tools**: Scoped repository token permissions and cloud sandbox resources
- **Known Limitations**:
  - Requires enterprise cloud configuration
- **Support Status**: `live`

### 16. `cursor-canvas` (Cursor Canvas & Artifact Interface)

- **Surface**: `canvas`
- **Source Evidence**: Cursor IDE Canvas interactive preview and artifact visualization panels
- **Requirements**: Local/Cloud: `both`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: Markdown, HTML, SVG, or JSON artifact payload
  - *Output*: Interactive side-by-side rendered visual canvas with live feedback controls
  - *Lifecycle*: Agent writes artifact -> Canvas panel renders -> User reviews / interacts -> Agent updates
- **Persistence & Identity**: Stored in workspace scratch directory or embedded in conversation transcript
- **Permissions & Tools**: Read-only display for user interaction; can dispatch actions to agent
- **Known Limitations**:
  - Complex JS execution in canvas requires trusted sandbox mode
- **Support Status**: `live`

### 17. `cursor-router` (Cursor Adaptive Model Router)

- **Surface**: `router`
- **Source Evidence**: Cursor model selection settings: auto/fast/smart/reasoning dynamic routing
- **Requirements**: Local/Cloud: `both`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: Prompt complexity, active task type (code edit vs reasoning vs chat), and latency target
  - *Output*: Optimally routed LLM model endpoint invocation (Sonnet, Opus, GPT-5, Flash, etc.)
  - *Lifecycle*: Prompt classified at gateway -> Route selected -> Model invoked -> Tokens streamed
- **Persistence & Identity**: Stateless model routing proxy managed by Cursor infrastructure
- **Permissions & Tools**: Model capabilities aligned with selected backend
- **Known Limitations**:
  - Automatic routing decisions may vary based on model provider availability
- **Support Status**: `live`

### 18. `cursor-plugin-command` (Cursor Plugin Command Format)

- **Surface**: `plugin`
- **Source Evidence**: cursor/plugins repository: commands/*.md standard command declarations
- **Requirements**: Local/Cloud: `both`, Platforms: darwin, linux, win32
- **Contract**:
  - *Input*: User slash command (/command-name) invocation in chat prompt
  - *Output*: Expanded prompt instructions, workflow triggers, and command context
  - *Lifecycle*: Loaded from commands/ -> Matched on slash input -> Prompt expanded -> Executed
- **Persistence & Identity**: Static markdown command definitions committed to commands/ directory
- **Permissions & Tools**: Inherits caller environment tool and permission boundaries
- **Known Limitations**:
  - Static markdown template without dynamic interactive input prompting
- **Support Status**: `live`

