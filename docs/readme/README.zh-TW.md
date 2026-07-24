# oh-my-cursor

English: [README.md](../../README.md) · [简体中文](./README.zh.md) · [繁體中文](./README.zh-TW.md)

以 Cursor Agent 能力為依據的編排層。

- 套件：`@iml1s/oh-my-cursor`
- CLI：`omcu`
- 版本：`0.2.1`
- Node.js：20+
- 釘選 Cursor Agent：`2026.07.23-e383d2b`
- 專案狀態：`.omcu/`（僅擁有者可寫，由 CLI 撰寫）

Oh My Cursor 包裝已文件化的 Cursor Agent 能力，其餘部分如實標示。支援互動與 headless 工作階段、Ask/Plan 模式、resume/continue、外掛、skills、hooks、MCP、子代理、工作流程證據與本機復原。它**不**宣稱有文件化的原生 Cursor team/workflow 指令、原生 memory/notification CLI，或安全隔離邊界。

> **重要：** Cursor 文件將 `--print` 描述為非互動，且可使用寫入與 shell 工具。`--print` 本身**不是**唯讀。唯讀代理通道請用 Ask 或 Plan 模式，並將作業系統層隔離／核准控制分開處理。

## 快速開始

```sh
npm ci
npm run build
npm test
node dist/bin/omcu.js --version
node dist/bin/omcu.js capabilities discover
cursor-agent --plugin-dir "$PWD"
```

最後一行僅為單次 Cursor 呼叫載入外掛，不會修改 `~/.cursor`。

## 安裝

### 方便方式（最新 release）

```sh
curl -fsSL https://raw.githubusercontent.com/ImL1s/oh-my-cursor/main/scripts/bootstrap.sh | bash
```

可用 `OMCU_TAG=v0.2.1` 釘選版本，並以 `OMCU_PROJECT=/absolute/path` 在安裝時初始化專案。bootstrap 會下載 release 壓縮檔與 `SHA256SUMS`，在執行任何內容前先驗證校驗和，再執行封裝的收據式安裝程式（會再次驗證壓縮檔，並在受管解壓前拒絕不安全的壓縮路徑）。

### 從原始碼

```sh
npm ci
npm run build
./scripts/install.sh --source "$PWD" --project /absolute/path/to/project
```

會將不可變套件位元組暫存於 `~/.local/state/oh-my-cursor/`，建立 `~/.local/bin/omcu`，初始化專案 `.omcu/`，並列印收據。若需要，請將 `~/.local/bin` 加入 `PATH`。

### 離線 release

若已有 checkout 或已解壓的 release：

```sh
./scripts/install.sh \
  --archive /absolute/path/to/iml1s-oh-my-cursor-0.2.1.tgz \
  --checksums /absolute/path/to/SHA256SUMS \
  --project /absolute/path/to/project
```

首次離線 bootstrap：先驗證校驗和、解壓 `.tgz`，再從解壓後的 release 執行 `package/scripts/install.sh`。安裝程式會再次驗證壓縮檔，並在受管解壓前拒絕不安全路徑。完整 bootstrap、來源／release 更新、手動外掛載入、讀回、回滾與收據式解除安裝見 [安裝與生命週期](../installation.zh-TW.md)。

## `omcu` 提供什麼

| 領域 | 指令 | 真實邊界 |
| --- | --- | --- |
| 主機 | `capabilities`、`native-status`、`session`、`resume` | 委派給釘選的 Cursor Agent CLI。 |
| 權威 | `state`/`run`、`cancel`、`lease` | 僅此路徑可變更 run 驗證狀態。 |
| 本機服務 | `recover`、`compact`、`memory`、`notify`、`tracker`、`wiki` | 專案本機；非 Cursor 原生服務。 |
| 外掛／MCP | `mcp-install`、`mcp-server` | 固定唯讀／提案 MCP 工具；無 shell 或驗證權威。 |
| 工作流程 | `workflow`、`ralplan`、`ralph`、`autopilot`、`review`、`qa`、`accept` | 收據與關卡為建議性，且 `verified: false`。 |
| 持久化 | `persist start`/`status`/`done`/`stop` | 透過 `stop`/`subagentStop` hooks 的 opt-in「巨石不停」迴圈；絕不偽造完成。 |
| 平行工作 | `ulw`、`team` | worktree／tmux 為實驗性本機協調，非 Cursor 原生 team。 |

