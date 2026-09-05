import { redact } from '../runtime/redaction.js';

export const MAX_RECORD_TEXT_BYTES = 64 * 1024;
export const MAX_RECORD_METADATA_BYTES = 64 * 1024;
export const MAX_IMPORT_RECORDS = 1000;
export const MAX_IMPORT_BUNDLE_BYTES = 8 * 1024 * 1024;
export const MAX_SEARCH_QUERY_LENGTH = 4096;

export interface ProjectMemory {
  readonly schema_version: 1;
  readonly id: string;
  readonly text: string;
  readonly metadata: unknown;
  readonly updated_at: string;
}

export interface MemoryExport {
  readonly schema_version: 1;
  readonly memories: readonly ProjectMemory[];
}

export type MemoryConflictPolicy = 'reject' | 'skip' | 'replace' | 'newer-wins';

export interface MemoryImportOptions {
  readonly conflict?: MemoryConflictPolicy | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface MemoryImportPlanItem {
  readonly id: string;
  readonly action: 'create' | 'replace' | 'skip';
  readonly reason?: string | undefined;
  readonly incoming_updated_at: string;
  readonly existing_updated_at?: string | undefined;
}

export interface MemoryImportPlan {
  readonly schema_version: 1;
  readonly conflict_policy: MemoryConflictPolicy;
  readonly total_incoming: number;
  readonly to_create: readonly string[];
  readonly to_replace: readonly string[];
  readonly to_skip: readonly string[];
  readonly conflicts: readonly { readonly id: string; readonly reason: string }[];
  readonly items: readonly MemoryImportPlanItem[];
}

export interface MemoryImportReceipt {
  readonly schema_version: 1;
  readonly dry_run: boolean;
  readonly conflict_policy: MemoryConflictPolicy;
  readonly imported: number;
  readonly created: readonly string[];
  readonly replaced: readonly string[];
  readonly skipped: readonly string[];
}

export interface MemoryIndexEntry {
  readonly id: string;
  readonly updated_at: string;
  readonly byte_size: number;
}

export interface MemoryIndex {
  readonly schema_version: 1;
  readonly ids: readonly string[];
  readonly rescanned_at: string;
  readonly entries?: readonly MemoryIndexEntry[] | undefined;
}

export interface MemoryDoctorReport {
  readonly ok: boolean;
  readonly total_records: number;
  readonly valid_records: number;
  readonly corrupt_records: readonly {
    readonly file: string;
    readonly id?: string | undefined;
    readonly reason: string;
    readonly quarantined_to?: string | undefined;
  }[];
  readonly index_rebuilt: boolean;
}

export function safeMemoryId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error('E_MEMORY_ID_INVALID');
  }
  return value;
}

export function validIsoDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time);
}

export function cleanMemoryText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value) > MAX_RECORD_TEXT_BYTES) {
    throw new Error('E_MEMORY_TEXT_INVALID');
  }
  const redacted = String(redact(value, { maxStringLength: MAX_RECORD_TEXT_BYTES }));
  if (Buffer.byteLength(redacted) > MAX_RECORD_TEXT_BYTES) {
    throw new Error('E_MEMORY_TEXT_INVALID');
  }
  return redacted;
}

export function cleanMemoryMetadata(value: unknown): unknown {
  if (value === undefined) return {};
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return {};
    if (Buffer.byteLength(serialized) > MAX_RECORD_METADATA_BYTES) {
      throw new Error('E_MEMORY_METADATA_INVALID');
    }
    const redacted = redact(value);
    const redactedSerialized = JSON.stringify(redacted);
    if (redactedSerialized !== undefined && Buffer.byteLength(redactedSerialized) > MAX_RECORD_METADATA_BYTES) {
      throw new Error('E_MEMORY_METADATA_INVALID');
    }
    return redacted;
  } catch (error) {
    if ((error as Error).message === 'E_MEMORY_METADATA_INVALID') throw error;
    throw new Error('E_MEMORY_METADATA_INVALID', { cause: error });
  }
}

export function validateMemoryRecord(parsed: unknown, expectedId?: string): ProjectMemory {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('E_MEMORY_RECORD_INVALID');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema_version !== 1) {
    throw new Error('E_MEMORY_RECORD_INVALID');
  }
  const id = safeMemoryId(obj.id);
  if (expectedId !== undefined && id !== expectedId) {
    throw new Error('E_MEMORY_RECORD_INVALID');
  }
  if (typeof obj.text !== 'string' || obj.text.trim() === '' || Buffer.byteLength(obj.text) > MAX_RECORD_TEXT_BYTES) {
    throw new Error('E_MEMORY_RECORD_INVALID');
  }
  if (!Object.prototype.hasOwnProperty.call(obj, 'metadata')) {
    throw new Error('E_MEMORY_RECORD_INVALID');
  }
  if (obj.metadata !== undefined) {
    try {
      const serialized = JSON.stringify(obj.metadata);
      if (serialized !== undefined && Buffer.byteLength(serialized) > MAX_RECORD_METADATA_BYTES) {
        throw new Error('E_MEMORY_RECORD_INVALID');
      }
    } catch {
      throw new Error('E_MEMORY_RECORD_INVALID');
    }
  }
  if (!validIsoDate(obj.updated_at)) {
    throw new Error('E_MEMORY_RECORD_INVALID');
  }

  return {
    schema_version: 1,
    id,
    text: obj.text,
    metadata: obj.metadata,
    updated_at: obj.updated_at as string,
  };
}

export function validateRawImportBundle(bundle: unknown): {
  readonly schema_version: 1;
  readonly memories: readonly unknown[];
} {
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('E_MEMORY_IMPORT_INVALID');
  }
  const obj = bundle as Record<string, unknown>;
  if (obj.schema_version !== 1 || !Array.isArray(obj.memories)) {
    throw new Error('E_MEMORY_IMPORT_INVALID');
  }
  if (obj.memories.length > MAX_IMPORT_RECORDS) {
    throw new Error('E_MEMORY_IMPORT_TOO_LARGE');
  }
  try {
    const rawLength = Buffer.byteLength(JSON.stringify(bundle));
    if (rawLength > MAX_IMPORT_BUNDLE_BYTES) {
      throw new Error('E_MEMORY_IMPORT_TOO_LARGE');
    }
  } catch (error) {
    if ((error as Error).message === 'E_MEMORY_IMPORT_TOO_LARGE') throw error;
    throw new Error('E_MEMORY_IMPORT_INVALID', { cause: error });
  }

  return {
    schema_version: 1,
    memories: obj.memories,
  };
}
