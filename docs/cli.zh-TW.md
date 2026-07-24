# CLI 參考

English: [cli.md](./cli.md) · [简体中文](./cli.zh.md) · [繁體中文](./cli.zh-TW.md)

除非路徑選項另有說明，所有命令皆以目前工作目錄為準。專案服務寫入 `<cwd>/.omcu/`。輸出為 JSON，互動式 Cursor 工作階段、渲染的 checkpoint 文字與直接 Cursor 輸出除外。

```sh
omcu --help
omcu --version
```

## Host 啟動（互動 / madmax）

與 OMX 對齊的入口：

```sh
omcu                         # 互動式 cursor-agent（含 --plugin-dir）
omcu "修復失敗測試"            # 帶初始 prompt 的互動
omcu --madmax                # full-open break-glass
omcu --madmax --direct …     # 不包 tmux
omcu --madmax --tmux …       # 強制 tmux（缺失則失敗）
```

`--madmax` 對應 Cursor `--force --sandbox disabled`，並一律以 `--plugin-dir` 載入本套件。`--approve-mcps` / `--trust` 僅在你顯式傳入時生效。這是 host launcher，不是 mode FSM，也不會蓋 `verified`。預設傳輸為 detached tmux 再 attach；auto 在無 tmux 時可回退 direct；顯式 `--tmux` 不會回退。

## 生命週期與能力

| 命令 | 用途 |
| --- | --- |
| `omcu setup [--source <dir>] [--state-root <dir>]` | 安裝套件來源、建立目前專案的 `.omcu/`，並執行 doctor。 |
| `omcu update [--source <dir>] [--state-root <dir>]` | 暫存並切換至來源位元組；失敗時回滾。 |
| `omcu doctor` | 檢查 Cursor、外掛可載入性與本機設定。結束碼 `0`、`2`（警告）或 `1`（失敗）。 |
| `omcu uninstall [--receipt <file>] [--state-root <dir>] [--purge-project-state]` | 移除收據擁有的路徑；預設為目前收據。 |
| `omcu capabilities discover` | 比對即時 Cursor 版本/help 與釘選 lock。 |
| `omcu capabilities native-status` | 執行 `cursor-agent status` 並回傳 JSON 封套。 |
| `omcu native-status` | `capabilities native-status` 的別名。 |
| `omcu mcp-install [--file <path>]` | 將 `oh-my-cursor` stdio 伺服器合併至專案 MCP JSON 檔。 |
| `omcu mcp-server` | 在 stdio 上提供固定的非權威 MCP 工具集。 |

CLI 生命週期路徑從來源安裝。已驗證的離線壓縮檔請使用 [安裝](installation.zh-TW.md) 所述的 `scripts/install.sh` 與 `dist/src/setup/script-entry.js`。

## 工作階段

```sh
omcu session create
omcu session list
omcu session resume --id <chat-id> [--prompt <text>]
omcu session continue [--prompt <text>]
omcu resume --id <chat-id> [--prompt <text>]
```

無 prompt 時，list/resume/continue 使用 Cursor 互動終端。有 prompt 時使用 `--print --output-format json`。Print 模式本身不是唯讀。

## 權威 run 狀態

`state` 與 `run` 為別名。

```sh
omcu state create --id <run-id> --objective <text>
omcu state status --id <run-id>
omcu state transition --id <run-id> --revision <n> --status active|complete|failed|cancelled
omcu state verify --id <run-id> --revision <n> --evidence-sha256 <64-hex>
omcu state event --id <run-id> --type <type> [--payload-json <json>]
omcu cancel --id <run-id>
```

每次轉換會清除先前的驗證。驗證會拒絕 active run、過期 revision 與格式錯誤的證據摘要。`cancel` 讀取目前 revision 並執行有圍欄的取消。

Lease 協調專案寫入者：

```sh
omcu lease acquire --run <run-id> --name <lease> --owner <owner> [--ttl-ms <n>]
omcu lease status --run <run-id> --name <lease>
omcu lease release --run <run-id> --name <lease> --owner <owner> --generation <n>
```

TTL 須介於 1,000 與 86,400,000 毫秒之間。

## 復原與 checkpoint

