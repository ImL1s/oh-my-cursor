# oh-my-cursor

<p align="center">
  <img src="../../assets/omcu-character.png" alt="oh-my-cursor character" width="300">
</p>


English: [README.md](../../README.md) · [简体中文](./README.zh.md) · [繁體中文](./README.zh-TW.md)

面向 Cursor Agent 的能力落地编排层。

- 包：`@iml1s/oh-my-cursor`
- CLI：`omcu`
- 版本：`0.2.1`
- Node.js：20+
- 固定 Cursor Agent：`2026.07.23-e383d2b`
- 项目状态：`.omcu/`（仅所有者可写，由 CLI 写入）

Oh My Cursor 封装已文档化的 Cursor Agent 能力，其余部分如实标注。支持交互与 headless 会话、Ask/Plan 模式、resume/continue、插件、skills、hooks、MCP、子代理、工作流证据与本地恢复。它**不**声称存在文档化的原生 Cursor team/workflow 命令、原生 memory/notification CLI，或安全隔离边界。

> **重要：** Cursor 文档将 `--print` 描述为非交互，且可使用写入与 shell 工具。`--print` 本身**不是**只读。只读代理通道请用 Ask 或 Plan 模式，并将操作系统层隔离/审批控制分开处理。

## 快速开始

```sh
npm ci
npm run build
npm test
node dist/bin/omcu.js --version
node dist/bin/omcu.js capabilities discover
cursor-agent --plugin-dir "$PWD"
```

最后一行仅为单次 Cursor 调用加载插件，不会修改 `~/.cursor`。

## 安装

### 便捷方式（最新 release）

```sh
curl -fsSL https://raw.githubusercontent.com/ImL1s/oh-my-cursor/main/scripts/bootstrap.sh | bash
```

可用 `OMCU_TAG=v0.2.1` 固定版本，并用 `OMCU_PROJECT=/absolute/path` 在安装时初始化项目。bootstrap 会下载 release 压缩包与 `SHA256SUMS`，在执行任何内容前先校验，再运行打包的收据式安装程序（会再次校验压缩包，并在受管解压前拒绝不安全的归档路径）。

### 从源码

```sh
npm ci
npm run build
./scripts/install.sh --source "$PWD" --project /absolute/path/to/project
```

将不可变包字节暂存于 `~/.local/state/oh-my-cursor/`，创建 `~/.local/bin/omcu`，初始化项目 `.omcu/`，并打印收据。如需，请将 `~/.local/bin` 加入 `PATH`。

### 离线 release

若已有 checkout 或已解压的 release：

```sh
./scripts/install.sh \
  --archive /absolute/path/to/iml1s-oh-my-cursor-0.2.1.tgz \
  --checksums /absolute/path/to/SHA256SUMS \
  --project /absolute/path/to/project
```

首次离线 bootstrap：先校验、解压 `.tgz`，再从解压后的 release 运行 `package/scripts/install.sh`。安装程序会再次校验压缩包，并在受管解压前拒绝不安全路径。完整的 bootstrap、源码/release 更新、手动插件加载、读回、回滚与收据式卸载见 [安装与生命周期](../installation.zh.md)。

## `omcu` 提供什么

| 领域 | 命令 | 真实边界 |
| --- | --- | --- |
| 主机 | `capabilities`、`native-status`、`session`、`resume` | 委托给固定的 Cursor Agent CLI。 |
| 权威 | `state`/`run`、`cancel`、`lease` | 仅此路径可变更 run 验证状态。 |
| 本地服务 | `recover`、`compact`、`memory`、`notify`、`tracker`、`wiki` | 项目本地；非 Cursor 原生服务。 |
| 插件/MCP | `mcp-install`、`mcp-server` | 固定只读/提案 MCP 工具；无 shell 或验证权威。 |
| 工作流 | `workflow`、`ralplan`、`ralph`、`autopilot`、`review`、`qa`、`accept` | 收据与关卡为建议性，且 `verified: false`。 |
| 持久化 | `persist start`/`status`/`done`/`stop` | 通过 `stop`/`subagentStop` hooks 的 opt-in「巨石不停」循环；绝不伪造完成。 |
| 并行工作 | `ulw`、`team` | worktree/tmux 为实验性本地协调，非 Cursor 原生 team。 |

