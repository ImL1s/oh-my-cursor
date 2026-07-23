# Session recovery

Use Cursor's native session commands first:

```sh
omcu session list
omcu session resume --id <chat-id>
omcu session continue
```

Exact resume is the safest path because it delegates to Cursor's documented chat history instead of reconstructing a transcript.

## Partial JSONL recovery

The recovery library is a bounded fallback for an explicitly named local JSONL transcript. It does not discover Cursor storage, guess a session, or promise a complete conversation.

Recovery:

1. requires exactly one absolute source path;
2. rejects symlinks, non-files, sources larger than 128 MiB, and files that change while read;
3. copies only the last **900 lines**;
4. limits the copied tail to 16 MiB;
5. redacts parsed records and preserves malformed lines as redacted raw text;
6. writes an immutable copy and metadata under `.omcu/recovery/<id>/`.

A source with more than 900 lines sets `truncated: true`. The snapshot may report:

| Warning | Meaning |
| --- | --- |
| `W_PARTIAL_RECORD` | A selected line is not valid JSON. It is preserved as redacted raw text. |
| `W_UNKNOWN_RECORD` | A record shape is not recognized. It is preserved without interpretation. |
| `W_BROKEN_CHAIN` | A parent reference is missing, often because it fell outside the copied window. |

These warnings are evidence of an incomplete or ambiguous recovery. Do not infer task completion, acceptance, or full history from the tail.

## Safe continuation

After reading a snapshot:

1. compare it with `git status`, the current branch, and the working diff;
2. restate the recovered objective and explicitly list missing context;
3. read the authoritative run with `omcu run status --id <run-id>` when available;
4. rerun the smallest relevant validation;
5. append a diagnostic event rather than marking the run complete if uncertainty remains.

Recovery data can contain private source paths and conversation content even after redaction. Do not commit `.omcu/`, paste snapshots into issues, or treat redaction as proof that every secret format was removed.
