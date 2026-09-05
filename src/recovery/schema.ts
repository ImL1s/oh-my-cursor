import path from 'node:path';
import { redactText } from '../runtime/redaction.js';

export const RECOVERY_LINE_LIMIT = 900;
export const MAX_SOURCE_BYTES = 128 * 1024 * 1024; // 128 MiB
export const MAX_TAIL_BYTES = 16 * 1024 * 1024; // 16 MiB
export const MAX_LINE_BYTES = 1024 * 1024; // 1 MiB per line limit
export const MAX_SNAPSHOT_BYTES = 48 * 1024 * 1024; // 48 MiB
export const RECOVERY_SCHEMA_VERSION = 2;

export type RecoveryWarningCode =
  | 'W_TRUNCATED_PREFIX'
  | 'W_PARENT_OUTSIDE_RETAINED_TAIL'
  | 'W_PARTIAL_FINAL_RECORD'
  | 'W_MALFORMED_RECORD'
  | 'W_UNKNOWN_RECORD'
  | 'W_BROKEN_CHAIN'
  | 'W_CHAIN_UNVERIFIED'
  | 'W_PARTIAL_RECORD'; // Retained for v1 compatibility

export interface RecoveryWarning {
  readonly code: RecoveryWarningCode;
  readonly line: number;
  readonly detail: string;
}

export interface RecoveryOptions {
  readonly transcriptPath?: string;
  readonly projectJsonlPath?: string;
  readonly recoveryId?: string;
  readonly now?: () => Date;
}

export interface RecoverySnapshotV1 {
  readonly schema_version: 1;
  readonly recovery_id: string;
  readonly source_path: string;
  readonly source_sha256: string;
  readonly copied_sha256: string;
  readonly copied_lines: number;
  readonly source_lines: number;
  readonly truncated: boolean;
  readonly records: readonly unknown[];
  readonly warnings: readonly RecoveryWarning[];
  readonly created_at: string;
  readonly copy_path: string;
}

export interface RecoverySnapshotV2 {
  readonly schema_version: 2;
  readonly recovery_id: string;
  readonly source_path: string;
  readonly source_sha256: string;
  readonly source_bytes: number;
  readonly source_lines: number;
  readonly copied_sha256: string;
  readonly copied_lines: number;
  readonly retained_first_line: number;
  readonly retained_last_line: number;
  readonly truncated: boolean;
  readonly consistency_status: 'consistent';
  readonly records: readonly unknown[];
  readonly warnings: readonly RecoveryWarning[];
  readonly created_at: string;
  readonly copy_path: string;
}

export type RecoverySnapshot = RecoverySnapshotV1 | RecoverySnapshotV2;

