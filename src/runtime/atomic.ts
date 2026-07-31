import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  classifyProcessLiveness,
  currentProcessIdentity,
  probeProcess,
  type ProcessIdentity,
} from './process-identity.js';

export interface DirectoryLockOptions {
  readonly staleMs?: number;
  readonly pollMs?: number;
  readonly heartbeatMs?: number;
  readonly errorPrefix?: string;
  /** Parent-side race seam invoked immediately before bound helper transitions. */
  readonly faultInjector?: (point: DirectoryLockFaultPoint) => void;
  /** Serializable child-helper syscall faults. Test-only; never inferred from production input. */
  readonly helperFaults?: readonly DirectoryLockFaultPoint[];
}

export type DirectoryLockFaultPoint =
  | 'parent_revalidate'
  | 'segment_revalidate'
  | 'lock_mkdir'
  | 'after_owner_publish_crash'
  | 'reclaim_rename'
  | 'cleanup_candidate_replace'
  | 'cleanup_remove'
  | 'owner_read'
  | 'heartbeat_write'
  | 'release_remove';

export type AtomicWritePhase =
  | 'not_committed'
  | 'committed'
  | 'commit_durability_unknown';

export interface AtomicWriteResult {
  readonly phase: 'committed';
  readonly bytes: number;
}

export type AtomicWriteFaultPoint =
  | 'parent_revalidate'
  | 'segment_revalidate'
  | 'temp_open'
  | 'write'
  | 'file_chmod'
  | 'file_fsync'
  | 'file_close'
  | 'rename'
  | 'exclusive_temp_unlink'
  | 'after_commit_crash'
  | 'directory_open'
  | 'directory_fsync'
  | 'directory_close'
  | 'temp_unlink'
  | 'cleanup_candidate_replace'
  | 'cleanup_remove';

export interface AtomicWriteOptions {
  /** Maximum UTF-8 payload bytes. Defaults to 8 MiB. */
  readonly maxBytes?: number;
  /** New-file mode. Existing regular files preserve their current mode by default. */
  readonly mode?: number;
  /** Parent-side race seam invoked immediately before bound helper transitions. */
  readonly faultInjector?: (point: AtomicWriteFaultPoint) => void;
  /** Serializable child-helper syscall faults. Test-only; never inferred from serialized state. */
  readonly helperFaults?: readonly AtomicWriteFaultPoint[];
}

export interface AtomicDirectoryPublishOptions {
  /** Test-only helper faults; after_commit_crash terminates the publishing child after rename. */
  readonly helperFaults?: readonly ('directory_publish' | 'after_commit_crash')[];
  readonly faultInjector?: (point: 'parent_revalidate' | 'segment_revalidate') => void;
}

export const ATOMIC_STAGE_MARKER_FILE = '.omcu-stage.json';

export interface AtomicStagingDirectoryMarker {
  readonly schema_version: 1;
  readonly target: string;
  readonly token: string;
  readonly stage_dev: number;
  readonly stage_ino: number;
  readonly creator: Pick<ProcessIdentity, 'pid' | 'start_identity' | 'start_identity_proven'>;
}

export interface AtomicStagingDirectoryProof {
  readonly dev: number;
  readonly ino: number;
  readonly marker: AtomicStagingDirectoryMarker;
}

export interface BoundQuarantineOptions {
  readonly errorPrefix?: string;
  /** Test/doctor seam after the parent and file identity are captured but before helper spawn. */
  readonly beforeRevalidate?: () => void;
  /** Optional caller-validated invalid snapshot that the quarantine must still match exactly. */
  readonly expectedSnapshot?: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly sha256: string;
  };
}

export class AtomicWriteError extends Error {
  readonly phase: AtomicWritePhase;
  readonly causeError?: unknown;
  readonly cleanupError?: unknown;
  readonly recoveryArtifact: string | undefined;

  constructor(
    message: string,
    phase: AtomicWritePhase,
    causeError?: unknown,
    cleanupError?: unknown,
    recoveryArtifact?: string,
  ) {
    super(message, causeError === undefined ? undefined : { cause: causeError });
    this.name = 'AtomicWriteError';
    this.phase = phase;
    this.causeError = causeError;
    this.cleanupError = cleanupError;
    this.recoveryArtifact = recoveryArtifact;
  }
}

export class DirectoryLockError extends Error {
  readonly phase = 'post_action_cleanup_failed' as const;
  readonly actionCompleted = true;
  readonly cleanupError: unknown;

  constructor(cleanupError: unknown, errorPrefix = 'E_LOCK') {
    super(`${errorPrefix}_POST_ACTION_CLEANUP_FAILED: ${errorText(cleanupError)}`, { cause: cleanupError });
    this.name = 'DirectoryLockError';
    this.cleanupError = cleanupError;
  }
}

export class DirectoryLockDualFailureError extends AggregateError {
  readonly primaryError: unknown;
  readonly cleanupError: unknown;

  constructor(primaryError: unknown, cleanupError: unknown, errorPrefix = 'E_LOCK') {
    super(
      [primaryError, cleanupError],
      `${errorPrefix}_ACTION_AND_CLEANUP_FAILED: ${errorText(primaryError)}`,
      { cause: primaryError },
    );
    this.name = 'DirectoryLockDualFailureError';
    this.primaryError = primaryError;
    this.cleanupError = cleanupError;
  }
}

interface DirectoryLockOwner {
  readonly schema_version: 1;
  readonly pid: number;
  readonly start_identity: string;
  readonly start_identity_proven: boolean;
  readonly token: string;
  readonly created_at_ms: number;
  readonly renewed_at_ms: number;
}

interface LegacyDirectoryLockOwner {
  readonly schema_version: 1;
  readonly pid: number;
  readonly token: string;
  readonly created_at_ms: number;
}

const DEFAULT_LOCK_STALE_MS = 60_000;
const DEFAULT_LOCK_POLL_MS = 20;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const ARTIFACT_CLEANUP_AGE_MS = 24 * 60 * 60 * 1_000;
const ARTIFACT_CLEANUP_LIMIT = 32;
const ARTIFACT_SCAN_LIMIT = 256;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invokeFault(options: AtomicWriteOptions, point: AtomicWriteFaultPoint): void {
  options.faultInjector?.(point);
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface SecuredFilePath {
  readonly file: string;
  readonly parent: string;
  readonly parentIdentity: DirectoryIdentity;
}

interface BoundHelperResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly committed?: boolean;
  readonly exists?: boolean;
  readonly recovery?: string;
  readonly lockDev?: number;
  readonly lockIno?: number;
}

/*
 * Node does not expose openat(2).  A helper process whose cwd is the already
 * canonicalized parent gives us the same essential binding: the kernel pins
 * that directory while the helper validates `.` and performs only relative
 * basename operations.  Renaming/replacing the pathname after spawn cannot
 * redirect those operations to another directory.
 */
