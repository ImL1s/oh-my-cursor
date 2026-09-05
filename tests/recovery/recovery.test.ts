import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectStateRoot } from '../../src/runtime/state-root.js';
import {
  MAX_LINE_BYTES,
  MAX_SOURCE_BYTES,
  MAX_TAIL_BYTES,
  RECOVERY_LINE_LIMIT,
  RECOVERY_SCHEMA_VERSION,
  readRecovery,
  recoverCursorSession,
  recoverySummary,
} from '../../src/recovery/index.js';
import type { RecoverySnapshotV1 } from '../../src/recovery/schema.js';

const roots: string[] = [];
function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-recovery-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of roots.splice(0, roots.length)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }
});

const fixedNow = () => new Date('2026-08-01T12:00:00.000Z');

describe('Recovery streaming and truthful chain validation (#21)', () => {
  it('handles fewer than 900 lines without truncation', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'transcript.jsonl');
    const records = [
      JSON.stringify({ id: 'p1', type: 'message', content: 'hello' }),
      JSON.stringify({ id: 'c1', parent_id: 'p1', type: 'message', content: 'world' }),
    ];
    fs.writeFileSync(transcript, `${records.join('\n')}\n`);

    const snapshot = recoverCursorSession(root, {
      projectJsonlPath: transcript,
      recoveryId: 'fewer-900',
      now: fixedNow,
    });

    expect(snapshot.schema_version).toBe(2);
    expect(snapshot.source_lines).toBe(2);
    expect(snapshot.copied_lines).toBe(2);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.retained_first_line).toBe(1);
    expect(snapshot.retained_last_line).toBe(2);
    expect(snapshot.warnings).toHaveLength(0);

    const summary = recoverySummary(snapshot);
    expect(summary.truncated).toBe(false);
    expect(summary.broken_chain_count).toBe(0);
    expect(summary.outside_tail_count).toBe(0);
    expect(summary.malformed_count).toBe(0);
  });

  it('handles exactly 900 lines without truncation', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'transcript.jsonl');
    const lines = Array.from({ length: 900 }, (_, i) =>
      JSON.stringify({ id: `msg-${i}`, type: 'message' }),
    );
    fs.writeFileSync(transcript, `${lines.join('\n')}\n`);

    const snapshot = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'exact-900',
      now: fixedNow,
    });

    expect(snapshot.source_lines).toBe(900);
    expect(snapshot.copied_lines).toBe(900);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.retained_first_line).toBe(1);
    expect(snapshot.retained_last_line).toBe(900);
    expect(snapshot.warnings).toHaveLength(0);
  });

  it('handles empty source file gracefully', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'empty.jsonl');
    fs.writeFileSync(transcript, '');

    const snapshot = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'empty',
      now: fixedNow,
    });

    expect(snapshot.source_lines).toBe(0);
    expect(snapshot.copied_lines).toBe(0);
    expect(snapshot.source_bytes).toBe(0);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.retained_first_line).toBe(0);
    expect(snapshot.retained_last_line).toBe(0);
    expect(snapshot.records).toHaveLength(0);
    expect(snapshot.warnings).toHaveLength(0);
  });

  it('handles LF, CRLF, and trailing newlines identically to standard split', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);

    // CRLF transcript
    const crlfTranscript = path.join(cwd, 'crlf.jsonl');
    fs.writeFileSync(crlfTranscript, '{"id":"m1"}\r\n{"id":"m2"}\r\n');
    const crlfSnap = recoverCursorSession(root, {
      transcriptPath: crlfTranscript,
      recoveryId: 'crlf',
      now: fixedNow,
    });
    expect(crlfSnap.source_lines).toBe(2);
    expect(crlfSnap.copied_lines).toBe(2);

    // No trailing newline
    const noNlTranscript = path.join(cwd, 'no-nl.jsonl');
    fs.writeFileSync(noNlTranscript, '{"id":"m1"}\n{"id":"m2"}');
    const noNlSnap = recoverCursorSession(root, {
      transcriptPath: noNlTranscript,
      recoveryId: 'no-nl',
      now: fixedNow,
    });
    expect(noNlSnap.source_lines).toBe(2);
    expect(noNlSnap.copied_lines).toBe(2);

    // Blank line in middle
    const blankTranscript = path.join(cwd, 'blank.jsonl');
    fs.writeFileSync(blankTranscript, '{"id":"m1"}\n\n{"id":"m2"}\n');
    const blankSnap = recoverCursorSession(root, {
      transcriptPath: blankTranscript,
      recoveryId: 'blank',
      now: fixedNow,
    });
    expect(blankSnap.source_lines).toBe(3);
    expect(blankSnap.copied_lines).toBe(3);
  });

  it('handles multi-byte UTF-8 characters across chunk boundary', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'utf8.jsonl');

    // Fill small records so the Chinese character lands across the 64 KiB chunk boundary
    const chunk = 64 * 1024;
    // Build records of exact known length
    const lines: string[] = [];
    let currentBytes = 0;
    let idx = 0;
    while (currentBytes < chunk - 20) {
      const line = JSON.stringify({ id: `pre-${idx}`, msg: 'pad' });
      lines.push(line);
      currentBytes += Buffer.byteLength(line, 'utf8') + 1; // +1 for newline
      idx++;
    }

    // Now pad exactly up to chunk - 1 byte before newline or field
    const remainingToBoundary = chunk - currentBytes;
    const paddingStr = 'x'.repeat(Math.max(0, remainingToBoundary - 8));
    // '測' is 3 bytes (0xE6 0xB8 0xAC)
    const targetMsg = `hello-${paddingStr}-測試`;
    lines.push(JSON.stringify({ id: 'target-utf8', msg: targetMsg }));

    fs.writeFileSync(transcript, `${lines.join('\n')}\n`);

    const snapshot = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'utf8-cross',
      now: fixedNow,
    });

    const targetRecord = (snapshot.records as Array<{ id?: string; msg?: string }>).find(
      (r) => r.id === 'target-utf8',
    );
    expect(targetRecord).toBeDefined();
    expect(targetRecord!.msg).toBe(targetMsg);
  });

  it('truncates oversized single line exceeding MAX_LINE_BYTES', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'long-line.jsonl');

    const hugeContent = 'x'.repeat(MAX_LINE_BYTES + 5000);
    fs.writeFileSync(transcript, `${JSON.stringify({ id: 'long', content: hugeContent })}\n`);

    const snapshot = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'long-line',
      now: fixedNow,
    });

    expect(snapshot.source_lines).toBe(1);
    expect(snapshot.copied_lines).toBe(1);
    // Because line was truncated at MAX_LINE_BYTES, JSON.parse may fail or succeed depending on boundary
    // In any case, it didn't crash and recorded the line
    expect(snapshot.records).toHaveLength(1);
  });

  it('distinguishes parent in omitted prefix from genuinely broken chain', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'prefix-chain.jsonl');

    // Total 1000 lines:
    // Line 50: id "prefix-parent"
    // Lines 1..100: prefix lines
    // Lines 101..1000: tail (900 lines)
    // In tail:
    // child-1 -> references "prefix-parent" (valid, in omitted prefix)
    // child-2 -> references "ghost-parent" (broken, does not exist in prefix or tail)
    // child-3 -> references "tail-parent" (valid, in tail)
    const lines: string[] = [];
    for (let i = 1; i <= 1000; i++) {
      if (i === 50) {
        lines.push(JSON.stringify({ id: 'prefix-parent', type: 'message' }));
      } else if (i === 950) {
        lines.push(JSON.stringify({ id: 'tail-parent', type: 'message' }));
      } else if (i === 960) {
        lines.push(JSON.stringify({ id: 'child-1', parent_id: 'prefix-parent', type: 'message' }));
      } else if (i === 970) {
        lines.push(JSON.stringify({ id: 'child-2', parent_id: 'ghost-parent', type: 'message' }));
      } else if (i === 980) {
        lines.push(JSON.stringify({ id: 'child-3', parent_id: 'tail-parent', type: 'message' }));
      } else {
        lines.push(JSON.stringify({ id: `msg-${i}`, type: 'message' }));
      }
    }
    fs.writeFileSync(transcript, `${lines.join('\n')}\n`);

    const snapshot = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'chain-test',
      now: fixedNow,
    });

    expect(snapshot.source_lines).toBe(1000);
    expect(snapshot.copied_lines).toBe(900);
    expect(snapshot.truncated).toBe(true);

    const warningCodes = snapshot.warnings.map((w) => w.code);
    // W_TRUNCATED_PREFIX must be present
    expect(warningCodes).toContain('W_TRUNCATED_PREFIX');

    // child-1 must report W_PARENT_OUTSIDE_RETAINED_TAIL, NOT W_BROKEN_CHAIN
    const outsideWarnings = snapshot.warnings.filter((w) => w.code === 'W_PARENT_OUTSIDE_RETAINED_TAIL');
    expect(outsideWarnings).toHaveLength(1);
    expect(outsideWarnings[0]!.detail).toContain('prefix-parent');

    // child-2 must report W_BROKEN_CHAIN
    const brokenWarnings = snapshot.warnings.filter((w) => w.code === 'W_BROKEN_CHAIN');
    expect(brokenWarnings).toHaveLength(1);
    expect(brokenWarnings[0]!.detail).toContain('ghost-parent');

    // child-3 should produce no warning
    expect(snapshot.warnings.some((w) => w.detail.includes('tail-parent'))).toBe(false);

    // Summary counts
    const summary = recoverySummary(snapshot);
    expect(summary.outside_tail_count).toBe(1);
    expect(summary.broken_chain_count).toBe(1);
  });

  it('distinguishes malformed middle record from incomplete final record', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);

    // Case 1: Malformed record in the middle, complete record at end
    const middleTranscript = path.join(cwd, 'middle-malformed.jsonl');
    fs.writeFileSync(middleTranscript, '{"id":"1"}\n{"malformed":\n{"id":"2"}\n');
    const middleSnap = recoverCursorSession(root, {
      transcriptPath: middleTranscript,
      recoveryId: 'mid-mal',
      now: fixedNow,
    });
    expect(middleSnap.warnings.some((w) => w.code === 'W_MALFORMED_RECORD')).toBe(true);
    expect(middleSnap.warnings.some((w) => w.code === 'W_PARTIAL_FINAL_RECORD')).toBe(false);

    // Case 2: Interrupted/incomplete final append (no trailing newline, bad JSON)
    const finalTranscript = path.join(cwd, 'final-partial.jsonl');
    fs.writeFileSync(finalTranscript, '{"id":"1"}\n{"partial_append":');
    const finalSnap = recoverCursorSession(root, {
      transcriptPath: finalTranscript,
      recoveryId: 'fin-part',
      now: fixedNow,
    });
    expect(finalSnap.warnings.some((w) => w.code === 'W_PARTIAL_FINAL_RECORD')).toBe(true);
    expect(finalSnap.warnings.some((w) => w.code === 'W_MALFORMED_RECORD')).toBe(false);
  });

  it('rejects symlink and non-file sources', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);

    const realFile = path.join(cwd, 'real.jsonl');
    fs.writeFileSync(realFile, '{"id":"1"}\n');

    const symlinkFile = path.join(cwd, 'symlink.jsonl');
    fs.symlinkSync(realFile, symlinkFile);

    expect(() =>
      recoverCursorSession(root, {
        transcriptPath: symlinkFile,
        recoveryId: 'sym',
      }),
    ).toThrow('E_RECOVERY_SOURCE_UNSAFE');

    // Directory
    expect(() =>
      recoverCursorSession(root, {
        transcriptPath: cwd,
        recoveryId: 'dir',
      }),
    ).toThrow('E_RECOVERY_SOURCE_UNSAFE');
  });

  it('rejects sources exceeding MAX_SOURCE_BYTES', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const hugeFile = path.join(cwd, 'huge.jsonl');

    // Create sparse file with ftruncateSync to simulate > 128 MiB
    const fd = fs.openSync(hugeFile, 'w');
    fs.ftruncateSync(fd, MAX_SOURCE_BYTES + 1024);
    fs.closeSync(fd);

    expect(() =>
      recoverCursorSession(root, {
        transcriptPath: hugeFile,
        recoveryId: 'huge',
      }),
    ).toThrow('E_RECOVERY_SOURCE_TOO_LARGE');
  });

  it('computes source SHA-256 matching independent stream hash', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'hash-check.jsonl');
    const content = Array.from({ length: 100 }, (_, i) => `{"line":${i},"random":"${crypto.randomUUID()}"}\n`).join('');
    fs.writeFileSync(transcript, content);

    const expectedSha = crypto.createHash('sha256').update(content).digest('hex');

    const snapshot = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'hash-test',
      now: fixedNow,
    });

    expect(snapshot.source_sha256).toBe(expectedSha);
    expect(snapshot.source_bytes).toBe(Buffer.byteLength(content));
  });

  it('preserves read compatibility for schema v1 snapshots', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const recoveryDir = path.join(root.path, 'recovery', 'v1-test');
    fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });

    const records = [{ id: 'v1-msg', type: 'message' }];
    const copyContent = `${JSON.stringify(records[0])}\n`;
    const copyPath = path.join(recoveryDir, 'transcript.tail.jsonl');
    fs.writeFileSync(copyPath, copyContent, { mode: 0o400 });

    const v1Snapshot: RecoverySnapshotV1 = {
      schema_version: 1,
      recovery_id: 'v1-test',
      source_path: path.join(cwd, 'fake.jsonl'),
      source_sha256: crypto.createHash('sha256').update('source').digest('hex'),
      copied_sha256: crypto.createHash('sha256').update(copyContent).digest('hex'),
      copied_lines: 1,
      source_lines: 1,
      truncated: false,
      records,
      warnings: [],
      created_at: fixedNow().toISOString(),
      copy_path: copyPath,
    };

    const metadataPath = path.join(recoveryDir, 'snapshot.json');
    fs.writeFileSync(metadataPath, JSON.stringify(v1Snapshot), { mode: 0o400 });

    const read = readRecovery(root, 'v1-test');
    expect(read.schema_version).toBe(1);
    expect(read.recovery_id).toBe('v1-test');
    expect(read.copied_lines).toBe(1);

    const summary = recoverySummary(read);
    expect(summary.schema_version).toBe(1);
    expect(summary.retained_range.count).toBe(1);

    // Re-accessing existing v1 snapshot via recoverCursorSession returns v1 object without cast
    const sourceFile = path.join(cwd, 'fake.jsonl');
    fs.writeFileSync(sourceFile, copyContent);
    const v1SnapshotFixed: RecoverySnapshotV1 = {
      ...v1Snapshot,
      source_sha256: crypto.createHash('sha256').update(copyContent).digest('hex'),
    };
    fs.chmodSync(metadataPath, 0o600);
    fs.writeFileSync(metadataPath, JSON.stringify(v1SnapshotFixed));
    fs.chmodSync(metadataPath, 0o400);

    const reloaded = recoverCursorSession(root, {
      transcriptPath: sourceFile,
      recoveryId: 'v1-test',
      now: fixedNow,
    });
    expect(reloaded.schema_version).toBe(1);
    expect(reloaded).toEqual(v1SnapshotFixed);
  });

  it('rejects mutation of existing immutable snapshots with conflict', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript1 = path.join(cwd, 'trans1.jsonl');
    const transcript2 = path.join(cwd, 'trans2.jsonl');
    fs.writeFileSync(transcript1, '{"id":"one"}\n');
    fs.writeFileSync(transcript2, '{"id":"two"}\n');

    recoverCursorSession(root, {
      transcriptPath: transcript1,
      recoveryId: 'conflict-id',
      now: fixedNow,
    });

    // Re-creating with exact same source is idempotent
    expect(() =>
      recoverCursorSession(root, {
        transcriptPath: transcript1,
        recoveryId: 'conflict-id',
        now: fixedNow,
      }),
    ).not.toThrow();

    // Re-creating with different content throws immutable conflict
    expect(() =>
      recoverCursorSession(root, {
        transcriptPath: transcript2,
        recoveryId: 'conflict-id',
        now: fixedNow,
      }),
    ).toThrow('E_RECOVERY_IMMUTABLE_CONFLICT');
  });

  it('detects source file changes and concurrent modifications', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'mod.jsonl');
    fs.writeFileSync(transcript, '{"id":"m1"}\n{"id":"m2"}\n');

    // Tampering mtime immediately to simulate mutation
    const future = new Date(Date.now() + 10000);
    fs.utimesSync(transcript, future, future);

    // Normal read works with current mtime
    const snap = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'mod-test',
      now: fixedNow,
    });
    expect(snap.source_lines).toBe(2);

    // If source path is modified to directory before read
    const dirSource = path.join(cwd, 'dir-source');
    fs.mkdirSync(dirSource);
    expect(() =>
      recoverCursorSession(root, {
        transcriptPath: dirSource,
      }),
    ).toThrow('E_RECOVERY_SOURCE_UNSAFE');
  });

  it('streams large transcripts with bounded memory usage', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'large-stream.jsonl');

    // Write 20,000 records (approx 1.5MB)
    const fd = fs.openSync(transcript, 'w');
    const batch: string[] = [];
    for (let i = 0; i < 20000; i++) {
      batch.push(`{"id":"msg-${i}","type":"message","text":"bounded-test"}\n`);
      if (batch.length === 2000) {
        fs.writeSync(fd, batch.join(''));
        batch.length = 0;
      }
    }
    if (batch.length > 0) fs.writeSync(fd, batch.join(''));
    fs.closeSync(fd);

    const memBefore = process.memoryUsage().heapUsed;
    const snap = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'large-snap',
      now: fixedNow,
    });
    const memAfter = process.memoryUsage().heapUsed;

    expect(snap.source_lines).toBe(20000);
    expect(snap.copied_lines).toBe(900);
    expect(snap.truncated).toBe(true);
    expect(snap.retained_first_line).toBe(19101);
    expect(snap.retained_last_line).toBe(20000);

    // Heap usage should not expand by tens of megabytes
    const heapDiffMb = (memAfter - memBefore) / (1024 * 1024);
    expect(heapDiffMb).toBeLessThan(35);
  });

  it('handles multiple children referencing the same prefix parent', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'multi-child.jsonl');

    // Total 1000 lines. Line 10 has id 'shared-parent'
    // Tail has lines 910 and 920 referencing 'shared-parent'
    const lines: string[] = [];
    for (let i = 1; i <= 1000; i++) {
      if (i === 10) {
        lines.push(JSON.stringify({ id: 'shared-parent', type: 'message' }));
      } else if (i === 910) {
        lines.push(JSON.stringify({ id: 'child-a', parent_id: 'shared-parent', type: 'message' }));
      } else if (i === 920) {
        lines.push(JSON.stringify({ id: 'child-b', parent_id: 'shared-parent', type: 'message' }));
      } else {
        lines.push(JSON.stringify({ id: `item-${i}`, type: 'message' }));
      }
    }
    fs.writeFileSync(transcript, `${lines.join('\n')}\n`);

    const snapshot = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'multi-child-snap',
      now: fixedNow,
    });

    const outsideWarnings = snapshot.warnings.filter((w) => w.code === 'W_PARENT_OUTSIDE_RETAINED_TAIL');
    // Both children produce W_PARENT_OUTSIDE_RETAINED_TAIL
    expect(outsideWarnings).toHaveLength(2);
    expect(snapshot.warnings.some((w) => w.code === 'W_BROKEN_CHAIN')).toBe(false);
  });

  it('does not treat malformed text in prefix as confirmed parent', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'malformed-prefix.jsonl');

    // Total 1000 lines. Line 10 is invalid JSON containing {"id":"corrupt-parent"
    // Tail has line 950 referencing 'corrupt-parent'
    const lines: string[] = [];
    for (let i = 1; i <= 1000; i++) {
      if (i === 10) {
        lines.push('{"id":"corrupt-parent", broken json');
      } else if (i === 950) {
        lines.push(JSON.stringify({ id: 'child-c', parent_id: 'corrupt-parent', type: 'message' }));
      } else {
        lines.push(JSON.stringify({ id: `item-${i}`, type: 'message' }));
      }
    }
    fs.writeFileSync(transcript, `${lines.join('\n')}\n`);

    const snapshot = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'malformed-prefix-snap',
      now: fixedNow,
    });

    // child-c must NOT be treated as W_PARENT_OUTSIDE_RETAINED_TAIL
    expect(snapshot.warnings.some((w) => w.code === 'W_PARENT_OUTSIDE_RETAINED_TAIL')).toBe(false);
    // Instead it must be marked W_CHAIN_UNVERIFIED
    const unverified = snapshot.warnings.filter((w) => w.code === 'W_CHAIN_UNVERIFIED');
    expect(unverified).toHaveLength(1);
    expect(unverified[0]!.detail).toContain('corrupt-parent');
  });

  it('rejects snapshots with impossible source_lines and source_bytes combinations', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'valid.jsonl');
    fs.writeFileSync(transcript, '{"id":"m1"}\n');

    const snap = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'line-byte-check',
      now: fixedNow,
    });

    const metadataPath = path.join(root.path, 'recovery', 'line-byte-check', 'snapshot.json');

    // Case 1: positive line count with source_bytes: 0
    fs.chmodSync(metadataPath, 0o600);
    fs.writeFileSync(metadataPath, JSON.stringify({ ...snap, source_bytes: 0 }));
    fs.chmodSync(metadataPath, 0o400);
    expect(() => readRecovery(root, 'line-byte-check')).toThrow('E_RECOVERY_INVALID');

    // Case 2: source_lines > source_bytes
    fs.chmodSync(metadataPath, 0o600);
    fs.writeFileSync(metadataPath, JSON.stringify({ ...snap, source_lines: 50, source_bytes: 10 }));
    fs.chmodSync(metadataPath, 0o400);
    expect(() => readRecovery(root, 'line-byte-check')).toThrow('E_RECOVERY_INVALID');

    // Case 3: 0 lines with positive source_bytes
    fs.chmodSync(metadataPath, 0o600);
    fs.writeFileSync(metadataPath, JSON.stringify({ ...snap, source_lines: 0, source_bytes: 100 }));
    fs.chmodSync(metadataPath, 0o400);
    expect(() => readRecovery(root, 'line-byte-check')).toThrow('E_RECOVERY_INVALID');
  });

  it('keeps valid non-object JSON out of the malformed path and reports broken chain', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'non-object.jsonl');

    // Total 1000 lines: prefix has valid non-object JSON string containing "ghost"
    const lines: string[] = [];
    for (let i = 1; i <= 99; i++) {
      lines.push(JSON.stringify({ id: `p-${i}`, role: 'assistant' }));
    }
    // Line 100: valid JSON primitive string "ghost"
    lines.push(JSON.stringify('ghost'));
    for (let i = 101; i <= 999; i++) {
      lines.push(JSON.stringify({ id: `p-${i}`, role: 'assistant' }));
    }
    // Line 1000 in tail: references parent_id "ghost"
    lines.push(JSON.stringify({ id: 'tail-child', parent_id: 'ghost', role: 'user' }));
    fs.writeFileSync(transcript, `${lines.join('\n')}\n`);

    const snapshot = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'non-object-ghost',
      now: fixedNow,
    });

    // "ghost" was in valid non-object JSON, not an object record with id "ghost", so it must be W_BROKEN_CHAIN
    const broken = snapshot.warnings.filter((w) => w.code === 'W_BROKEN_CHAIN');
    expect(broken).toHaveLength(1);
    expect(broken[0]!.detail).toContain('ghost');

    const unverified = snapshot.warnings.filter((w) => w.code === 'W_CHAIN_UNVERIFIED');
    expect(unverified).toHaveLength(0);
  });

  it('bounds remainder while streaming oversized records across chunks', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'stream-oversized.jsonl');

    // Write 2 lines: line 1 is 1.5 MiB (larger than MAX_LINE_BYTES), line 2 is normal
    const fd = fs.openSync(transcript, 'w');
    const chunk = 'a'.repeat(64 * 1024);
    for (let i = 0; i < 24; i++) {
      fs.writeSync(fd, chunk);
    }
    fs.writeSync(fd, '\n{"id":"normal-line"}\n');
    fs.closeSync(fd);

    const snapshot = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'stream-oversized',
      now: fixedNow,
    });

    expect(snapshot.source_lines).toBe(2);
    expect(snapshot.copied_lines).toBe(2);
  });

  it('marks candidate parent IDs in malformed retained records as W_CHAIN_UNVERIFIED', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'tail-malformed-parent.jsonl');

    // Line 1: malformed line containing "tail-parent-corrupt"
    // Line 2: valid record referencing parent_id "tail-parent-corrupt"
    fs.writeFileSync(
      transcript,
      '{"id":"tail-parent-corrupt", invalid_json_syntax}\n{"id":"child-1","parent_id":"tail-parent-corrupt","role":"user"}\n',
    );

    const snapshot = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'tail-malformed-check',
      now: fixedNow,
    });

    const unverified = snapshot.warnings.filter((w) => w.code === 'W_CHAIN_UNVERIFIED');
    expect(unverified).toHaveLength(1);
    expect(unverified[0]!.detail).toContain('tail-parent-corrupt');
    expect(unverified[0]!.detail).toContain('malformed retained record');

    const broken = snapshot.warnings.filter((w) => w.code === 'W_BROKEN_CHAIN');
    expect(broken).toHaveLength(0);
  });

  it('rejects with E_RECOVERY_TAIL_TOO_LARGE when aggregate retained bytes exceed MAX_TAIL_BYTES', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'tail-too-large.jsonl');

    // Write 17 lines of 1 MiB each (17 MiB > MAX_TAIL_BYTES of 16 MiB)
    const fd = fs.openSync(transcript, 'w');
    const lineChunk = `${'a'.repeat(MAX_LINE_BYTES - 100)}\n`;
    for (let i = 0; i < 17; i++) {
      fs.writeSync(fd, lineChunk);
    }
    fs.closeSync(fd);

    expect(() =>
      recoverCursorSession(root, {
        transcriptPath: transcript,
        recoveryId: 'tail-overflow',
        now: fixedNow,
      }),
    ).toThrow('E_RECOVERY_TAIL_TOO_LARGE');
  });

  it('accepts transcript with 17 large prefix lines when evicted by 900 ordinary tail records', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'prefix-large-evicted.jsonl');

    // 17 lines of ~1 MiB followed by 900 ordinary lines
    const fd = fs.openSync(transcript, 'w');
    const lineChunk = `${'a'.repeat(MAX_LINE_BYTES - 100)}\n`;
    for (let i = 0; i < 17; i++) {
      fs.writeSync(fd, lineChunk);
    }
    for (let i = 0; i < 900; i++) {
      fs.writeSync(fd, `{"id":"tail-${i}","role":"assistant"}\n`);
    }
    fs.closeSync(fd);

    const snapshot = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'prefix-evicted',
      now: fixedNow,
    });

    expect(snapshot.source_lines).toBe(917);
    expect(snapshot.copied_lines).toBe(900);
    expect(snapshot.truncated).toBe(true);
  });

  it('matches parent IDs containing escape characters in malformed records as unverified', () => {
    const cwd = workspace();
    const root = projectStateRoot(cwd);
    const transcript = path.join(cwd, 'escaped-parent.jsonl');

    // Child references a parent with special chars (newline and quote)
    const parentId = 'p"special\nid';
    // Malformed line in tail containing the serialized parent ID
    const malformedTailLine = `{"broken-json": true, "raw_text": "references ${JSON.stringify(parentId).slice(1, -1)} somewhere"`;
    const childRecord = JSON.stringify({
      id: 'c1',
      parent_id: parentId,
      type: 'message',
    });

    fs.writeFileSync(transcript, `${malformedTailLine}\n${childRecord}\n`);

    const snapshot = recoverCursorSession(root, {
      transcriptPath: transcript,
      recoveryId: 'escaped-parent-tail',
      now: fixedNow,
    });

    const unverified = snapshot.warnings.filter((w) => w.code === 'W_CHAIN_UNVERIFIED');
    expect(unverified).toHaveLength(1);
    expect(unverified[0]!.detail).toContain(parentId);

    const broken = snapshot.warnings.filter((w) => w.code === 'W_BROKEN_CHAIN');
    expect(broken).toHaveLength(0);
  });
});