export interface RecoverySummary {
  readonly recovery_id: string;
  readonly schema_version: number;
  readonly source_bytes?: number;
  readonly source_lines: number;
  readonly retained_range: {
    readonly first: number;
    readonly last: number;
    readonly count: number;
  };
  readonly truncated: boolean;
  readonly malformed_count: number;
  readonly broken_chain_count: number;
  readonly outside_tail_count: number;
  readonly warnings: readonly RecoveryWarning[];
  readonly note: string;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

export const SNAPSHOT_V1_KEYS = [
  'schema_version', 'recovery_id', 'source_path', 'source_sha256', 'copied_sha256',
  'copied_lines', 'source_lines', 'truncated', 'records', 'warnings', 'created_at', 'copy_path',
] as const;

export const SNAPSHOT_V2_KEYS = [
  'schema_version', 'recovery_id', 'source_path', 'source_sha256', 'source_bytes',
  'source_lines', 'copied_sha256', 'copied_lines', 'retained_first_line', 'retained_last_line',
  'truncated', 'consistency_status', 'records', 'warnings', 'created_at', 'copy_path',
] as const;

export const WARNING_KEYS = ['code', 'line', 'detail'] as const;

export const V1_WARNING_CODES = new Set<RecoveryWarningCode>([
  'W_PARTIAL_RECORD', 'W_UNKNOWN_RECORD', 'W_BROKEN_CHAIN',
]);

export const V2_WARNING_CODES = new Set<RecoveryWarningCode>([
  'W_TRUNCATED_PREFIX',
  'W_PARENT_OUTSIDE_RETAINED_TAIL',
  'W_PARTIAL_FINAL_RECORD',
  'W_MALFORMED_RECORD',
  'W_UNKNOWN_RECORD',
  'W_BROKEN_CHAIN',
  'W_CHAIN_UNVERIFIED',
]);

export function validateRecoveryWarning(
  warning: unknown,
  allowedCodes: ReadonlySet<RecoveryWarningCode>,
  sourceLines: number,
): RecoveryWarning {
  if (!isObject(warning) || !exactKeys(warning, WARNING_KEYS)) {
    throw new Error('E_RECOVERY_INVALID');
  }
  if (typeof warning.code !== 'string' || !allowedCodes.has(warning.code as RecoveryWarningCode)) {
    throw new Error('E_RECOVERY_INVALID');
  }
  if (typeof warning.line !== 'number' || !Number.isSafeInteger(warning.line)) {
    throw new Error('E_RECOVERY_INVALID');
  }
  if (sourceLines <= 0 || warning.line < 1 || warning.line > sourceLines) {
    throw new Error('E_RECOVERY_INVALID');
  }
  if (typeof warning.detail !== 'string') {
    throw new Error('E_RECOVERY_INVALID');
  }
  return warning as unknown as RecoveryWarning;
}

export function validateRecovery(
  value: unknown,
  requestedId: string,
  expectedCopy: string,
): RecoverySnapshot {
  if (!isObject(value)) throw new Error('E_RECOVERY_INVALID');

  if (value.schema_version === 1) {
    if (!exactKeys(value, SNAPSHOT_V1_KEYS)) throw new Error('E_RECOVERY_INVALID');
    if (value.recovery_id !== requestedId) throw new Error('E_RECOVERY_INVALID');
    if (typeof value.source_path !== 'string' || !path.isAbsolute(value.source_path)) throw new Error('E_RECOVERY_INVALID');
    if (typeof value.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.source_sha256)) throw new Error('E_RECOVERY_INVALID');
    if (typeof value.copied_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.copied_sha256)) throw new Error('E_RECOVERY_INVALID');
    if (typeof value.copied_lines !== 'number' || !Number.isSafeInteger(value.copied_lines) || value.copied_lines < 0 || value.copied_lines > RECOVERY_LINE_LIMIT) {
      throw new Error('E_RECOVERY_INVALID');
    }
    if (typeof value.source_lines !== 'number' || !Number.isSafeInteger(value.source_lines) || value.source_lines < value.copied_lines) {
      throw new Error('E_RECOVERY_INVALID');
    }
    if (value.copied_lines !== Math.min(value.source_lines, RECOVERY_LINE_LIMIT)) throw new Error('E_RECOVERY_INVALID');
    if (typeof value.truncated !== 'boolean' || value.truncated !== (value.source_lines > RECOVERY_LINE_LIMIT)) throw new Error('E_RECOVERY_INVALID');
    if (!Array.isArray(value.records) || value.records.length !== value.copied_lines) throw new Error('E_RECOVERY_INVALID');
    if (!Array.isArray(value.warnings)) throw new Error('E_RECOVERY_INVALID');
    if (typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) throw new Error('E_RECOVERY_INVALID');
    if (value.copy_path !== expectedCopy) throw new Error('E_RECOVERY_INVALID');

