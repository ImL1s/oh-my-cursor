import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface DirectoryLockOptions {
  readonly staleMs?: number;
  readonly pollMs?: number;
}

interface DirectoryLockOwner {
  readonly schema_version: 1;
  readonly pid: number;
  readonly token: string;
  readonly created_at_ms: number;
}

const DEFAULT_LOCK_STALE_MS = 60_000;
const DEFAULT_LOCK_POLL_MS = 20;

export function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  const directory = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function lockOwnerFile(lock: string): string {
  return path.join(lock, 'owner.json');
}

function readLockOwner(lock: string): DirectoryLockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockOwnerFile(lock), 'utf8')) as Partial<DirectoryLockOwner>;
    if (parsed.schema_version !== 1 || !Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0
      || typeof parsed.token !== 'string' || !/^[a-f0-9]{32}$/.test(parsed.token)
      || !Number.isSafeInteger(parsed.created_at_ms) || (parsed.created_at_ms ?? 0) <= 0) return null;
    return parsed as DirectoryLockOwner;
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

function assertOwnedLockDirectory(lock: string): void {
  const stat = fs.lstatSync(lock);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('E_LOCK_INVALID');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('E_LOCK_NOT_OWNED');
}

function reclaimDeadLock(lock: string, staleMs: number): boolean {
  try {
    assertOwnedLockDirectory(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  const owner = readLockOwner(lock);
  const age = owner === null
    ? Date.now() - fs.statSync(lock).mtimeMs
    : Date.now() - owner.created_at_ms;
  if (owner !== null) {
    if (processAlive(owner.pid)) return false;
  } else if (age <= staleMs) return false;
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

function tryAcquireDirectoryLock(lock: string): DirectoryLockOwner | null {
  const owner: DirectoryLockOwner = {
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
    atomicWriteJson(lockOwnerFile(lock), owner);
    return owner;
  } catch (error) {
    fs.rmSync(lock, { recursive: true, force: true });
    throw error;
  }
}

function releaseDirectoryLock(lock: string, owner: DirectoryLockOwner): void {
  const current = readLockOwner(lock);
  if (current === null || current.pid !== owner.pid || current.token !== owner.token) {
    throw new Error('E_LOCK_OWNERSHIP_LOST');
  }
  fs.rmSync(lock, { recursive: true });
}

export async function withDirectoryLock<T>(
  target: string,
  action: () => T | Promise<T>,
  timeoutMs = 2000,
  options: DirectoryLockOptions = {},
): Promise<T> {
  const lock = `${target}.lock`;
  const deadline = Date.now() + timeoutMs;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  let owner: DirectoryLockOwner | null = null;
  while (true) {
    owner = tryAcquireDirectoryLock(lock);
    if (owner !== null) break;
    if (reclaimDeadLock(lock, staleMs)) continue;
    if (Date.now() >= deadline) throw new Error('E_LOCK_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  try {
    return await action();
  } finally {
    releaseDirectoryLock(lock, owner);
  }
}