const BOUND_DIRECTORY_HELPER = String.raw`
const fs = require('node:fs');
const crypto = require('node:crypto');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const result = { ok: false };
const fail = (code, error, committed = false) => {
  result.code = code;
  result.message = error instanceof Error ? error.message : String(error);
  result.committed = committed;
};
const owned = (stat) => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const validateCwd = () => {
  const stat = fs.lstatSync('.');
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || stat.dev !== input.dev || stat.ino !== input.ino) throw new Error(input.prefix + '_PARENT_CHANGED');
};
const validateName = (name) => {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..'
    || name.includes('/') || name.includes('\\0')) throw new Error(input.prefix + '_NAME_INVALID');
};
const inject = (point) => {
  if (Array.isArray(input.faults) && input.faults.includes(point)) {
    throw new Error(input.prefix + '_FAULT_' + String(point).toUpperCase());
  }
};
const crash = (point) => {
  if (Array.isArray(input.faults) && input.faults.includes(point)) {
    process.kill(process.pid, 'SIGKILL');
  }
};
const validateStageMarker = (stage, proof) => {
  validateName(stage);
  if (!proof || typeof proof !== 'object') throw new Error(input.prefix + '_STAGE_PROOF_INVALID');
  const stageStat = fs.lstatSync(stage);
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink() || !owned(stageStat)
    || stageStat.dev !== proof.dev || stageStat.ino !== proof.ino) {
    throw new Error(input.prefix + '_STAGE_CHANGED');
  }
  const markerName = stage + '/.omcu-stage.json';
  const markerStat = fs.lstatSync(markerName);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || !owned(markerStat)) {
    throw new Error(input.prefix + '_STAGE_MARKER_UNSAFE');
  }
  const marker = JSON.parse(fs.readFileSync(markerName, 'utf8'));
  const expected = proof.marker;
  const creator = marker && marker.creator;
  const expectedCreator = expected && expected.creator;
  if (!marker || typeof marker !== 'object' || marker.schema_version !== 1
    || marker.target !== input.target || marker.target !== expected.target
    || typeof marker.token !== 'string' || !/^[a-f0-9]{64}$/.test(marker.token)
    || marker.token !== expected.token
    || marker.stage_dev !== proof.dev || marker.stage_ino !== proof.ino
    || marker.stage_dev !== expected.stage_dev || marker.stage_ino !== expected.stage_ino
    || !creator || !expectedCreator
    || creator.pid !== expectedCreator.pid
    || creator.start_identity !== expectedCreator.start_identity
    || creator.start_identity_proven !== expectedCreator.start_identity_proven) {
    throw new Error(input.prefix + '_STAGE_MARKER_INVALID');
  }
  return marker;
};
const creatorIsDead = (creator) => {
  if (!creator || !Number.isSafeInteger(creator.pid) || creator.pid <= 0) return false;
  try { process.kill(creator.pid, 0); return false; }
  catch (error) { return Boolean(error && error.code === 'ESRCH'); }
};
const exactOwnerShape = (owner, allowLegacy) => {
  if (!owner || typeof owner !== 'object') return false;
  const keys = Object.keys(owner).sort().join(',');
  const modern = 'created_at_ms,pid,renewed_at_ms,schema_version,start_identity,start_identity_proven,token';
  const legacy = 'created_at_ms,pid,schema_version,token';
  return keys === modern || (allowLegacy && keys === legacy);
};
const validOwnerRecord = (owner, allowLegacy, now = Date.now()) => {
  if (!exactOwnerShape(owner, allowLegacy) || owner.schema_version !== 1
    || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
    || typeof owner.token !== 'string' || !/^[a-f0-9]{32}$/.test(owner.token)
    || !Number.isSafeInteger(owner.created_at_ms) || owner.created_at_ms <= 0
    || owner.created_at_ms > now + 60000) return false;
  if (!('renewed_at_ms' in owner)) return allowLegacy;
  return typeof owner.start_identity === 'string'
    && owner.start_identity.length > 0 && owner.start_identity.length <= 512
    && typeof owner.start_identity_proven === 'boolean'
    && Number.isSafeInteger(owner.renewed_at_ms) && owner.renewed_at_ms > 0
    && owner.renewed_at_ms >= owner.created_at_ms
    && owner.renewed_at_ms <= now + 60000;
};
const generatedArtifactName = (name, prefix) => {
  if (!name.startsWith(prefix)) return false;
  const match = /^([1-9]\d*)-[a-f0-9]{16}$/.exec(name.slice(prefix.length));
  return match !== null && Number.isSafeInteger(Number(match[1]));
};
const validStaleLockArtifact = (name) => {
  let fd;
  try {
    const ownerStat = fs.lstatSync(name + '/owner.json');
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || !owned(ownerStat)
      || ownerStat.size <= 0 || ownerStat.size > 16 * 1024
      || (process.platform !== 'win32' && (ownerStat.mode & 0o077) !== 0)) return false;
    fd = fs.openSync(name + '/owner.json', fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== ownerStat.dev || opened.ino !== ownerStat.ino
      || opened.size !== ownerStat.size || !owned(opened)
      || (process.platform !== 'win32' && (opened.mode & 0o077) !== 0)) return false;
    const buffer = Buffer.alloc(16 * 1024 + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    const finalStat = fs.fstatSync(fd);
    if (offset !== ownerStat.size || finalStat.dev !== ownerStat.dev || finalStat.ino !== ownerStat.ino
      || finalStat.size !== ownerStat.size || !owned(finalStat)
      || (process.platform !== 'win32' && (finalStat.mode & 0o077) !== 0)) return false;
    return validOwnerRecord(JSON.parse(buffer.subarray(0, offset).toString('utf8')), true);
  } catch { return false; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
};
const cleanupOld = (prefix, directories) => {
  const now = Date.now();
  const candidates = [];
  const directory = fs.opendirSync('.');
  try {
    let traversed = 0;
    let matched = 0;
    const traversalLimit = input.scanLimit * 64;
    while (traversed < traversalLimit && matched < input.scanLimit) {
      const entry = directory.readSync();
      if (entry === null) break;
      traversed += 1;
      const name = entry.name;
      if (!generatedArtifactName(name, prefix)) continue;
      try {
        const stat = fs.lstatSync(name);
        if (stat.isSymbolicLink() || !owned(stat) || now - stat.mtimeMs < input.cleanupAge) continue;
        if (directories ? !stat.isDirectory() : !stat.isFile()) continue;
        if (directories && !validStaleLockArtifact(name)) continue;
        matched += 1;
        candidates.push({ name, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino });
      } catch {}
    }
  } finally { directory.closeSync(); }
  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  let removed = 0;
  let replacementInjected = false;
  for (const { name, dev, ino } of candidates) {
    if (removed >= input.cleanupLimit) break;
    try {
      const stat = fs.lstatSync(name);
      if (stat.isSymbolicLink() || !owned(stat) || now - stat.mtimeMs < input.cleanupAge) continue;
      if (directories ? !stat.isDirectory() : !stat.isFile()) continue;
      if (stat.dev !== dev || stat.ino !== ino) continue;
      if (directories && !validStaleLockArtifact(name)) continue;
      if (!replacementInjected && Array.isArray(input.faults)
        && input.faults.includes('cleanup_candidate_replace')) {
        replacementInjected = true;
        const displaced = name + '.test-displaced';
        fs.renameSync(name, displaced);
        if (directories) fs.mkdirSync(name, { mode: 0o700 });
        else fs.writeFileSync(name, 'replacement', { mode: 0o600 });
      }
      const quarantine = prefix + process.pid + '-' + crypto.randomBytes(8).toString('hex');
      fs.renameSync(name, quarantine);
      let authenticated = false;
      try {
        const quarantineStat = fs.lstatSync(quarantine);
        authenticated = !quarantineStat.isSymbolicLink() && owned(quarantineStat)
          && quarantineStat.dev === dev && quarantineStat.ino === ino
          && (directories ? quarantineStat.isDirectory() : quarantineStat.isFile())
          && (!directories || validStaleLockArtifact(quarantine));
      } catch {}
      if (!authenticated) {
        try { fs.renameSync(quarantine, name); } catch {}
        continue;
      }
      try {
        inject('cleanup_remove');
        if (directories) fs.rmSync(quarantine, { recursive: true }); else fs.unlinkSync(quarantine);
      } catch {
        try { fs.renameSync(quarantine, name); } catch {}
        continue;
      }
      removed += 1;
    } catch {}
  }
};
const writeTemp = () => {
  validateName(input.temp);
  let fd;
  let operationError;
  try {
    inject('temp_open');
    fd = fs.openSync(input.temp, 'wx', input.mode);
    if (Array.isArray(input.faults) && input.faults.includes('write')) {
      const partial = Buffer.from(input.body).subarray(0, Math.max(1, Math.floor(Buffer.byteLength(input.body) / 2)));
      fs.writeFileSync(fd, partial);
      inject('write');
    }
    fs.writeFileSync(fd, input.body);
    inject('file_chmod');
    fs.fchmodSync(fd, input.mode);
    inject('file_fsync');
    fs.fsyncSync(fd);
  } catch (error) {
    operationError = error;
  }
  if (fd !== undefined) {
    try { inject('file_close'); fs.closeSync(fd); }
    catch (error) { if (operationError === undefined) operationError = error; else try { fs.closeSync(fd); } catch {} }
  }
  if (operationError !== undefined) throw operationError;
};
const commit = () => {
  validateName(input.temp); validateName(input.target);
  inject('rename');
  if (input.exclusive) {
    fs.linkSync(input.temp, input.target);
    result.committed = true;
    inject('exclusive_temp_unlink');
    fs.unlinkSync(input.temp);
  } else {
    fs.renameSync(input.temp, input.target);
    result.committed = true;
  }
};
const cleanupTemp = () => {
  validateName(input.temp);
  try { inject('temp_unlink'); fs.unlinkSync(input.temp); }
  catch (error) {
    if (error && error.code === 'ENOENT') return;
    const recovery = input.temp + '.failed-' + crypto.randomBytes(4).toString('hex');
    fs.renameSync(input.temp, recovery);
    result.recovery = recovery;
    throw error;
  }
};
const readOwner = (lock) => {
  validateName(lock);
  return JSON.parse(fs.readFileSync(lock + '/owner.json', 'utf8'));
};
const syncDirectory = () => {
  let fd;
  let operationError;
  try {
    inject('directory_open');
    fd = fs.openSync('.', 'r');
    inject('directory_fsync');
    fs.fsyncSync(fd);
  } catch (error) { operationError = error; }
  if (fd !== undefined) {
    try { inject('directory_close'); fs.closeSync(fd); }
    catch (error) { if (operationError === undefined) operationError = error; else try { fs.closeSync(fd); } catch {} }
  }
  if (operationError !== undefined) throw operationError;
};
try {
  validateCwd();
  if (input.op === 'atomic-all') {
    validateName(input.target); validateName(input.temp);
    cleanupOld(input.target + '.tmp-', false);
    writeTemp(); commit(); crash('after_commit_crash');
    syncDirectory();
  } else if (input.op === 'cleanup-old') {
    validateName(input.target); cleanupOld(input.target + '.tmp-', false);
  } else if (input.op === 'write-temp') writeTemp();
  else if (input.op === 'commit') { commit(); crash('after_commit_crash'); }
  else if (input.op === 'cleanup-temp') cleanupTemp();
  else if (input.op === 'quarantine-temp') {
    validateName(input.temp);
    const recovery = input.temp + '.failed-' + crypto.randomBytes(4).toString('hex');
    fs.renameSync(input.temp, recovery); result.recovery = recovery;
  }
  else if (input.op === 'fsync-dir') {
    syncDirectory();
  } else if (input.op === 'lock-acquire') {
    validateName(input.lock); cleanupOld(input.lock + '.stale-', true);
    inject('lock_mkdir');
    try { fs.mkdirSync(input.lock, { mode: 0o700 }); }
    catch (error) { if (error && error.code === 'EEXIST') result.exists = true; else throw error; }
    if (!result.exists) {
      const parentFd = fs.openSync('.', 'r');
      const lockStat = fs.lstatSync(input.lock);
      result.lockDev = lockStat.dev; result.lockIno = lockStat.ino;
      process.chdir(input.lock);
      const cwdStat = fs.lstatSync('.');
      if (!cwdStat.isDirectory() || cwdStat.isSymbolicLink()
        || cwdStat.dev !== lockStat.dev || cwdStat.ino !== lockStat.ino) throw new Error(input.prefix + '_LOCK_CHANGED');
      const owner = 'owner.json';
      const temp = owner + '.tmp-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
      let fd;
      try {
        fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, input.body);
        fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd);
      } finally { if (fd !== undefined) fs.closeSync(fd); }
      fs.linkSync(temp, owner); fs.unlinkSync(temp);
      crash('after_owner_publish_crash');
      const lockFd = fs.openSync('.', 'r'); try { fs.fsyncSync(lockFd); } finally { fs.closeSync(lockFd); }
      try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    }
  } else if (input.op === 'lock-cleanup') {
    validateName(input.lock);
    const stat = fs.lstatSync(input.lock);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)
      || stat.dev !== input.lockDev || stat.ino !== input.lockIno) throw new Error(input.prefix + '_LOCK_CHANGED');
    fs.rmSync(input.lock, { recursive: true });
  } else if (input.op === 'lock-reclaim') {
    validateName(input.lock); validateName(input.reclaimed);
    inject('reclaim_rename');
    fs.renameSync(input.lock, input.reclaimed);
    try {
      const stat = fs.lstatSync(input.reclaimed);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)
        || stat.dev !== input.lockDev || stat.ino !== input.lockIno) {
        throw new Error(input.prefix + '_LOCK_CHANGED');
      }
      const owner = readOwner(input.reclaimed);
      if (!input.owner || !exactOwnerShape(owner, true) || owner.schema_version !== 1
        || owner.pid !== input.owner.pid || owner.start_identity !== input.owner.start_identity
        || owner.start_identity_proven !== input.owner.start_identity_proven
        || owner.token !== input.owner.token || owner.created_at_ms !== input.owner.created_at_ms
        || owner.renewed_at_ms !== input.owner.renewed_at_ms || !creatorIsDead(owner)) {
        throw new Error(input.prefix + '_LOCK_OWNER_CHANGED');
      }
    } catch (error) {
      try { fs.renameSync(input.reclaimed, input.lock); } catch {}
      throw error;
    }
    fs.rmSync(input.reclaimed, { recursive: true });
  } else if (input.op === 'lock-release') {
    validateName(input.lock);
    const quarantine = input.lock + '.release-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
    fs.renameSync(input.lock, quarantine);
    const stat = fs.lstatSync(quarantine);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)
      || stat.dev !== input.lockDev || stat.ino !== input.lockIno) {
      try { fs.renameSync(quarantine, input.lock); } catch {}
      throw new Error(input.prefix + '_LOCK_CHANGED');
    }
    const owner = readOwner(quarantine);
    if (!exactOwnerShape(owner, false)
      || owner.pid !== input.owner.pid || owner.start_identity !== input.owner.start_identity
      || owner.start_identity_proven !== input.owner.start_identity_proven
      || owner.token !== input.owner.token) {
      try { fs.renameSync(quarantine, input.lock); } catch {}
      throw new Error(input.prefix + '_OWNERSHIP_LOST');
    }
    try { inject('release_remove'); fs.rmSync(quarantine, { recursive: true }); }
    catch (error) {
      try { fs.renameSync(quarantine, input.lock); } catch {}
      throw error;
    }
  } else if (input.op === 'quarantine-file') {
    validateName(input.target); validateName(input.quarantine);
    fs.renameSync(input.target, input.quarantine);
    try {
      const stat = fs.lstatSync(input.quarantine);
      if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat)
        || stat.dev !== input.fileDev || stat.ino !== input.fileIno || stat.size !== input.fileSize) {
        throw new Error(input.prefix + '_CHANGED');
      }
      const body = fs.readFileSync(input.quarantine);
      if (crypto.createHash('sha256').update(body).digest('hex') !== input.sha256) {
        throw new Error(input.prefix + '_CHANGED');
      }
    } catch (error) {
      try { fs.renameSync(input.quarantine, input.target); } catch {}
      throw error;
    }
    result.recovery = input.quarantine;
  } else if (input.op === 'publish-directory') {
    validateName(input.stage); validateName(input.target);
    validateStageMarker(input.stage, input.proof);
    try { fs.lstatSync(input.target); result.exists = true; }
    catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    if (!result.exists) {
      inject('directory_publish');
      fs.renameSync(input.stage, input.target);
      result.committed = true;
      crash('after_commit_crash');
      syncDirectory();
    }
  } else if (input.op === 'remove-directory') {
    validateName(input.target);
    validateStageMarker(input.stage, input.proof);
    fs.rmSync(input.stage, { recursive: true });
    syncDirectory();
  } else if (input.op === 'remove-bootstrap-directory') {
    validateName(input.stage); validateName(input.target);
    const expectedPrefix = '.' + input.target + '.init-';
    const stageSuffix = input.stage.slice(expectedPrefix.length);
    if (input.stagePrefix !== expectedPrefix || !input.stage.startsWith(expectedPrefix)
      || !/^\d+-[a-f0-9]{16}$/.test(stageSuffix)) {
      throw new Error(input.prefix + '_STAGE_PREFIX_INVALID');
    }
    const quarantine = input.stage + '.bootstrap-remove-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
    validateName(quarantine);
    fs.renameSync(input.stage, quarantine);
    try {
      const stat = fs.lstatSync(quarantine);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat)
        || stat.dev !== input.stageDev || stat.ino !== input.stageIno) {
        throw new Error(input.prefix + '_STAGE_CHANGED');
      }
      try {
        fs.lstatSync(quarantine + '/.omcu-stage.json');
        throw new Error(input.prefix + '_STAGE_MARKER_PUBLISHED');
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }
      fs.rmSync(quarantine, { recursive: true });
      syncDirectory();
    } catch (error) {
      try { fs.renameSync(quarantine, input.stage); } catch {}
      throw error;
    }
  } else if (input.op === 'cleanup-stages') {
    if (typeof input.stagePrefix !== 'string' || input.stagePrefix === ''
      || input.stagePrefix.includes('/') || input.stagePrefix.includes('\\0')) {
      throw new Error(input.prefix + '_STAGE_PREFIX_INVALID');
    }
    validateName(input.target);
    if (!Array.isArray(input.proofs) || input.proofs.length > input.cleanupLimit) {
      throw new Error(input.prefix + '_STAGE_LIMIT');
    }
    let removed = 0;
    for (const candidate of input.proofs) {
      if (!candidate || typeof candidate.name !== 'string' || !candidate.name.startsWith(input.stagePrefix)) {
        throw new Error(input.prefix + '_STAGE_PROOF_INVALID');
      }
      const marker = validateStageMarker(candidate.name, candidate.proof);
      if (!creatorIsDead(marker.creator)) throw new Error(input.prefix + '_STAGE_CREATOR_ACTIVE');
      fs.rmSync(candidate.name, { recursive: true });
      removed += 1;
    }
    if (removed > 0) syncDirectory();
  } else throw new Error(input.prefix + '_HELPER_OPERATION_INVALID');
  result.ok = true;
} catch (error) {
  fail(input.prefix + '_HELPER_FAILED', error, result.committed === true);
}
process.stdout.write(JSON.stringify(result));
`;

