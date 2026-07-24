# 会话恢复

English: [recovery.md](./recovery.md) · [简体中文](./recovery.zh.md) · [繁體中文](./recovery.zh-TW.md)

请优先使用 Cursor 原生会话命令：

```sh
omcu session list
omcu session resume --id <chat-id>
omcu session continue
```

精确 resume 是最安全的路径，因为它委托给 Cursor 文档化的聊天历史，而非重建逐字稿。

## 部分 JSONL 恢复

恢复库是针对**明确指名**本地 JSONL 逐字稿的有界后备方案。它不会探索 Cursor 存储、猜测会话，也不承诺完整对话。

恢复：

1. 需要恰好一个绝对来源路径；
2. 拒绝符号链接、非文件、大于 128 MiB 的来源，以及读取时变更的文件；
3. 仅复制最后 **900 行**；
4. 将复制的尾部限制在 16 MiB；
5. 编修已解析记录，并将格式错误行保留为编修后的原始文字；
6. 在 `.omcu/recovery/<id>/` 下写入不可变副本与元数据。

来源超过 900 行时会设置 `truncated: true`。快照可能报告：

| 警告 | 意义 |
| --- | --- |
| `W_PARTIAL_RECORD` | 选定行不是有效 JSON。保留为编修后原始文字。 |
| `W_UNKNOWN_RECORD` | 记录形状无法辨认。保留但不解读。 |
| `W_BROKEN_CHAIN` | 缺少父引用，常因落在复制视窗外。 |

这些警告表示恢复不完整或模糊。勿从尾部推断任务完成、验收或完整历史。

## 安全延续

读取快照后：

1. 与 `git status`、当前分支与工作差异比对；
2. 重述恢复目标并明确列出缺失上下文；
3. 可用时以 `omcu run status --id <run-id>` 读取权威 run；
4. 重跑最小相关验证；
5. 若仍有不确定性，附加诊断事件，而非标记 run 完成。

恢复数据即使经过编修仍可能包含私人来源路径与对话内容。勿提交 `.omcu/`、勿将快照贴到 issue，且勿将编修视为已移除所有秘密格式。