```sh
omcu recover --transcript /absolute/path/to/file.jsonl [--id <id>]
omcu recover --project-jsonl /absolute/path/to/file.jsonl [--id <id>]
omcu recover show --id <id>

omcu compact checkpoint --id <id> --generation <n> --payload-json <json>
omcu compact show --id <id>
omcu compact render --id <id> --generation <n>
```

復原需要恰好一個絕對來源路徑，且僅複製最後 900 行。Checkpoint 使用 generation 圍欄與摘要鏈。

## 專案記憶體

這是 OMCU 專案記憶體，**不是**文件化的 Cursor memory CLI。

```sh
omcu memory put --text <text> [--id <id>] [--metadata-json <json>]
omcu memory list
omcu memory show --id <id>
omcu memory search --query <text> [--limit <1-100>]
omcu memory export
omcu memory import --file <bundle.json>
omcu memory rescan
```

值在儲存前會經過編修。export 將 JSON 寫至 stdout；需要時請重導向至受保護檔案。

## 通知

```sh
omcu notify status
omcu notify configure --generation <n> [--enable --destination <value>]
omcu notify enqueue --payload-json <json> [--id <id>]
omcu notify show --id <id>
omcu notify dispatch --id <id> --generation <n> --nonce <nonce>
```

通知預設關閉。OMCU 在 CLI 中連接拒絕傳輸，因此即使啟用目的地，dispatch 仍不支援。佇列與檢視僅限本機。

## Tracker 與 wiki

```sh
omcu tracker record --id <subject> --phase created|started|checkpointed|completed|failed|cancelled [--detail-json <json>]
omcu tracker history --id <subject>
omcu wiki render --slug <slug> --generation <n> --title <text> --tracker <subject>
omcu wiki show --slug <slug>
```

Tracker 轉換有順序。Wiki 頁面為單一 tracker 歷史的編修、generation 圍欄檢視。

## 工作流程

安裝不可變、版本化的定義：

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

定義依 name/version/digest 不可變。計畫與摘要鏈收據位於 `.omcu/workflows/`。已完成的工作流程仍回報 `verified: false`；僅 run 狀態驗證命令具權威。

每次 Cursor 呼叫前，CLI 會持久化 `task_started` 意圖。若程序在對應收據變為持久之前結束，`status` 與 `replay` 會回報 `ambiguous`。OMCU 不會自動重跑該任務，因為其編輯或 shell 副作用可能已發生。檢查 run 記錄與儲存庫、手動對帳不確定效果後，若需明確重跑請建立新 run ID。刻意**沒有**自動 `ambiguous`→重試轉換。

## Cursor 支援的模式

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

RALPLAN 使用 Plan 模式。Review 與 acceptance prompt 亦使用 Plan 模式；其他角色 prompt 使用 Ask 模式。模式輸出為建議性，絕不自我驗證。

## Worktree 與 tmux 協調

Worktree ULW 接受 JSON 陣列：

```sh
omcu ulw --id <run-id> --workers-json '[
  {"id":"docs","objective":"update docs","owned_paths":["docs"]},
  {"id":"tests","objective":"add tests","owned_paths":["tests"]}
]'
```

每個 worker 在 `.omcu-worktrees/<run-id>/` 下取得唯一命名的 detached worktree。重複 worker ID、重疊擁有權與逃逸路徑會在 worktree 或 Cursor 效果前被拒絕。

一旦已呼叫 Cursor，即使 worker 失敗，OMCU 仍保留 worktree，因為其中可能有未提交編輯或 detached commit。收據回報 worktree 路徑、可觀察時的 HEAD OID、dirty 狀態、狀態摘要與清理命令。執行該命令前請先 integrate 或另行保留 worker 結果。僅在可證明於 worker 呼叫**之前**失敗的情況才符合自動移除 worktree 條件。

實驗性 tmux supervisor 接受含 `id`、`objective`、`owned_paths` 的 workers；`cwd` 可選，預設為目前目錄：

```sh
omcu team start --id <team-id> --workers-json '<json-array>'
omcu team status --id <team-id>
omcu team collect --id <team-id>
omcu team stop --id <team-id>
```

`team run` 為 `team start` 的別名；不會 collect 或驗證結果。supervisor 建立 `cursor-agent --print --mode ask` 程序、記錄 pane 程序群組，並回報 `native_cursor_team: false`。
