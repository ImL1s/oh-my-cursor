import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { atomicWriteJson } from '../runtime/atomic.js';
import { redact, redactText } from '../runtime/redaction.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';
import {
  MAX_LINE_BYTES,
  MAX_SOURCE_BYTES,
  MAX_TAIL_BYTES,
  RECOVERY_LINE_LIMIT,
  RECOVERY_SCHEMA_VERSION,
  type RecoveryOptions,
  type RecoverySnapshot,
  type RecoverySnapshotV1,
  type RecoverySnapshotV2,
  type RecoverySummary,
  type RecoveryWarning,
  type RecoveryWarningCode,
  recoverySummary,
  validateRecovery,
} from './schema.js';

export {
  MAX_LINE_BYTES,
  MAX_SOURCE_BYTES,
  MAX_TAIL_BYTES,
  RECOVERY_LINE_LIMIT,
  RECOVERY_SCHEMA_VERSION,
  type RecoveryOptions,
  type RecoverySnapshot,
  type RecoverySnapshotV1,
  type RecoverySnapshotV2,
  type RecoverySummary,
  type RecoveryWarning,
  type RecoveryWarningCode,
  recoverySummary,
  validateRecovery,
};

function explicitSource(options: RecoveryOptions): string {
  const candidates = [options.transcriptPath, options.projectJsonlPath].filter((v): v is string => v !== undefined);
  if (candidates.length !== 1) throw new Error('E_RECOVERY_EXPLICIT_SOURCE_REQUIRED');
  if (!path.isAbsolute(candidates[0]!)) throw new Error('E_RECOVERY_SOURCE_NOT_ABSOLUTE');
  return path.resolve(candidates[0]!);
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('E_RECOVERY_ID_INVALID');
  return value;
}

function digest(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function immutableFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o400) throw new Error('E_RECOVERY_INVALID');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('E_RECOVERY_INVALID');
}

function privateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) throw new Error('E_RECOVERY_INVALID');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('E_RECOVERY_INVALID');
}

class LineRingBuffer {
  private readonly buffer: Array<{ raw: string; unterminated: boolean; bytes: number; spilled: boolean }>;
  private head = 0;
  private count = 0;
  private _totalBytes = 0;
  private _inMemoryBytes = 0;

  constructor(public readonly capacity: number, public readonly maxBytes: number = MAX_TAIL_BYTES) {
    this.buffer = new Array(capacity);
  }

  push(raw: string, unterminated: boolean): void {
    const bytes = Buffer.byteLength(raw);

    if (this.count === this.capacity) {
      const oldest = this.buffer[this.head]!;
      this._totalBytes -= oldest.bytes;
      if (!oldest.spilled) {
        this._inMemoryBytes -= oldest.bytes;
      }
      this.head = (this.head + 1) % this.capacity;
      this.count--;
    }

    const index = (this.head + this.count) % this.capacity;
    this.buffer[index] = { raw, unterminated, bytes, spilled: false };
    this.count++;
    this._totalBytes += bytes;
    this._inMemoryBytes += bytes;

    // Bound in-memory storage: spill oldest provisional records if heap footprint exceeds maxBytes
    if (this._inMemoryBytes > this.maxBytes) {
      for (let i = 0; i < this.count && this._inMemoryBytes > this.maxBytes; i++) {
        const slot = (this.head + i) % this.capacity;
        const entry = this.buffer[slot]!;
        if (!entry.spilled) {
          entry.raw = '';
          entry.spilled = true;
          this._inMemoryBytes -= entry.bytes;
        }
      }
    }
  }

  toArray(): Array<{ raw: string; unterminated: boolean }> {
    const res: Array<{ raw: string; unterminated: boolean }> = [];
    for (let i = 0; i < this.count; i++) {
      const entry = this.buffer[(this.head + i) % this.capacity]!;
      res.push({ raw: entry.raw, unterminated: entry.unterminated });
    }
    return res;
  }

  get length(): number {
    return this.count;
  }