function runBoundHelper(
  secured: SecuredFilePath,
  request: Readonly<Record<string, unknown>>,
  errorPrefix: string,
  maxBuffer = DEFAULT_MAX_BYTES + 64 * 1024,
): BoundHelperResult {
  if (process.platform === 'win32') {
    throw new Error(`${errorPrefix}_BOUND_DIRECTORY_UNSUPPORTED`);
  }
  const input = JSON.stringify({
    ...request,
    dev: secured.parentIdentity.dev,
    ino: secured.parentIdentity.ino,
    prefix: errorPrefix,
    cleanupAge: ARTIFACT_CLEANUP_AGE_MS,
    cleanupLimit: ARTIFACT_CLEANUP_LIMIT,
    scanLimit: ARTIFACT_SCAN_LIMIT,
  });
  const child = spawnSync(process.execPath, ['-e', BOUND_DIRECTORY_HELPER], {
    cwd: secured.parent,
    input,
    encoding: 'utf8',
    maxBuffer,
    windowsHide: true,
  });
  const commitCapable = request.op === 'atomic-all' || request.op === 'commit' || request.op === 'publish-directory';
  const uncertainCommit = (reason: string): never => {
    throw new AtomicWriteError(
      `${errorPrefix}_DURABILITY_UNKNOWN: ${reason}`,
      'commit_durability_unknown',
    );
  };
  if (child.error !== undefined) {
    if (child.pid === undefined) {
      throw new Error(`${errorPrefix}_HELPER_START_FAILED: ${errorText(child.error)}`);
    }
    if (commitCapable) uncertainCommit(`${errorPrefix}_HELPER_FAILED: ${errorText(child.error)}`);
    throw new Error(`${errorPrefix}_HELPER_FAILED: ${errorText(child.error)}`);
  }
  if (child.status !== 0 || child.signal !== null) {
    const reason = `${errorPrefix}_HELPER_EXIT_FAILED: ${child.signal ?? child.status ?? 'unknown'}`;
    if (commitCapable) uncertainCommit(reason);
    throw new Error(reason);
  }
  try {
    const result = JSON.parse(child.stdout) as BoundHelperResult;
    if (typeof result.ok !== 'boolean') throw new Error('invalid result');
    return result;
  } catch (error) {
    const reason = `${errorPrefix}_HELPER_PROTOCOL_FAILED: ${errorText(error)}`;
    if (commitCapable) uncertainCommit(reason);
    throw new Error(reason);
  }
}