執行 `omcu --help` 查看指令索引；選項與範例見 [完整 CLI 參考](../cli.zh-TW.md)。

ULW 在呼叫 worker 後保留每個 worktree，以便未提交變更與 detached commit 仍可整合；收據包含保留路徑與 Git 證據。若工作流程 run 出現孤立的 `task_started` 意圖，會回報 `ambiguous`，且絕不自動重跑不確定的副作用。手動對帳與清理指引見 CLI 參考。

## 狀態與驗證

安裝狀態與專案狀態刻意分離：

```text
~/.local/state/oh-my-cursor/   不可變階段、目前指標、收據
<project>/.omcu/               runs、證據、workflows、復原、本機服務
```

已完成的工作流程或子代理回應**不算** verified。權威序列為：

```sh
omcu state create --id release-0.1.0 --objective "verify release"
omcu state transition --id release-0.1.0 --revision 1 --status complete
omcu state verify --id release-0.1.0 --revision 2 --evidence-sha256 <64-hex-digest>
omcu state status --id release-0.1.0
```

轉換使用 revision 圍欄，並清除先前的驗證。證據須為來自新鮮、穩定結果的小寫 SHA-256 摘要。

## Cursor 整合

外掛包含 commands、skills、自訂 agents、rules 與 hooks。隨附的 `.mcp.json` 為空，安裝時不會默默啟用伺服器；僅在專案需要暴露 OMCU 本機 MCP 工具時執行 `omcu mcp-install`。

Cursor 官方文件：

- [CLI 概覽](https://cursor.com/docs/cli/overview)、[使用方式](https://cursor.com/docs/cli/using)、[參數](https://cursor.com/docs/cli/reference/parameters)、[輸出格式](https://cursor.com/docs/cli/reference/output-format)
- [外掛](https://cursor.com/docs/plugins)、[rules](https://cursor.com/docs/rules)、[skills](https://cursor.com/docs/skills)、[子代理](https://cursor.com/docs/subagents)、[hooks](https://cursor.com/docs/hooks)、[MCP](https://cursor.com/docs/mcp)
- [Terminal 工具](https://cursor.com/docs/agent/tools/terminal)

能力分級、工作階段路由、外掛表面、worktree 與 tmux 相容性見 [Cursor 整合](../cursor-integration.zh-TW.md)。

## 復原警告

優先使用原生 `resume`/`continue`。JSONL 復原後備服務接受**一個**明確的絕對路徑檔案，且僅複製最後 **900 行**。會記錄截斷與 partial/unknown/broken-chain 警告。復原快照可能不完整，且**無法**建立完成或驗證。見 [工作階段復原](../recovery.zh-TW.md)。

## 開發與發布

```sh
npm run check
node dist/bin/omcu.js --help
node dist/bin/omcu.js capabilities discover
```

- [架構](../architecture.zh-TW.md)
- [貢獻指南](../../CONTRIBUTING.md)
- [安全](../../SECURITY.md)
- [行為準則](../../CODE_OF_CONDUCT.md)
- [專案狀態](../../PROJECT.md)
- [測試就緒](../../TEST_READY.md)
- [即時驗證](../live-verification.md)（僅英文）
- [發布流程與產物](../releasing.zh-TW.md)
- [變更紀錄](../../CHANGELOG.md)


## 語言

| 語言 | README |
| --- | --- |
| English | [../../README.md](../../README.md) |
| 简体中文 | [README.zh.md](./README.zh.md) |
| 繁體中文 | [README.zh-TW.md](./README.zh-TW.md) |

翻譯文件索引與維護規則：[README.md](./README.md)。

授權：[MIT](../../LICENSE)。
