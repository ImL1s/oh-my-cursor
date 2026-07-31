import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AtomicWriteError,
  atomicCreateJson,
  quarantineOwnedRegularFile,
  withDirectoryLockSync,
} from '../runtime/atomic.js';
import type { StateRoot } from '../runtime/state-root.js';

const CLI_AUTHORITY = Symbol('omcu-cli-authority');
const CLI_OWNER_FILE = Symbol('omcu-owner-file');
export interface CliMutationAuthority {
  readonly source: 'omcu-cli';
  readonly ownerToken: string;
  readonly [CLI_AUTHORITY]: true;
  readonly [CLI_OWNER_FILE]: string;
}

interface OwnerRecord { readonly schema_version: 1; readonly owner_token: string; readonly created_at: string }
interface OwnerSnapshot {
  readonly body: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly sha256: string;
}
const OWNER_RECORD_MAX_BYTES = 4 * 1024;
export interface OwnerRepairOptions {
  /** Test/doctor seam invoked while the owner guard is held, before final revalidation. */
  readonly beforeRevalidate?: () => void;
}

function assertOwnerRoot(root: StateRoot): void {
  const stat = fs.lstatSync(root.path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('E_OWNER_ROOT_UNSAFE');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('E_OWNER_ROOT_NOT_OWNED');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('E_OWNER_ROOT_MODE_UNSAFE');
  }
}

function readOwnerSnapshot(file: string, allowEmpty = false): OwnerSnapshot {
  const initial = fs.lstatSync(file);
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error('E_OWNER_RECORD_UNSAFE');
  if (typeof process.getuid === 'function' && initial.uid !== process.getuid()) {
    throw new Error('E_OWNER_RECORD_NOT_OWNED');
  }
  if (process.platform !== 'win32' && (initial.mode & 0o077) !== 0) {
    throw new Error('E_OWNER_RECORD_MODE_UNSAFE');
  }
  if ((!allowEmpty && initial.size < 1) || initial.size > OWNER_RECORD_MAX_BYTES) {
    throw new Error('E_OWNER_RECORD_SIZE_UNSAFE');
  }

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino
      || opened.size !== initial.size) throw new Error('E_OWNER_RECORD_CHANGED');
    const buffer = Buffer.alloc(opened.size);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes !== opened.size) throw new Error('E_OWNER_RECORD_CHANGED');
    const body = buffer.toString('utf8');
    return {
      body,
      dev: opened.dev,
      ino: opened.ino,
      size: opened.size,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseOwner(body: string): OwnerRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('E_OWNER_RECORD_INVALID', { cause: error });
    throw error;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('E_OWNER_RECORD_INVALID');
  }
  const candidate = parsed as Partial<OwnerRecord> & Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join(',') !== 'created_at,owner_token,schema_version'
    || candidate.schema_version !== 1 || typeof candidate.owner_token !== 'string'
    || !/^[a-f0-9]{64}$/.test(candidate.owner_token) || typeof candidate.created_at !== 'string'
    || !Number.isFinite(Date.parse(candidate.created_at))
    || new Date(candidate.created_at).toISOString() !== candidate.created_at) {
    throw new Error('E_OWNER_RECORD_INVALID');
  }
  return candidate as OwnerRecord;
}

function readOwner(file: string): OwnerRecord {
  return parseOwner(readOwnerSnapshot(file).body);
}

function withOwnerGuard<T>(root: StateRoot, action: () => T): T {
  return withDirectoryLockSync(root.ownerFile, action, 2_000, {
    errorPrefix: 'E_OWNER_GUARD',
  });
}

/** Validate an adopted project root and any existing CLI owner without creating authority. */
export function validateExistingCliOwnerRecord(root: StateRoot): void {
  assertOwnerRoot(root);
  try {
    readOwner(root.ownerFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

/**
 * Explicit repair seam for doctor-style callers. Valid owner records are never
 * moved. Invalid records must be regular, non-symlink files owned by this user.
 */
export function quarantineInvalidCliOwnerRecord(
  root: StateRoot,
  options: OwnerRepairOptions = {},
): string | null {
  assertOwnerRoot(root);
  return withOwnerGuard(root, () => {
    let snapshot: OwnerSnapshot;
    try {
      snapshot = readOwnerSnapshot(root.ownerFile, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if ((error as Error).message === 'E_OWNER_RECORD_UNSAFE') {
        throw new Error('E_OWNER_RECORD_REPAIR_UNSAFE', { cause: error });
      }
      throw error;
    }
    try {
      parseOwner(snapshot.body);
      return null;
    } catch (error) {
      if ((error as Error).message !== 'E_OWNER_RECORD_INVALID') throw error;
    }
    // Bind the exact invalid inode and bytes through the destructive helper so
    // a concurrently repaired valid owner can never be quarantined.
    return quarantineOwnedRegularFile(root.ownerFile, {
      errorPrefix: 'E_OWNER_RECORD_REPAIR',
      expectedSnapshot: snapshot,
      ...(options.beforeRevalidate === undefined ? {} : { beforeRevalidate: options.beforeRevalidate }),
    });
  });
}

/** Internal entry point: intentionally not re-exported from the package root. */
export function createCliMutationAuthority(root: StateRoot): CliMutationAuthority {
  assertOwnerRoot(root);
  const record = withOwnerGuard(root, () => {
    try {
      return readOwner(root.ownerFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && fs.existsSync(root.ownerFile)) {
        throw error;
      }
    }
    const candidate: OwnerRecord = {
      schema_version: 1,
      owner_token: crypto.randomBytes(32).toString('hex'),
      created_at: new Date().toISOString(),
    };
    try {
      atomicCreateJson(root.ownerFile, candidate, { mode: 0o600, maxBytes: OWNER_RECORD_MAX_BYTES });
      return candidate;
    } catch (error) {
      // A durability-unknown exclusive create may already be visible.
      if (error instanceof AtomicWriteError && error.phase === 'commit_durability_unknown') {
        return readOwner(root.ownerFile);
      }
      throw error;
    }
  });
  return {
    source: 'omcu-cli',
    ownerToken: record.owner_token,
    [CLI_AUTHORITY]: true,
    [CLI_OWNER_FILE]: root.ownerFile,
  };
}

export function assertCliMutationAuthority(authority: CliMutationAuthority): void {
  if (authority.source !== 'omcu-cli' || authority[CLI_AUTHORITY] !== true || authority.ownerToken.length < 32) {
    throw new Error('E_CLI_MUTATION_AUTHORITY_REQUIRED');
  }
  assertOwnerRoot({ path: path.dirname(authority[CLI_OWNER_FILE]), ownerFile: authority[CLI_OWNER_FILE] });
  const persisted = readOwner(authority[CLI_OWNER_FILE]);
  if (persisted.owner_token !== authority.ownerToken) throw new Error('E_CLI_MUTATION_AUTHORITY_STALE');
}

export function authorityDigest(authority: CliMutationAuthority): string {
  assertCliMutationAuthority(authority);
  return crypto.createHash('sha256').update(authority.ownerToken).digest('hex');
}