    for (const warning of value.warnings) {
      validateRecoveryWarning(warning, V1_WARNING_CODES, value.source_lines);
    }
    return value as unknown as RecoverySnapshotV1;
  }

  if (value.schema_version === 2) {
    if (!exactKeys(value, SNAPSHOT_V2_KEYS)) throw new Error('E_RECOVERY_INVALID');
    if (value.recovery_id !== requestedId) throw new Error('E_RECOVERY_INVALID');
    if (typeof value.source_path !== 'string' || !path.isAbsolute(value.source_path)) throw new Error('E_RECOVERY_INVALID');
    if (typeof value.source_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.source_sha256)) throw new Error('E_RECOVERY_INVALID');
    if (typeof value.source_bytes !== 'number' || !Number.isSafeInteger(value.source_bytes) || value.source_bytes < 0 || value.source_bytes > MAX_SOURCE_BYTES) {
      throw new Error('E_RECOVERY_INVALID');
    }
    if (typeof value.source_lines !== 'number' || !Number.isSafeInteger(value.source_lines) || value.source_lines < 0 || value.source_lines > value.source_bytes) {
      throw new Error('E_RECOVERY_INVALID');
    }
    if ((value.source_lines === 0) !== (value.source_bytes === 0)) {
      throw new Error('E_RECOVERY_INVALID');
    }
    if (typeof value.copied_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.copied_sha256)) throw new Error('E_RECOVERY_INVALID');
    if (typeof value.copied_lines !== 'number' || !Number.isSafeInteger(value.copied_lines) || value.copied_lines < 0 || value.copied_lines > RECOVERY_LINE_LIMIT) {
      throw new Error('E_RECOVERY_INVALID');
    }
    if (value.copied_lines !== Math.min(value.source_lines, RECOVERY_LINE_LIMIT)) throw new Error('E_RECOVERY_INVALID');

    const expectedFirst = value.source_lines === 0 ? 0 : value.source_lines - value.copied_lines + 1;
    const expectedLast = value.source_lines;
    if (typeof value.retained_first_line !== 'number' || value.retained_first_line !== expectedFirst) {
      throw new Error('E_RECOVERY_INVALID');
    }
    if (typeof value.retained_last_line !== 'number' || value.retained_last_line !== expectedLast) {
      throw new Error('E_RECOVERY_INVALID');
    }

    if (typeof value.truncated !== 'boolean' || value.truncated !== (value.source_lines > RECOVERY_LINE_LIMIT)) {
      throw new Error('E_RECOVERY_INVALID');
    }
    if (value.consistency_status !== 'consistent') throw new Error('E_RECOVERY_INVALID');
    if (!Array.isArray(value.records) || value.records.length !== value.copied_lines) throw new Error('E_RECOVERY_INVALID');
    if (!Array.isArray(value.warnings)) throw new Error('E_RECOVERY_INVALID');
    if (typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) throw new Error('E_RECOVERY_INVALID');
    if (value.copy_path !== expectedCopy) throw new Error('E_RECOVERY_INVALID');

    let truncatedPrefixCount = 0;
    for (const warning of value.warnings) {
      validateRecoveryWarning(warning, V2_WARNING_CODES, value.source_lines);
      if (warning.code === 'W_TRUNCATED_PREFIX') {
        truncatedPrefixCount++;
        if (!value.truncated || warning.line !== 1) {
          throw new Error('E_RECOVERY_INVALID');
        }
      } else {
        if (warning.line < value.retained_first_line || warning.line > value.retained_last_line) {
          throw new Error('E_RECOVERY_INVALID');
        }
        if (warning.code === 'W_PARENT_OUTSIDE_RETAINED_TAIL') {
          if (!value.truncated) {
            throw new Error('E_RECOVERY_INVALID');
          }
        } else if (warning.code === 'W_PARTIAL_FINAL_RECORD') {
          if (warning.line !== value.retained_last_line) {
            throw new Error('E_RECOVERY_INVALID');
          }
        }
      }
    }
    if (value.truncated && truncatedPrefixCount !== 1) {
      throw new Error('E_RECOVERY_INVALID');
    }
    if (!value.truncated && truncatedPrefixCount !== 0) {
      throw new Error('E_RECOVERY_INVALID');
    }
    return value as unknown as RecoverySnapshotV2;
  }

  throw new Error('E_RECOVERY_INVALID');
}

export function recoverySummary(snapshot: RecoverySnapshot): RecoverySummary {
  let malformedCount = 0;
  let brokenChainCount = 0;
  let outsideTailCount = 0;

  for (const warning of snapshot.warnings) {
    if (warning.code === 'W_PARTIAL_FINAL_RECORD' || warning.code === 'W_MALFORMED_RECORD' || warning.code === 'W_PARTIAL_RECORD') {
      malformedCount++;
    } else if (warning.code === 'W_BROKEN_CHAIN') {
      brokenChainCount++;
    } else if (warning.code === 'W_PARENT_OUTSIDE_RETAINED_TAIL') {
      outsideTailCount++;
    }
  }

  const first = snapshot.schema_version === 2 ? snapshot.retained_first_line : (snapshot.source_lines === 0 ? 0 : snapshot.source_lines - snapshot.copied_lines + 1);
  const last = snapshot.schema_version === 2 ? snapshot.retained_last_line : snapshot.source_lines;

  const redactedWarnings: RecoveryWarning[] = snapshot.warnings.map((warning) => ({
    code: warning.code,
    line: warning.line,
    detail: redactText(warning.detail),
  }));

  return {
    recovery_id: snapshot.recovery_id,
    schema_version: snapshot.schema_version,
    ...(snapshot.schema_version === 2 ? { source_bytes: snapshot.source_bytes } : {}),
    source_lines: snapshot.source_lines,
    retained_range: {
      first,
      last,
      count: snapshot.copied_lines,
    },
    truncated: snapshot.truncated,
    malformed_count: malformedCount,
    broken_chain_count: brokenChainCount,
    outside_tail_count: outsideTailCount,
    warnings: redactedWarnings,
    note: 'parent_outside_retained_tail is expected under truncation and does not represent corruption. Recovery snapshots are non-authoritative.',
  };
}
