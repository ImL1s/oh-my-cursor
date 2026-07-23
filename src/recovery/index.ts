import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../runtime/atomic.js';
import { redact } from '../runtime/redaction.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';

export const RECOVERY_LINE_LIMIT = 900;
export type RecoveryWarningCode = 'W_PARTIAL_RECORD' | 'W_UNKNOWN_RECORD' | 'W_BROKEN_CHAIN';
export interface RecoveryWarning { readonly code: RecoveryWarningCode; readonly line: number; readonly detail: string }
export interface RecoverySnapshot {
  readonly schema_version: 1; readonly recovery_id: string; readonly source_path: string;
  readonly source_sha256: string; readonly copied_sha256: string; readonly copied_lines: number;
  readonly source_lines: number; readonly truncated: boolean; readonly records: readonly unknown[];
  readonly warnings: readonly RecoveryWarning[]; readonly created_at: string; readonly copy_path: string;
}
export interface RecoveryOptions { readonly transcriptPath?: string; readonly projectJsonlPath?: string; readonly recoveryId?: string; readonly now?: () => Date }

function explicitSource(options: RecoveryOptions): string {
  const candidates = [options.transcriptPath, options.projectJsonlPath].filter((value): value is string => value !== undefined);
  if (candidates.length !== 1) throw new Error('E_RECOVERY_EXPLICIT_SOURCE_REQUIRED');
  if (!path.isAbsolute(candidates[0]!)) throw new Error('E_RECOVERY_SOURCE_NOT_ABSOLUTE');
  return path.resolve(candidates[0]!);
}
function safeId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('E_RECOVERY_ID_INVALID');
  return value;
}
function digest(value: string | Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }
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
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}
const SNAPSHOT_KEYS = [
  'schema_version', 'recovery_id', 'source_path', 'source_sha256', 'copied_sha256',
  'copied_lines', 'source_lines', 'truncated', 'records', 'warnings', 'created_at', 'copy_path',
] as const;
const WARNING_KEYS = ['code', 'line', 'detail'] as const;
const WARNING_CODES = new Set<RecoveryWarningCode>(['W_PARTIAL_RECORD', 'W_UNKNOWN_RECORD', 'W_BROKEN_CHAIN']);

function validateRecovery(value: unknown, requestedId: string, expectedCopy: string): RecoverySnapshot {
  if (!object(value) || !exactKeys(value, SNAPSHOT_KEYS)
    || value.schema_version !== 1 || value.recovery_id !== requestedId
    || typeof value.source_path !== 'string' || !path.isAbsolute(value.source_path)
    || typeof value.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.source_sha256)
    || typeof value.copied_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.copied_sha256)
    || typeof value.copied_lines !== 'number' || !Number.isSafeInteger(value.copied_lines) || value.copied_lines < 0 || value.copied_lines > RECOVERY_LINE_LIMIT
    || typeof value.source_lines !== 'number' || !Number.isSafeInteger(value.source_lines) || value.source_lines < value.copied_lines
    || value.copied_lines !== Math.min(value.source_lines, RECOVERY_LINE_LIMIT)
    || typeof value.truncated !== 'boolean' || value.truncated !== (value.source_lines > RECOVERY_LINE_LIMIT)
    || !Array.isArray(value.records) || value.records.length !== value.copied_lines
    || !Array.isArray(value.warnings)
    || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))
    || value.copy_path !== expectedCopy) throw new Error('E_RECOVERY_INVALID');
  for (const warning of value.warnings) {
    if (!object(warning) || !exactKeys(warning, WARNING_KEYS)
      || typeof warning.code !== 'string' || !WARNING_CODES.has(warning.code as RecoveryWarningCode)
      || typeof warning.line !== 'number' || !Number.isSafeInteger(warning.line) || warning.line < 1 || warning.line > value.source_lines
      || typeof warning.detail !== 'string') throw new Error('E_RECOVERY_INVALID');
  }
  return value as unknown as RecoverySnapshot;
}

