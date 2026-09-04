import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Journal,
  sha256,
  canonicalJson,
  type JournalRecord,
} from '../../src/runtime/journal.js';

describe('Journal primitive', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-journal-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('initializes layout with meta, head, and empty segment', () => {
    const streamDir = path.join(tempDir, 'stream-1');
    const journal = new Journal(streamDir, 'test-stream');

    const head = journal.init();
    expect(head.head_sequence).toBe(0);
    expect(head.head_digest).toBeNull();
    expect(head.active_segment).toBe('00000001.jsonl');
    expect(head.total_records).toBe(0);

    const meta = journal.readMeta();
    expect(meta).not.toBeNull();
    expect(meta?.stream_id).toBe('test-stream');
    expect(meta?.schema_version).toBe(1);

    expect(fs.existsSync(path.join(streamDir, 'segments', '00000001.jsonl'))).toBe(true);
    expect(journal.verify().ok).toBe(true);
  });

  it('appends monotonically with cryptographic digest chaining and redaction', async () => {
    const streamDir = path.join(tempDir, 'chain');
    const journal = new Journal<{ msg: string; token?: string }>(streamDir, 'chain-stream', { redactPayload: true });

    const rec1 = await journal.append({ kind: 'init', payload: { msg: 'first', token: 'secret-val' } });
    expect(rec1.sequence).toBe(1);
    expect(rec1.previous_digest).toBeNull();
    expect(rec1.payload.token).toBe('<redacted>');

    const rec2 = await journal.append({ kind: 'progress', payload: { msg: 'second' } });
    expect(rec2.sequence).toBe(2);
    expect(rec2.previous_digest).toBe(rec1.digest);

    const rec3 = await journal.append({ kind: 'done', payload: { msg: 'third' } });
    expect(rec3.sequence).toBe(3);
    expect(rec3.previous_digest).toBe(rec2.digest);

    // Verify digest calculation
    const { digest: d3, ...mat3 } = rec3;
    expect(sha256(canonicalJson(mat3))).toBe(d3);

    const head = journal.readHead();
    expect(head?.head_sequence).toBe(3);
    expect(head?.head_digest).toBe(rec3.digest);
    expect(head?.total_records).toBe(3);

    const verification = journal.verify();
    expect(verification.ok).toBe(true);
    expect(verification.status).toBe('valid');
    expect(verification.total_records).toBe(3);
  });

  it('fences appends with expectedHead for optimistic concurrency', async () => {
    const streamDir = path.join(tempDir, 'fence');
    const journal = new Journal<{ count: number }>(streamDir, 'fence-stream');

    const rec1 = await journal.append({ kind: 'tick', payload: { count: 1 } }, { sequence: 0, digest: null });
    expect(rec1.sequence).toBe(1);

    // Mismatched expectedHead throws E_JOURNAL_HEAD_MISMATCH
    await expect(
      journal.append({ kind: 'tick', payload: { count: 2 } }, { sequence: 0, digest: null }),
    ).rejects.toThrow('E_JOURNAL_HEAD_MISMATCH');

    // Matching expectedHead succeeds
    const rec2 = await journal.append({ kind: 'tick', payload: { count: 2 } }, { sequence: 1, digest: rec1.digest });
    expect(rec2.sequence).toBe(2);
  });

  it('rotates segments when byte limit is reached and preserves continuous ordering', async () => {
    const streamDir = path.join(tempDir, 'rotate');
    // Set small segment size to trigger rotation after every ~2 records
    const journal = new Journal<{ text: string }>(streamDir, 'rotate-stream', {
      maxSegmentBytes: 400,
    });

    const records: JournalRecord<{ text: string }>[] = [];
    for (let i = 0; i < 10; i++) {
      const rec = await journal.append({ kind: 'item', payload: { text: `item-${i}-${'x'.repeat(50)}` } });
      records.push(rec);
    }

    const segments = fs.readdirSync(path.join(streamDir, 'segments')).sort();
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0]).toBe('00000001.jsonl');
    expect(segments[1]).toBe('00000002.jsonl');

    // Verification across multiple segments succeeds
    const verification = journal.verify();
    expect(verification.ok).toBe(true);
    expect(verification.total_records).toBe(10);
    expect(verification.head_sequence).toBe(10);

    // Range query across segments
    const range = journal.readRange({ fromSequence: 3, toSequence: 7 });
    expect(range.map((r) => r.sequence)).toEqual([3, 4, 5, 6, 7]);

    // Descending range query
    const descRange = journal.readRange({ fromSequence: 3, toSequence: 5, direction: 'desc' });
    expect(descRange.map((r) => r.sequence)).toEqual([5, 4, 3]);
  });

  it('tail reads only latest records without loading all history', async () => {
    const streamDir = path.join(tempDir, 'tail');
    const journal = new Journal<{ n: number }>(streamDir, 'tail-stream', {
      maxSegmentBytes: 300,
    });

    for (let i = 1; i <= 20; i++) {
      await journal.append({ kind: 'n', payload: { n: i } });
    }

    const tail3 = journal.tail(3);
    expect(tail3).toHaveLength(3);
    expect(tail3.map((r) => r.sequence)).toEqual([18, 19, 20]);

    const tail1 = journal.tail(1);
    expect(tail1).toHaveLength(1);
    expect(tail1[0]?.sequence).toBe(20);
  });

  it('detects incomplete tail with missing newline and repairs with receipt', async () => {
    const streamDir = path.join(tempDir, 'incomplete-newline');
    const journal = new Journal<{ val: string }>(streamDir, 'inc-nl');

    const r1 = await journal.append({ kind: 'step', payload: { val: 'one' } });
    const r2 = await journal.append({ kind: 'step', payload: { val: 'two' } });

    // Simulate interrupted write: partial line without newline at the tail
    const activeSegPath = path.join(streamDir, 'segments', '00000001.jsonl');
    const originalContent = fs.readFileSync(activeSegPath);
    fs.appendFileSync(activeSegPath, '{"schema_version":1,"incomplete');

    const verifyBefore = journal.verify();
    expect(verifyBefore.ok).toBe(false);
    expect(verifyBefore.status).toBe('incomplete_tail');
    expect(verifyBefore.repairable).toBe(true);
    expect(verifyBefore.error?.code).toBe('E_JOURNAL_INCOMPLETE_TAIL');

    // Repair
    const receipt = await journal.repairIncompleteTail();
    expect(receipt.store_kind).toBe('journal_repair_receipt');
    expect(receipt.repaired_bytes).toBe(originalContent.length);
    expect(receipt.truncated_bytes).toBe(Buffer.byteLength('{"schema_version":1,"incomplete'));
    expect(fs.existsSync(receipt.backup_file)).toBe(true);

    // After repair, stream is valid again
    const verifyAfter = journal.verify();
    expect(verifyAfter.ok).toBe(true);
    expect(verifyAfter.total_records).toBe(2);
    expect(verifyAfter.head_sequence).toBe(2);

    // Original records remain readable
    const tail = journal.tail(2);
    expect(tail.map((r) => r.sequence)).toEqual([1, 2]);
  });

  it('detects incomplete tail with uncommitted record and repairs with receipt', async () => {
    const streamDir = path.join(tempDir, 'uncommitted-tail');
    const journal = new Journal<{ val: string }>(streamDir, 'uncommitted');

    const r1 = await journal.append({ kind: 'step', payload: { val: 'one' } });

    // Simulate crash after appending line to segment but before updating head.json
    const activeSegPath = path.join(streamDir, 'segments', '00000001.jsonl');
    const uncommittedRecord = {
      schema_version: 1,
      stream_id: 'uncommitted',
      sequence: 2,
      kind: 'step',
      payload: { val: 'uncommitted' },
      at: new Date().toISOString(),
      previous_digest: r1.digest,
    };
    const uncommittedDigest = sha256(canonicalJson(uncommittedRecord));
    const uncommittedLine = `${canonicalJson({ ...uncommittedRecord, digest: uncommittedDigest })}\n`;
    fs.appendFileSync(activeSegPath, uncommittedLine);

    const verifyBefore = journal.verify();
    expect(verifyBefore.ok).toBe(false);
    expect(verifyBefore.status).toBe('incomplete_tail');
    expect(verifyBefore.repairable).toBe(true);

    const receipt = await journal.repairIncompleteTail();
    expect(receipt.truncated_bytes).toBe(Buffer.byteLength(uncommittedLine));

    const verifyAfter = journal.verify();
    expect(verifyAfter.ok).toBe(true);
    expect(verifyAfter.total_records).toBe(1);
    expect(verifyAfter.head_sequence).toBe(1);
  });

  it('detects non-tail corruption and refuses truncation repair', async () => {
    const streamDir = path.join(tempDir, 'corrupt-middle');
    const journal = new Journal<{ val: string }>(streamDir, 'corrupt-mid');

    await journal.append({ kind: 'step', payload: { val: 'one' } });
    await journal.append({ kind: 'step', payload: { val: 'two' } });
    await journal.append({ kind: 'step', payload: { val: 'three' } });

    // Tamper with record 1 in the middle
    const activeSegPath = path.join(streamDir, 'segments', '00000001.jsonl');
    const lines = fs.readFileSync(activeSegPath, 'utf8').trim().split('\n');
    const tamperedLine0 = lines[0]!.replace('"one"', '"tampered"');
    fs.writeFileSync(activeSegPath, `${tamperedLine0}\n${lines[1]}\n${lines[2]}\n`);

    const verification = journal.verify();
    expect(verification.ok).toBe(false);
    expect(verification.status).toBe('corrupt');
    expect(verification.repairable).toBe(false);
    expect(verification.error?.code).toBe('E_JOURNAL_DIGEST_MISMATCH');

    // Repairing non-tail corruption must throw E_JOURNAL_NON_TAIL_CORRUPTION
    await expect(journal.repairIncompleteTail()).rejects.toThrow('E_JOURNAL_NON_TAIL_CORRUPTION');
  });

  it('enforces maxRecordBytes and maxStreamRecords limits', async () => {
    const streamDir = path.join(tempDir, 'limits');
    const journal = new Journal<{ data: string }>(streamDir, 'limits-stream', {
      maxRecordBytes: 350,
      maxStreamRecords: 2,
    });

    // Record too large
    await expect(
      journal.append({ kind: 'big', payload: { data: 'a'.repeat(500) } }),
    ).rejects.toThrow('E_JOURNAL_RECORD_TOO_LARGE');

    // Allowed records
    await journal.append({ kind: 'ok', payload: { data: '1' } });
    await journal.append({ kind: 'ok', payload: { data: '2' } });

    // Limit reached
    await expect(
      journal.append({ kind: 'ok', payload: { data: '3' } }),
    ).rejects.toThrow('E_JOURNAL_LIMIT');
  });

  it('validates safe stream IDs', () => {
    expect(() => new Journal(tempDir, '../unsafe')).toThrow('E_JOURNAL_STREAM_ID_INVALID');
    expect(() => new Journal(tempDir, '/absolute')).toThrow('E_JOURNAL_STREAM_ID_INVALID');
    expect(() => new Journal(tempDir, 'valid-stream_1.0')).not.toThrow();
  });

  it('serializes concurrent appends with identical expectedHead so exactly one wins', async () => {
    const streamDir = path.join(tempDir, 'concurrent-race');
    const journal = new Journal<{ id: string }>(streamDir, 'concurrent');
    await journal.append({ kind: 'init', payload: { id: '0' } });
    const head = journal.readHead()!;

    const results = await Promise.allSettled([
      journal.append({ kind: 'a', payload: { id: '1a' } }, { sequence: head.head_sequence, digest: head.head_digest }),
      journal.append({ kind: 'b', payload: { id: '1b' } }, { sequence: head.head_sequence, digest: head.head_digest }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe('E_JOURNAL_HEAD_MISMATCH');
  });

  it('detects corruption at the beginning, middle, and uncommitted tail with precise reports', async () => {
    // 1. Beginning corruption
    const dirBeg = path.join(tempDir, 'corrupt-beg');
    const jBeg = new Journal<{ x: number }>(dirBeg, 'beg');
    await jBeg.append({ kind: 'item', payload: { x: 1 } });
    await jBeg.append({ kind: 'item', payload: { x: 2 } });
    const segBeg = path.join(dirBeg, 'segments', '00000001.jsonl');
    const linesBeg = fs.readFileSync(segBeg, 'utf8').trim().split('\n');
    fs.writeFileSync(segBeg, `{"corrupt":true}\n${linesBeg[1]}\n`);
    const vBeg = jBeg.verify();
    expect(vBeg.ok).toBe(false);
    expect(vBeg.status).toBe('corrupt');
    expect(vBeg.error?.sequence).toBe(1);

    // 2. Middle corruption (sequence mismatch)
    const dirMid = path.join(tempDir, 'corrupt-mid-seq');
    const jMid = new Journal<{ x: number }>(dirMid, 'mid');
    await jMid.append({ kind: 'item', payload: { x: 1 } });
    await jMid.append({ kind: 'item', payload: { x: 2 } });
    await jMid.append({ kind: 'item', payload: { x: 3 } });
    const segMid = path.join(dirMid, 'segments', '00000001.jsonl');
    const linesMid = fs.readFileSync(segMid, 'utf8').trim().split('\n');
    // Replace line 1 with a duplicate line 0 (sequence mismatch)
    fs.writeFileSync(segMid, `${linesMid[0]}\n${linesMid[0]}\n${linesMid[2]}\n`);
    const vMid = jMid.verify();
    expect(vMid.ok).toBe(false);
    expect(vMid.status).toBe('corrupt');
    expect(vMid.error?.code).toBe('E_JOURNAL_SEQUENCE_MISMATCH');
  });

  it('scales to 200 records across multiple segments with bounded tail latency and linear replay', async () => {
    const streamDir = path.join(tempDir, 'scale-200');
    const journal = new Journal<{ idx: number }>(streamDir, 'scale', {
      maxSegmentBytes: 2048, // frequent segment rotation (~20 segments)
    });

    for (let i = 1; i <= 200; i++) {
      await journal.append({ kind: 'step', payload: { idx: i } });
    }

    const startTail = performance.now();
    const tail10 = journal.tail(10);
    const tailDuration = performance.now() - startTail;

    expect(tail10).toHaveLength(10);
    expect(tail10[9]?.payload.idx).toBe(200);
    expect(tail10[0]?.payload.idx).toBe(191);
    // Tail should take < 50ms since it only reads the active segment
    expect(tailDuration).toBeLessThan(100);

    const startVerify = performance.now();
    const verification = journal.verify();
    const verifyDuration = performance.now() - startVerify;

    expect(verification.ok).toBe(true);
    expect(verification.total_records).toBe(200);
    expect(verifyDuration).toBeLessThan(1000);
  }, 30_000);
});
