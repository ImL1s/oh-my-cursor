# 架构

English: [architecture.md](./architecture.md) · [简体中文](./architecture.zh.md) · [繁體中文](./architecture.zh-TW.md)

Oh My Cursor 是本地 TypeScript 包与 Cursor 插件。它将代理行为委托给 Cursor Agent，但将自己的证据与生命周期状态分开维护。

## 边界

```text
Cursor Agent
  interactive / --print / Ask / Plan / sessions
             |
             v
src/host + src/capabilities + src/sessions
             |
             v
omcu CLI ------------------> <project>/.omcu/
  |                              owner-only state
  +--> workflow and mode libraries
  +--> local services
  +--> experimental worktrees/tmux

setup lifecycle -----------> ~/.local/state/oh-my-cursor/
                               immutable stages + receipts
```

### 主机适配器

`src/host/` 构建有界参数数组，并以 `shell: false` 直接调用 `cursor-agent`。JSON 与 stream-JSON 输出在解析前会限制大小。标准错误会经过编修。

`src/capabilities/` 比对实时 `--version` 与 `--help` 表面与 `omcu_capabilities.lock.json`。完全不符时会降级所有能力宣称。

`src/sessions/` 将 OMCU 会话命令映射到 `create-chat`、`ls`、`--resume` 与 `--continue`。交互式 resume/continue 继承 Cursor 终端 UI；提供 prompt 时使用 JSON print 模式。

### 状态与权威

`src/runtime/` 建立仅所有者可写的根目录，防止路径逃逸与符号链接根、执行原子写入，并编修敏感字段。

`src/state/` 在 `.omcu/` 下存储 runs、events 与 leases。Run 转换使用乐观 revision。Lease 使用 owner、generation 与到期围栏。终端 run 在 `omcu run verify` 记录新鲜 SHA-256 证据摘要前不算 verified。

工作流收据、模式结果、team 收集、hooks 与 MCP 提案刻意包含 `verified: false`。它们可提供证据，但无法自行验收。

### 工作流与协调

`src/workflows/` 验证不可变工作流定义、构建依赖排序的计划、在 Ask 或 Plan 模式调用 Cursor，并发出摘要链事件与收据。

`src/modes/` 包含 RALPLAN、Ralph、worktree ULW 与建议性 plan/review/QA/acceptance 关卡。这些是 OMCU 实现，**不是**文档化的原生 Cursor workflow 命令。

`src/team/` 监督实验性 tmux 会话。它记录 pane 进程组、拒绝重叠路径所有权、捕获输出，并报告 `native_cursor_team: false`。Cursor 文档化的子代理表面仍是偏好的代理内并行机制。

### 项目服务

- `src/recovery/`：复制明确指名 JSONL 来源的不可变、编修后尾部。
- `src/compaction/`：generation 围栏 checkpoint。
- `src/memory/`：编修的项目本地记录与导入/导出；非原生 Cursor memory。
- `src/notify/`：默认关闭的队列与传输边界；非原生 Cursor 通知。
- `src/tracker/` 与 `src/wiki/`：生命周期历史与衍生页面。
- `src/mcp/`：固定只读/提案工具；结构上拒绝 shell 与验证权威。

### 插件表面

`.cursor-plugin/plugin.json` 连接 slash commands、skills、自定义 agents、rules、hooks 与 `.mcp.json`。hook 实现验证并编修输入，但返回中性策略响应。随附 MCP manifest 为空；加载服务器需要明确的项目配置。

见 [Cursor 集成](cursor-integration.zh.md) 与 [安全政策](../SECURITY.md)。
