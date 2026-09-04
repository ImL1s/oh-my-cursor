import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Journal,
  sha256,
  canonicalJson,
  assertSafeStreamId,
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
  }, 20_000);

  it('tail reads only latest records without loading all history', async () => {
    const streamDir = path.join(tempDir, 'tail');
    const journal = new Journal<{ n: number }>(streamDir, 'tail-stream', {
      maxSegmentBytes: 350,
    });

    for (let i = 1; i <= 10; i++) {
      await journal.append({ kind: 'n', payload: { n: i } });
    }

    const tail3 = journal.tail(3);
    expect(tail3).toHaveLength(3);
    expect(tail3.map((r) => r.sequence)).toEqual([8, 9, 10]);

    const tail1 = journal.tail(1);
    expect(tail1).toHaveLength(1);
    expect(tail1[0]?.sequence).toBe(10);
  }, 20_000);

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
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync');
    const receipt = await journal.repairIncompleteTail();
    expect(fsyncSpy).toHaveBeenCalled();
    fsyncSpy.mockRestore();
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

    // Reopened stream with defaults inherits persisted metadata limits
    const reopened = new Journal<{ data: string }>(streamDir, 'limits-stream');
    expect(reopened.getLimits().maxStreamRecords).toBe(2);
    expect(reopened.getLimits().maxRecordBytes).toBe(350);
    await expect(
      reopened.append({ kind: 'ok', payload: { data: '3' } }),
    ).rejects.toThrow('E_JOURNAL_LIMIT');

    // Reopened stream with incompatible constructor options is rejected
    const incompatible = new Journal<{ data: string }>(streamDir, 'limits-stream', {
      maxStreamRecords: 5,
    });
    await expect(
      incompatible.append({ kind: 'ok', payload: { data: '3' } }),
    ).rejects.toThrow('E_JOURNAL_OPTIONS_INCOMPATIBLE');
    expect(() => incompatible.init()).toThrow('E_JOURNAL_OPTIONS_INCOMPATIBLE');

    // Reopened stream with matching constructor options succeeds
    const matching = new Journal<{ data: string }>(streamDir, 'limits-stream', {
      maxRecordBytes: 350,
      maxStreamRecords: 2,
    });
    expect(matching.getLimits().maxStreamRecords).toBe(2);
  });

  it('validates safe stream IDs', () => {
    expect(() => new Journal(tempDir, '../unsafe')).toThrow('E_JOURNAL_STREAM_ID_INVALID');
    expect(() => new Journal(tempDir, '/absolute')).toThrow('E_JOURNAL_STREAM_ID_INVALID');
    expect(() => new Journal(tempDir, 'runs/../unsafe')).toThrow('E_JOURNAL_STREAM_ID_INVALID');
    expect(() => new Journal(tempDir, 'runs//unsafe')).toThrow('E_JOURNAL_STREAM_ID_INVALID');
    expect(() => new Journal(tempDir, 'runs/unsafe/')).toThrow('E_JOURNAL_STREAM_ID_INVALID');
    expect(() => new Journal(tempDir, 'valid-stream_1.0')).not.toThrow();
    // Namespaced entity IDs
    expect(() => new Journal(tempDir, `runs/${'a'.repeat(128)}`)).not.toThrow();
    expect(() => new Journal(tempDir, 'runs/entity..with..dots')).not.toThrow();
    expect(() => new Journal(tempDir, 'team/alpha/mailbox/worker-1')).not.toThrow();
    expect(() => new Journal(tempDir, `team/${'a'.repeat(64)}/mailbox/${'b'.repeat(64)}`)).not.toThrow();
  });

  it('completes append when writeSync returns short writes across multiple chunks', async () => {
    const streamDir = path.join(tempDir, 'short-writes');
    const journal = new Journal<{ msg: string }>(streamDir, 'short-writes');

    const originalWriteSync = fs.writeSync;
    let writeCalls = 0;
    const writeSpy = vi.spyOn(fs, 'writeSync').mockImplementation(function (
      this: unknown,
      fd: number,
      buffer: any,
      offset?: any,
      length?: any,
      position?: any,
    ) {
      if (Buffer.isBuffer(buffer) && typeof length === 'number' && length > 5) {
        writeCalls += 1;
        // Return a short write of 5 bytes on the first call for this buffer
        if (writeCalls === 1) {
          return (originalWriteSync as any).call(this, fd, buffer, offset, 5, position);
        }
      }
      return (originalWriteSync as any).call(this, fd, buffer, offset, length, position);
    });

    const record = await journal.append({ kind: 'chunked', payload: { msg: 'hello world durable' } });
    expect(record.sequence).toBe(1);
    expect(writeCalls).toBeGreaterThanOrEqual(2);
    writeSpy.mockRestore();

    const verify = journal.verify();
    expect(verify.ok).toBe(true);
    expect(verify.head_sequence).toBe(1);
    expect(journal.tail(1)[0]?.payload.msg).toBe('hello world durable');
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
  }, 60_000);

  it('selects latest matching records when readRange uses direction: desc and limit', async () => {
    const streamDir = path.join(tempDir, 'desc-range');
    const journal = new Journal<{ seq: number }>(streamDir, 'desc-test');

    for (let i = 1; i <= 12; i++) {
      await journal.append({ kind: 'num', payload: { seq: i } });
    }

    const latest5 = journal.readRange({ limit: 5, direction: 'desc' });
    expect(latest5).toHaveLength(5);
    expect(latest5.map((r) => r.payload.seq)).toEqual([12, 11, 10, 9, 8]);

    const subRange = journal.readRange({ fromSequence: 3, toSequence: 10, limit: 3, direction: 'desc' });
    expect(subRange).toHaveLength(3);
    expect(subRange.map((r) => r.payload.seq)).toEqual([10, 9, 8]);

    // Bounded limit: 1 in both directions
    const ascFirst1 = journal.readRange({ limit: 1, direction: 'asc' });
    expect(ascFirst1).toHaveLength(1);
    expect(ascFirst1[0]?.payload.seq).toBe(1);

    const descLast1 = journal.readRange({ limit: 1, direction: 'desc' });
    expect(descLast1).toHaveLength(1);
    expect(descLast1[0]?.payload.seq).toBe(12);

    const midAsc2 = journal.readRange({ fromSequence: 2, toSequence: 11, limit: 2, direction: 'asc' });
    expect(midAsc2.map((r) => r.payload.seq)).toEqual([2, 3]);

    const midDesc2 = journal.readRange({ fromSequence: 2, toSequence: 11, limit: 2, direction: 'desc' });
    expect(midDesc2.map((r) => r.payload.seq)).toEqual([11, 10]);
  }, 20_000);

  it('rotates segment when maxSegmentRecords is reached', async () => {
    const streamDir = path.join(tempDir, 'record-limit-rotate');
    const journal = new Journal<{ msg: string }>(streamDir, 'rec-limit', {
      maxSegmentRecords: 2,
    });

    await journal.append({ kind: 'msg', payload: { msg: 'first' } });
    await journal.append({ kind: 'msg', payload: { msg: 'second' } });
    // 3rd record should trigger rotation to 00000002.jsonl
    await journal.append({ kind: 'msg', payload: { msg: 'third' } });

    const seg1 = path.join(streamDir, 'segments', '00000001.jsonl');
    const seg2 = path.join(streamDir, 'segments', '00000002.jsonl');

    expect(fs.existsSync(seg1)).toBe(true);
    expect(fs.existsSync(seg2)).toBe(true);

    const lines1 = fs.readFileSync(seg1, 'utf8').trim().split('\n');
    const lines2 = fs.readFileSync(seg2, 'utf8').trim().split('\n');
    expect(lines1).toHaveLength(2);
    expect(lines2).toHaveLength(1);

    const head = journal.readHead()!;
    expect(head.active_segment).toBe('00000002.jsonl');
    expect(head.active_segment_records).toBe(1);
    expect(head.head_sequence).toBe(3);
  });

  it('repairs uncommitted tail in rotated segment and unlinks empty rotated segment', async () => {
    const streamDir = path.join(tempDir, 'rotate-uncommitted');
    const journal = new Journal<{ count: number }>(streamDir, 'rot-uncommitted', {
      maxSegmentRecords: 2,
    });

    await journal.append({ kind: 'c', payload: { count: 1 } });
    await journal.append({ kind: 'c', payload: { count: 2 } });

    // Segment 1 now has 2 records, head is sequence 2, active_segment is 00000001.jsonl
    // Simulate an uncommitted append into rotated segment 2:
    const seg2 = path.join(streamDir, 'segments', '00000002.jsonl');
    const head = journal.readHead()!;
    const recordMaterial = {
      schema_version: 1 as const,
      stream_id: 'rot-uncommitted',
      sequence: 3,
      kind: 'c',
      payload: { count: 3 },
      at: '2026-07-23T00:00:00.000Z',
      previous_digest: head.head_digest,
    };
    const digest = sha256(canonicalJson(recordMaterial));
    fs.writeFileSync(seg2, `${canonicalJson({ ...recordMaterial, digest })}\n`);

    const vBefore = journal.verify();
    expect(vBefore.ok).toBe(false);
    expect(vBefore.status).toBe('incomplete_tail');
    expect(vBefore.error?.segment).toBe('00000002.jsonl');
    expect(vBefore.error?.byte_offset).toBe(0);

    const receipt = await journal.repairIncompleteTail();
    expect(receipt.segment).toBe('00000002.jsonl');
    expect(receipt.repaired_bytes).toBe(0);
    // The empty rotated segment should have been unlinked
    expect(fs.existsSync(seg2)).toBe(false);

    const vAfter = journal.verify();
    expect(vAfter.ok).toBe(true);
    expect(vAfter.total_records).toBe(2);
  });

  it('refuses to classify committed corrupt records as incomplete_tail', async () => {
    const streamDir = path.join(tempDir, 'committed-corrupt');
    const journal = new Journal<{ x: number }>(streamDir, 'comm-corrupt');

    await journal.append({ kind: 'x', payload: { x: 1 } });
    await journal.append({ kind: 'x', payload: { x: 2 } });

    const seg = path.join(streamDir, 'segments', '00000001.jsonl');
    const lines = fs.readFileSync(seg, 'utf8').trim().split('\n');

    // Make second committed line invalid JSON while head.head_sequence is 2
    fs.writeFileSync(seg, `${lines[0]}\n{invalid-json\n`);

    const v = journal.verify();
    expect(v.ok).toBe(false);
    expect(v.status).toBe('corrupt');
    expect(v.repairable).toBe(false);
    await expect(journal.repairIncompleteTail()).rejects.toThrow('E_JOURNAL_NON_TAIL_CORRUPTION');
  });

  it('detects stale or corrupt head counters during verify and reports corrupt status', async () => {
    const streamDir = path.join(tempDir, 'corrupt-counters');
    const journal = new Journal<{ x: number }>(streamDir, 'counters');

    await journal.append({ kind: 'x', payload: { x: 1 } });
    await journal.append({ kind: 'x', payload: { x: 2 } });
    expect(journal.verify().ok).toBe(true);

    const headFile = path.join(streamDir, 'head.json');
    const validHead = JSON.parse(fs.readFileSync(headFile, 'utf8'));

    // 1. Lower total_records
    fs.writeFileSync(headFile, JSON.stringify({ ...validHead, total_records: 1 }));
    let v = journal.verify();
    expect(v.ok).toBe(false);
    expect(v.status).toBe('corrupt');
    expect(v.error?.code).toBe('E_JOURNAL_HEAD_MISMATCH');
    expect(v.error?.message).toContain('total_records mismatch');

    // 2. Corrupt active_segment_records
    fs.writeFileSync(headFile, JSON.stringify({ ...validHead, active_segment_records: 0 }));
    v = journal.verify();
    expect(v.ok).toBe(false);
    expect(v.status).toBe('corrupt');
    expect(v.error?.code).toBe('E_JOURNAL_HEAD_MISMATCH');
    expect(v.error?.message).toContain('active_segment_records mismatch');

    // 3. Corrupt total_bytes
    fs.writeFileSync(headFile, JSON.stringify({ ...validHead, total_bytes: 9999 }));
    v = journal.verify();
    expect(v.ok).toBe(false);
    expect(v.status).toBe('corrupt');
    expect(v.error?.code).toBe('E_JOURNAL_HEAD_MISMATCH');
    expect(v.error?.message).toContain('total_bytes mismatch');

    // Restoring valid head restores valid status
    fs.writeFileSync(headFile, JSON.stringify(validHead));
    expect(journal.verify().ok).toBe(true);
  });

  it('propagates file fsync errors in repairIncompleteTail and does not write receipt', async () => {
    const streamDir = path.join(tempDir, 'repair-fsync-fail');
    const journal = new Journal<{ msg: string }>(streamDir, 'repair-fsync');

    await journal.append({ kind: 'msg', payload: { msg: 'first' } });
    const seg = path.join(streamDir, 'segments', '00000001.jsonl');
    fs.appendFileSync(seg, '{incomplete-tail-without-newline');

    const spyFsync = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw new Error('EIO: i/o failure during fsync');
    });

    try {
      await expect(journal.repairIncompleteTail()).rejects.toThrow('EIO: i/o failure during fsync');
      const receiptsDir = path.join(streamDir, 'receipts');
      if (fs.existsSync(receiptsDir)) {
        expect(fs.readdirSync(receiptsDir)).toHaveLength(0);
      }
    } finally {
      spyFsync.mockRestore();
    }
  });

  it('validates committed records in readRange and tail and fails with structured corruption error', async () => {
    const streamDir = path.join(tempDir, 'read-range-validation');
    const journal = new Journal<{ status: string }>(streamDir, 'read-val');

    await journal.append({ kind: 'event', payload: { status: 'init' } });
    await journal.append({ kind: 'event', payload: { status: 'running' } });

    // Sanity check: valid readRange returns both
    expect(journal.readRange()).toHaveLength(2);
    expect(journal.tail(2)).toHaveLength(2);

    const seg = path.join(streamDir, 'segments', '00000001.jsonl');
    const lines = fs.readFileSync(seg, 'utf8').trim().split('\n');

    // 1. Corrupt payload in committed record 2 (valid JSON, but altered payload so digest mismatches)
    const rec2 = JSON.parse(lines[1]!);
    rec2.payload.status = 'corrupted_status';
    fs.writeFileSync(seg, `${lines[0]}\n${JSON.stringify(rec2)}\n`);

    expect(() => journal.readRange()).toThrow('E_JOURNAL_DIGEST_MISMATCH');
    expect(() => journal.tail(1)).toThrow('E_JOURNAL_DIGEST_MISMATCH');

    // 2. Corrupt sequence in committed record 2
    rec2.sequence = 99;
    fs.writeFileSync(seg, `${lines[0]}\n${JSON.stringify(rec2)}\n`);
    expect(() => journal.readRange()).toThrow();

    // 3. Corrupt stream ID in committed record 2
    rec2.stream_id = 'different-stream';
    fs.writeFileSync(seg, `${lines[0]}\n${JSON.stringify(rec2)}\n`);
    expect(() => journal.readRange()).toThrow('E_JOURNAL_STREAM_MISMATCH');

    // 4. Corrupt JSON in committed record 1
    fs.writeFileSync(seg, `{bad-json\n${lines[1]}\n`);
    expect(() => journal.readRange()).toThrow('E_JOURNAL_CORRUPT');
    expect(() => journal.tail(2)).toThrow('E_JOURNAL_CORRUPT');
  });

  it('enforces segment byte limits and rejects incompatible limits or oversized records', async () => {
    const streamDir = path.join(tempDir, 'incompatible-limits');

    // 1. Reject incompatible options where maxRecordBytes > maxSegmentBytes
    expect(() => new Journal(streamDir, 'incompat', {
      maxRecordBytes: 1000,
      maxSegmentBytes: 500,
    })).toThrow('E_JOURNAL_OPTIONS_INCOMPATIBLE');

    // Reject non-positive or non-safe integer options
    expect(() => new Journal(streamDir, 'incompat', { maxSegmentRecords: 0 })).toThrow('E_JOURNAL_OPTIONS_INVALID');
    expect(() => new Journal(streamDir, 'incompat', { maxSegmentRecords: -5 })).toThrow('E_JOURNAL_OPTIONS_INVALID');
    expect(() => new Journal(streamDir, 'incompat', { maxSegmentBytes: 0 })).toThrow('E_JOURNAL_OPTIONS_INVALID');
    expect(() => new Journal(streamDir, 'incompat', { maxRecordBytes: -1 })).toThrow('E_JOURNAL_OPTIONS_INVALID');
    expect(() => new Journal(streamDir, 'incompat', { maxStreamRecords: 0 })).toThrow('E_JOURNAL_OPTIONS_INVALID');
    expect(() => new Journal(streamDir, 'incompat', { maxSegmentBytes: 1.5 })).toThrow('E_JOURNAL_OPTIONS_INVALID');

    // 2. Bound single record size to segment bound even if record limit is lower
    const boundDir = path.join(tempDir, 'bound-record-test');
    const boundJournal = new Journal<{ data: string }>(boundDir, 'bound-test', {
      maxSegmentBytes: 200,
    });
    // Payload that exceeds 200 bytes
    const largePayload = 'a'.repeat(250);
    await expect(boundJournal.append({ kind: 'big', payload: { data: largePayload } }))
      .rejects.toThrow('E_JOURNAL_RECORD_TOO_LARGE');

    // 3. Record exceeding lowered segment bounds detected by verify
    const smallDir = path.join(tempDir, 'small-seg-test');
    const smallJournal = new Journal<{ x: string }>(smallDir, 'small-seg', {
      maxSegmentBytes: 400,
      maxRecordBytes: 250,
    });
    await smallJournal.append({ kind: 'x', payload: { x: 'hello' } });

    // Manually lower max_segment_bytes in meta.json below existing record size
    const metaPath = path.join(smallDir, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, max_segment_bytes: 50, max_record_bytes: 50 }));

    const v = smallJournal.verify();
    expect(v.ok).toBe(false);
    expect(v.status).toBe('corrupt');
    expect(v.error?.code).toBe('E_JOURNAL_RECORD_TOO_LARGE');
    expect(v.error?.message).toContain('exceeds maximum record bytes');

    // 4. Multiple records together exceeding segment limit
    const multiDir = path.join(tempDir, 'multi-seg-test');
    const multiJournal = new Journal<{ x: string }>(multiDir, 'multi-seg', {
      maxSegmentBytes: 800,
      maxRecordBytes: 300,
    });
    await multiJournal.append({ kind: 'x', payload: { x: 'first' } });
    await multiJournal.append({ kind: 'x', payload: { x: 'second' } });
    const multiMetaPath = path.join(multiDir, 'meta.json');
    const multiMeta = JSON.parse(fs.readFileSync(multiMetaPath, 'utf8'));
    // Each record is ~240 bytes (< 300), but both together are ~480 bytes (> 350)
    fs.writeFileSync(multiMetaPath, JSON.stringify({ ...multiMeta, max_segment_bytes: 350, max_record_bytes: 300 }));

    const vMulti = multiJournal.verify();
    expect(vMulti.ok).toBe(false);
    expect(vMulti.status).toBe('corrupt');
    expect(vMulti.error?.code).toBe('E_JOURNAL_CORRUPT');
    expect(vMulti.error?.message).toContain('exceeds maximum segment bytes');
  });

  it('refuses appends with E_JOURNAL_INCOMPLETE_TAIL when an uncommitted tail exists until repaired', async () => {
    const streamDir = path.join(tempDir, 'refuse-tail-append');
    const journal = new Journal<{ msg: string }>(streamDir, 'refuse-tail');

    const r1 = await journal.append({ kind: 'msg', payload: { msg: 'first' } });

    // Simulate crash after appending line to segment but before updating head.json
    const seg = path.join(streamDir, 'segments', '00000001.jsonl');
    const uncommittedRecord = {
      schema_version: 1,
      stream_id: 'refuse-tail',
      sequence: 2,
      kind: 'msg',
      payload: { msg: 'uncommitted' },
      at: new Date().toISOString(),
      previous_digest: r1.digest,
    };
    const uncommittedDigest = sha256(canonicalJson(uncommittedRecord));
    const uncommittedLine = `${canonicalJson({ ...uncommittedRecord, digest: uncommittedDigest })}\n`;
    fs.appendFileSync(seg, uncommittedLine);

    // Subsequent append is refused with E_JOURNAL_INCOMPLETE_TAIL
    await expect(journal.append({ kind: 'msg', payload: { msg: 'second' } }))
      .rejects.toThrow('E_JOURNAL_INCOMPLETE_TAIL');

    // Repair the tail
    await journal.repairIncompleteTail();

    // Now append succeeds and assigns sequence 2 cleanly
    const r2 = await journal.append({ kind: 'msg', payload: { msg: 'second' } });
    expect(r2.sequence).toBe(2);
    expect(journal.verify().ok).toBe(true);

    // Also verify un-terminated trailing line is refused with E_JOURNAL_INCOMPLETE_TAIL
    fs.appendFileSync(seg, '{"incomplete_json');
    await expect(journal.append({ kind: 'msg', payload: { msg: 'third' } }))
      .rejects.toThrow('E_JOURNAL_INCOMPLETE_TAIL');
    await journal.repairIncompleteTail();
    const r3 = await journal.append({ kind: 'msg', payload: { msg: 'third' } });
    expect(r3.sequence).toBe(3);
    expect(journal.verify().ok).toBe(true);
  });

  it('fsyncs segments directory when a new rotated segment is created', async () => {
    const streamDir = path.join(tempDir, 'fsync-segments-dir');
    const journal = new Journal<{ msg: string }>(streamDir, 'fsync-seg', {
      maxSegmentRecords: 1,
    });

    const segmentsDir = path.join(streamDir, 'segments');
    let segmentsDirSynced = false;
    const realOpenSync = fs.openSync.bind(fs);
    const spyOpen = vi.spyOn(fs, 'openSync').mockImplementation((p: any, flags: any, ...rest: any[]) => {
      if (typeof p === 'string' && path.resolve(p) === path.resolve(segmentsDir)) {
        segmentsDirSynced = true;
      }
      return (realOpenSync as any)(p, flags, ...rest);
    });

    try {
      await journal.append({ kind: 'msg', payload: { msg: 'record1' } });
      // Record 2 triggers rotation to segment 2 and fsyncs segments dir
      segmentsDirSynced = false;
      await journal.append({ kind: 'msg', payload: { msg: 'record2' } });
      expect(segmentsDirSynced).toBe(true);
    } finally {
      spyOpen.mockRestore();
    }
  });

  it('refuses appends with E_JOURNAL_INCOMPLETE_TAIL when an uncommitted rotated segment exists', async () => {
    const streamDir = path.join(tempDir, 'refuse-rotated-tail');
    const journal = new Journal<{ msg: string }>(streamDir, 'refuse-rot-tail', {
      maxSegmentRecords: 2,
    });

    await journal.append({ kind: 'msg', payload: { msg: 'first' } });
    await journal.append({ kind: 'msg', payload: { msg: 'second' } });

    // Segment 1 is active (2 records). Simulate a crash after rotating to segment 2 but before updating head.json
    const seg2 = path.join(streamDir, 'segments', '00000002.jsonl');
    const head = journal.readHead()!;
    const recordMaterial = {
      schema_version: 1 as const,
      stream_id: 'refuse-rot-tail',
      sequence: 3,
      kind: 'msg',
      payload: { msg: 'uncommitted' },
      at: '2026-07-23T00:00:00.000Z',
      previous_digest: head.head_digest,
    };
    const digest = sha256(canonicalJson(recordMaterial));
    fs.writeFileSync(seg2, `${canonicalJson({ ...recordMaterial, digest })}\n`);

    await expect(journal.append({ kind: 'msg', payload: { msg: 'third' } }))
      .rejects.toThrow('E_JOURNAL_INCOMPLETE_TAIL');

    await journal.repairIncompleteTail();
    const r3 = await journal.append({ kind: 'msg', payload: { msg: 'third' } });
    expect(r3.sequence).toBe(3);
    expect(journal.verify().ok).toBe(true);
  });

  it('append performs bounded tail check and does not read historical segments', async () => {
    const streamDir = path.join(tempDir, 'bounded-append');
    const journal = new Journal<{ msg: string }>(streamDir, 'bounded-append', {
      maxSegmentRecords: 1,
    });

    await journal.append({ kind: 'msg', payload: { msg: 'rec1' } });
    await journal.append({ kind: 'msg', payload: { msg: 'rec2' } });

    // Now active segment is 00000002.jsonl. Segment 1 is frozen history.
    // Spy on fs.openSync to ensure segment 1 is never read during append.
    const seg1Path = path.resolve(path.join(streamDir, 'segments', '00000001.jsonl'));
    let seg1Read = false;

    const origOpenSync = fs.openSync.bind(fs);
    const spyOpen = vi.spyOn(fs, 'openSync').mockImplementation((p: any, flags: any, ...rest: any[]) => {
      if (typeof p === 'string' && path.resolve(p) === seg1Path && (flags === 'r' || flags === 'r+')) {
        seg1Read = true;
      }
      return (origOpenSync as any)(p, flags, ...rest);
    });

    try {
      await journal.append({ kind: 'msg', payload: { msg: 'rec3' } });
      expect(seg1Read).toBe(false);
    } finally {
      spyOpen.mockRestore();
    }
  });

  it('enforces max_stream_records bound during verify and reports corrupt when exceeded', async () => {
    const streamDir = path.join(tempDir, 'max-stream-verify');
    const journal = new Journal<{ msg: string }>(streamDir, 'max-stream-verify', {
      maxStreamRecords: 3,
    });

    await journal.append({ kind: 'msg', payload: { msg: '1' } });
    await journal.append({ kind: 'msg', payload: { msg: '2' } });

    expect(journal.verify().ok).toBe(true);

    // Tamper with meta.json to reduce max_stream_records to 1 (below the 2 committed records)
    const metaPath = path.join(streamDir, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, max_stream_records: 1 }));

    const v = journal.verify();
    expect(v.ok).toBe(false);
    expect(v.status).toBe('corrupt');
    expect(v.error?.code).toBe('E_JOURNAL_LIMIT');
    expect(v.error?.message).toContain('exceeds maximum stream records');
  });

  it('classifies empty rotated segment beyond head.active_segment as incomplete_tail and repairs cleanly', async () => {
    const streamDir = path.join(tempDir, 'empty-rotated-seg');
    const journal = new Journal<{ msg: string }>(streamDir, 'empty-rot', {
      maxSegmentRecords: 2,
    });

    await journal.append({ kind: 'msg', payload: { msg: 'first' } });

    // Simulate crash after opening empty rotated segment 00000002.jsonl before writing to it
    const seg2 = path.join(streamDir, 'segments', '00000002.jsonl');
    fs.writeFileSync(seg2, '');

    // append() refuses because empty rotated segment exists
    await expect(journal.append({ kind: 'msg', payload: { msg: 'second' } }))
      .rejects.toThrow('E_JOURNAL_INCOMPLETE_TAIL');

    // verify() correctly reports incomplete_tail (not valid!)
    const v = journal.verify();
    expect(v.ok).toBe(false);
    expect(v.status).toBe('incomplete_tail');
    expect(v.repairable).toBe(true);
    expect(v.error?.segment).toBe('00000002.jsonl');

    // repairIncompleteTail unlinks the empty segment
    const receipt = await journal.repairIncompleteTail();
    expect(receipt.segment).toBe('00000002.jsonl');
    expect(receipt.truncated_bytes).toBe(0);
    expect(fs.existsSync(seg2)).toBe(false);

    // Stream is now valid and append succeeds
    expect(journal.verify().ok).toBe(true);
    const r2 = await journal.append({ kind: 'msg', payload: { msg: 'second' } });
    expect(r2.sequence).toBe(2);
  });

  it('refuses to reinitialize a journal whose head is missing when artifacts exist, and reports corrupt in verify', async () => {
    const streamDir = path.join(tempDir, 'missing-head-stream');
    const journal = new Journal<{ msg: string }>(streamDir, 'missing-head');

    await journal.append({ kind: 'msg', payload: { msg: 'first' } });
    expect(journal.verify().ok).toBe(true);

    const headPath = path.join(streamDir, 'head.json');
    const metaPath = path.join(streamDir, 'meta.json');
    const originalMeta = fs.readFileSync(metaPath, 'utf8');

    // Simulate catastrophic crash/corruption where head.json is removed
    fs.rmSync(headPath);

    // verify() should fail closed with status: 'corrupt' and E_JOURNAL_CORRUPT
    const v = journal.verify();
    expect(v.ok).toBe(false);
    expect(v.status).toBe('corrupt');
    expect(v.error?.code).toBe('E_JOURNAL_CORRUPT');
    expect(v.error?.message).toContain('head.json is missing');

    // init() MUST throw E_JOURNAL_CORRUPT and refuse to overwrite existing stream
    expect(() => journal.init()).toThrow('E_JOURNAL_CORRUPT');

    // Ensure meta.json was not modified/overwritten
    expect(fs.readFileSync(metaPath, 'utf8')).toBe(originalMeta);
    // Ensure head.json was NOT recreated with sequence 0
    expect(fs.existsSync(headPath)).toBe(false);
  });

  it('classifies trailing blank line in active segment as incomplete_tail and repairs cleanly', async () => {
    const streamDir = path.join(tempDir, 'trailing-blank-stream');
    const journal = new Journal<{ msg: string }>(streamDir, 'trailing-blank');

    await journal.append({ kind: 'msg', payload: { msg: 'first' } });
    expect(journal.verify().ok).toBe(true);

    const activeSegPath = path.join(streamDir, 'segments', '00000001.jsonl');
    const originalContent = fs.readFileSync(activeSegPath);

    // Simulate extra newline at the end of the active segment
    fs.appendFileSync(activeSegPath, '\n');

    // verify() MUST report incomplete_tail and repairable: true
    const v = journal.verify();
    expect(v.ok).toBe(false);
    expect(v.status).toBe('incomplete_tail');
    expect(v.repairable).toBe(true);
    expect(v.error?.code).toBe('E_JOURNAL_INCOMPLETE_TAIL');
    expect(v.error?.message).toContain('trailing blank line');
    expect(v.uncommitted_tail_bytes).toBe(1);

    // append() refuses because active segment has trailing blank line
    await expect(journal.append({ kind: 'msg', payload: { msg: 'second' } }))
      .rejects.toThrow('E_JOURNAL_INCOMPLETE_TAIL');

    // repairIncompleteTail() truncates the trailing newline
    const receipt = await journal.repairIncompleteTail();
    expect(receipt.segment).toBe('00000001.jsonl');
    expect(receipt.truncated_bytes).toBe(1);
    expect(fs.readFileSync(activeSegPath)).toEqual(originalContent);

    // Stream is now valid and append succeeds
    expect(journal.verify().ok).toBe(true);
    const r2 = await journal.append({ kind: 'msg', payload: { msg: 'second' } });
    expect(r2.sequence).toBe(2);
  });

  it('rejects append with E_JOURNAL_CORRUPT when head.total_records mismatches head.head_sequence', async () => {
    const streamDir = path.join(tempDir, 'corrupted-head-counter');
    const journal = new Journal<{ msg: string }>(streamDir, 'corrupted-counter', {
      maxStreamRecords: 2,
    });

    await journal.append({ kind: 'msg', payload: { msg: 'first' } });
    await journal.append({ kind: 'msg', payload: { msg: 'second' } });

    // Stream has reached maxStreamRecords (2)
    // Tamper with head.json to lower total_records to 0 while keeping head_sequence at 2
    const headPath = path.join(streamDir, 'head.json');
    const head = JSON.parse(fs.readFileSync(headPath, 'utf8'));
    fs.writeFileSync(headPath, JSON.stringify({ ...head, total_records: 0 }), 'utf8');

    // append() must NOT trust the corrupted total_records to permit an append beyond maxStreamRecords
    // It must reject with E_JOURNAL_CORRUPT
    await expect(journal.append({ kind: 'msg', payload: { msg: 'third' } }))
      .rejects.toThrow('E_JOURNAL_CORRUPT');

    // Verify head.json was not rewritten or corrupted further
    const afterHead = JSON.parse(fs.readFileSync(headPath, 'utf8'));
    expect(afterHead.head_sequence).toBe(2);
  });

  it('gives each repair receipt and quarantine backup a collision-resistant name even when now() is frozen', async () => {
    const streamDir = path.join(tempDir, 'collision-resistant-receipts');
    const fixedTime = new Date('2026-09-04T12:00:00.000Z');
    const journal = new Journal<{ msg: string }>(streamDir, 'collision-check', {
      now: () => fixedTime,
    });

    await journal.append({ kind: 'msg', payload: { msg: 'first' } });

    // Simulate incomplete tail #1
    const activeSegPath = path.join(streamDir, 'segments', '00000001.jsonl');
    fs.appendFileSync(activeSegPath, '{"broken":1');
    expect(journal.verify().status).toBe('incomplete_tail');

    const receipt1 = await journal.repairIncompleteTail();
    expect(fs.existsSync(receipt1.backup_file)).toBe(true);

    // Simulate incomplete tail #2 at the exact same frozen millisecond
    fs.appendFileSync(activeSegPath, '{"broken":2');
    expect(journal.verify().status).toBe('incomplete_tail');

    const receipt2 = await journal.repairIncompleteTail();
    expect(fs.existsSync(receipt2.backup_file)).toBe(true);

    // Verify receipt and backup paths are distinct
    expect(receipt1.backup_file).not.toBe(receipt2.backup_file);
    expect(fs.existsSync(receipt1.backup_file)).toBe(true);
    expect(fs.existsSync(receipt2.backup_file)).toBe(true);

    // Verify two distinct repair receipts exist in receipts dir
    const receiptsDir = path.join(streamDir, 'receipts');
    const receiptFiles = fs.readdirSync(receiptsDir);
    expect(receiptFiles).toHaveLength(2);
    expect(receiptFiles[0]).not.toBe(receiptFiles[1]);

    // Verify quarantine dir contains both backups
    const quarantineDir = path.join(streamDir, 'quarantine');
    const quarantineFiles = fs.readdirSync(quarantineDir);
    expect(quarantineFiles).toHaveLength(2);
    expect(quarantineFiles).toContain(path.basename(receipt1.backup_file));
    expect(quarantineFiles).toContain(path.basename(receipt2.backup_file));
  });

  it('rejects negative total_bytes and total_records in head.json with E_JOURNAL_CORRUPT', async () => {
    const streamDir = path.join(tempDir, 'negative-head-counters');
    const journal = new Journal<{ msg: string }>(streamDir, 'negative-counters');

    await journal.append({ kind: 'msg', payload: { msg: 'first' } });

    const headPath = path.join(streamDir, 'head.json');
    const validHead = JSON.parse(fs.readFileSync(headPath, 'utf8'));

    // Tamper head with negative total_bytes
    fs.writeFileSync(headPath, JSON.stringify({ ...validHead, total_bytes: -1 }), 'utf8');
    expect(() => journal.readHead()).toThrow('E_JOURNAL_CORRUPT');
    await expect(journal.append({ kind: 'msg', payload: { msg: 'second' } }))
      .rejects.toThrow('E_JOURNAL_CORRUPT');

    // Tamper head with negative total_records
    fs.writeFileSync(headPath, JSON.stringify({ ...validHead, total_records: -1 }), 'utf8');
    expect(() => journal.readHead()).toThrow('E_JOURNAL_CORRUPT');
    await expect(journal.append({ kind: 'msg', payload: { msg: 'second' } }))
      .rejects.toThrow('E_JOURNAL_CORRUPT');
  });

  it('rejects non-positive limits in meta.json with E_JOURNAL_CORRUPT', async () => {
    const streamDir = path.join(tempDir, 'invalid-meta-limits');
    const journal = new Journal<{ msg: string }>(streamDir, 'invalid-limits');

    await journal.append({ kind: 'msg', payload: { msg: 'first' } });

    const metaPath = path.join(streamDir, 'meta.json');
    const validMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    fs.writeFileSync(metaPath, JSON.stringify({ ...validMeta, max_record_bytes: 0 }), 'utf8');
    expect(() => journal.readMeta()).toThrow('E_JOURNAL_CORRUPT');

    fs.writeFileSync(metaPath, JSON.stringify({ ...validMeta, max_segment_bytes: -100 }), 'utf8');
    expect(() => journal.readMeta()).toThrow('E_JOURNAL_CORRUPT');
  });

  it('rejects symlinked segment file and symlinked segments directory with E_JOURNAL_CORRUPT', async () => {
    const streamDir = path.join(tempDir, 'symlink-rejection');
    const journal = new Journal<{ msg: string }>(streamDir, 'symlink-stream');

    await journal.append({ kind: 'msg', payload: { msg: 'first' } });

    // Target file outside .omcu
    const outsideDir = path.join(tempDir, 'outside-target');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, 'target.txt');
    fs.writeFileSync(outsideFile, 'safe-content', { mode: 0o644 });

    // Test 1: Active segment replaced by a symlink to outside file
    const activeSegPath = path.join(streamDir, 'segments', '00000001.jsonl');
    fs.unlinkSync(activeSegPath);
    fs.symlinkSync(outsideFile, activeSegPath);

    // append must refuse with E_JOURNAL_CORRUPT and not write to or chmod outsideFile
    await expect(journal.append({ kind: 'msg', payload: { msg: 'second' } }))
      .rejects.toThrow('E_JOURNAL_CORRUPT');
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('safe-content');
    const outsideStat = fs.statSync(outsideFile);
    expect(outsideStat.mode & 0o777).toBe(0o644);

    // verify must detect corruption
    const v1 = journal.verify();
    expect(v1.ok).toBe(false);
    expect(v1.status).toBe('corrupt');
    expect(v1.error?.code).toBe('E_JOURNAL_CORRUPT');

    // Test 2: segments directory replaced by a symlink to an outside directory
    fs.unlinkSync(activeSegPath);
    const segDir = path.join(streamDir, 'segments');
    fs.rmSync(segDir, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, segDir);

    await expect(journal.append({ kind: 'msg', payload: { msg: 'third' } }))
      .rejects.toThrow('E_JOURNAL_CORRUPT');

    const v2 = journal.verify();
    expect(v2.ok).toBe(false);
    expect(v2.status).toBe('corrupt');
    expect(v2.error?.code).toBe('E_JOURNAL_CORRUPT');
  });

  it('rejects symlinked head.json and meta.json with E_JOURNAL_CORRUPT and prevents repair truncation', async () => {
    const streamDir = path.join(tempDir, 'metadata-symlink-rejection');
    const journal = new Journal<{ msg: string }>(streamDir, 'metadata-symlink-stream');

    await journal.append({ kind: 'msg', payload: { msg: 'first' } });
    await journal.append({ kind: 'msg', payload: { msg: 'second' } });

    const originalHeadContent = fs.readFileSync(path.join(streamDir, 'head.json'), 'utf8');
    const originalMetaContent = fs.readFileSync(path.join(streamDir, 'meta.json'), 'utf8');
    const activeSegPath = path.join(streamDir, 'segments', '00000001.jsonl');
    const originalSegSize = fs.statSync(activeSegPath).size;

    const outsideDir = path.join(tempDir, 'outside-metadata');
    fs.mkdirSync(outsideDir, { recursive: true });

    // 1. Symlinked head.json pointing to an external stale head
    const staleHead = {
      schema_version: 1,
      stream_id: 'metadata-symlink-stream',
      head_sequence: 1,
      head_digest: '0'.repeat(64),
      active_segment: '00000001.jsonl',
      total_records: 1,
      total_bytes: 50,
      updated_at: new Date().toISOString(),
    };
    const outsideHeadFile = path.join(outsideDir, 'head.json');
    fs.writeFileSync(outsideHeadFile, JSON.stringify(staleHead), 'utf8');

    const headPath = path.join(streamDir, 'head.json');
    fs.unlinkSync(headPath);
    fs.symlinkSync(outsideHeadFile, headPath);

    // readHead must reject symlink
    expect(() => journal.readHead()).toThrow('E_JOURNAL_CORRUPT');

    // verify must treat it as corrupt, not incomplete_tail
    const vHead = journal.verify();
    expect(vHead.ok).toBe(false);
    expect(vHead.status).toBe('corrupt');
    expect(vHead.repairable).toBe(false);
    expect(vHead.error?.code).toBe('E_JOURNAL_CORRUPT');

    // repairIncompleteTail must refuse to truncate valid records
    await expect(journal.repairIncompleteTail()).rejects.toThrow('E_JOURNAL_NON_TAIL_CORRUPTION');
    expect(fs.statSync(activeSegPath).size).toBe(originalSegSize);

    // append must refuse
    await expect(journal.append({ kind: 'msg', payload: { msg: 'third' } })).rejects.toThrow('E_JOURNAL_CORRUPT');

    // 2. Restore head.json, test symlinked meta.json
    fs.unlinkSync(headPath);
    fs.writeFileSync(headPath, originalHeadContent, 'utf8');

    const outsideMetaFile = path.join(outsideDir, 'meta.json');
    fs.writeFileSync(outsideMetaFile, originalMetaContent, 'utf8');

    const metaPath = path.join(streamDir, 'meta.json');
    fs.unlinkSync(metaPath);
    fs.symlinkSync(outsideMetaFile, metaPath);

    // readMeta must reject symlink
    expect(() => journal.readMeta()).toThrow('E_JOURNAL_CORRUPT');

    const vMeta = journal.verify();
    expect(vMeta.ok).toBe(false);
    expect(vMeta.status).toBe('corrupt');
    expect(vMeta.repairable).toBe(false);
    expect(vMeta.error?.code).toBe('E_JOURNAL_CORRUPT');

    await expect(journal.repairIncompleteTail()).rejects.toThrow('E_JOURNAL_NON_TAIL_CORRUPTION');
    expect(fs.statSync(activeSegPath).size).toBe(originalSegSize);

    await expect(journal.append({ kind: 'msg', payload: { msg: 'third' } })).rejects.toThrow('E_JOURNAL_CORRUPT');
  });

  it('recovers pending repair intent and publishes finalized receipt after simulated crash', async () => {
    const streamDir = path.join(tempDir, 'intent-crash-recovery');
    const journal = new Journal<{ msg: string }>(streamDir, 'intent-stream');

    await journal.append({ kind: 'msg', payload: { msg: 'first' } });
    const head = journal.readHead()!;
    const segPath = path.join(streamDir, 'segments', '00000001.jsonl');
    const committedSize = fs.statSync(segPath).size;

    // Simulate an incomplete tail write
    fs.appendFileSync(segPath, '{"uncommitted": "data"');

    // Simulate crash after writing repair intent and truncating, but before writing receipt.json
    fs.truncateSync(segPath, committedSize);

    const timestamp = 1234567890;
    const nonce = 'abcdef123456';
    const finalReceiptPath = path.join(streamDir, 'receipts', `repair-${timestamp}-${nonce}.json`);
    const intentPath = path.join(streamDir, 'receipts', `repair-${timestamp}-${nonce}.intent.json`);

    fs.mkdirSync(path.join(streamDir, 'receipts'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(intentPath, JSON.stringify({
      schema_version: 1,
      store_kind: 'journal_repair_intent',
      stream_id: 'intent-stream',
      repaired_at: new Date(timestamp).toISOString(),
      segment: '00000001.jsonl',
      original_bytes: committedSize + 20,
      repaired_bytes: committedSize,
      truncated_bytes: 20,
      backup_file: path.join(streamDir, 'quarantine', '00000001.jsonl.tail-corrupt-1234567890-abcdef123456'),
      head_sequence: head.head_sequence,
      head_digest: head.head_digest,
      final_receipt_path: finalReceiptPath,
      receipt_sha256: 'f'.repeat(64),
    }), 'utf8');

    // Initially, final receipt does not exist
    expect(fs.existsSync(finalReceiptPath)).toBe(false);
    expect(fs.existsSync(intentPath)).toBe(true);

    // Calling verify or listReceipts must automatically recover and publish the final receipt
    const v = journal.verify();
    expect(v.ok).toBe(true);
    expect(fs.existsSync(finalReceiptPath)).toBe(true);
    expect(fs.existsSync(intentPath)).toBe(false);

    const receipts = journal.listReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.stream_id).toBe('intent-stream');
    expect(receipts[0]?.repaired_bytes).toBe(committedSize);
  });

  it('bounds segment read and returns corrupt for oversized crafted segment during verify', async () => {
    const streamDir = path.join(tempDir, 'oversized-crafted-segment');
    const journal = new Journal<{ msg: string }>(streamDir, 'oversized', {
      maxSegmentBytes: 500,
      maxRecordBytes: 250,
    });
    await journal.append({ kind: 'msg', payload: { msg: 'first' } });

    // Simulate an oversized record in segment (> maxRecordBytes and > maxSegmentBytes)
    const segPath = path.join(streamDir, 'segments', '00000001.jsonl');
    const largeLine = `{"schema_version":1,"sequence":2,"stream_id":"oversized","kind":"msg","payload":{"msg":"${'x'.repeat(2000)}"},"at":"${new Date().toISOString()}","previous_digest":null,"digest":"bad"}\n`;
    fs.appendFileSync(segPath, largeLine);

    const v = journal.verify();
    expect(v.ok).toBe(false);
    expect(v.status).toBe('corrupt');
    expect(v.error?.code).toBe('E_JOURNAL_RECORD_TOO_LARGE');
  });

  it('rejects closed non-active segment exceeding maxSegmentBytes without loading into memory', async () => {
    const streamDir = path.join(tempDir, 'oversized-closed-segment');
    const journal = new Journal<{ msg: string }>(streamDir, 'closed-seg', {
      maxSegmentBytes: 350,
      maxRecordBytes: 300,
    });
    // Each record is ~150 bytes, so 2nd or 3rd record rotates to segment 2
    await journal.append({ kind: 'msg', payload: { msg: 'first' } });
    await journal.append({ kind: 'msg', payload: { msg: 'second' } });
    await journal.append({ kind: 'msg', payload: { msg: 'third' } });

    // Segment 1 is closed. Tamper with segment 1 to exceed maxSegmentBytes
    const seg1Path = path.join(streamDir, 'segments', '00000001.jsonl');
    fs.appendFileSync(seg1Path, 'x'.repeat(1000) + '\n');

    const v = journal.verify();
    expect(v.ok).toBe(false);
    expect(v.status).toBe('corrupt');
    expect(v.error?.code).toBe('E_JOURNAL_CORRUPT');
    expect(v.error?.message).toContain('exceeds maximum segment bytes');
  });

  it('rejects gaps in segment sequence before appending and during verify', async () => {
    const streamDir = path.join(tempDir, 'segment-gap-stream');
    const journal = new Journal<{ msg: string }>(streamDir, 'gap-stream', {
      maxSegmentBytes: 350,
      maxRecordBytes: 300,
    });
    // Create at least 2 segments
    await journal.append({ kind: 'msg', payload: { msg: 'first' } });
    await journal.append({ kind: 'msg', payload: { msg: 'second' } });
    await journal.append({ kind: 'msg', payload: { msg: 'third' } });

    const head = journal.readHead();
    expect(head?.active_segment).toBe('00000003.jsonl');

    // Simulate missing earlier segment (delete 00000001.jsonl)
    const seg1Path = path.join(streamDir, 'segments', '00000001.jsonl');
    fs.unlinkSync(seg1Path);

    // Verify should detect the gap and return corrupt
    const v = journal.verify();
    expect(v.ok).toBe(false);
    expect(v.status).toBe('corrupt');
    expect(v.error?.code).toBe('E_JOURNAL_CORRUPT');

    // Append should reject the gap and fail with E_JOURNAL_CORRUPT
    await expect(journal.append({ kind: 'msg', payload: { msg: 'fourth' } })).rejects.toThrow('E_JOURNAL_CORRUPT');
  });

  it('recovers and safely completes partial initial initialization', async () => {
    const streamDir = path.join(tempDir, 'partial-init-stream');
    const journal = new Journal<{ msg: string }>(streamDir, 'partial-init');

    // Simulate crash after meta.json and segments dir created, but before head.json
    fs.mkdirSync(path.join(streamDir, 'segments'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(streamDir, 'receipts'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(streamDir, 'quarantine'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(streamDir, 'meta.json'),
      JSON.stringify({
        schema_version: 1,
        stream_id: 'partial-init',
        created_at: new Date().toISOString(),
        max_record_bytes: 65536,
        max_segment_bytes: 2097152,
        max_segment_records: 5000,
        max_stream_records: 100000,
      }),
    );
    // 0-byte initial segment
    fs.writeFileSync(path.join(streamDir, 'segments', '00000001.jsonl'), '');

    // Next init() should safely recover and complete initialization instead of throwing E_JOURNAL_CORRUPT
    const head = journal.init();
    expect(head.stream_id).toBe('partial-init');
    expect(head.head_sequence).toBe(0);
    expect(head.active_segment).toBe('00000001.jsonl');

    // Appending should work normally
    const rec = await journal.append({ kind: 'msg', payload: { msg: 'recovered' } });
    expect(rec.sequence).toBe(1);
    expect(journal.verify().ok).toBe(true);
  });

  it('validates repair receipts and ignores corrupt or forged receipts', async () => {
    const streamDir = path.join(tempDir, 'repair-receipt-validation');
    const journal = new Journal<{ msg: string }>(streamDir, 'receipt-val', {
      maxSegmentBytes: 1000,
      maxRecordBytes: 500,
    });
    await journal.append({ kind: 'msg', payload: { msg: 'first' } });

    // Simulate uncommitted trailing bytes and perform legitimate repair
    const segPath = path.join(streamDir, 'segments', '00000001.jsonl');
    fs.appendFileSync(segPath, '{"broken-tail\n');
    const legitReceipt = await journal.repairIncompleteTail();
    expect(legitReceipt.receipt_sha256).toBeDefined();

    // Verify listReceipts includes the legitimate receipt
    expect(journal.listReceipts()).toHaveLength(1);

    // Plant corrupt receipt (invalid json)
    fs.writeFileSync(path.join(streamDir, 'receipts', 'repair-01-corrupt.json'), '{invalid json');
    // Plant forged receipt (wrong receipt_sha256)
    const forgedReceipt = { ...legitReceipt, receipt_sha256: '0000000000000000000000000000000000000000000000000000000000000000' };
    fs.writeFileSync(path.join(streamDir, 'receipts', 'repair-02-forged.json'), JSON.stringify(forgedReceipt));
    // Plant wrong stream_id receipt
    const wrongStreamReceipt = { ...legitReceipt, stream_id: 'other-stream' };
    fs.writeFileSync(path.join(streamDir, 'receipts', 'repair-03-wrong-stream.json'), JSON.stringify(wrongStreamReceipt));

    // listReceipts should only return the 1 authentic valid receipt
    const filtered = journal.listReceipts();
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.receipt_sha256).toBe(legitReceipt.receipt_sha256);
  });

  it('rejects an invalid active segment for an empty journal during verify', async () => {
    const streamDir = path.join(tempDir, 'empty-invalid-active-seg');
    const journal = new Journal<{ msg: string }>(streamDir, 'empty-active');
    journal.init();

    // Verify initially passes
    expect(journal.verify().ok).toBe(true);

    // Tamper head.json to reference nonexistent later segment (00000002.jsonl) while journal is empty
    const headPath = path.join(streamDir, 'head.json');
    const head = JSON.parse(fs.readFileSync(headPath, 'utf8'));
    head.active_segment = '00000002.jsonl';
    fs.writeFileSync(headPath, JSON.stringify(head));

    // verify() should reject this layout as corrupt with E_JOURNAL_HEAD_MISMATCH
    const v = journal.verify();
    expect(v.ok).toBe(false);
    expect(v.status).toBe('corrupt');
    expect(v.error?.code).toBe('E_JOURNAL_HEAD_MISMATCH');
    expect(v.repairable).toBe(false);

    // append() should also reject the layout as corrupt
    await expect(journal.append({ kind: 'msg', payload: { msg: 'test' } })).rejects.toThrow('E_JOURNAL_CORRUPT');
  });

  it('rejects appends when meta.json is deleted from an existing stream', async () => {
    const streamDir = path.join(tempDir, 'missing-meta-stream');
    const journal = new Journal<{ msg: string }>(streamDir, 'missing-meta');
    await journal.append({ kind: 'msg', payload: { msg: 'initial' } });

    // Stream is valid initially
    expect(journal.verify().ok).toBe(true);

    // Delete meta.json
    const metaPath = path.join(streamDir, 'meta.json');
    fs.unlinkSync(metaPath);
    expect(fs.existsSync(metaPath)).toBe(false);

    // append() must reject with E_JOURNAL_CORRUPT rather than silently using constructor defaults
    await expect(journal.append({ kind: 'msg', payload: { msg: 'second' } })).rejects.toThrow('E_JOURNAL_CORRUPT');
  });

  it('retains repair intent when crashed before truncation, and finishes orphan cleanup when crashed after truncation', async () => {
    const streamDir = path.join(tempDir, 'intent-recovery-stream');
    const journal = new Journal<{ msg: string }>(streamDir, 'intent-stream', {
      maxSegmentBytes: 1000,
      maxRecordBytes: 500,
    });
    await journal.append({ kind: 'msg', payload: { msg: 'first' } });

    // Case 1: Plant an intent where segment was NOT truncated (size > repaired_bytes)
    // Simulates crash after intent write but before truncateSync
    const receiptsDir = path.join(streamDir, 'receipts');
    const seg1Path = path.join(streamDir, 'segments', '00000001.jsonl');
    const originalSize = fs.statSync(seg1Path).size;
    const preTruncateIntentPath = path.join(receiptsDir, 'repair-01.intent.json');
    const preTruncateIntent = {
      store_kind: 'journal_repair_intent',
      stream_id: 'intent-stream',
      repaired_at: new Date().toISOString(),
      segment: '00000001.jsonl',
      original_bytes: originalSize + 50,
      repaired_bytes: 10, // segment is larger than 10
      truncated_bytes: originalSize + 40,
      backup_file: 'backup.bak',
      head_sequence: 1,
      head_digest: journal.readHead()?.head_digest ?? null,
      receipt_sha256: 'abc',
      final_receipt_path: path.join(receiptsDir, 'repair-01.json'),
    };
    fs.writeFileSync(preTruncateIntentPath, JSON.stringify(preTruncateIntent));

    // Calling listReceipts triggers recovery scan. Because segment wasn't truncated, intent must NOT be deleted!
    journal.listReceipts();
    expect(fs.existsSync(preTruncateIntentPath)).toBe(true);
    fs.unlinkSync(preTruncateIntentPath); // clean up pre-truncate test file

    // Case 2: Plant an intent where segment WAS truncated (empty rotated segment 00000002.jsonl)
    // but crash occurred before unlinking 00000002.jsonl or quarantining 00000003.jsonl
    const seg2Path = path.join(streamDir, 'segments', '00000002.jsonl');
    const seg3Path = path.join(streamDir, 'segments', '00000003.jsonl');
    fs.writeFileSync(seg2Path, ''); // 0-byte truncated target segment
    fs.writeFileSync(seg3Path, 'orphan'); // orphan segment created beyond target
    const postTruncateIntentPath = path.join(receiptsDir, 'repair-02.intent.json');
    const finalReceiptPath = path.join(receiptsDir, 'repair-02.json');
    const postTruncateIntent = {
      store_kind: 'journal_repair_intent',
      stream_id: 'intent-stream',
      repaired_at: new Date().toISOString(),
      segment: '00000002.jsonl',
      original_bytes: 50,
      repaired_bytes: 0,
      truncated_bytes: 50,
      backup_file: 'backup2.bak',
      head_sequence: 1,
      head_digest: journal.readHead()?.head_digest ?? null,
      receipt_sha256: 'xyz',
      final_receipt_path: finalReceiptPath,
    };
    fs.writeFileSync(postTruncateIntentPath, JSON.stringify(postTruncateIntent));

    // Recovery must unlink empty seg2, quarantine seg3, publish receipt, and remove intent!
    const receipts = journal.listReceipts();
    expect(receipts.length).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(seg2Path)).toBe(false); // unlinked!
    expect(fs.existsSync(seg3Path)).toBe(false); // unlinked & quarantined!
    expect(fs.existsSync(postTruncateIntentPath)).toBe(false); // intent consumed!
    expect(fs.existsSync(finalReceiptPath)).toBe(true); // final receipt published!
  });

  it('rejects append when active_segment_records is corrupted, and recomputes rotation when omitted', async () => {
    const streamDir = path.join(tempDir, 'active-records-check-stream');
    const journal = new Journal<{ msg: string }>(streamDir, 'active-records-stream', {
      maxSegmentRecords: 2,
    });
    await journal.append({ kind: 'msg', payload: { msg: 'first' } });
    await journal.append({ kind: 'msg', payload: { msg: 'second' } });

    const headPath = path.join(streamDir, 'head.json');
    const originalHead = JSON.parse(fs.readFileSync(headPath, 'utf8'));
    expect(originalHead.active_segment_records).toBe(2);

    // Case 1: Corrupt active_segment_records to 0 (counter tampered/stale)
    // append must reject with E_JOURNAL_CORRUPT rather than committing a 3rd record to a 2-record segment
    fs.writeFileSync(headPath, JSON.stringify({ ...originalHead, active_segment_records: 0 }));
    await expect(journal.append({ kind: 'msg', payload: { msg: 'third' } })).rejects.toThrow('E_JOURNAL_CORRUPT');

    // Case 2: Omitted active_segment_records (e.g. from an older schema)
    // append must recompute actual records (2), rotate because maxSegmentRecords=2, and succeed
    const { active_segment_records: _, ...headWithoutCounter } = originalHead;
    fs.writeFileSync(headPath, JSON.stringify(headWithoutCounter));

    const rec3 = await journal.append({ kind: 'msg', payload: { msg: 'third' } });
    expect(rec3.sequence).toBe(3);

    const newHead = journal.readHead();
    expect(newHead?.active_segment).toBe('00000002.jsonl');
    expect(newHead?.active_segment_records).toBe(1);
    expect(journal.verify().ok).toBe(true);
  });
});