/** Same-parent atomic directory publication. The caller owns the unpublished staging directory. */
export function atomicPublishDirectory(
  stagingDirectory: string,
  targetDirectory: string,
  proof: AtomicStagingDirectoryProof,
  options: AtomicDirectoryPublishOptions = {},
): AtomicWriteResult {
  const target = secureFilePath(
    targetDirectory,
    'E_ATOMIC_DIRECTORY',
    (phase) => options.faultInjector?.(phase === 'parent' ? 'parent_revalidate' : 'segment_revalidate'),
  );
  const staging = path.resolve(stagingDirectory);
  if (path.dirname(staging) !== target.parent) {
    throw new AtomicWriteError('E_ATOMIC_DIRECTORY_STAGE_PARENT_INVALID', 'not_committed');
  }
  try {
    const result = runBoundHelper(target, {
      op: 'publish-directory',
      stage: path.basename(staging),
      target: path.basename(target.file),
      proof,
      faults: options.helperFaults,
    }, 'E_ATOMIC_DIRECTORY', 64 * 1024);
    if (result.exists === true) throw new AtomicWriteError('E_ATOMIC_DIRECTORY_EXISTS', 'not_committed');
    if (!result.ok) {
      throw new AtomicWriteError(
        result.committed === true ? 'E_ATOMIC_DIRECTORY_DURABILITY_UNKNOWN' : 'E_ATOMIC_DIRECTORY_NOT_COMMITTED',
        result.committed === true ? 'commit_durability_unknown' : 'not_committed',
      );
    }
    return { phase: 'committed', bytes: 0 };
  } catch (error) {
    throw asAtomicPrecommit(error);
  }
}

