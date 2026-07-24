# 工作階段復原

English: [recovery.md](./recovery.md) · [简体中文](./recovery.zh.md) · [繁體中文](./recovery.zh-TW.md)

請優先使用 Cursor 原生工作階段命令：

```sh
omcu session list
omcu session resume --id <chat-id>
omcu session continue
```

精確 resume 是最安全的路徑，因為它委派給 Cursor 文件化的聊天歷史，而非重建逐字稿。

## 部分 JSONL 復原

復原函式庫是針對**明確指名**本機 JSONL 逐字稿的有界後備方案。它不會探索 Cursor 儲存、猜測工作階段，也不承諾完整對話。

復原：

1. 需要恰好一個絕對來源路徑；
2. 拒絕符號連結、非檔案、大於 128 MiB 的來源，以及讀取時變更的檔案；
3. 僅複製最後 **900 行**；
4. 將複製的尾部限制在 16 MiB；
5. 編修已解析記錄，並將格式錯誤行保留為編修後的原始文字；
6. 在 `.omcu/recovery/<id>/` 下寫入不可變副本與中繼資料。

來源超過 900 行時會設定 `truncated: true`。快照可能回報：

| 警告 | 意義 |
| --- | --- |
| `W_PARTIAL_RECORD` | 選定行不是有效 JSON。保留為編修後原始文字。 |
| `W_UNKNOWN_RECORD` | 記錄形狀無法辨識。保留但不解讀。 |
| `W_BROKEN_CHAIN` | 缺少父參考，常因落在複製視窗外。 |

這些警告表示復原不完整或模糊。勿從尾部推斷任務完成、驗收或完整歷史。

## 安全延續

讀取快照後：

1. 與 `git status`、目前分支與工作差異比對；
2. 重述復原目標並明確列出缺失脈絡；
3. 可用時以 `omcu run status --id <run-id>` 讀取權威 run；
4. 重跑最小相關驗證；
5. 若仍有不確定性，附加診斷事件，而非標記 run 完成。

復原資料即使經過編修仍可能包含私人來源路徑與對話內容。勿提交 `.omcu/`、勿將快照貼到 issue，且勿將編修視為已移除所有秘密格式。