  get totalBytes(): number {
    return this._totalBytes;
  }

  get inMemoryBytes(): number {
    return this._inMemoryBytes;
  }

  get hasSpilled(): boolean {
    for (let i = 0; i < this.count; i++) {
      if (this.buffer[(this.head + i) % this.capacity]!.spilled) return true;
    }
    return false;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function candidateRepresentations(id: string): string[] {
  const set = new Set<string>();
  if (id.length > 0) set.add(id);
  try {
    const encoded = JSON.stringify(id).slice(1, -1);
    if (encoded.length > 0) set.add(encoded);
  } catch {
    // ignore
  }
  return Array.from(set);
}

function lineMatchesParent(lineStr: string, parent: string): boolean {
  if (lineStr.includes(parent)) return true;
  try {
    const encoded = JSON.stringify(parent).slice(1, -1);
    return lineStr.includes(encoded);
  } catch {
    return false;
  }
}

function truncateToUtf8Bytes(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  if (end < maxBytes) {
    const lead = buf[end]!;
    let seqLen = 1;
    if ((lead & 0xe0) === 0xc0) seqLen = 2;
    else if ((lead & 0xf0) === 0xe0) seqLen = 3;
    else if ((lead & 0xf8) === 0xf0) seqLen = 4;
    if (end + seqLen > maxBytes) {
      return buf.toString('utf8', 0, end);
    }
  }
  return buf.toString('utf8', 0, maxBytes);
}

function buildCandidatesRegex(candidates: Set<string>): RegExp | null {
  const list = Array.from(candidates).flatMap(candidateRepresentations).filter((c) => c.length > 0);
  if (list.length === 0) return null;
  return new RegExp(list.map(escapeRegex).join('|'));
}

function extractIdFromLine(line: string): { validId: string | null; malformed: boolean } {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const id = [record.id, record.uuid, record.message_id].find((v): v is string => typeof v === 'string');
      return { validId: id ?? null, malformed: false };
    }
    return { validId: null, malformed: false };
  } catch {
    return { validId: null, malformed: true };
  }
}