/** Copies only the bounded tail of an explicitly supplied JSONL file into immutable project state. */
export function recoverCursorSession(root: StateRoot, options: RecoveryOptions): RecoverySnapshot {
  const source = explicitSource(options);
  const before = fs.lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('E_RECOVERY_SOURCE_UNSAFE');
  if (before.size > 128 * 1024 * 1024) throw new Error('E_RECOVERY_SOURCE_TOO_LARGE');
  const bytes = fs.readFileSync(source);
  const after = fs.statSync(source);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('E_RECOVERY_SOURCE_CHANGED');
  const text = bytes.toString('utf8');
  const all = text.split(/\r?\n/);
  if (all.at(-1) === '') all.pop();
  const tail = all.slice(-RECOVERY_LINE_LIMIT);
  const firstLine = all.length - tail.length + 1;
  const warnings: RecoveryWarning[] = [];
  const records: unknown[] = [];
  const copiedLines: string[] = [];
  const ids = new Set<string>();
  const parentRefs: Array<{ parent: string; line: number }> = [];
  for (let index = 0; index < tail.length; index += 1) {
    const raw = tail[index]!;
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
      const id = [record.id, record.uuid, record.message_id].find((value): value is string => typeof value === 'string');
      if (id !== undefined) ids.add(id);
      const parent = [record.parent_id, record.parentId, record.parent_uuid].find((value): value is string => typeof value === 'string');
      if (parent !== undefined) parentRefs.push({ parent, line });
      if (typeof record.type !== 'string' && typeof record.role !== 'string' && id === undefined) {
        warnings.push({ code: 'W_UNKNOWN_RECORD', line, detail: 'unrecognized record shape preserved' });
      }
    } catch {
      const redacted = { raw: redact(raw) };
      records.push(redacted);
      copiedLines.push(JSON.stringify(redacted));
      warnings.push({ code: 'W_PARTIAL_RECORD', line, detail: 'invalid JSON preserved as redacted raw text' });
    }
  }
  for (const ref of parentRefs) if (!ids.has(ref.parent)) warnings.push({ code: 'W_BROKEN_CHAIN', line: ref.line, detail: `missing parent ${ref.parent}` });
  const copied = copiedLines.length === 0 ? '' : `${copiedLines.join('\n')}\n`;
  if (Buffer.byteLength(copied) > 16 * 1024 * 1024) throw new Error('E_RECOVERY_TAIL_TOO_LARGE');
  const sourceSha = digest(bytes);
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
  const snapshot: RecoverySnapshot = {
    schema_version: 1, recovery_id: recoveryId, source_path: source, source_sha256: sourceSha,
    copied_sha256: copySha, copied_lines: tail.length, source_lines: all.length,
    truncated: all.length > RECOVERY_LINE_LIMIT, records, warnings,
    created_at: (options.now ?? (() => new Date()))().toISOString(), copy_path: copyPath,
  };
  const metadata = path.join(directory, 'snapshot.json');
  if (fs.existsSync(metadata)) {
    const existing = readRecovery(root, recoveryId);
    if (existing.source_path !== source || existing.source_sha256 !== sourceSha || existing.copied_sha256 !== copySha) throw new Error('E_RECOVERY_IMMUTABLE_CONFLICT');
    return existing;
  }
  atomicWriteJson(metadata, snapshot);
  fs.chmodSync(metadata, 0o400);
  return snapshot;
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
    if (copied.byteLength > 16 * 1024 * 1024 || digest(copied) !== snapshot.copied_sha256) throw new Error('E_RECOVERY_INVALID');
    const expected = snapshot.records.length === 0 ? '' : `${snapshot.records.map((record) => JSON.stringify(record)).join('\n')}\n`;
    if (!copied.equals(Buffer.from(expected)) || digest(expected) !== snapshot.copied_sha256) throw new Error('E_RECOVERY_INVALID');
    return snapshot;
  } catch (error) {
    if (error instanceof Error && error.message === 'E_RECOVERY_INVALID') throw error;
    throw new Error('E_RECOVERY_INVALID');
  }
}
