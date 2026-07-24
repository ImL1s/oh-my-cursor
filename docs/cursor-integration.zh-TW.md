# Cursor 整合

English: [cursor-integration.md](./cursor-integration.md) · [简体中文](./cursor-integration.zh.md) · [繁體中文](./cursor-integration.zh-TW.md)

## 已驗證的主機表面

OMCU 釘選 Cursor Agent `2026.07.23-e383d2b`。執行：

```sh
omcu capabilities discover
```

僅當版本與必要 help 文字皆符合 lock 時才算 verified。這可避免文件與編排在默默假設較新或不同的 CLI。

釘選表面包含：

- 互動式 Agent 工作階段與非互動 `--print` 輸出；
- `text`、`json` 與 `stream-json` 輸出；
- 工作階段建立、選取、精確 resume 與最新工作階段 continue；
- Ask 與 Plan 模式；
- 外掛載入、rules、skills、hooks、MCP 與子代理。

Cursor 官方參考：

- [Cursor CLI 概覽](https://cursor.com/docs/cli/overview)
- [在 CLI 中使用 Agent](https://cursor.com/docs/cli/using)
- [CLI 參數](https://cursor.com/docs/cli/reference/parameters)
- [輸出格式](https://cursor.com/docs/cli/reference/output-format)
- [Rules](https://cursor.com/docs/rules)
- [Agent Skills](https://cursor.com/docs/skills)
- [子代理](https://cursor.com/docs/subagents)
- [Hooks](https://cursor.com/docs/hooks)
- [MCP](https://cursor.com/docs/mcp)
- [外掛](https://cursor.com/docs/plugins)
- [Terminal 工具](https://cursor.com/docs/agent/tools/terminal)

## 唯讀行為

`--print` 僅使執行變為非互動。Cursor 文件說明 print 模式具備所有工具，包含檔案寫入與 shell 命令。因此不應將其視為唯讀旗標：

```sh
# 非互動，但本身不是唯讀
cursor-agent --print "inspect the repository"

# OMCU 唯讀規劃通道會加上 Plan 模式
cursor-agent --print --mode plan "produce a plan; do not edit files"
```

Ask 與 Plan 在釘選主機表面上會降低編輯權威，但無法證明作業系統層隔離。請使用 Cursor 自己的核准與 sandbox 設定處理該邊界。

## 工作階段

```sh
omcu session create
omcu session list
omcu session resume --id <chat-id>
omcu session continue
```

無 `--prompt` 時，resume 與 continue 以互動方式開啟 Cursor。有 `--prompt` 時，OMCU 使用非互動 JSON 輸出。精確 resume 會驗證提供的 ID，絕不回退到其他 chat。

## 外掛、rules、skills 與 agents

為單次 Cursor 呼叫載入 checkout：

```sh
cursor-agent --plugin-dir "$PWD"
```

外掛 manifest 暴露：

- `commands/` 中的 slash commands；
- `skills/` 中成對的 Agent Skills；
- `agents/` 中的自訂 agents；
- `.cursor/rules/oh-my-cursor.mdc` 中的 always-applied rule；
- `hooks/hooks.json` 的生命週期 hooks；
- `.mcp.json` 的 MCP 設定。

子代理為 Cursor 原生 worker。OMCU 自訂 agents 明確禁止巢狀委派，最終整合與驗證保留在父代理。OMCU 不宣稱有文件化的原生 Cursor `team` 命令或一般 workflow-engine 命令。

## MCP

Cursor Agent 讀取專案 MCP 設定。OMCU 隨附空的 `.mcp.json`，安裝時不會默默啟動或授權伺服器。本機 MCP 服務僅實作：

- `omcu.memory.search`；
- `omcu.memory.show`；
- `omcu.recovery.show`；
- `omcu.proposal.write`。

不提供 shell 工具，並拒絕試圖宣稱 `passes` 或 `verified` 的欄位。提案經過編修且非權威。

## Worktree 與 tmux

Cursor 支援 terminal 工具與子代理。OMCU 另外提供：

- worktree ULW：隔離的 detached Git worktree 與不重疊的路徑擁有權；
- 實驗性 tmux supervisor：在記錄的 pane 與程序群組中執行本機 `cursor-agent --print --mode ask` 程序。

這些是 OMCU 本機實作。它們不是原生 Cursor team 權威、不會自我驗證，且需要父程序整合結果。tmux 行為取決於本機終端、shell 設定與程序群組支援。當代理終端輸出異常時，Cursor 終端文件建議簡化 shell prompt。

## 不宣稱原生 memory 或 notification

上述 Cursor 文件未定義 Cursor Agent memory 管理 CLI 或通知傳遞 CLI。OMCU 的 `memory` 與 `notify` 模組為 `.omcu/` 下的專案本機服務。通知預設關閉，且 OMCU 僅包含拒絕傳輸，因此在應用程式提供並啟用傳輸前不會傳送任何訊息。