/** Remove one exact owned sibling staging directory through the bound helper. */
export function removeAtomicStagingDirectory(
  stagingDirectory: string,
  targetDirectory: string,
  proof: AtomicStagingDirectoryProof,
): void {
  const target = secureFilePath(targetDirectory, 'E_ATOMIC_DIRECTORY');
  const staging = path.resolve(stagingDirectory);
  if (path.dirname(staging) !== target.parent) throw new Error('E_ATOMIC_DIRECTORY_STAGE_PARENT_INVALID');
  const result = runBoundHelper(target, {
    op: 'remove-directory', stage: path.basename(staging), target: path.basename(target.file), proof,
  }, 'E_ATOMIC_DIRECTORY', 64 * 1024);
  if (!result.ok) throw new Error(result.message ?? result.code ?? 'E_ATOMIC_DIRECTORY_REMOVE_FAILED');
}

/** Remove one exact unpublished team-init stage. A published marker makes this fail closed. */
export function removeAtomicBootstrapStagingDirectory(
  stagingDirectory: string,
  targetDirectory: string,
  stagePrefix: string,
  identity: Readonly<DirectoryIdentity>,
): void {
  const target = secureFilePath(targetDirectory, 'E_ATOMIC_DIRECTORY');
  const staging = path.resolve(stagingDirectory);
  if (path.dirname(staging) !== target.parent) throw new Error('E_ATOMIC_DIRECTORY_STAGE_PARENT_INVALID');
  const result = runBoundHelper(target, {
    op: 'remove-bootstrap-directory',
    stage: path.basename(staging),
    target: path.basename(target.file),
    stagePrefix,
    stageDev: identity.dev,
    stageIno: identity.ino,
  }, 'E_ATOMIC_DIRECTORY', 64 * 1024);
  if (!result.ok) throw new Error(result.message ?? result.code ?? 'E_ATOMIC_DIRECTORY_REMOVE_FAILED');
}

/** Remove abandoned transaction-owned sibling stages while the caller holds the target lock. */
export function cleanupAtomicStagingDirectories(targetDirectory: string, stagePrefix: string): void {
  const target = secureFilePath(targetDirectory, 'E_ATOMIC_DIRECTORY');
  const proofs: { readonly name: string; readonly proof: AtomicStagingDirectoryProof }[] = [];
  let scanned = 0;
  for (const entry of fs.readdirSync(target.parent, { withFileTypes: true })) {
    if (scanned >= ARTIFACT_SCAN_LIMIT || proofs.length >= ARTIFACT_CLEANUP_LIMIT) break;
    if (!entry.name.startsWith(stagePrefix)) continue;
    scanned += 1;
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const stage = path.join(target.parent, entry.name);
      const stat = fs.lstatSync(stage);
      const markerStat = fs.lstatSync(path.join(stage, ATOMIC_STAGE_MARKER_FILE));
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || !markerStat.isFile() || markerStat.isSymbolicLink()) continue;
      const marker = JSON.parse(fs.readFileSync(path.join(stage, ATOMIC_STAGE_MARKER_FILE), 'utf8')) as AtomicStagingDirectoryMarker;
      if (marker.schema_version !== 1 || marker.target !== path.basename(target.file)
        || !/^[a-f0-9]{64}$/.test(marker.token)
        || marker.stage_dev !== stat.dev || marker.stage_ino !== stat.ino
        || !marker.creator || classifyProcessLiveness(marker.creator).status !== 'dead') continue;
      proofs.push({ name: entry.name, proof: { dev: stat.dev, ino: stat.ino, marker } });
    } catch { /* malformed or raced stages are not ours to remove */ }
  }
  const result = runBoundHelper(target, {
    op: 'cleanup-stages', stagePrefix, target: path.basename(target.file), proofs,
  }, 'E_ATOMIC_DIRECTORY', 64 * 1024);
  if (!result.ok) throw new Error(result.message ?? result.code ?? 'E_ATOMIC_DIRECTORY_CLEANUP_FAILED');
}

function directoryIdentity(stat: fs.Stats): DirectoryIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function assertDirectoryIdentity(
  directory: string,
  expected: DirectoryIdentity,
  errorPrefix: string,
): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || stat.dev !== expected.dev || stat.ino !== expected.ino) {
    throw new Error(`${errorPrefix}_PARENT_CHANGED`);
  }
}

/**
 * Resolve operations onto a canonical parent descriptor path. User-owned
 * existing ancestors are walked explicitly so a symlink cannot hide between
 * the requested target and its trusted, non-user-controlled ancestor.
 */
