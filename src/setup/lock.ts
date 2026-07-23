import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../runtime/atomic.js';

export interface InstallLockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  readonly pollMs?: number;
}

interface LockOwner {
  readonly schema_version: 1;
  readonly pid: number;
  readonly token: string;
  readonly created_at_ms: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 25;

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ownerFile(lock: string): string {
  return path.join(lock, 'owner.json');
}

function assertOwnedDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('E_INSTALL_LOCK_INVALID');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('E_INSTALL_LOCK_NOT_OWNED');
}

function readOwner(lock: string): LockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerFile(lock), 'utf8')) as Partial<LockOwner>;
    if (parsed.schema_version !== 1 || !Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0
      || typeof parsed.token !== 'string' || !/^[a-f0-9]{32}$/.test(parsed.token)
      || !Number.isSafeInteger(parsed.created_at_ms) || (parsed.created_at_ms ?? 0) <= 0) return null;
    return parsed as LockOwner;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function reclaimIfStale(lock: string, staleMs: number): boolean {
  try {
    assertOwnedDirectory(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  const owner = readOwner(lock);
  const statAge = Date.now() - fs.statSync(lock).mtimeMs;
  const ownerAge = owner === null ? statAge : Date.now() - owner.created_at_ms;
  if (owner !== null) {
    if (processAlive(owner.pid)) return false;
  } else if (ownerAge <= staleMs) return false;
  const reclaimed = `${lock}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(lock, reclaimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  fs.rmSync(reclaimed, { recursive: true, force: true });
  return true;
}

function tryAcquire(lock: string): LockOwner | null {
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(lock), 0o700);
  const owner: LockOwner = {
    schema_version: 1,
    pid: process.pid,
    token: crypto.randomBytes(16).toString('hex'),
    created_at_ms: Date.now(),
  };
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
  try {
    atomicWriteJson(ownerFile(lock), owner);
    fs.chmodSync(ownerFile(lock), 0o600);
    return owner;
  } catch (error) {
    fs.rmSync(lock, { recursive: true, force: true });
    throw error;
  }
}

function release(lock: string, owner: LockOwner): void {
  const current = readOwner(lock);
  if (current === null || current.token !== owner.token || current.pid !== owner.pid) {
    throw new Error('E_INSTALL_LOCK_OWNERSHIP_LOST');
  }
  fs.rmSync(lock, { recursive: true });
}

function lockPath(stateRoot: string): string {
  return path.join(path.resolve(stateRoot), 'install', 'transaction.lock');
}

export async function withInstallLock<T>(
  stateRoot: string,
  action: () => Promise<T> | T,
  options: InstallLockOptions = {},
): Promise<T> {
  const lock = lockPath(stateRoot);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  let owner: LockOwner | null = null;
  while (owner === null) {
    owner = tryAcquire(lock);
    if (owner !== null) break;
    if (reclaimIfStale(lock, staleMs)) continue;
    if (Date.now() >= deadline) throw new Error('E_INSTALL_LOCK_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  try {
    return await action();
  } finally {
    release(lock, owner);
  }
}

export function withInstallLockSync<T>(
  stateRoot: string,
  action: () => T,
  options: InstallLockOptions = {},
): T {
  const lock = lockPath(stateRoot);
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  let owner: LockOwner | null = null;
  while (owner === null) {
    owner = tryAcquire(lock);
    if (owner !== null) break;
    if (reclaimIfStale(lock, staleMs)) continue;
    if (Date.now() >= deadline) throw new Error('E_INSTALL_LOCK_TIMEOUT');
    sleepSync(pollMs);
  }
  try {
    return action();
  } finally {
    release(lock, owner);
  }
}
