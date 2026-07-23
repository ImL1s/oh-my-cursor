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

/** Creates an absolute, owner-only state root. The caller supplies the location; no user config is modified. */
export function ensureExternalStateRoot(root: string): StateRoot {
  if (!path.isAbsolute(root)) throw new Error('E_STATE_ROOT_NOT_ABSOLUTE');
  const resolved = path.resolve(root);
  assertNoSymlink(resolved);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  fs.chmodSync(resolved, 0o700);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error('E_STATE_ROOT_NOT_DIRECTORY');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('E_STATE_ROOT_NOT_OWNED');
  }
  return { path: resolved, ownerFile: path.join(resolved, 'owner.json') };
}

export function projectStateRoot(workspace: string): StateRoot {
  return ensureExternalStateRoot(path.join(path.resolve(workspace), PROJECT_STATE_DIRECTORY));
}

export function withinStateRoot(root: StateRoot, ...segments: string[]): string {
  const candidate = path.resolve(root.path, ...segments);
  if (candidate !== root.path && !candidate.startsWith(`${root.path}${path.sep}`)) {
    throw new Error('E_PATH_OUTSIDE_STATE_ROOT');
  }
  return candidate;
}
