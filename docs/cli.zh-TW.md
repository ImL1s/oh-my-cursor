# CLI 參考

English: [cli.md](./cli.md) · [简体中文](./cli.zh.md) · [繁體中文](./cli.zh-TW.md)

除非路徑選項另有說明，所有命令皆以目前工作目錄為準。專案服務寫入 `<cwd>/.omcu/`。輸出為 JSON，互動式 Cursor 工作階段、渲染的 checkpoint 文字與直接 Cursor 輸出除外。

```sh
omcu --help
omcu --version
omcu --json-errors <命令> ... # 結構化 stderr：code、command_path、token、message、usage
```

## Host 啟動（互動 / madmax）

與 OMX 對齊的入口：

```sh
omcu                         # 互動式 cursor-agent（含 --plugin-dir）
omcu "修復失敗測試"            # 帶初始 prompt 的互動
omcu prompt "workflow"       # 明確的單字提示詞
omcu --prompt "workflow"     # 明確的提示詞參數形式
omcu --madmax                # break-glass: --yolo --sandbox disabled
omcu --madmax --direct …     # 不包 tmux
omcu --madmax --tmux …       # 強制 tmux（缺失則失敗）
```

只有當單一 token 與所有已知 OMCU 命令的編輯距離都大於二時，才使用提示詞簡寫。類似命令的拼字錯誤會由 CLI parser fail closed；單字提示詞請使用 `prompt` 或 `--prompt`。

`--madmax` 對應 Cursor `--yolo --sandbox disabled`，並一律以 `--plugin-dir` 載入本套件。顯式 deny 規則仍生效；`--approve-mcps` / `--trust` 僅在你顯式傳入時生效。這是 host launcher，不是 mode FSM，也不會蓋 `verified`。預設傳輸為 detached tmux 再 attach；auto 在無 tmux 時可回退 direct；顯式 `--tmux` 不會回退。

## 生命週期與能力

| 命令 | 用途 |
| --- | --- |
| `omcu setup [--source <dir>] [--state-root <dir>] [--init-project-state]` | 安裝套件來源並執行 doctor；專案 `.omcu/` 必須明確要求才初始化。 |
| `omcu update [--source <dir>] [--state-root <dir>] [--init-project-state]` | 暫存並切換至來源位元組；失敗時回滾。 |
| `omcu doctor [--repair-owner]` | 檢查 Cursor、外掛可載入性與本機設定；只有明確旗標才隔離損壞 owner 記錄。 |
| `omcu uninstall [--receipt <file>] [--state-root <dir>] [--purge-project-state]` | 移除收據擁有的路徑；預設為目前收據。 |
| `omcu capabilities discover` | 比對即時 Cursor 版本/help 與釘選 lock。 |
| `omcu capabilities native-status` | 執行 `cursor-agent status` 並回傳 JSON 封套。 |
| `omcu native-status` | `capabilities native-status` 的別名。 |
| `omcu mcp status|install|uninstall [--file <path>]` | 檢查、安裝或安全移除專案 MCP 伺服器設定。 |
| `omcu mcp-install [--file <path>]` | 將 `oh-my-cursor` stdio 伺服器合併至專案 MCP JSON 檔（舊版別名）。 |
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

每次轉換會清除先前的驗證。驗證要求狀態為 `complete`，並會拒絕非 complete 的 run（`active`、`failed`、`cancelled`）、過期 revision 與格式錯誤的證據摘要。`cancel` 讀取目前 revision 並執行有圍欄的取消。

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
omcu workflow lease-status --id run-1
omcu workflow lease-reconcile --id run-1 --revision <n> --credential-json '<不含秘密的確認 JSON>'
```

定義依 name/version/digest 不可變。計畫與摘要鏈收據位於 `.omcu/workflows/`。已完成的工作流程仍回報 `verified: false`；僅 run 狀態驗證命令具權威。

`lease-reconcile` 使用 `lease-status` 回傳的精確脫敏租約中繼資料、預期的 `ambiguous` 狀態/原因，以及 `operator_confirmation: "owner-dead-side-effects-reviewed"`。不要把原始 owner nonce 放進命令列；它不會持久化，崩潰協調也不需要它。

每次 Cursor 呼叫前，CLI 會持久化 `task_started` 意圖。若程序在對應收據變為持久之前結束，`status` 與 `replay` 會回報 `ambiguous`。OMCU 不會自動重跑該任務，因為其編輯或 shell 副作用可能已發生。檢查 run 記錄與儲存庫、手動對帳不確定效果後，若需明確重跑請建立新 run ID。刻意**沒有**自動 `ambiguous`→重試轉換。

## 持久化執行

```sh
omcu persist start --goal <text> [--max-loops 25] [--deadline-min 120]
omcu persist status
omcu persist done
omcu persist stop
omcu persist decide [--input <json>]
```

`persist` 透過 Cursor 的 `stop` 與 `subagentStop` hooks 協調 opt-in「巨石不停」繼續執行迴圈。迴圈上限由 OMCU 自有的持久化狀態（`.omcu/persist.json`）強制執行，而非僅依賴宿主 hook 計數器。
- 延續限制嚴格單調遞增：在回傳後續訊息前，`consumed_loops` 會在加鎖保護下原子遞增並寫入磁碟。
- 缺失、非整數、負數、非有限值或遞減的宿主計數器均 fail-closed 中止。
- 重複 hook 事件依 event/loop 識別去重，最多消耗一次延續名額。
- Schema v1 狀態安全平滑遷移至 schema v2，絕不意外重置活躍迴圈預算。
- 所有決策均在鎖內原子事務中運行；`persist done` 與 `persist stop` 在並發決策競態中勝出。

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
omcu team run --id <team-id> --workers-json '<json-array>'
omcu team status --id <team-id>
omcu team collect --id <team-id>
omcu team stop --id <team-id>
```