/** Copies only the bounded tail of an explicitly supplied JSONL file into immutable project state. */
export function recoverCursorSession(root: StateRoot, options: RecoveryOptions): RecoverySnapshot {
  const source = explicitSource(options);

  // Validate path and open file descriptor
  const lstatBefore = fs.lstatSync(source);
  if (!lstatBefore.isFile() || lstatBefore.isSymbolicLink()) throw new Error('E_RECOVERY_SOURCE_UNSAFE');
  if (lstatBefore.size > MAX_SOURCE_BYTES) throw new Error('E_RECOVERY_SOURCE_TOO_LARGE');

  const fd = fs.openSync(source, 'r');
  let beforeStat: fs.Stats;
  let sourceLines = 0;
  let bytesReadTotal = 0;
  const hasher = crypto.createHash('sha256');
  const ringBuffer = new LineRingBuffer(RECOVERY_LINE_LIMIT);

  try {
    beforeStat = fs.fstatSync(fd);
    if (beforeStat.dev !== lstatBefore.dev || beforeStat.ino !== lstatBefore.ino) {
      throw new Error('E_RECOVERY_SOURCE_UNSAFE');
    }
    if (beforeStat.size > MAX_SOURCE_BYTES) {
      throw new Error('E_RECOVERY_SOURCE_TOO_LARGE');
    }

    const chunkBuffer = Buffer.alloc(64 * 1024);
    const decoder = new StringDecoder('utf8');
    let remainder = '';
    let discardingOversized = false;

    while (true) {
      const bytesRead = fs.readSync(fd, chunkBuffer, 0, chunkBuffer.length, null);
      if (bytesRead === 0) break;

      bytesReadTotal += bytesRead;
      if (bytesReadTotal > MAX_SOURCE_BYTES) {
        throw new Error('E_RECOVERY_SOURCE_TOO_LARGE');
      }

      hasher.update(chunkBuffer.subarray(0, bytesRead));
      let chunkText = decoder.write(chunkBuffer.subarray(0, bytesRead));

      if (discardingOversized) {
        const nl = chunkText.indexOf('\n');
        if (nl === -1) {
          continue;
        }
        discardingOversized = false;
        sourceLines++;
        ringBuffer.push(remainder, false);
        remainder = '';
        chunkText = chunkText.slice(nl + 1);
      }

      remainder += chunkText;

      let newlineIndex: number;
      while ((newlineIndex = remainder.indexOf('\n')) !== -1) {
        let lineStr = remainder.slice(0, newlineIndex);
        if (lineStr.endsWith('\r')) lineStr = lineStr.slice(0, -1);
        remainder = remainder.slice(newlineIndex + 1);
        sourceLines++;
        if (Buffer.byteLength(lineStr, 'utf8') > MAX_LINE_BYTES) {
          lineStr = truncateToUtf8Bytes(lineStr, MAX_LINE_BYTES);
        }
        ringBuffer.push(lineStr, false);
      }

      if (Buffer.byteLength(remainder, 'utf8') > MAX_LINE_BYTES) {
        remainder = truncateToUtf8Bytes(remainder, MAX_LINE_BYTES);
        discardingOversized = true;
      }
    }

    const finalChunk = decoder.end();
    let textToProcess = finalChunk;
    if (discardingOversized) {
      const nl = textToProcess.indexOf('\n');
      if (nl !== -1) {
        discardingOversized = false;
        sourceLines++;
        ringBuffer.push(remainder, false);
        remainder = '';
        textToProcess = textToProcess.slice(nl + 1);
      }
    }

    remainder += textToProcess;
    let newlineIndex: number;
    while ((newlineIndex = remainder.indexOf('\n')) !== -1) {
      let lineStr = remainder.slice(0, newlineIndex);
      if (lineStr.endsWith('\r')) lineStr = lineStr.slice(0, -1);
      remainder = remainder.slice(newlineIndex + 1);
      sourceLines++;
      if (Buffer.byteLength(lineStr, 'utf8') > MAX_LINE_BYTES) {
        lineStr = truncateToUtf8Bytes(lineStr, MAX_LINE_BYTES);
      }
      ringBuffer.push(lineStr, false);
    }

    if (discardingOversized) {
      sourceLines++;
      ringBuffer.push(remainder, true);
    } else if (remainder.length > 0) {
      let lineStr = remainder;
      if (lineStr.endsWith('\r')) lineStr = lineStr.slice(0, -1);
      sourceLines++;
      if (Buffer.byteLength(lineStr, 'utf8') > MAX_LINE_BYTES) {
        lineStr = truncateToUtf8Bytes(lineStr, MAX_LINE_BYTES);
      }
      ringBuffer.push(lineStr, true);
    }

    // Verify stable source identity after complete scan
    const afterStat = fs.fstatSync(fd);
    const afterLstat = fs.lstatSync(source);
    if (
      afterStat.dev !== beforeStat.dev ||
      afterStat.ino !== beforeStat.ino ||
      afterStat.size !== beforeStat.size ||
      afterStat.mtimeMs !== beforeStat.mtimeMs ||
      bytesReadTotal !== beforeStat.size ||
      afterLstat.dev !== beforeStat.dev ||
      afterLstat.ino !== beforeStat.ino
    ) {
      throw new Error('E_RECOVERY_SOURCE_CHANGED');
    }

    if (ringBuffer.totalBytes > MAX_TAIL_BYTES || ringBuffer.hasSpilled) {
      throw new Error('E_RECOVERY_TAIL_TOO_LARGE');
    }

    const tail = ringBuffer.toArray();
    const truncated = sourceLines > RECOVERY_LINE_LIMIT;
    const firstLine = sourceLines === 0 ? 0 : sourceLines - tail.length + 1;
    const lastLine = sourceLines;

    const warnings: RecoveryWarning[] = [];
    const records: unknown[] = [];
    const copiedLines: string[] = [];
    const tailIds = new Set<string>();
    const parentRefs: Array<{ parent: string; line: number }> = [];
    const malformedTailLines: string[] = [];

    if (truncated) {
      warnings.push({
        code: 'W_TRUNCATED_PREFIX',
        line: 1,
        detail: `omitted prefix of ${sourceLines - tail.length} lines before retained tail`,
      });
    }

    for (let index = 0; index < tail.length; index++) {
      const { raw, unterminated } = tail[index]!;
      const line = firstLine + index;
      try {
        const parsed = JSON.parse(raw) as unknown;
        const redacted = redact(parsed);
        records.push(redacted);
        copiedLines.push(JSON.stringify(redacted));

        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          warnings.push({ code: 'W_UNKNOWN_RECORD', line, detail: 'record is not a JSON object' });
          continue;
        }

        const record = parsed as Record<string, unknown>;
        const id = [record.id, record.uuid, record.message_id].find((v): v is string => typeof v === 'string');
        if (id !== undefined) tailIds.add(id);

        const parent = [record.parent_id, record.parentId, record.parent_uuid].find((v): v is string => typeof v === 'string');
        if (parent !== undefined) parentRefs.push({ parent, line });

        if (typeof record.type !== 'string' && typeof record.role !== 'string' && id === undefined) {
          warnings.push({ code: 'W_UNKNOWN_RECORD', line, detail: 'unrecognized record shape preserved' });
        }
      } catch {
        malformedTailLines.push(raw);
        const redacted = { raw: redact(raw) };
        records.push(redacted);
        copiedLines.push(JSON.stringify(redacted));
        if (unterminated) {
          warnings.push({
            code: 'W_PARTIAL_FINAL_RECORD',
            line,
            detail: 'incomplete final record preserved as redacted raw text',
          });
        } else {
          warnings.push({
            code: 'W_MALFORMED_RECORD',
            line,
            detail: 'malformed record preserved as redacted raw text',
          });
        }
      }
    }

    // Truthful parent chain analysis
    const missingTailParents = new Set<string>();
    for (const ref of parentRefs) {
      if (ref.parent.length > 0 && !tailIds.has(ref.parent)) {
        missingTailParents.add(ref.parent);
      }
    }

    const unverifiedInTail = new Set<string>();
    if (missingTailParents.size > 0 && malformedTailLines.length > 0) {
      const candidateTailParents = new Set<string>(missingTailParents);
      const searchRegex = buildCandidatesRegex(candidateTailParents);
      if (searchRegex !== null) {
        for (const malformedLine of malformedTailLines) {
          if (candidateTailParents.size === 0) break;
          if (searchRegex.test(malformedLine)) {
            for (const parent of candidateTailParents) {
              if (lineMatchesParent(malformedLine, parent)) {
                unverifiedInTail.add(parent);
                candidateTailParents.delete(parent);
              }
            }
          }
        }
      }
    }

    const foundInPrefix = new Set<string>();
    const unverifiedInPrefix = new Set<string>();
    let chainScanError = false;

    if (missingTailParents.size > 0 && truncated) {
      try {
        const prefixLinesCount = sourceLines - tail.length;
        let prefixOffset = 0;
        const prefixBuf = Buffer.alloc(64 * 1024);
        let prefixRemainder = '';
        let prefixLinesRead = 0;
        const prefixDecoder = new StringDecoder('utf8');
        let prefixDiscardingOversized = false;
        let prefixOversizedLine = '';

        const candidatesNeedingMalformedCheck = new Set<string>(missingTailParents);
        const searchRegex = buildCandidatesRegex(candidatesNeedingMalformedCheck);

        const checkPrefixLine = (lineStr: string): boolean => {
          const { validId, malformed } = extractIdFromLine(lineStr);
          if (validId !== null && missingTailParents.has(validId)) {
            foundInPrefix.add(validId);
            candidatesNeedingMalformedCheck.delete(validId);
            if (foundInPrefix.size === missingTailParents.size) return true;
          } else if (malformed && searchRegex !== null && candidatesNeedingMalformedCheck.size > 0) {
            if (searchRegex.test(lineStr)) {
              for (const parent of candidatesNeedingMalformedCheck) {
                if (lineMatchesParent(lineStr, parent)) {
                  unverifiedInPrefix.add(parent);
                  candidatesNeedingMalformedCheck.delete(parent);
                }
              }
            }
          }
          return false;
        };

        while (prefixLinesRead < prefixLinesCount && foundInPrefix.size < missingTailParents.size) {
          const bytesRead = fs.readSync(fd, prefixBuf, 0, prefixBuf.length, prefixOffset);
          if (bytesRead === 0) break;
          prefixOffset += bytesRead;

          let chunkText = prefixDecoder.write(prefixBuf.subarray(0, bytesRead));
          if (prefixDiscardingOversized) {
            const nl = chunkText.indexOf('\n');
            if (nl === -1) continue;
            prefixDiscardingOversized = false;
            prefixLinesRead++;
            const lineStr = prefixOversizedLine;
            prefixOversizedLine = '';
            chunkText = chunkText.slice(nl + 1);
            if (checkPrefixLine(lineStr)) break;
            if (prefixLinesRead >= prefixLinesCount) break;
          }

          prefixRemainder += chunkText;

          let newlineIndex: number;
          while ((newlineIndex = prefixRemainder.indexOf('\n')) !== -1) {
            let lineStr = prefixRemainder.slice(0, newlineIndex);
            if (lineStr.endsWith('\r')) lineStr = lineStr.slice(0, -1);
            prefixRemainder = prefixRemainder.slice(newlineIndex + 1);
            prefixLinesRead++;

            if (Buffer.byteLength(lineStr, 'utf8') > MAX_LINE_BYTES) {
              lineStr = truncateToUtf8Bytes(lineStr, MAX_LINE_BYTES);
            }
            if (checkPrefixLine(lineStr)) break;
            if (prefixLinesRead >= prefixLinesCount) break;
          }

          if (Buffer.byteLength(prefixRemainder, 'utf8') > MAX_LINE_BYTES) {
            prefixOversizedLine = truncateToUtf8Bytes(prefixRemainder, MAX_LINE_BYTES);
            prefixRemainder = '';
            prefixDiscardingOversized = true;
          }
        }

        // Verify stable source identity after prefix scan
        const prefixAfterStat = fs.fstatSync(fd);
        const prefixAfterLstat = fs.lstatSync(source);
        if (
          prefixAfterStat.dev !== beforeStat.dev ||
          prefixAfterStat.ino !== beforeStat.ino ||
          prefixAfterStat.size !== beforeStat.size ||
          prefixAfterStat.mtimeMs !== beforeStat.mtimeMs ||
          prefixAfterLstat.dev !== beforeStat.dev ||
          prefixAfterLstat.ino !== beforeStat.ino
        ) {
          throw new Error('E_RECOVERY_SOURCE_CHANGED');
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'E_RECOVERY_SOURCE_CHANGED') {
          throw error;
        }
        chainScanError = true;
      }
    }

    for (const ref of parentRefs) {
      if (!tailIds.has(ref.parent)) {
        const safeParent = redactText(ref.parent);
        if (foundInPrefix.has(ref.parent)) {
          warnings.push({
            code: 'W_PARENT_OUTSIDE_RETAINED_TAIL',
            line: ref.line,
            detail: `parent ${safeParent} located outside retained tail in omitted prefix`,
          });
        } else if (unverifiedInTail.has(ref.parent)) {
          warnings.push({
            code: 'W_CHAIN_UNVERIFIED',
            line: ref.line,
            detail: `parent ${safeParent} unverified due to malformed retained record`,
          });
        } else if (unverifiedInPrefix.has(ref.parent)) {
          warnings.push({
            code: 'W_CHAIN_UNVERIFIED',
            line: ref.line,
            detail: `parent ${safeParent} unverified due to malformed prefix record`,
          });
        } else if (chainScanError) {
          warnings.push({
            code: 'W_CHAIN_UNVERIFIED',
            line: ref.line,
            detail: `parent ${safeParent} verification incomplete due to scan error`,
          });
        } else {
          warnings.push({
            code: 'W_BROKEN_CHAIN',
            line: ref.line,
            detail: `missing parent ${safeParent}`,
          });
        }
      }
    }

    const copied = copiedLines.length === 0 ? '' : `${copiedLines.join('\n')}\n`;
    if (Buffer.byteLength(copied) > MAX_TAIL_BYTES) throw new Error('E_RECOVERY_TAIL_TOO_LARGE');

    const sourceSha = hasher.digest('hex');
    const copySha = digest(copied);
    const recoveryId = safeId(options.recoveryId ?? sourceSha.slice(0, 24));
    const directory = withinStateRoot(root, 'recovery', recoveryId);

    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    privateDirectory(withinStateRoot(root, 'recovery'));
    privateDirectory(directory);

    const copyPath = path.join(directory, 'transcript.tail.jsonl');
    if (fs.existsSync(copyPath)) {
      immutableFile(copyPath);
      if (digest(fs.readFileSync(copyPath)) !== copySha) throw new Error('E_RECOVERY_IMMUTABLE_CONFLICT');
    } else {
      fs.writeFileSync(copyPath, copied, { flag: 'wx', mode: 0o400 });
    }
    fs.chmodSync(copyPath, 0o400);

    const snapshot: RecoverySnapshotV2 = {
      schema_version: RECOVERY_SCHEMA_VERSION,
      recovery_id: recoveryId,
      source_path: source,
      source_sha256: sourceSha,
      source_bytes: beforeStat.size,
      source_lines: sourceLines,
      copied_sha256: copySha,
      copied_lines: tail.length,
      retained_first_line: firstLine,
      retained_last_line: lastLine,
      truncated,
      consistency_status: 'consistent',
      records,
      warnings,
      created_at: (options.now ?? (() => new Date()))().toISOString(),
      copy_path: copyPath,
    };

    const metadata = path.join(directory, 'snapshot.json');
    if (fs.existsSync(metadata)) {
      const existing = readRecovery(root, recoveryId);
      if (
        existing.source_path !== source ||
        existing.source_sha256 !== sourceSha ||
        existing.copied_sha256 !== copySha
      ) {
        throw new Error('E_RECOVERY_IMMUTABLE_CONFLICT');
      }
      return existing;
    }

    atomicWriteJson(metadata, snapshot);
    fs.chmodSync(metadata, 0o400);
    return snapshot;
  } finally {
    fs.closeSync(fd);
  }
}