function secureFilePath(
  file: string,
  errorPrefix: string,
  beforeCanonicalize?: (phase: 'parent' | 'segment') => void,
): SecuredFilePath {
  const resolved = path.resolve(file);
  const requestedParent = path.dirname(resolved);
  const missing: string[] = [];
  let existing = requestedParent;
  let existingIdentity: DirectoryIdentity | null = null;
  while (true) {
    try {
      const stat = fs.lstatSync(existing);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${errorPrefix}_PARENT_INVALID`);
      existingIdentity = directoryIdentity(stat);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error(`${errorPrefix}_PARENT_ABSENT`, { cause: error });
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }

  // Validate every user-controlled existing ancestor, stopping at the first
  // non-user-owned trust boundary (for example /tmp or macOS /private/var).
  if (typeof process.getuid === 'function') {
    let cursor = existing;
    while (true) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${errorPrefix}_PARENT_INVALID`);
      if (stat.uid !== process.getuid()) break;
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }

  beforeCanonicalize?.('parent');
  let canonical = fs.realpathSync(existing);
  if (existingIdentity === null) throw new Error(`${errorPrefix}_PARENT_INVALID`);
  assertDirectoryIdentity(canonical, existingIdentity, errorPrefix);
  let canonicalIdentity = existingIdentity;
  for (const segment of missing) {
    const candidate = path.join(canonical, segment);
    try { fs.mkdirSync(candidate, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${errorPrefix}_PARENT_INVALID`);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error(`${errorPrefix}_PARENT_NOT_OWNED`);
    }
    const candidateIdentity = directoryIdentity(stat);
    beforeCanonicalize?.('segment');
    canonical = fs.realpathSync(candidate);
    assertDirectoryIdentity(canonical, candidateIdentity, errorPrefix);
    canonicalIdentity = candidateIdentity;
  }
  assertDirectoryIdentity(canonical, canonicalIdentity, errorPrefix);
  return {
    file: path.join(canonical, path.basename(resolved)),
    parent: canonical,
    parentIdentity: canonicalIdentity,
  };
}

function asAtomicPrecommit(error: unknown): AtomicWriteError {
  return error instanceof AtomicWriteError
    ? error
    : new AtomicWriteError(`E_ATOMIC_NOT_COMMITTED: ${errorText(error)}`, 'not_committed', error);
}

function attachAtomicCleanupEvidence(
  primary: AtomicWriteError,
  cleanup: { readonly error?: unknown; readonly recoveryArtifact?: string },
): AtomicWriteError {
  if (cleanup.error !== undefined) {
    const cleanupError = primary.cleanupError === undefined
      ? cleanup.error
      : new AggregateError(
        [primary.cleanupError, cleanup.error],
        'E_ATOMIC_TEMP_CLEANUP_FAILED',
        { cause: primary.cleanupError },
      );
    Object.defineProperty(primary, 'cleanupError', { value: cleanupError, configurable: true });
  }
  if (primary.recoveryArtifact === undefined && cleanup.recoveryArtifact !== undefined) {
    Object.defineProperty(primary, 'recoveryArtifact', {
      value: cleanup.recoveryArtifact,
      configurable: true,
    });
  }
  return primary;
}

function intendedMode(file: string, requested: number | undefined): number {
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested < 0 || requested > 0o777) {
      throw new AtomicWriteError('E_ATOMIC_MODE_INVALID', 'not_committed');
    }
    return requested;
  }
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new AtomicWriteError('E_ATOMIC_TARGET_INVALID', 'not_committed');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new AtomicWriteError('E_ATOMIC_TARGET_NOT_OWNED', 'not_committed');
    }
    return stat.mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0o600;
    throw error;
  }
}

function serialize(value: unknown, maxBytes: number): { readonly body: string; readonly bytes: number } {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (error) {
    throw new AtomicWriteError(`E_ATOMIC_SERIALIZE: ${errorText(error)}`, 'not_committed', error);
  }
  if (serialized === undefined) throw new AtomicWriteError('E_ATOMIC_SERIALIZE_UNDEFINED', 'not_committed');
  const body = `${serialized}\n`;
  return boundedText(body, maxBytes);
}

function boundedText(body: string, maxBytes: number): { readonly body: string; readonly bytes: number } {
  const bytes = Buffer.byteLength(body);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new AtomicWriteError('E_ATOMIC_MAX_BYTES_INVALID', 'not_committed');
  }
  if (bytes > maxBytes) {
    throw new AtomicWriteError('E_ATOMIC_TOO_LARGE', 'not_committed');
  }
  return { body, bytes };
}

/**
 * Quarantine one owned regular file through a helper bound to the validated
 * parent directory. The identity/content snapshot and destructive rename are
 * checked inside the same pinned directory context.
 */
export function quarantineOwnedRegularFile(
  file: string,
  options: BoundQuarantineOptions = {},
): string {
  const errorPrefix = options.errorPrefix ?? 'E_QUARANTINE';
  const secured = secureFilePath(file, errorPrefix);
  const stat = fs.lstatSync(secured.file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${errorPrefix}_UNSAFE`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${errorPrefix}_NOT_OWNED`);
  }
  const body = fs.readFileSync(secured.file);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  if (options.expectedSnapshot !== undefined) {
    const expected = options.expectedSnapshot;
    if (stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size !== expected.size
      || sha256 !== expected.sha256) {
      throw new Error(`${errorPrefix}_CHANGED`);
    }
  }
  const quarantine = `${path.basename(secured.file)}.invalid-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  options.beforeRevalidate?.();
  const result = runBoundHelper(secured, {
    op: 'quarantine-file',
    target: path.basename(secured.file),
    quarantine,
    fileDev: stat.dev,
    fileIno: stat.ino,
    fileSize: stat.size,
    sha256,
  }, errorPrefix, 64 * 1024);
  if (!result.ok || result.recovery !== quarantine) {
    throw new Error(result.message ?? result.code ?? `${errorPrefix}_FAILED`);
  }
  return path.join(secured.parent, quarantine);
}

function atomicWritePrepared(
  secured: SecuredFilePath,
  body: string,
  bytes: number,
  mode: number,
  options: AtomicWriteOptions,
  exclusive: boolean,
): AtomicWriteResult {
  const file = secured.file;
  const target = path.basename(file);
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  let committed = false;
  try {
    if (options.faultInjector === undefined && options.helperFaults === undefined) {
      const result = runBoundHelper(secured, {
        op: 'atomic-all', target, temp: temporary, body, mode, exclusive,
      }, 'E_ATOMIC');
      if (!result.ok) {
        committed = result.committed === true;
        throw new Error(result.message ?? result.code ?? 'E_ATOMIC_HELPER_FAILED');
      }
      committed = true;
    } else {
      const cleanup = runBoundHelper(secured, {
        op: 'cleanup-old', target, faults: options.helperFaults,
      }, 'E_ATOMIC');
      if (!cleanup.ok) throw new Error(cleanup.message ?? cleanup.code ?? 'E_ATOMIC_HELPER_FAILED');
      invokeFault(options, 'temp_open');
      invokeFault(options, 'write');
      invokeFault(options, 'file_chmod');
      invokeFault(options, 'file_fsync');
      invokeFault(options, 'file_close');
      const written = runBoundHelper(secured, {
        op: 'write-temp', temp: temporary, body, mode, faults: options.helperFaults,
      }, 'E_ATOMIC');
      if (!written.ok) throw new Error(written.message ?? written.code ?? 'E_ATOMIC_HELPER_FAILED');
      invokeFault(options, 'rename');
      const result = runBoundHelper(secured, {
        op: 'commit', target, temp: temporary, exclusive, faults: options.helperFaults,
      }, 'E_ATOMIC');
      if (!result.ok) {
        committed = result.committed === true;
        throw new Error(result.message ?? result.code ?? 'E_ATOMIC_HELPER_FAILED');
      }
      committed = true;
      invokeFault(options, 'directory_open');
      invokeFault(options, 'directory_fsync');
      invokeFault(options, 'directory_close');
      const finalized = runBoundHelper(secured, { op: 'fsync-dir', faults: options.helperFaults }, 'E_ATOMIC');
      if (!finalized.ok) {
        throw new AtomicWriteError(
          `E_ATOMIC_DURABILITY_UNKNOWN: ${finalized.message ?? finalized.code ?? 'helper failure'}`,
          'commit_durability_unknown',
        );
      }
    }
  } catch (error) {
    let cleanup: { readonly error?: unknown; readonly recoveryArtifact?: string } = {};
    if (!committed || exclusive) {
      try {
        invokeFault(options, 'temp_unlink');
        const result = runBoundHelper(secured, {
          op: 'cleanup-temp', temp: temporary, faults: options.helperFaults,
        }, 'E_ATOMIC');
        if (!result.ok) {
          cleanup = {
            error: new Error(result.message ?? result.code ?? 'E_ATOMIC_TEMP_CLEANUP_FAILED'),
            ...(result.recovery === undefined ? {} : { recoveryArtifact: path.join(secured.parent, result.recovery) }),
          };
        }
      } catch (cleanupError) {
        try {
          const result = runBoundHelper(secured, { op: 'quarantine-temp', temp: temporary }, 'E_ATOMIC');
          cleanup = {
            error: cleanupError,
            ...(result.recovery === undefined ? {} : { recoveryArtifact: path.join(secured.parent, result.recovery) }),
          };
        } catch (quarantineError) {
          cleanup = { error: new AggregateError([cleanupError, quarantineError], 'E_ATOMIC_TEMP_CLEANUP_FAILED') };
        }
      }
    }
    if (error instanceof AtomicWriteError) throw attachAtomicCleanupEvidence(error, cleanup);
    throw new AtomicWriteError(
      `${committed ? 'E_ATOMIC_DURABILITY_UNKNOWN' : 'E_ATOMIC_NOT_COMMITTED'}: ${errorText(error)}`,
      committed ? 'commit_durability_unknown' : 'not_committed',
      error,
      cleanup.error,
      cleanup.recoveryArtifact,
    );
  }
  return { phase: 'committed', bytes };
}

/** Atomically replace a JSON file, preserving an existing regular file's mode by default. */
export function atomicWriteJson(
  file: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): AtomicWriteResult {
  try {
    const { body, bytes } = serialize(value, options.maxBytes ?? DEFAULT_MAX_BYTES);
    const secured = secureFilePath(
      file,
      'E_ATOMIC',
      (phase) => invokeFault(options, phase === 'parent' ? 'parent_revalidate' : 'segment_revalidate'),
    );
    return atomicWritePrepared(
      secured,
      body,
      bytes,
      intendedMode(secured.file, options.mode),
      options,
      false,
    );
  } catch (error) {
    throw asAtomicPrecommit(error);
  }
}

/** Atomically replace a UTF-8 text file without applying JSON serialization. */
export function atomicWriteText(
  file: string,
  value: string,
  options: AtomicWriteOptions = {},
): AtomicWriteResult {
  try {
    const { body, bytes } = boundedText(value, options.maxBytes ?? DEFAULT_MAX_BYTES);
    const secured = secureFilePath(
      file,
      'E_ATOMIC',
      (phase) => invokeFault(options, phase === 'parent' ? 'parent_revalidate' : 'segment_revalidate'),
    );
    return atomicWritePrepared(
      secured,
      body,
      bytes,
      intendedMode(secured.file, options.mode),
      options,
      false,
    );
  } catch (error) {
    throw asAtomicPrecommit(error);
  }
}

/** Crash-safe exclusive create. EEXIST is reported as a typed pre-commit failure. */
export function atomicCreateJson(
  file: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): AtomicWriteResult {
  try {
    const { body, bytes } = serialize(value, options.maxBytes ?? DEFAULT_MAX_BYTES);
    const secured = secureFilePath(
      file,
      'E_ATOMIC',
      (phase) => invokeFault(options, phase === 'parent' ? 'parent_revalidate' : 'segment_revalidate'),
    );
    let exists = false;
    try {
      fs.lstatSync(secured.file);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (exists) throw new AtomicWriteError('E_ATOMIC_EXISTS', 'not_committed');
    return atomicWritePrepared(
      secured,
      body,
      bytes,
      intendedMode(secured.file, options.mode),
      options,
      true,
    );
  } catch (error) {
    throw asAtomicPrecommit(error);
  }
}

function lockOwnerFile(lock: string): string {
  return path.join(lock, 'owner.json');
}

type LockOwnerRead =
  | { readonly status: 'valid'; readonly owner: DirectoryLockOwner | LegacyDirectoryLockOwner }
  | { readonly status: 'ambiguous' };

function readLockOwner(lock: string): LockOwnerRead {
  let fd: number | undefined;
  try {
    const file = lockOwnerFile(lock);
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > 16 * 1024
      || (typeof process.getuid === 'function' && before.uid !== process.getuid())
      || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)) return { status: 'ambiguous' };
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const after = fs.fstatSync(fd);
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || (typeof process.getuid === 'function' && after.uid !== process.getuid())
      || (process.platform !== 'win32' && (after.mode & 0o077) !== 0)) {
      return { status: 'ambiguous' };
    }
    const buffer = Buffer.alloc(16 * 1024 + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    const finalStat = fs.fstatSync(fd);
    if (offset !== before.size || finalStat.dev !== before.dev || finalStat.ino !== before.ino
      || finalStat.size !== before.size
      || (typeof process.getuid === 'function' && finalStat.uid !== process.getuid())
      || (process.platform !== 'win32' && (finalStat.mode & 0o077) !== 0)) return { status: 'ambiguous' };
    const parsed = JSON.parse(buffer.subarray(0, offset).toString('utf8')) as Partial<DirectoryLockOwner>;
    const keys = Object.keys(parsed).sort();
    const expectedKeys = [
      'created_at_ms', 'pid', 'renewed_at_ms', 'schema_version',
      'start_identity', 'start_identity_proven', 'token',
    ];
    const legacyKeys = ['created_at_ms', 'pid', 'schema_version', 'token'];
    const now = Date.now();
    const commonInvalid = parsed.schema_version !== 1 || !Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0
      || typeof parsed.token !== 'string' || !/^[a-f0-9]{32}$/.test(parsed.token)
      || !Number.isSafeInteger(parsed.created_at_ms) || (parsed.created_at_ms ?? 0) <= 0;
    if (commonInvalid || (parsed.created_at_ms ?? 0) > now + 60_000) return { status: 'ambiguous' };
    if (JSON.stringify(keys) === JSON.stringify(legacyKeys)) {
      return { status: 'valid', owner: parsed as LegacyDirectoryLockOwner };
    }
    if (typeof parsed.start_identity !== 'string' || parsed.start_identity.length === 0 || parsed.start_identity.length > 512
      || typeof parsed.start_identity_proven !== 'boolean'
      || !Number.isSafeInteger(parsed.renewed_at_ms) || (parsed.renewed_at_ms ?? 0) <= 0
      || (parsed.renewed_at_ms ?? 0) < (parsed.created_at_ms ?? 0)
      || (parsed.renewed_at_ms ?? 0) > now + 60_000
      || JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      return { status: 'ambiguous' };
    }
    return { status: 'valid', owner: parsed as DirectoryLockOwner };
  } catch {
    return { status: 'ambiguous' };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* the descriptor is not reused */ }
    }
  }
}

