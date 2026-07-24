# CLI 参考

English: [cli.md](./cli.md) · [简体中文](./cli.zh.md) · [繁體中文](./cli.zh-TW.md)

除非路径选项另有说明，所有命令均以当前工作目录为准。项目服务写入 `<cwd>/.omcu/`。输出为 JSON，交互式 Cursor 会话、渲染的 checkpoint 文字与直接 Cursor 输出除外。

```sh
omcu --help
omcu --version
```

## Host 启动（交互 / madmax）

与 OMX 对齐的入口：

```sh
omcu                         # 交互式 cursor-agent（含 --plugin-dir）
omcu "修复失败测试"            # 带初始 prompt 的交互
omcu --madmax                # full-open break-glass
omcu --madmax --direct …     # 不包 tmux
omcu --madmax --tmux …       # 强制 tmux（缺失则失败）
```

`--madmax` 映射为 Cursor `--force --sandbox disabled`，并始终通过 `--plugin-dir` 加载本包。`--approve-mcps` / `--trust` 仅在你显式传入时生效。它是 host launcher，不是 mode FSM，也不会盖 `verified`。默认传输为 detached tmux 再 attach；auto 在无 tmux 时可回退 direct；显式 `--tmux` 不会回退。

## 生命周期与能力

| 命令 | 用途 |
| --- | --- |
| `omcu setup [--source <dir>] [--state-root <dir>]` | 安装包来源、创建当前项目的 `.omcu/`，并运行 doctor。 |
| `omcu update [--source <dir>] [--state-root <dir>]` | 暂存并切换至来源字节；失败时回滚。 |
| `omcu doctor` | 检查 Cursor、插件可加载性与本地配置。退出码 `0`、`2`（警告）或 `1`（失败）。 |
| `omcu uninstall [--receipt <file>] [--state-root <dir>] [--purge-project-state]` | 移除收据拥有的路径；默认为当前收据。 |
| `omcu capabilities discover` | 比对实时 Cursor 版本/help 与固定 lock。 |
| `omcu capabilities native-status` | 运行 `cursor-agent status` 并返回 JSON 封装。 |
| `omcu native-status` | `capabilities native-status` 的别名。 |
| `omcu mcp-install [--file <path>]` | 将 `oh-my-cursor` stdio 服务器合并至项目 MCP JSON 文件。 |
| `omcu mcp-server` | 在 stdio 上提供固定的非权威 MCP 工具集。 |

CLI 生命周期路径从来源安装。已验证的离线压缩包请使用 [安装](installation.zh.md) 所述的 `scripts/install.sh` 与 `dist/src/setup/script-entry.js`。

## 会话

```sh
omcu session create
omcu session list
omcu session resume --id <chat-id> [--prompt <text>]
omcu session continue [--prompt <text>]
omcu resume --id <chat-id> [--prompt <text>]
```

无 prompt 时，list/resume/continue 使用 Cursor 交互终端。有 prompt 时使用 `--print --output-format json`。Print 模式本身不是只读。

## 权威 run 状态

`state` 与 `run` 为别名。

```sh
omcu state create --id <run-id> --objective <text>
omcu state status --id <run-id>
omcu state transition --id <run-id> --revision <n> --status active|complete|failed|cancelled
omcu state verify --id <run-id> --revision <n> --evidence-sha256 <64-hex>
omcu state event --id <run-id> --type <type> [--payload-json <json>]
omcu cancel --id <run-id>
```

每次转换会清除先前的验证。验证会拒绝 active run、过期 revision 与格式错误的证据摘要。`cancel` 读取当前 revision 并执行有围栏的取消。

Lease 协调项目写入者：

```sh
omcu lease acquire --run <run-id> --name <lease> --owner <owner> [--ttl-ms <n>]
omcu lease status --run <run-id> --name <lease>
omcu lease release --run <run-id> --name <lease> --owner <owner> --generation <n>
```

TTL 须介于 1,000 与 86,400,000 毫秒之间。

## 恢复与 checkpoint

```sh
omcu recover --transcript /absolute/path/to/file.jsonl [--id <id>]
omcu recover --project-jsonl /absolute/path/to/file.jsonl [--id <id>]
omcu recover show --id <id>

omcu compact checkpoint --id <id> --generation <n> --payload-json <json>
omcu compact show --id <id>
omcu compact render --id <id> --generation <n>
```

恢复需要恰好一个绝对来源路径，且仅复制最后 900 行。Checkpoint 使用 generation 围栏与摘要链。

## 项目内存

这是 OMCU 项目内存，**不是**文档化的 Cursor memory CLI。