export function readRecovery(root: StateRoot, recoveryId: string): RecoverySnapshot {
  try {
    const id = safeId(recoveryId);
    const recoveryRoot = withinStateRoot(root, 'recovery');
    const directory = withinStateRoot(root, 'recovery', id);
    const metadata = withinStateRoot(root, 'recovery', id, 'snapshot.json');
    const copy = withinStateRoot(root, 'recovery', id, 'transcript.tail.jsonl');

    privateDirectory(recoveryRoot);
    privateDirectory(directory);
    immutableFile(metadata);
    immutableFile(copy);

    const snapshot = validateRecovery(JSON.parse(fs.readFileSync(metadata, 'utf8')) as unknown, id, copy);
    const copied = fs.readFileSync(copy);
    if (copied.byteLength > MAX_TAIL_BYTES || digest(copied) !== snapshot.copied_sha256) {
      throw new Error('E_RECOVERY_INVALID');
    }
    const expected = snapshot.records.length === 0 ? '' : `${snapshot.records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    if (!copied.equals(Buffer.from(expected)) || digest(expected) !== snapshot.copied_sha256) {
      throw new Error('E_RECOVERY_INVALID');
    }
    return snapshot;
  } catch (error) {
    if (error instanceof Error && error.message === 'E_RECOVERY_INVALID') throw error;
    throw new Error('E_RECOVERY_INVALID');
  }
}