function lockError(options: DirectoryLockOptions, suffix: string): Error {
  return new Error(`${options.errorPrefix ?? 'E_LOCK'}_${suffix}`);
}

function assertOwnedLockDirectory(lock: string, options: DirectoryLockOptions): void {
  const stat = fs.lstatSync(lock);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw lockError(options, 'INVALID');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw lockError(options, 'NOT_OWNED');
}

function reclaimDeadLock(
  lock: string,
  parent: SecuredFilePath,
  _staleMs: number,
  options: DirectoryLockOptions,
): boolean {
  assertDirectoryIdentity(parent.parent, parent.parentIdentity, options.errorPrefix ?? 'E_LOCK');
  let lockStat: fs.Stats;
  try {
    assertOwnedLockDirectory(lock, options);
    lockStat = fs.lstatSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  const ownerRead = readLockOwner(lock);
  if (ownerRead.status === 'ambiguous') return false;
  const owner = ownerRead.owner;
  const liveness = 'start_identity' in owner
    ? classifyProcessLiveness(owner)
    : probeProcess(owner.pid);
  // Only proven process death permits reclaim. Missing, malformed, live,
  // reused-PID, or otherwise ambiguous evidence remains fail-closed.
  if (liveness.status !== 'dead') return false;
  const reclaimed = `${lock}.stale-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  options.faultInjector?.('reclaim_rename');
  const result = runBoundHelper(parent, {
    op: 'lock-reclaim',
    lock: path.basename(lock),
    reclaimed: path.basename(reclaimed),
    lockDev: lockStat.dev,
    lockIno: lockStat.ino,
    owner,
    faults: options.helperFaults,
  }, options.errorPrefix ?? 'E_LOCK');
  if (!result.ok) {
    if (result.message?.includes('ENOENT') === true) return true;
    throw new Error(result.message ?? result.code ?? `${options.errorPrefix ?? 'E_LOCK'}_RECLAIM_FAILED`);
  }
  return true;
}

function ownerFromIdentity(identity: ProcessIdentity): DirectoryLockOwner {
  const now = Date.now();
  return {
    schema_version: 1,
    pid: identity.pid,
    start_identity: identity.start_identity,
    start_identity_proven: identity.start_identity_proven,
    token: crypto.randomBytes(16).toString('hex'),
    created_at_ms: now,
    renewed_at_ms: now,
  };
}

function tryAcquireDirectoryLock(
  lock: string,
  parent: SecuredFilePath,
  options: DirectoryLockOptions,
): DirectoryLockOwner | null {
  assertDirectoryIdentity(parent.parent, parent.parentIdentity, options.errorPrefix ?? 'E_LOCK');
  const owner = ownerFromIdentity(currentProcessIdentity());
  options.faultInjector?.('lock_mkdir');
  const body = `${JSON.stringify(owner, null, 2)}\n`;
  let result: BoundHelperResult;
  try {
    result = runBoundHelper(parent, {
      op: 'lock-acquire', lock: path.basename(lock), body, faults: options.helperFaults,
    }, options.errorPrefix ?? 'E_LOCK', 64 * 1024);
  } catch (error) {
    // The helper may die after exclusively publishing owner.json but before it
    // can report the lock inode. Adopt only our exact unpredictable owner token;
    // live foreign or malformed locks remain untouched and fail closed.
    const observed = readLockOwner(lock);
    if (observed.status === 'valid' && 'start_identity' in observed.owner
      && sameOwner(observed.owner, owner)) return owner;
    throw error;
  }
  if (result.exists === true) return null;
  if (!result.ok) {
    if (result.lockDev !== undefined && result.lockIno !== undefined) {
      try {
        runBoundHelper(parent, {
          op: 'lock-cleanup', lock: path.basename(lock), lockDev: result.lockDev, lockIno: result.lockIno,
        }, options.errorPrefix ?? 'E_LOCK', 64 * 1024);
      } catch { /* fail closed: never fall back to an unbound pathname cleanup */ }
    }
    throw new Error(result.message ?? result.code ?? `${options.errorPrefix ?? 'E_LOCK'}_ACQUIRE_FAILED`);
  }
  return owner;
}

function sameOwner(left: DirectoryLockOwner, right: DirectoryLockOwner): boolean {
  return left.pid === right.pid
    && left.start_identity === right.start_identity
    && left.start_identity_proven === right.start_identity_proven
    && left.token === right.token;
}

function renewDirectoryLock(
  lock: string,
  owner: DirectoryLockOwner,
  options: DirectoryLockOptions,
): DirectoryLockOwner {
  options.faultInjector?.('owner_read');
  const current = readLockOwner(lock);
  if (current.status !== 'valid' || !('start_identity' in current.owner) || !sameOwner(current.owner, owner)) {
    throw new Error('E_LOCK_OWNERSHIP_LOST');
  }
  const renewed = { ...owner, renewed_at_ms: Date.now() };
  options.faultInjector?.('heartbeat_write');
  atomicWriteJson(lockOwnerFile(lock), renewed, {
    mode: 0o600,
    maxBytes: 16 * 1024,
    ...(options.helperFaults?.includes('heartbeat_write') === true ? { helperFaults: ['write'] } : {}),
  });
  return renewed;
}

function releaseDirectoryLock(
  lock: string,
  parent: SecuredFilePath,
  owner: DirectoryLockOwner,
  options: DirectoryLockOptions,
): void {
  options.faultInjector?.('owner_read');
  const current = readLockOwner(lock);
  if (current.status !== 'valid' || !('start_identity' in current.owner) || !sameOwner(current.owner, owner)) {
    throw lockError(options, 'OWNERSHIP_LOST');
  }
  const lockStat = fs.lstatSync(lock);
  options.faultInjector?.('release_remove');
  const result = runBoundHelper(parent, {
    op: 'lock-release',
    lock: path.basename(lock),
    lockDev: lockStat.dev,
    lockIno: lockStat.ino,
    owner,
    faults: options.helperFaults,
  }, options.errorPrefix ?? 'E_LOCK', 64 * 1024);
  if (!result.ok) throw new Error(result.message ?? result.code ?? `${options.errorPrefix ?? 'E_LOCK'}_RELEASE_FAILED`);
}

function attachCleanupError(primary: unknown, cleanup: unknown, errorPrefix = 'E_LOCK'): Error {
  if (primary instanceof Error) {
    try {
      Object.defineProperty(primary, 'cleanupError', { value: cleanup, configurable: true });
      if (primary.cause === undefined) {
        Object.defineProperty(primary, 'cause', { value: cleanup, configurable: true });
      }
      return primary;
    } catch {
      // Fall through to an envelope that preserves the unmodified primary value.
    }
  }
  return new DirectoryLockDualFailureError(primary, cleanup, errorPrefix);
}

function acquireDirectoryLockSync(
  secured: SecuredFilePath,
  timeoutMs: number,
  options: DirectoryLockOptions,
): DirectoryLockOwner {
  const deadline = Date.now() + timeoutMs;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const lock = secured.file;
  while (true) {
    const owner = tryAcquireDirectoryLock(lock, secured, options);
    if (owner !== null) return owner;
    if (reclaimDeadLock(lock, secured, staleMs, options)) continue;
    if (Date.now() >= deadline) throw lockError(options, 'TIMEOUT');
    Atomics.wait(waitBuffer, 0, 0, pollMs);
  }
}

async function acquireDirectoryLock(
  secured: SecuredFilePath,
  timeoutMs: number,
  options: DirectoryLockOptions,
): Promise<DirectoryLockOwner> {
  const deadline = Date.now() + timeoutMs;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const lock = secured.file;
  while (true) {
    const owner = tryAcquireDirectoryLock(lock, secured, options);
    if (owner !== null) return owner;
    if (reclaimDeadLock(lock, secured, staleMs, options)) continue;
    if (Date.now() >= deadline) throw lockError(options, 'TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** Run an asynchronous action under an owner-fenced directory lock adjacent to target. */
export async function withDirectoryLock<T>(
  target: string,
  action: () => T | Promise<T>,
  timeoutMs = 2_000,
  options: DirectoryLockOptions = {},
): Promise<T> {
  const secured = secureFilePath(
    `${target}.lock`,
    options.errorPrefix ?? 'E_LOCK',
    (phase) => options.faultInjector?.(phase === 'parent' ? 'parent_revalidate' : 'segment_revalidate'),
  );
  const lock = secured.file;
  const owner = await acquireDirectoryLock(secured, timeoutMs, options);
  let currentOwner = owner;
  let heartbeatError: unknown;
  const heartbeat = options.heartbeatMs !== undefined && options.heartbeatMs > 0
    ? setInterval(() => {
      try { currentOwner = renewDirectoryLock(lock, currentOwner, options); }
      catch (error) { heartbeatError ??= error; }
    }, options.heartbeatMs)
    : null;
  heartbeat?.unref();
  let actionFailed = false;
  let actionError: unknown;
  let result: T | undefined;
  try {
    result = await action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
  }
  let cleanupError: unknown;
  try { releaseDirectoryLock(lock, secured, currentOwner, options); }
  catch (error) { cleanupError = error; }
  if (actionFailed) {
    if (cleanupError !== undefined) {
      throw attachCleanupError(actionError, cleanupError, options.errorPrefix ?? 'E_LOCK');
    }
    if (heartbeatError !== undefined) {
      throw attachCleanupError(actionError, heartbeatError, options.errorPrefix ?? 'E_LOCK');
    }
    throw actionError;
  }
  if (cleanupError !== undefined) throw new DirectoryLockError(cleanupError, options.errorPrefix ?? 'E_LOCK');
  if (heartbeatError !== undefined) throw new DirectoryLockError(
    new Error('E_LOCK_HEARTBEAT_FAILED', { cause: heartbeatError }),
    options.errorPrefix ?? 'E_LOCK',
  );
  return result as T;
}

/** Synchronous counterpart for stores and setup lifecycle code. */
export function withDirectoryLockSync<T>(
  target: string,
  action: () => T,
  timeoutMs = 2_000,
  options: DirectoryLockOptions = {},
): T {
  const secured = secureFilePath(
    `${target}.lock`,
    options.errorPrefix ?? 'E_LOCK',
    (phase) => options.faultInjector?.(phase === 'parent' ? 'parent_revalidate' : 'segment_revalidate'),
  );
  const lock = secured.file;
  const owner = acquireDirectoryLockSync(secured, timeoutMs, options);
  let actionFailed = false;
  let actionError: unknown;
  let result: T | undefined;
  try { result = action(); }
  catch (error) { actionFailed = true; actionError = error; }
  let cleanupError: unknown;
  try { releaseDirectoryLock(lock, secured, owner, options); }
  catch (error) { cleanupError = error; }
  if (actionFailed) {
    if (cleanupError !== undefined) {
      throw attachCleanupError(actionError, cleanupError, options.errorPrefix ?? 'E_LOCK');
    }
    throw actionError;
  }
  if (cleanupError !== undefined) throw new DirectoryLockError(cleanupError, options.errorPrefix ?? 'E_LOCK');
  return result as T;
}