运行 `omcu --help` 查看命令索引；选项与示例见 [完整 CLI 参考](../cli.zh.md)。

ULW 在调用 worker 后保留每个 worktree，以便未提交变更与 detached commit 仍可整合；收据包含保留路径与 Git 证据。若工作流 run 出现孤立的 `task_started` 意图，会报告 `ambiguous`，且绝不自动重跑不确定的副作用。手动对账与清理指引见 CLI 参考。

## 状态与验证

安装状态与项目状态刻意分离：

```text
~/.local/state/oh-my-cursor/   不可变阶段、当前指针、收据
<project>/.omcu/               runs、证据、workflows、恢复、本地服务
```

已完成的工作流或子代理响应**不算** verified。权威序列为：

```sh
omcu state create --id release-0.1.0 --objective "verify release"
omcu state transition --id release-0.1.0 --revision 1 --status complete
omcu state verify --id release-0.1.0 --revision 2 --evidence-sha256 <64-hex-digest>
omcu state status --id release-0.1.0
```

转换使用 revision 围栏，并清除先前的验证。证据须为来自新鲜、稳定结果的小写 SHA-256 摘要。

## Cursor 集成

插件包含 commands、skills、自定义 agents、rules 与 hooks。随附的 `.mcp.json` 为空，安装时不会静默启用服务器；仅在项目需要暴露 OMCU 本地 MCP 工具时运行 `omcu mcp-install`。

Cursor 官方文档：

- [CLI 概览](https://cursor.com/docs/cli/overview)、[用法](https://cursor.com/docs/cli/using)、[参数](https://cursor.com/docs/cli/reference/parameters)、[输出格式](https://cursor.com/docs/cli/reference/output-format)
- [插件](https://cursor.com/docs/plugins)、[rules](https://cursor.com/docs/rules)、[skills](https://cursor.com/docs/skills)、[子代理](https://cursor.com/docs/subagents)、[hooks](https://cursor.com/docs/hooks)、[MCP](https://cursor.com/docs/mcp)
- [Terminal 工具](https://cursor.com/docs/agent/tools/terminal)

能力分级、会话路由、插件表面、worktree 与 tmux 兼容性见 [Cursor 集成](../cursor-integration.zh.md)。

## 恢复警告

优先使用原生 `resume`/`continue`。JSONL 恢复后备服务接受**一个**明确的绝对路径文件，且仅复制最后 **900 行**。会记录截断与 partial/unknown/broken-chain 警告。恢复快照可能不完整，且**无法**建立完成或验证。见 [会话恢复](../recovery.zh.md)。

## 开发与发布

```sh
npm run check
node dist/bin/omcu.js --help
node dist/bin/omcu.js capabilities discover
```

- [架构](../architecture.zh.md)
- [贡献指南](../../CONTRIBUTING.md)
- [安全](../../SECURITY.md)
- [行为准则](../../CODE_OF_CONDUCT.md)
- [项目状态](../../PROJECT.md)
- [测试就绪](../../TEST_READY.md)
- [实时验证](../live-verification.md)（仅英文）
- [发布流程与产物](../releasing.zh.md)
- [变更记录](../../CHANGELOG.md)

许可：[MIT](../../LICENSE)。

## 语言

| 语言 | README |
| --- | --- |
| English | [../../README.md](../../README.md) |
| 简体中文 | [README.zh.md](./README.zh.md) |
| 繁體中文 | [README.zh-TW.md](./README.zh-TW.md) |

翻译文档索引与维护规则：[README.md](./README.md)。

