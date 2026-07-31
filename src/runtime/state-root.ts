import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_STATE_DIRECTORY = '.omcu';

export interface StateRoot {
  readonly path: string;
  readonly ownerFile: string;
}

function assertNoSymlink(target: string): void {
  if (!fs.existsSync(target)) return;
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error(`E_STATE_ROOT_SYMLINK: ${target}`);
}

function asStateRoot(resolved: string): StateRoot {
  return { path: resolved, ownerFile: path.join(resolved, 'owner.json') };
}

/** Resolve a project state root path without creating or chmodding it. */
export function resolveProjectStatePath(workspace: string): string {
  return path.join(path.resolve(workspace), PROJECT_STATE_DIRECTORY);
}

/**
 * Open an existing project state root without creating it.
 * Throws E_STATE_ROOT_ABSENT when the directory does not exist.
 */
export function openProjectStateRoot(workspace: string): StateRoot {
  const resolved = resolveProjectStatePath(workspace);
  assertNoSymlink(resolved);
  if (!fs.existsSync(resolved)) throw new Error('E_STATE_ROOT_ABSENT');
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error('E_STATE_ROOT_NOT_DIRECTORY');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('E_STATE_ROOT_NOT_OWNED');
  }
  return asStateRoot(resolved);
}

/** Open an existing root for mutation without creating it or changing its mode. */
export function openWritableProjectStateRoot(workspace: string): StateRoot {
  const root = openProjectStateRoot(workspace);
  if (process.platform !== 'win32' && (fs.statSync(root.path).mode & 0o077) !== 0) {
    throw new Error('E_OWNER_ROOT_MODE_UNSAFE');
  }
  return root;
}

/** Creates an absolute, owner-only state root. The caller supplies the location; no user config is modified. */
export function ensureExternalStateRoot(root: string): StateRoot {
  if (!path.isAbsolute(root)) throw new Error('E_STATE_ROOT_NOT_ABSOLUTE');
  const resolved = path.resolve(root);
  assertNoSymlink(resolved);
  const existed = fs.existsSync(resolved);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  // Only chmod newly created roots; preserve existing modes (issue #8).
  if (!existed) fs.chmodSync(resolved, 0o700);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error('E_STATE_ROOT_NOT_DIRECTORY');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('E_STATE_ROOT_NOT_OWNED');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('E_STATE_ROOT_MODE_UNSAFE: expected owner-only permissions (0700)');
  }
  return asStateRoot(resolved);
}

/** Ensure (create if needed) the project-local `.omcu` state root. */
export function projectStateRoot(workspace: string): StateRoot {
  return ensureExternalStateRoot(resolveProjectStatePath(workspace));
}

export function withinStateRoot(root: StateRoot, ...segments: string[]): string {
  const candidate = path.resolve(root.path, ...segments);
  if (candidate !== root.path && !candidate.startsWith(`${root.path}${path.sep}`)) {
    throw new Error('E_PATH_OUTSIDE_STATE_ROOT');
  }
  return candidate;
}