`team run` 為 `team start` 的別名；不會 collect 或驗證結果。supervisor 建立 `cursor-agent --print --mode ask` 程序、記錄 pane 程序群組，並回報 `native_cursor_team: false`。

<!-- OMCU:CLI-REFERENCE:START -->
## Generated CLI reference

Do not edit this block manually; it is generated from `COMMAND_SCHEMAS`.

- `omcu help` | options: none | positionals: command; action
- `omcu version` | options: none | positionals: none
- `omcu setup` | options: --source:string; --archive:string; --checksums:string; --tag:string; --latest:flag; --state-root:string; --init-project-state:flag; --dry-run:flag | positionals: none
- `omcu update` | options: --source:string; --archive:string; --checksums:string; --tag:string; --latest:flag; --state-root:string; --init-project-state:flag; --dry-run:flag | positionals: none
- `omcu install` | options: none | positionals: none
- `omcu install status` | options: --state-root:string | positionals: none
- `omcu install list` | options: --state-root:string | positionals: none
- `omcu install verify` | options: --state-root:string; --all:flag | positionals: none
- `omcu install prune` | options: --state-root:string; --dry-run:flag; --apply:flag; --keep:integer default=2 | positionals: none
- `omcu install repair` | options: --state-root:string | positionals: none
- `omcu rollback` | options: --receipt:string; --state-root:string; --dry-run:flag | positionals: none
- `omcu doctor` | options: --repair-owner:flag; --repair-journals:flag | positionals: none
- `omcu uninstall` | options: --receipt:string; --state-root:string; --purge-project-state:flag | positionals: none
- `omcu capabilities` | options: none | positionals: none
- `omcu capabilities discover` | options: none | positionals: none
- `omcu capabilities native-status` | options: none | positionals: none
- `omcu native-status` | options: none | positionals: none
- `omcu mcp-server` | options: none | positionals: none
- `omcu mcp` | options: none | positionals: none
- `omcu mcp status` | options: --file:string; --receipt:string; --no-probe:flag | positionals: none
- `omcu mcp install` | options: --file:string; --receipt:string; --dry-run:flag; --replace:flag | positionals: none
- `omcu mcp uninstall` | options: --file:string; --receipt:string; --dry-run:flag | positionals: none
- `omcu mcp-install` | options: --file:string; --receipt:string; --dry-run:flag; --replace:flag | positionals: none
- `omcu session` | options: none | positionals: none
- `omcu session create` | options: none | positionals: none
- `omcu session list` | options: none | positionals: none
- `omcu session resume` | options: --id:string required; --prompt:string | positionals: none
- `omcu session continue` | options: --prompt:string | positionals: none
- `omcu resume` | options: --id:string required; --prompt:string | positionals: none
- `omcu state` | options: none | positionals: none
- `omcu state create` | options: --id:string required; --objective:string required | positionals: none
- `omcu state status` | options: --id:string required | positionals: none
- `omcu state transition` | options: --id:string required; --revision:integer required; --status:string required | positionals: none
- `omcu state verify` | options: --id:string required; --revision:integer required; --evidence-sha256:string required | positionals: none
- `omcu state event` | options: --id:string required; --type:string required; --payload-json:json default={} | positionals: none
- `omcu run` | options: none | positionals: none
- `omcu run create` | options: --id:string required; --objective:string required | positionals: none
- `omcu run status` | options: --id:string required | positionals: none
- `omcu run transition` | options: --id:string required; --revision:integer required; --status:string required | positionals: none
- `omcu run verify` | options: --id:string required; --revision:integer required; --evidence-sha256:string required | positionals: none
- `omcu run event` | options: --id:string required; --type:string required; --payload-json:json default={} | positionals: none
- `omcu lease` | options: none | positionals: none
- `omcu lease status` | options: --run:string required; --name:string required | positionals: none
- `omcu lease acquire` | options: --run:string required; --name:string required; --owner:string required; --ttl-ms:integer default=30000 | positionals: none
- `omcu lease release` | options: --run:string required; --name:string required; --owner:string required; --generation:integer required | positionals: none
- `omcu cancel` | options: --id:string required | positionals: none
- `omcu recover` | options: none | positionals: none
- `omcu recover show` | options: --id:string required; --summary:flag | positionals: none
- `omcu recover create` | options: --transcript:string; --project-jsonl:string; --id:string; --summary:flag | positionals: none
- `omcu compact` | options: none | positionals: none
- `omcu compact checkpoint` | options: --id:string required; --generation:integer required; --payload-json:json required | positionals: none
- `omcu compact show` | options: --id:string required | positionals: none
- `omcu compact render` | options: --id:string required; --generation:integer required | positionals: none
- `omcu memory` | options: none | positionals: none
- `omcu memory put` | options: --text:string required; --id:string; --metadata-json:json default={} | positionals: none
- `omcu memory list` | options: none | positionals: none
- `omcu memory show` | options: --id:string required | positionals: none
- `omcu memory search` | options: --query:string required; --limit:integer default=20 | positionals: none
- `omcu memory export` | options: none | positionals: none
- `omcu memory import` | options: --file:string required; --conflict:string default="reject"; --dry-run:flag | positionals: none
- `omcu memory delete` | options: --id:string required; --expected-updated-at:string | positionals: none
- `omcu memory doctor` | options: --repair:flag | positionals: none
- `omcu memory rescan` | options: none | positionals: none
- `omcu notify` | options: none | positionals: none
- `omcu notify status` | options: none | positionals: none
- `omcu notify configure` | options: --generation:integer required; --enable:flag; --destination:string | positionals: none
- `omcu notify enqueue` | options: --payload-json:json required; --id:string | positionals: none
- `omcu notify show` | options: --id:string required | positionals: none
- `omcu notify dispatch` | options: --id:string required; --generation:integer required; --nonce:string required | positionals: none
- `omcu tracker` | options: none | positionals: none
- `omcu tracker record` | options: --id:string required; --phase:string required; --detail-json:json default={} | positionals: none
- `omcu tracker history` | options: --id:string required | positionals: none
- `omcu wiki` | options: none | positionals: none
- `omcu wiki render` | options: --slug:string required; --tracker:string required; --generation:integer required; --title:string required | positionals: none
- `omcu wiki show` | options: --slug:string required | positionals: none
- `omcu workflow` | options: none | positionals: none
- `omcu workflow install` | options: --file:string required | positionals: none
- `omcu workflow list` | options: none | positionals: none
- `omcu workflow show` | options: --name:string required; --version:string default="1" | positionals: none
- `omcu workflow plan` | options: --name:string required; --version:string default="1"; --id:string required; --objective:string; --prompt:string | positionals: objective
- `omcu workflow run` | options: --id:string required | positionals: none
- `omcu workflow status` | options: --id:string required | positionals: none
- `omcu workflow replay` | options: --id:string required | positionals: none
- `omcu workflow lease-status` | options: --id:string required | positionals: none
- `omcu workflow lease-reconcile` | options: --id:string required; --revision:integer required; --credential-json:json required | positionals: none
- `omcu team` | options: none | positionals: none
- `omcu team start` | options: --id:string required; --workers-json:json required | positionals: none
- `omcu team run` | options: --id:string required; --workers-json:json required | positionals: none
- `omcu team status` | options: --id:string required | positionals: none
- `omcu team collect` | options: --id:string required | positionals: none
- `omcu team stop` | options: --id:string required | positionals: none
- `omcu team api` | options: --op:string; --input:json default={}; --supervisor:flag; --help:flag aliases=-h | positionals: operation
- `omcu persist` | options: none | positionals: none
- `omcu persist start` | options: --goal:string required; --max-loops:integer default=25; --deadline-min:integer default=120 | positionals: none
- `omcu persist stop` | options: none | positionals: none
- `omcu persist done` | options: none | positionals: none
- `omcu persist status` | options: none | positionals: none
- `omcu persist decide` | options: --input:json | positionals: none
- `omcu ralplan` | options: --objective:string; --prompt:string; --rounds:integer default=3 | positionals: objective
- `omcu ralph` | options: --objective:string; --prompt:string; --iterations:integer default=5 | positionals: objective
- `omcu ulw` | options: --id:string required; --workers-json:json required | positionals: none
- `omcu autopilot` | options: --objective:string; --prompt:string; --gates-json:json | positionals: objective
- `omcu pipeline` | options: --objective:string; --prompt:string; --gates-json:json | positionals: objective
- `omcu review` | options: --objective:string; --prompt:string; --format:string default="json" | positionals: objective
- `omcu qa` | options: --objective:string; --prompt:string; --format:string default="json" | positionals: objective
- `omcu accept` | options: --objective:string; --prompt:string; --format:string default="json" | positionals: objective
- `omcu integrate` | options: --objective:string; --prompt:string; --format:string default="json" | positionals: objective
- `omcu ask` | options: --objective:string; --prompt:string; --format:string default="json" | positionals: objective
<!-- OMCU:CLI-REFERENCE:END -->
