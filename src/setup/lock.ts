import path from 'node:path';
import {
  withDirectoryLock,
  withDirectoryLockSync,
  type DirectoryLockOptions,
} from '../runtime/atomic.js';

export interface InstallLockOptions {
  readonly timeoutMs?: number;
  readonly staleMs?: number;
  readonly pollMs?: number;
  readonly heartbeatMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function targetPath(stateRoot: string): string {
  // The shared primitive appends `.lock`, preserving the public transaction.lock path.
  return path.join(path.resolve(stateRoot), 'install', 'transaction');
}

function directoryOptions(options: InstallLockOptions): DirectoryLockOptions {
  return {
    errorPrefix: 'E_INSTALL_LOCK',
    ...(options.staleMs === undefined ? {} : { staleMs: options.staleMs }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
  };
}

export function withInstallLock<T>(
  stateRoot: string,
  action: () => Promise<T> | T,
  options: InstallLockOptions = {},
): Promise<T> {
  return withDirectoryLock(
    targetPath(stateRoot),
    action,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    directoryOptions(options),
  );
}

export function withInstallLockSync<T>(
  stateRoot: string,
  action: () => T,
  options: InstallLockOptions = {},
): T {
  return withDirectoryLockSync(
    targetPath(stateRoot),
    action,
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    directoryOptions(options),
  );
}
