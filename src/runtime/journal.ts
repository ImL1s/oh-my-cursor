import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, withDirectoryLock, withDirectoryLockSync } from './atomic.js';
import { redact } from './redaction.js';

export interface JournalRecord<T = unknown> {
  readonly schema_version: 1;
  readonly stream_id: string;
  readonly sequence: number;
  readonly kind: string;
  readonly payload: T;
  readonly at: string;
  readonly previous_digest: string | null;
  readonly digest: string;
}

export type JournalRecordInput<T = unknown> = {
  readonly kind: string;
  readonly payload: T;
  readonly at?: string;
};

export interface JournalHead {
  readonly schema_version: 1;
  readonly stream_id: string;
  readonly head_sequence: number;
  readonly head_digest: string | null;
  readonly active_segment: string;
  readonly active_segment_records?: number;
  readonly total_records: number;
  readonly total_bytes: number;
  readonly updated_at: string;
}

export interface JournalHeadFence {
  readonly sequence: number;
  readonly digest: string | null;
}

export interface JournalMeta {
  readonly schema_version: 1;
  readonly stream_id: string;
  readonly created_at: string;
  readonly max_record_bytes: number;
  readonly max_segment_bytes: number;
  readonly max_segment_records: number;
  readonly max_stream_records: number;
}

export interface JournalOptions {
  readonly maxRecordBytes?: number;
  readonly maxSegmentBytes?: number;
  readonly maxSegmentRecords?: number;
  readonly maxStreamRecords?: number;
  readonly redactPayload?: boolean;
  readonly now?: () => Date;
}

export interface JournalRangeOptions {
  readonly fromSequence?: number;
  readonly toSequence?: number;
  readonly limit?: number;
  readonly direction?: 'asc' | 'desc';
}

export type JournalVerificationStatus =
  | 'valid'
  | 'incomplete_tail'
  | 'corrupt'
  | 'absent';

export type JournalErrorCode =
  | 'E_JOURNAL_ABSENT'
  | 'E_JOURNAL_INCOMPLETE_TAIL'
  | 'E_JOURNAL_CORRUPT'
  | 'E_JOURNAL_DIGEST_MISMATCH'
  | 'E_JOURNAL_SEQUENCE_MISMATCH'
  | 'E_JOURNAL_STREAM_MISMATCH'
  | 'E_JOURNAL_UNSUPPORTED_VERSION'
  | 'E_JOURNAL_HEAD_MISMATCH'
  | 'E_JOURNAL_LIMIT'
  | 'E_JOURNAL_RECORD_TOO_LARGE'
  | 'E_JOURNAL_STREAM_ID_INVALID'
  | 'E_JOURNAL_NON_TAIL_CORRUPTION'
  | 'E_JOURNAL_NOT_REPAIRABLE'
  | 'E_JOURNAL_OPTIONS_INCOMPATIBLE';

export interface JournalVerificationError {
  readonly code: JournalErrorCode;
  readonly message: string;
  readonly segment?: string;
  readonly sequence?: number;
  readonly byte_offset?: number;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export interface JournalVerificationResult {
  readonly ok: boolean;
  readonly status: JournalVerificationStatus;
  readonly stream_id: string;
  readonly total_records: number;
  readonly head_sequence: number;
  readonly head_digest: string | null;
  readonly error?: JournalVerificationError;
  readonly repairable: boolean;
  readonly uncommitted_tail_bytes?: number;
}

export interface JournalRepairReceipt {
  readonly schema_version: 1;
  readonly store_kind: 'journal_repair_receipt';
  readonly stream_id: string;
  readonly repaired_at: string;
  readonly segment: string;
  readonly original_bytes: number;
  readonly repaired_bytes: number;
  readonly truncated_bytes: number;
  readonly backup_file: string;
  readonly head_sequence: number;
  readonly head_digest: string | null;
  readonly receipt_sha256: string;
}

export const DEFAULT_MAX_RECORD_BYTES = 64 * 1024; // 64 KiB
export const DEFAULT_MAX_SEGMENT_BYTES = 2 * 1024 * 1024; // 2 MiB
export const DEFAULT_MAX_SEGMENT_RECORDS = 5_000;
export const DEFAULT_MAX_STREAM_RECORDS = 100_000;

const SAFE_STREAM_ID = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,127}$/;

