# Cursor 集成

English: [cursor-integration.md](./cursor-integration.md) · [简体中文](./cursor-integration.zh.md) · [繁體中文](./cursor-integration.zh-TW.md)

## 已验证的主机表面

OMCU 固定 Cursor Agent `2026.07.20-8cc9c0b`。运行：

```sh
omcu capabilities discover
```

仅当版本与必要 help 文字皆符合 lock 时才算 verified。这可避免文档与编排默默假设较新或不同的 CLI。

固定表面包含：

- 交互式 Agent 会话与非交互 `--print` 输出；
- `text`、`json` 与 `stream-json` 输出；
- 会话创建、选择、精确 resume 与最新会话 continue；
- Ask 与 Plan 模式；
- 插件加载、rules、skills、hooks、MCP 与子代理。

Cursor 官方参考：

- [Cursor CLI 概览](https://cursor.com/docs/cli/overview)
- [在 CLI 中使用 Agent](https://cursor.com/docs/cli/using)
- [CLI 参数](https://cursor.com/docs/cli/reference/parameters)
- [输出格式](https://cursor.com/docs/cli/reference/output-format)
- [Rules](https://cursor.com/docs/rules)
- [Agent Skills](https://cursor.com/docs/skills)
- [子代理](https://cursor.com/docs/subagents)
- [Hooks](https://cursor.com/docs/hooks)
- [MCP](https://cursor.com/docs/mcp)
- [插件](https://cursor.com/docs/plugins)
- [Terminal 工具](https://cursor.com/docs/agent/tools/terminal)

## 只读行为

`--print` 仅使运行变为非交互。Cursor 文档说明 print 模式具备所有工具，包含文件写入与 shell 命令。因此不应将其视为只读标志：

```sh
# 非交互，但本身不是只读
cursor-agent --print "inspect the repository"

# OMCU 只读规划通道会加上 Plan 模式
cursor-agent --print --mode plan "produce a plan; do not edit files"
```

Ask 与 Plan 在固定主机表面上会降低编辑权威，但无法证明操作系统层隔离。请使用 Cursor 自己的审批与 sandbox 配置处理该边界。

## 会话

```sh
omcu session create
omcu session list
omcu session resume --id <chat-id>
omcu session continue
```

无 `--prompt` 时，resume 与 continue 以交互方式打开 Cursor。有 `--prompt` 时，OMCU 使用非交互 JSON 输出。精确 resume 会验证提供的 ID，绝不回退到其他 chat。

## 插件、rules、skills 与 agents

为单次 Cursor 调用加载 checkout：

```sh
cursor-agent --plugin-dir "$PWD"
```

插件 manifest 暴露：

- `commands/` 中的 slash commands；
- `skills/` 中成对的 Agent Skills；
- `agents/` 中的自定义 agents；
- `.cursor/rules/oh-my-cursor.mdc` 中的 always-applied rule；
- `hooks/hooks.json` 的生命周期 hooks；
- `.mcp.json` 的 MCP 配置。

子代理为 Cursor 原生 worker。OMCU 自定义 agents 明确禁止嵌套委派，最终集成与验证保留在父代理。OMCU 不声称存在文档化的原生 Cursor `team` 命令或一般 workflow-engine 命令。

## MCP

Cursor Agent 读取项目 MCP 配置。OMCU 随附空的 `.mcp.json`，安装时不会静默启动或授权服务器。本地 MCP 服务仅实现：

- `omcu.memory.search`；
- `omcu.memory.show`；
- `omcu.recovery.show`；
- `omcu.proposal.write`。

不提供 shell 工具，并拒绝试图宣称 `passes` 或 `verified` 的字段。提案经过编修且非权威。

## Worktree 与 tmux

Cursor 支持 terminal 工具与子代理。OMCU 另外提供：

- worktree ULW：隔离的 detached Git worktree 与不重叠的路径所有权；
- 实验性 tmux supervisor：在记录的 pane 与进程组中运行本地 `cursor-agent --print --mode ask` 进程。

这些是 OMCU 本地实现。它们不是原生 Cursor team 权威、不会自我验证，且需要父进程集成结果。tmux 行为取决于本地终端、shell 配置与进程组支持。当代理终端输出异常时，Cursor 终端文档建议简化 shell prompt。

## 不声称原生 memory 或 notification

上述 Cursor 文档未定义 Cursor Agent memory 管理 CLI 或通知传递 CLI。OMCU 的 `memory` 与 `notify` 模块为 `.omcu/` 下的项目本地服务。通知默认关闭，且 OMCU 仅包含拒绝传输，因此在应用程序提供并启用传输前不会发送任何消息。
