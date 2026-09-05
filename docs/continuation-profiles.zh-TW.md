# 基於 Cursor SDK 持久化與原生 Hooks 的目標與延續設定檔 (Continuation Profiles)

OMCU 透過 Cursor SDK 持久化代理 (Agent) 與原生 Hooks 提供可復原的領域投影 (Domain Projection)。

## 權責邊界架構

```text
┌────────────────────────────────────────────────────────┐
│                   Cursor SDK Store                     │
│    (對話紀錄、Agent ID、Run ID、本機/雲端 Store)       │
├────────────────────────────────────────────────────────┤
│                   Cursor Native Hooks                  │
│       (stop, afterAgentResponse, followup_message)      │
├────────────────────────────────────────────────────────┤
│                      OMCU Journal                      │
│   (目標、階段、Stories、Todos、預算、Handoffs、驗證證據)│
└────────────────────────────────────────────────────────┘
```

OMCU 絕不重複儲存 Cursor 的對話歷程，亦不建立第二套對話資料庫。

## 1. 規範 Workflow Projection 架構

自 OMCU 日誌可隨時重建的投影結構，僅參照 Cursor 原生 ID 與不可變 artifacts：

```json
{
  "run_id": "omcu-...",
  "cursor_agent_id": "...",
  "cursor_run_id": "...",
  "source_profile": "omc-autopilot|omx-ultragoal|omo-ulw-loop|...",
  "epoch": 1,
  "revision": 12,
  "status": "active",
  "phase": "execution",
  "objective_artifact": "artifact:...",
  "budgets": {
    "max_iterations": 20,
    "max_continuations": 50,
    "deadline_at": "..."
  },
  "goals": [],
  "stories": [],
  "todos": [],
  "child_tasks": [],
  "handoffs": [],
  "evidence": [],
  "failure_fingerprint": null,
  "cancel_requested": false,
  "verified": false,
  "verification_authority": "omcu-cli-only"
}
```

## 2. 來源設定檔 (Source Profiles)

### OMC 設定檔
- **omc-autopilot**: 自主迴圈：蘇格拉底式需求訪談 → 規劃 → 執行 → 審查 → QA → 完成。
- **omc-ralph**: 自我參照持久化迴圈，直到架構師驗證批准。
- **omc-ultrawork**: 跨子代理的高通量平行工作執行。
- **omc-ultraqa**: 對抗式 QA 場景生成與動態測試修復迴圈。
- **omc-pipeline**: 具備嚴格階段收據與屏障的多階段管線。
- **omc-persistent-todo**: 持久化 Todo 接續迴圈，直到所有任務具備證據標記完成。

### OMX 設定檔
- **omx-goal**: 目標導向執行，具備明確驗收標準。
- **omx-ultragoal**: 多目標 Stories 與檢查點，搭配共識審查。
- **omx-ralplan**: 計畫共識狀態機（提議 → 質疑 → 修訂 → 驗證者交接）。
- **omx-ralph**: OMX 持久化迴圈，具備評估者把關與架構師審批。
- **omx-team**: 跨專門角色的團隊 Story 執行。
- **omx-research-goal**: 假說導向研究迭代，產出經驗證的綜合報告。

### OMO 設定檔
- **omo-boulder**: 啟動引導與持續推進滾石前進（"the boulder never stops"）。
- **omo-ulw-loop**: 乾淨平行工作迴圈，具備嚴格的並行上限。
- **omo-atlas-todo**: Atlas 風格嚴格原子級 Todo 紀律，具備步驟前後審計。
- **omo-steering**: 有界轉向探索（Excursion），探索子問題而不丟失主執行緒。
- **omo-closing-briefing**: 結案簡報產出與狀態審計。

## 3. 原子延續交易 (Atomic Continuation Transaction)

原生 `stop` 或 `afterAgentResponse` hook 事件僅在符合下列目錄鎖保護的 OMCU 原子交易下才獲准延續：
1. Cursor agent ID 與 run ID 完全相符。
2. OMCU epoch 紀元完全相符。
3. 冪等鍵檢查通過（杜絕重複事件執行）。
4. 工作流程處於作用中 (active) 且未請求取消。
5. 期限未截止。
6. 延續預算仍有剩餘 (`consumed < max_continuations`)。
7. 無不明確副作用（偵測到未核對的副作用時立即 fail-closed 阻斷）。
8. 失敗特徵碼與進展檢驗（連續相同失敗將觸發重新規劃/轉派專家/阻斷）。
9. 存在明確的下一步行動。

交易在回傳原生 `followup_message` 前，會原子性地扣除一次延續配額。

## 4. 壓縮與復原 (Compaction & Resume)

在上下文視窗達到邊界前，OMCU 產出緊湊的交接文件 (Handoff Artifact)：
- 目標與當前階段
- 未完成之 Goals、Stories、Todos
- 已知事實與未決決策
- 異動檔案與 Worktrees
- 最新測試、審查、QA 證據
- 子任務原生執行狀態
- 下一步安全行動
- 剩餘預算

新程序透過 `resumeWorkflowFromHandoff`，結合 `Agent.resume(cursor_agent_id)` 與交接文件接續執行，推進 epoch 並拒絕不符的代理身分。

## 5. 權威驗證分離 (Verification Separation)

工作流程完成 (`status: 'completed'`) 絕對不會自動給予 `verified: true`。
權威驗證永遠嚴格保留給 OMCU 命令列驗證閘門 (`omcu-cli-only`)。
