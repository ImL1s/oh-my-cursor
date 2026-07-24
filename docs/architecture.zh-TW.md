# 架構

English: [architecture.md](./architecture.md) · [简体中文](./architecture.zh.md) · [繁體中文](./architecture.zh-TW.md)

Oh My Cursor 是本機 TypeScript 套件與 Cursor 外掛。它將代理行為委派給 Cursor Agent，但將自己的證據與生命週期狀態分開維護。

## 邊界

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

### 主機適配器

`src/host/` 建構有界參數陣列，並以 `shell: false` 直接呼叫 `cursor-agent`。JSON 與 stream-JSON 輸出在解析前會限制大小。標準錯誤會經過編修。

`src/capabilities/` 比對即時 `--version` 與 `--help` 表面與 `omcu_capabilities.lock.json`。完全不符時會降級所有能力宣稱。

`src/sessions/` 將 OMCU 工作階段命令對應到 `create-chat`、`ls`、`--resume` 與 `--continue`。互動式 resume/continue 繼承 Cursor 終端 UI；提供 prompt 時使用 JSON print 模式。

### 狀態與權威

`src/runtime/` 建立僅擁有者可寫的根目錄，防止路徑逃逸與符號連結根、執行原子寫入，並編修敏感欄位。

`src/state/` 在 `.omcu/` 下儲存 runs、events 與 leases。Run 轉換使用樂觀 revision。Lease 使用 owner、generation 與到期圍欄。終端 run 在 `omcu run verify` 記錄新鮮 SHA-256 證據摘要前不算 verified。

工作流程收據、模式結果、team 收集、hooks 與 MCP 提案刻意包含 `verified: false`。它們可提供證據，但無法自行驗收。

### 工作流程與協調

`src/workflows/` 驗證不可變工作流程定義、建構依賴排序的計畫、在 Ask 或 Plan 模式呼叫 Cursor，並發出摘要鏈事件與收據。

`src/modes/` 包含 RALPLAN、Ralph、worktree ULW 與建議性 plan/review/QA/acceptance 關卡。這些是 OMCU 實作，**不是**文件化的原生 Cursor workflow 命令。

`src/team/` 監督實驗性 tmux 工作階段。它記錄 pane 程序群組、拒絕重疊路徑擁有權、擷取輸出，並回報 `native_cursor_team: false`。Cursor 文件化的子代理表面仍是偏好的代理內平行機制。

### 專案服務

- `src/recovery/`：複製明確指名 JSONL 來源的不可變、編修後尾部。
- `src/compaction/`：generation 圍欄 checkpoint。
- `src/memory/`：編修的專案本機記錄與匯入/匯出；非原生 Cursor memory。
- `src/notify/`：預設關閉的佇列與傳輸邊界；非原生 Cursor 通知。
- `src/tracker/` 與 `src/wiki/`：生命週期歷史與衍生頁面。
- `src/mcp/`：固定唯讀/提案工具；結構上拒絕 shell 與驗證權威。

### 外掛表面

`.cursor-plugin/plugin.json` 連接 slash commands、skills、自訂 agents、rules、hooks 與 `.mcp.json`。hook 實作驗證並編修輸入，但回傳中性政策回應。隨附 MCP manifest 為空；載入伺服器需要明確的專案設定。

見 [Cursor 整合](cursor-integration.zh-TW.md) 與 [安全政策](../SECURITY.md)。