```sh
omcu memory put --text <text> [--id <id>] [--metadata-json <json>]
omcu memory list
omcu memory show --id <id>
omcu memory search --query <text> [--limit <1-100>]
omcu memory export
omcu memory import --file <bundle.json>
omcu memory rescan
```

值在存储前会经过编修。export 将 JSON 写入 stdout；需要时请重定向至受保护文件。

## 通知

```sh
omcu notify status
omcu notify configure --generation <n> [--enable --destination <value>]
omcu notify enqueue --payload-json <json> [--id <id>]
omcu notify show --id <id>
omcu notify dispatch --id <id> --generation <n> --nonce <nonce>
```

通知默认关闭。OMCU 在 CLI 中连接拒绝传输，因此即使启用目的地，dispatch 仍不支持。队列与查看仅限本地。

## Tracker 与 wiki

```sh
omcu tracker record --id <subject> --phase created|started|checkpointed|completed|failed|cancelled [--detail-json <json>]
omcu tracker history --id <subject>
omcu wiki render --slug <slug> --generation <n> --title <text> --tracker <subject>
omcu wiki show --slug <slug>
```

Tracker 转换有顺序。Wiki 页面为单一 tracker 历史的编修、generation 围栏视图。

## 工作流

安装不可变、版本化的定义：

```json
{
  "schema_version": 1,
  "name": "delivery",
  "version": "1",
  "capability_tier": "cursor-backed",
  "stages": [
    { "id": "plan", "prompt": "Produce a plan.", "mode": "plan", "depends_on": [], "max_attempts": 1 },
    { "id": "execute", "prompt": "Implement and test.", "mode": "ask", "depends_on": ["plan"], "max_attempts": 1 }
  ]
}
```

```sh
omcu workflow install --file delivery.json
omcu workflow list
omcu workflow show --name delivery [--version 1]
omcu workflow plan --name delivery [--version 1] --id run-1 --objective "ship safely"
omcu workflow run --id run-1
omcu workflow status --id run-1
omcu workflow replay --id run-1
```

定义依 name/version/digest 不可变。计划与摘要链收据位于 `.omcu/workflows/`。已完成的工作流仍报告 `verified: false`；仅 run 状态验证命令具权威。

每次 Cursor 调用前，CLI 会持久化 `task_started` 意图。若进程在对应收据变为持久之前结束，`status` 与 `replay` 会报告 `ambiguous`。OMCU 不会自动重跑该任务，因为其编辑或 shell 副作用可能已发生。检查 run 记录与仓库、手动对账不确定效果后，若需明确重跑请创建新 run ID。刻意**没有**自动 `ambiguous`→重试转换。

## Cursor 支持的模式

```sh
omcu ralplan --objective <text> [--rounds <1-10>]
omcu ralph --objective <text> [--iterations <1-100>]
omcu autopilot --objective <text>
omcu pipeline --gates-json <json>
omcu review --prompt <text> [--format stream-json]
omcu qa --prompt <text> [--format stream-json]
omcu accept --prompt <text> [--format stream-json]
omcu integrate --prompt <text> [--format stream-json]
omcu ask --prompt <text> [--format stream-json]
```

RALPLAN 使用 Plan 模式。Review 与 acceptance prompt 亦使用 Plan 模式；其他角色 prompt 使用 Ask 模式。模式输出为建议性，绝不自我验证。

## Worktree 与 tmux 协调

Worktree ULW 接受 JSON 数组：

```sh
omcu ulw --id <run-id> --workers-json '[
  {"id":"docs","objective":"update docs","owned_paths":["docs"]},
  {"id":"tests","objective":"add tests","owned_paths":["tests"]}
]'
```

每个 worker 在 `.omcu-worktrees/<run-id>/` 下取得唯一命名的 detached worktree。重复 worker ID、重叠所有权与逃逸路径会在 worktree 或 Cursor 效果前被拒绝。

一旦已调用 Cursor，即使 worker 失败，OMCU 仍保留 worktree，因为其中可能有未提交编辑或 detached commit。收据报告 worktree 路径、可观察时的 HEAD OID、dirty 状态、状态摘要与清理命令。执行该命令前请先 integrate 或另行保留 worker 结果。仅在可证明于 worker 调用**之前**失败的情况才符合自动移除 worktree 条件。

实验性 tmux supervisor 接受含 `id`、`objective`、`owned_paths` 的 workers；`cwd` 可选，默认为当前目录：

```sh
omcu team start --id <team-id> --workers-json '<json-array>'
omcu team status --id <team-id>
omcu team collect --id <team-id>
omcu team stop --id <team-id>
```

`team run` 为 `team start` 的别名；不会 collect 或验证结果。supervisor 创建 `cursor-agent --print --mode ask` 进程、记录 pane 进程组，并报告 `native_cursor_team: false`。