export function assertSafeStreamId(streamId: string): string {
  if (typeof streamId !== 'string' || !SAFE_STREAM_ID.test(streamId) || streamId.includes('..') || path.isAbsolute(streamId)) {
    throw new Error('E_JOURNAL_STREAM_ID_INVALID');
  }
  return streamId;
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function segmentFileName(index: number): string {
  return `${String(index).padStart(8, '0')}.jsonl`;
}

function parseSegmentIndex(fileName: string): number | null {
  const match = /^(\d{8})\.jsonl$/.exec(fileName);
  return match ? parseInt(match[1]!, 10) : null;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  try {
    return new Date(parsed).toISOString() === value;
  } catch {
    return false;
  }
}

export interface JournalLimits {
  readonly maxRecordBytes: number;
  readonly maxSegmentBytes: number;
  readonly maxSegmentRecords: number;
  readonly maxStreamRecords: number;
}

export class Journal<T = unknown> {
  readonly streamDir: string;
  readonly streamId: string;
  private readonly options: JournalOptions;
  private readonly maxRecordBytes: number;
  private readonly maxSegmentBytes: number;
  private readonly maxSegmentRecords: number;
  private readonly maxStreamRecords: number;
  private readonly redactPayload: boolean;
  private readonly now: () => Date;

  constructor(streamDir: string, streamId: string, options: JournalOptions = {}) {
    this.streamDir = path.resolve(streamDir);
    this.streamId = assertSafeStreamId(streamId);
    this.options = options;
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
    this.maxSegmentRecords = options.maxSegmentRecords ?? DEFAULT_MAX_SEGMENT_RECORDS;
    this.maxStreamRecords = options.maxStreamRecords ?? DEFAULT_MAX_STREAM_RECORDS;
    this.redactPayload = options.redactPayload ?? false;
    this.now = options.now ?? (() => new Date());
  }

  private resolveLimits(): JournalLimits {
    const meta = this.readMeta();
    if (meta === null) {
      return {
        maxRecordBytes: this.maxRecordBytes,
        maxSegmentBytes: this.maxSegmentBytes,
        maxSegmentRecords: this.maxSegmentRecords,
        maxStreamRecords: this.maxStreamRecords,
      };
    }

    if (
      (this.options.maxRecordBytes !== undefined && this.options.maxRecordBytes !== meta.max_record_bytes) ||
      (this.options.maxSegmentBytes !== undefined && this.options.maxSegmentBytes !== meta.max_segment_bytes) ||
      (this.options.maxSegmentRecords !== undefined && this.options.maxSegmentRecords !== meta.max_segment_records) ||
      (this.options.maxStreamRecords !== undefined && this.options.maxStreamRecords !== meta.max_stream_records)
    ) {
      throw new Error('E_JOURNAL_OPTIONS_INCOMPATIBLE');
    }

    return {
      maxRecordBytes: meta.max_record_bytes,
      maxSegmentBytes: meta.max_segment_bytes,
      maxSegmentRecords: meta.max_segment_records,
      maxStreamRecords: meta.max_stream_records,
    };
  }

  getLimits(): JournalLimits {
    return this.resolveLimits();
  }

  private metaPath(): string {
    return path.join(this.streamDir, 'meta.json');
  }

  private headPath(): string {
    return path.join(this.streamDir, 'head.json');
  }

  private segmentsDir(): string {
    return path.join(this.streamDir, 'segments');
  }

  private receiptsDir(): string {
    return path.join(this.streamDir, 'receipts');
  }

  private quarantineDir(): string {
    return path.join(this.streamDir, 'quarantine');
  }

  readMeta(): JournalMeta | null {
    const file = this.metaPath();
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<JournalMeta>;
      if (
        parsed.schema_version !== 1 ||
        parsed.stream_id !== this.streamId ||
        !validDate(parsed.created_at) ||
        !Number.isSafeInteger(parsed.max_record_bytes) ||
        !Number.isSafeInteger(parsed.max_segment_bytes) ||
        !Number.isSafeInteger(parsed.max_segment_records) ||
        !Number.isSafeInteger(parsed.max_stream_records)
      ) {
        throw new Error('E_JOURNAL_CORRUPT');
      }
      return parsed as JournalMeta;
    } catch (error) {
      if ((error as Error).message === 'E_JOURNAL_CORRUPT') throw error;
      throw new Error('E_JOURNAL_CORRUPT', { cause: error });
    }
  }

  readHead(): JournalHead | null {
    const file = this.headPath();
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<JournalHead>;
      if (
        parsed.schema_version !== 1 ||
        parsed.stream_id !== this.streamId ||
        !Number.isSafeInteger(parsed.head_sequence) ||
        (parsed.head_sequence as number) < 0 ||
        (parsed.head_sequence === 0 ? parsed.head_digest !== null : typeof parsed.head_digest !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.head_digest)) ||
        typeof parsed.active_segment !== 'string' ||
        parseSegmentIndex(parsed.active_segment) === null ||
        (parsed.active_segment_records !== undefined && (!Number.isSafeInteger(parsed.active_segment_records) || (parsed.active_segment_records as number) < 0)) ||
        !Number.isSafeInteger(parsed.total_records) ||
        !Number.isSafeInteger(parsed.total_bytes) ||
        !validDate(parsed.updated_at)
      ) {
        throw new Error('E_JOURNAL_CORRUPT');
      }
      return parsed as JournalHead;
    } catch (error) {
      if ((error as Error).message === 'E_JOURNAL_CORRUPT') throw error;
      throw new Error('E_JOURNAL_CORRUPT', { cause: error });
    }
  }

  init(): JournalHead {
    return withDirectoryLockSync(this.streamDir, () => this.initUnlocked());
  }

  private initUnlocked(): JournalHead {
    const existingHead = this.readHead();
    if (existingHead !== null) {
      this.resolveLimits();
      return existingHead;
    }

    const now = this.now();
    fs.mkdirSync(this.segmentsDir(), { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.receiptsDir(), { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.quarantineDir(), { recursive: true, mode: 0o700 });

    const meta: JournalMeta = {
      schema_version: 1,
      stream_id: this.streamId,
      created_at: now.toISOString(),
      max_record_bytes: this.maxRecordBytes,
      max_segment_bytes: this.maxSegmentBytes,
      max_segment_records: this.maxSegmentRecords,
      max_stream_records: this.maxStreamRecords,
    };
    atomicWriteJson(this.metaPath(), meta);

    const initialSegment = segmentFileName(1);
    const initialSegmentPath = path.join(this.segmentsDir(), initialSegment);
    if (!fs.existsSync(initialSegmentPath)) {
      fs.writeFileSync(initialSegmentPath, '', { mode: 0o600 });
    }

    const head: JournalHead = {
      schema_version: 1,
      stream_id: this.streamId,
      head_sequence: 0,
      head_digest: null,
      active_segment: initialSegment,
      active_segment_records: 0,
      total_records: 0,
      total_bytes: 0,
      updated_at: now.toISOString(),
    };
    atomicWriteJson(this.headPath(), head);
    return head;
  }

  async append(
    input: JournalRecordInput<T>,
    expectedHead?: JournalHeadFence,
  ): Promise<JournalRecord<T>> {
    if (typeof input.kind !== 'string' || input.kind.trim() === '') {
      throw new Error('E_JOURNAL_RECORD_INVALID');
    }

    return withDirectoryLock(this.streamDir, () => {
      let head = this.readHead();
      if (head === null) {
        head = this.initUnlocked();
      }

      const limits = this.resolveLimits();

      if (expectedHead !== undefined) {
        if (head.head_sequence !== expectedHead.sequence || head.head_digest !== expectedHead.digest) {
          throw new Error('E_JOURNAL_HEAD_MISMATCH');
        }
      }

      if (head.total_records >= limits.maxStreamRecords) {
        throw new Error('E_JOURNAL_LIMIT');
      }

      const sequence = head.head_sequence + 1;
      const at = input.at !== undefined && validDate(input.at) ? input.at : this.now().toISOString();
      const payload = this.redactPayload ? (redact(input.payload) as T) : input.payload;

      const recordMaterial = {
        schema_version: 1 as const,
        stream_id: this.streamId,
        sequence,
        kind: input.kind,
        payload,
        at,
        previous_digest: head.head_digest,
      };
      const digest = sha256(canonicalJson(recordMaterial));
      const record: JournalRecord<T> = {
        ...recordMaterial,
        digest,
      };

      const line = `${canonicalJson(record)}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (lineBytes > limits.maxRecordBytes) {
        throw new Error('E_JOURNAL_RECORD_TOO_LARGE');
      }

      fs.mkdirSync(this.segmentsDir(), { recursive: true, mode: 0o700 });
      let activeSegment = head.active_segment;
      let activeSegmentPath = path.join(this.segmentsDir(), activeSegment);

      let currentSegmentBytes = fs.existsSync(activeSegmentPath) ? fs.statSync(activeSegmentPath).size : 0;
      let currentSegmentRecords = typeof head.active_segment_records === 'number'
        ? head.active_segment_records
        : (fs.existsSync(activeSegmentPath) ? fs.readFileSync(activeSegmentPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).length : 0);
      let activeSegmentIndex = parseSegmentIndex(activeSegment) ?? 1;

      // Check if rotation is needed by byte limit or record limit
      if (
        (currentSegmentBytes > 0 && currentSegmentBytes + lineBytes > limits.maxSegmentBytes) ||
        (currentSegmentRecords > 0 && currentSegmentRecords >= limits.maxSegmentRecords)
      ) {
        activeSegmentIndex += 1;
        activeSegment = segmentFileName(activeSegmentIndex);
        activeSegmentPath = path.join(this.segmentsDir(), activeSegment);
        currentSegmentBytes = 0;
        currentSegmentRecords = 0;
      }

      // Append and fsync active segment file before updating head
      const fd = fs.openSync(activeSegmentPath, 'a', 0o600);
      try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(activeSegmentPath, 0o600);

      const nextHead: JournalHead = {
        schema_version: 1,
        stream_id: this.streamId,
        head_sequence: sequence,
        head_digest: digest,
        active_segment: activeSegment,
        active_segment_records: currentSegmentRecords + 1,
        total_records: head.total_records + 1,
        total_bytes: head.total_bytes + lineBytes,
        updated_at: this.now().toISOString(),
      };
      atomicWriteJson(this.headPath(), nextHead);

      return record;
    });
  }

  private listSegments(): string[] {
    const segmentsDir = this.segmentsDir();
    if (!fs.existsSync(segmentsDir)) return [];
    return fs
      .readdirSync(segmentsDir)
      .filter((name) => parseSegmentIndex(name) !== null)
      .sort();
  }

  tail(limit = 10): JournalRecord<T>[] {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    const head = this.readHead();
    if (head === null || head.head_sequence === 0) return [];

    const segments = this.listSegments();
    if (segments.length === 0) return [];

    const collected: JournalRecord<T>[] = [];
    // Read backwards through segments until limit is met
    for (let i = segments.length - 1; i >= 0 && collected.length < limit; i--) {
      const segmentFile = path.join(this.segmentsDir(), segments[i]!);
      if (!fs.existsSync(segmentFile)) continue;
      const content = fs.readFileSync(segmentFile, 'utf8');
      const lines = content.trim().split(/\r?\n/).filter(Boolean);
      for (let j = lines.length - 1; j >= 0 && collected.length < limit; j--) {
        try {
          const record = JSON.parse(lines[j]!) as JournalRecord<T>;
          // Only collect records up to head_sequence (fence uncommitted tail)
          if (record.sequence <= head.head_sequence) {
            collected.push(record);
          }
        } catch {
          // Skip unparseable lines in tail view
        }
      }
    }

    // Since we collected backwards, reverse to preserve chronological order
    return collected.reverse();
  }

  readRange(options: JournalRangeOptions = {}): JournalRecord<T>[] {
    const head = this.readHead();
    if (head === null || head.head_sequence === 0) return [];

    const fromSequence = Math.max(1, options.fromSequence ?? 1);
    const toSequence = Math.min(head.head_sequence, options.toSequence ?? head.head_sequence);
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    const direction = options.direction ?? 'asc';

    if (fromSequence > toSequence || limit <= 0) return [];

    const segments = this.listSegments();
    const records: JournalRecord<T>[] = [];

    if (direction === 'desc') {
      for (let i = segments.length - 1; i >= 0 && records.length < limit; i--) {
        const segmentPath = path.join(this.segmentsDir(), segments[i]!);
        if (!fs.existsSync(segmentPath)) continue;
        const content = fs.readFileSync(segmentPath, 'utf8');
        const lines = content.trim().split(/\r?\n/).filter(Boolean);

        for (let j = lines.length - 1; j >= 0 && records.length < limit; j--) {
          try {
            const record = JSON.parse(lines[j]!) as JournalRecord<T>;
            if (record.sequence >= fromSequence && record.sequence <= toSequence) {
              records.push(record);
            }
          } catch {
            // ignore bad lines during range read
          }
        }
      }
      return records;
    }

    for (const segment of segments) {
      if (records.length >= limit) break;
      const segmentPath = path.join(this.segmentsDir(), segment);
      if (!fs.existsSync(segmentPath)) continue;
      const content = fs.readFileSync(segmentPath, 'utf8');
      const lines = content.trim().split(/\r?\n/).filter(Boolean);

      for (const line of lines) {
        if (records.length >= limit) break;
        try {
          const record = JSON.parse(line) as JournalRecord<T>;
          if (record.sequence >= fromSequence && record.sequence <= toSequence) {
            records.push(record);
          }
        } catch {
          // ignore bad lines during range read
        }
      }
    }

    return records;
  }

  verify(): JournalVerificationResult {
    if (!fs.existsSync(this.streamDir)) {
      return {
        ok: false,
        status: 'absent',
        stream_id: this.streamId,
        total_records: 0,
        head_sequence: 0,
        head_digest: null,
        error: { code: 'E_JOURNAL_ABSENT', message: 'Stream directory does not exist' },
        repairable: false,
      };
    }

    let meta: JournalMeta;
    try {
      const read = this.readMeta();
      if (read === null) {
        return {
          ok: false,
          status: 'absent',
          stream_id: this.streamId,
          total_records: 0,
          head_sequence: 0,
          head_digest: null,
          error: { code: 'E_JOURNAL_ABSENT', message: 'meta.json is missing' },
          repairable: false,
        };
      }
      meta = read;
    } catch (error) {
      return {
        ok: false,
        status: 'corrupt',
        stream_id: this.streamId,
        total_records: 0,
        head_sequence: 0,
        head_digest: null,
        error: { code: 'E_JOURNAL_CORRUPT', message: `meta.json is corrupt: ${(error as Error).message}` },
        repairable: false,
      };
    }

    let head: JournalHead;
    try {
      const read = this.readHead();
      if (read === null) {
        return {
          ok: false,
          status: 'absent',
          stream_id: this.streamId,
          total_records: 0,
          head_sequence: 0,
          head_digest: null,
          error: { code: 'E_JOURNAL_ABSENT', message: 'head.json is missing' },
          repairable: false,
        };
      }
      head = read;
    } catch (error) {
      return {
        ok: false,
        status: 'corrupt',
        stream_id: this.streamId,
        total_records: 0,
        head_sequence: 0,
        head_digest: null,
        error: { code: 'E_JOURNAL_CORRUPT', message: `head.json is corrupt: ${(error as Error).message}` },
        repairable: false,
      };
    }

    const segments = this.listSegments();
    if (segments.length === 0) {
      if (head.head_sequence === 0) {
        if (
          head.total_records !== 0 ||
          head.total_bytes !== 0 ||
          (head.active_segment_records !== undefined && head.active_segment_records !== 0)
        ) {
          return {
            ok: false,
            status: 'corrupt',
            stream_id: this.streamId,
            total_records: 0,
            head_sequence: 0,
            head_digest: null,
            error: {
              code: 'E_JOURNAL_HEAD_MISMATCH',
              message: 'Head counters nonzero for empty stream',
            },
            repairable: false,
          };
        }
        return {
          ok: true,
          status: 'valid',
          stream_id: this.streamId,
          total_records: 0,
          head_sequence: 0,
          head_digest: null,
          repairable: false,
        };
      }
      return {
        ok: false,
        status: 'corrupt',
        stream_id: this.streamId,
        total_records: 0,
        head_sequence: head.head_sequence,
        head_digest: head.head_digest,
        error: { code: 'E_JOURNAL_HEAD_MISMATCH', message: 'No segment files present but head sequence > 0' },
        repairable: false,
      };
    }

    let expectedSeq = 1;
    let expectedPreviousDigest: string | null = null;
    let totalValid = 0;
    let lastValidCommittedByteOffset = 0;
    let firstUncommittedSegment: string | null = null;
    let firstUncommittedByteOffset: number | null = null;
    let incompleteTailSegment: string | null = null;
    let incompleteTailByteOffset: number | null = null;
    let scannedTotalBytes = 0;
    let scannedActiveSegmentRecords = 0;
    let lastCommittedSegment: string | null = null;

    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const segName = segments[segIdx]!;
      const segPath = path.join(this.segmentsDir(), segName);
      const isLastSegment = segIdx === segments.length - 1;
      const buffer = fs.readFileSync(segPath);
      let offset = 0;

      while (offset < buffer.length) {
        const nextNewline = buffer.indexOf(0x0a, offset);
        const lineBytes = nextNewline === -1 ? buffer.subarray(offset) : buffer.subarray(offset, nextNewline);
        const lineLength = nextNewline === -1 ? buffer.length - offset : nextNewline + 1 - offset;

        if (nextNewline === -1) {
          // File ended without newline
          if (isLastSegment && totalValid >= head.head_sequence) {
            incompleteTailSegment = segName;
            incompleteTailByteOffset = offset;
            return {
              ok: false,
              status: 'incomplete_tail',
              stream_id: this.streamId,
              total_records: totalValid,
              head_sequence: head.head_sequence,
              head_digest: head.head_digest,
              error: {
                code: 'E_JOURNAL_INCOMPLETE_TAIL',
                message: 'Active segment has un-terminated trailing line',
                segment: segName,
                byte_offset: offset,
              },
              repairable: true,
              uncommitted_tail_bytes: buffer.length - offset,
            };
          } else {
            return {
              ok: false,
              status: 'corrupt',
              stream_id: this.streamId,
              total_records: totalValid,
              head_sequence: head.head_sequence,
              head_digest: head.head_digest,
              error: {
                code: 'E_JOURNAL_CORRUPT',
                message: isLastSegment
                  ? 'Committed record in active segment is missing trailing newline'
                  : 'Non-active segment is missing trailing newline',
                segment: segName,
                byte_offset: offset,
              },
              repairable: false,
            };
          }
        }

        const lineStr = lineBytes.toString('utf8');
        if (lineStr.trim() === '') {
          // Empty line
          if (isLastSegment && offset + lineLength === buffer.length) {
            // Trailing extra newline
            offset += lineLength;
            continue;
          }
          return {
            ok: false,
            status: 'corrupt',
            stream_id: this.streamId,
            total_records: totalValid,
            head_sequence: head.head_sequence,
            head_digest: head.head_digest,
            error: {
              code: 'E_JOURNAL_CORRUPT',
              message: 'Blank line detected in segment',
              segment: segName,
              byte_offset: offset,
            },
            repairable: false,
          };
        }

        let record: JournalRecord<T>;
        try {
          record = JSON.parse(lineStr) as JournalRecord<T>;
        } catch (jsonErr) {
          if (isLastSegment && nextNewline + 1 === buffer.length && totalValid >= head.head_sequence) {
            // Uncommitted last line of active segment is invalid JSON
            return {
              ok: false,
              status: 'incomplete_tail',
              stream_id: this.streamId,
              total_records: totalValid,
              head_sequence: head.head_sequence,
              head_digest: head.head_digest,
              error: {
                code: 'E_JOURNAL_INCOMPLETE_TAIL',
                message: 'Active segment tail contains invalid JSON line',
                segment: segName,
                byte_offset: offset,
              },
              repairable: true,
              uncommitted_tail_bytes: buffer.length - offset,
            };
          }
          return {
            ok: false,
            status: 'corrupt',
            stream_id: this.streamId,
            total_records: totalValid,
            head_sequence: head.head_sequence,
            head_digest: head.head_digest,
            error: {
              code: 'E_JOURNAL_CORRUPT',
              message: 'Corrupt JSON in segment',
              segment: segName,
              sequence: expectedSeq,
              byte_offset: offset,
            },
            repairable: false,
          };
        }

        if (
          typeof record !== 'object' ||
          record === null ||
          typeof (record as any).sequence !== 'number'
        ) {
          return {
            ok: false,
            status: 'corrupt',
            stream_id: this.streamId,
            total_records: totalValid,
            head_sequence: head.head_sequence,
            head_digest: head.head_digest,
            error: {
              code: 'E_JOURNAL_CORRUPT',
              message: 'Malformed record in segment: missing required sequence number',
              segment: segName,
              sequence: expectedSeq,
              byte_offset: offset,
            },
            repairable: false,
          };
        }

        if (record.schema_version !== 1) {
          return {
            ok: false,
            status: 'corrupt',
            stream_id: this.streamId,
            total_records: totalValid,
            head_sequence: head.head_sequence,
            head_digest: head.head_digest,
            error: {
              code: 'E_JOURNAL_UNSUPPORTED_VERSION',
              message: `Unsupported record schema version: ${record.schema_version}`,
              segment: segName,
              sequence: record.sequence ?? expectedSeq,
              byte_offset: offset,
            },
            repairable: false,
          };
        }

        if (record.stream_id !== this.streamId) {
          return {
            ok: false,
            status: 'corrupt',
            stream_id: this.streamId,
            total_records: totalValid,
            head_sequence: head.head_sequence,
            head_digest: head.head_digest,
            error: {
              code: 'E_JOURNAL_STREAM_MISMATCH',
              message: `Stream ID mismatch: expected ${this.streamId}, got ${record.stream_id}`,
              segment: segName,
              sequence: record.sequence,
              byte_offset: offset,
            },
            repairable: false,
          };
        }

        if (record.sequence !== expectedSeq) {
          return {
            ok: false,
            status: 'corrupt',
            stream_id: this.streamId,
            total_records: totalValid,
            head_sequence: head.head_sequence,
            head_digest: head.head_digest,
            error: {
              code: 'E_JOURNAL_SEQUENCE_MISMATCH',
              message: `Sequence mismatch: expected ${expectedSeq}, got ${record.sequence}`,
              segment: segName,
              sequence: record.sequence,
              byte_offset: offset,
            },
            repairable: false,
          };
        }

        if (record.previous_digest !== expectedPreviousDigest) {
          return {
            ok: false,
            status: 'corrupt',
            stream_id: this.streamId,
            total_records: totalValid,
            head_sequence: head.head_sequence,
            head_digest: head.head_digest,
            error: {
              code: 'E_JOURNAL_DIGEST_MISMATCH',
              message: `Previous digest mismatch at sequence ${record.sequence}`,
              segment: segName,
              sequence: record.sequence,
              byte_offset: offset,
            },
            repairable: false,
          };
        }

        const { digest: claimedDigest, ...material } = record;
        const computedDigest = sha256(canonicalJson(material));
        if (claimedDigest !== computedDigest) {
          return {
            ok: false,
            status: 'corrupt',
            stream_id: this.streamId,
            total_records: totalValid,
            head_sequence: head.head_sequence,
            head_digest: head.head_digest,
            error: {
              code: 'E_JOURNAL_DIGEST_MISMATCH',
              message: `Record digest mismatch at sequence ${record.sequence}`,
              segment: segName,
              sequence: record.sequence,
              byte_offset: offset,
            },
            repairable: false,
          };
        }

        if (!validDate(record.at)) {
          return {
            ok: false,
            status: 'corrupt',
            stream_id: this.streamId,
            total_records: totalValid,
            head_sequence: head.head_sequence,
            head_digest: head.head_digest,
            error: {
              code: 'E_JOURNAL_CORRUPT',
              message: `Invalid record timestamp at sequence ${record.sequence}`,
              segment: segName,
              sequence: record.sequence,
              byte_offset: offset,
            },
            repairable: false,
          };
        }

        const recordStartOffset = offset;
        expectedPreviousDigest = record.digest;
        expectedSeq++;
        totalValid++;
        offset += lineLength;

        if (record.sequence <= head.head_sequence) {
          scannedTotalBytes += lineLength;
          lastCommittedSegment = segName;
          if (segName === head.active_segment) {
            scannedActiveSegmentRecords++;
          }
        }

        if (record.sequence === head.head_sequence) {
          lastValidCommittedByteOffset = offset;
        }
        if (record.sequence === head.head_sequence + 1 && firstUncommittedSegment === null) {
          firstUncommittedSegment = segName;
          firstUncommittedByteOffset = recordStartOffset;
        }
      }
    }

    // Now compare scanned total against head.json
    if (totalValid === head.head_sequence) {
      if (head.head_sequence > 0 && head.head_digest !== expectedPreviousDigest) {
        return {
          ok: false,
          status: 'corrupt',
          stream_id: this.streamId,
          total_records: totalValid,
          head_sequence: head.head_sequence,
          head_digest: head.head_digest,
          error: {
            code: 'E_JOURNAL_HEAD_MISMATCH',
            message: `Head digest mismatch: head has ${head.head_digest}, records compute ${expectedPreviousDigest}`,
          },
          repairable: false,
        };
      }

      if (head.total_records !== totalValid) {
        return {
          ok: false,
          status: 'corrupt',
          stream_id: this.streamId,
          total_records: totalValid,
          head_sequence: head.head_sequence,
          head_digest: head.head_digest,
          error: {
            code: 'E_JOURNAL_HEAD_MISMATCH',
            message: `Head total_records mismatch: head has ${head.total_records}, scanned ${totalValid}`,
          },
          repairable: false,
        };
      }

      if (head.total_bytes !== scannedTotalBytes) {
        return {
          ok: false,
          status: 'corrupt',
          stream_id: this.streamId,
          total_records: totalValid,
          head_sequence: head.head_sequence,
          head_digest: head.head_digest,
          error: {
            code: 'E_JOURNAL_HEAD_MISMATCH',
            message: `Head total_bytes mismatch: head has ${head.total_bytes}, scanned ${scannedTotalBytes}`,
          },
          repairable: false,
        };
      }

      if (head.head_sequence > 0 && lastCommittedSegment !== null && head.active_segment !== lastCommittedSegment) {
        return {
          ok: false,
          status: 'corrupt',
          stream_id: this.streamId,
          total_records: totalValid,
          head_sequence: head.head_sequence,
          head_digest: head.head_digest,
          error: {
            code: 'E_JOURNAL_HEAD_MISMATCH',
            message: `Head active_segment mismatch: head has ${head.active_segment}, scanned last committed segment is ${lastCommittedSegment}`,
          },
          repairable: false,
        };
      }

      if (head.active_segment_records !== undefined && head.active_segment_records !== scannedActiveSegmentRecords) {
        return {
          ok: false,
          status: 'corrupt',
          stream_id: this.streamId,
          total_records: totalValid,
          head_sequence: head.head_sequence,
          head_digest: head.head_digest,
          error: {
            code: 'E_JOURNAL_HEAD_MISMATCH',
            message: `Head active_segment_records mismatch: head has ${head.active_segment_records}, scanned ${scannedActiveSegmentRecords}`,
          },
          repairable: false,
        };
      }

      return {
        ok: true,
        status: 'valid',
        stream_id: this.streamId,
        total_records: totalValid,
        head_sequence: head.head_sequence,
        head_digest: head.head_digest,
        repairable: false,
      };
    }

    if (totalValid > head.head_sequence) {
      // Uncommitted records exist in active segment or rotated segment
      const tailSegment = firstUncommittedSegment ?? head.active_segment;
      const tailByteOffset = firstUncommittedByteOffset ?? lastValidCommittedByteOffset;
      const tailSegPath = path.join(this.segmentsDir(), tailSegment);
      const tailSize = fs.existsSync(tailSegPath) ? fs.statSync(tailSegPath).size : 0;
      return {
        ok: false,
        status: 'incomplete_tail',
        stream_id: this.streamId,
        total_records: totalValid,
        head_sequence: head.head_sequence,
        head_digest: head.head_digest,
        error: {
          code: 'E_JOURNAL_INCOMPLETE_TAIL',
          message: `Uncommitted tail records detected: stream has ${totalValid} records, head committed ${head.head_sequence}`,
          segment: tailSegment,
          byte_offset: tailByteOffset,
        },
        repairable: true,
        uncommitted_tail_bytes: tailSize - tailByteOffset,
      };
    }

    // totalValid < head.head_sequence
    return {
      ok: false,
      status: 'corrupt',
      stream_id: this.streamId,
      total_records: totalValid,
      head_sequence: head.head_sequence,
      head_digest: head.head_digest,
      error: {
        code: 'E_JOURNAL_HEAD_MISMATCH',
        message: `Head sequence ${head.head_sequence} points beyond scanned records (${totalValid})`,
      },
      repairable: false,
    };
  }

  async repairIncompleteTail(options: { readonly operator?: string } = {}): Promise<JournalRepairReceipt> {
    return withDirectoryLock(this.streamDir, () => {
      const verification = this.verify();
      if (verification.status === 'valid') {
        throw new Error('E_JOURNAL_NOT_REPAIRABLE');
      }
      if (verification.status === 'absent') {
        throw new Error('E_JOURNAL_ABSENT');
      }
      if (verification.status === 'corrupt') {
        throw new Error('E_JOURNAL_NON_TAIL_CORRUPTION');
      }

      if (verification.status !== 'incomplete_tail' || !verification.error?.segment || verification.error.byte_offset === undefined) {
        throw new Error('E_JOURNAL_NOT_REPAIRABLE');
      }

      const segment = verification.error.segment;
      const byteOffset = verification.error.byte_offset;
      const segmentPath = path.join(this.segmentsDir(), segment);

      if (!fs.existsSync(segmentPath)) {
        throw new Error('E_JOURNAL_CORRUPT');
      }

      const originalBytes = fs.statSync(segmentPath).size;
      const repairedBytes = byteOffset;
      const truncatedBytes = originalBytes - repairedBytes;

      fs.mkdirSync(this.quarantineDir(), { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.receiptsDir(), { recursive: true, mode: 0o700 });

      const timestamp = this.now().getTime();
      const backupFile = path.join(this.quarantineDir(), `${segment}.tail-corrupt-${timestamp}`);
      fs.copyFileSync(segmentPath, backupFile);

      // Truncate the segment to the last valid committed byte offset
      fs.truncateSync(segmentPath, repairedBytes);

      const head = this.readHead()!;
      const headActiveIndex = parseSegmentIndex(head.active_segment) ?? 1;
      const targetSegIndex = parseSegmentIndex(segment);

      // If segment is empty and was created beyond head.active_segment, unlink it so no orphaned segment remains
      if (targetSegIndex !== null && targetSegIndex > headActiveIndex && repairedBytes === 0) {
        if (fs.existsSync(segmentPath)) {
          fs.unlinkSync(segmentPath);
        }
      }

      // If there are segments created after this target segment or after head.active_segment, quarantine and unlink them
      const allSegments = this.listSegments();
      for (const seg of allSegments) {
        const idx = parseSegmentIndex(seg);
        if (idx !== null && ((targetSegIndex !== null && idx > targetSegIndex) || idx > headActiveIndex)) {
          const extraPath = path.join(this.segmentsDir(), seg);
          if (fs.existsSync(extraPath)) {
            const extraBackup = path.join(this.quarantineDir(), `${seg}.orphaned-${timestamp}`);
            fs.copyFileSync(extraPath, extraBackup);
            fs.unlinkSync(extraPath);
          }
        }
      }
      const receiptMaterial = {
        schema_version: 1 as const,
        store_kind: 'journal_repair_receipt' as const,
        stream_id: this.streamId,
        repaired_at: this.now().toISOString(),
        segment,
        original_bytes: originalBytes,
        repaired_bytes: repairedBytes,
        truncated_bytes: truncatedBytes,
        backup_file: backupFile,
        head_sequence: head.head_sequence,
        head_digest: head.head_digest,
      };

      const receiptSha256 = sha256(canonicalJson(receiptMaterial));
      const receipt: JournalRepairReceipt = {
        ...receiptMaterial,
        receipt_sha256: receiptSha256,
      };

      const receiptPath = path.join(this.receiptsDir(), `repair-${timestamp}.json`);
      atomicWriteJson(receiptPath, receipt);

      return receipt;
    });
  }
}
