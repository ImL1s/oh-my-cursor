import fs from 'node:fs';
import { atomicWriteJson } from '../runtime/atomic.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';

export const PERSIST_SCHEMA_VERSION = 1 as const;
export const MAX_PERSIST_LOOPS = 500;
export const DEFAULT_PERSIST_LOOPS = 25;
export const DEFAULT_PERSIST_DEADLINE_MINUTES = 120;
export const MAX_PERSIST_DEADLINE_MINUTES = 24 * 60;
const MAX_PERSIST_STATE_BYTES = 64 * 1024;

export interface PersistState {
  readonly schema_version: 1;
  readonly active: boolean;
  readonly goal: string;
  readonly max_loops: number;
  readonly deadline_ms: number;
  readonly created_at_ms: number;
  readonly done: boolean;
}

function persistFile(root: StateRoot): string {
  return withinStateRoot(root, 'persist.json');
}

/** Read current persist state. Absence is optional; corruption fails closed. */
export function readPersistState(root: StateRoot): PersistState | null {
  const file = persistFile(root);
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_PERSIST_STATE_BYTES) {
      throw new Error('E_PERSIST_STATE_INVALID');
    }
    if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
      throw new Error('E_PERSIST_STATE_OWNER_INVALID');
    }
    if ((before.mode & 0o077) !== 0) throw new Error('E_PERSIST_STATE_MODE_UNSAFE');
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size > MAX_PERSIST_STATE_BYTES) {
      throw new Error('E_PERSIST_STATE_CHANGED');
    }
    const value = JSON.parse(fs.readFileSync(descriptor, 'utf8')) as unknown;
    const state = normalizePersistState(value);
    if (state === null) throw new Error('E_PERSIST_STATE_INVALID');
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof Error && error.message === 'E_STATE_CORRUPT') throw error;
    throw new Error('E_STATE_CORRUPT', { cause: error });
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* a read failure is already surfaced above */ }
    }
  }
}

export function normalizePersistState(value: unknown): PersistState | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.schema_version !== PERSIST_SCHEMA_VERSION) return null;
  if (typeof state.active !== 'boolean') return null;
  if (typeof state.goal !== 'string' || state.goal.trim() === '' || state.goal.length > 8192) return null;
  if (!Number.isSafeInteger(state.max_loops) || (state.max_loops as number) < 1 || (state.max_loops as number) > MAX_PERSIST_LOOPS) return null;
  if (!Number.isSafeInteger(state.deadline_ms) || (state.deadline_ms as number) <= 0) return null;
  if (!Number.isSafeInteger(state.created_at_ms) || (state.created_at_ms as number) <= 0) return null;
  if (typeof state.done !== 'boolean') return null;
  return {
    schema_version: PERSIST_SCHEMA_VERSION,
    active: state.active as boolean,
    goal: state.goal as string,
    max_loops: state.max_loops as number,
    deadline_ms: state.deadline_ms as number,
    created_at_ms: state.created_at_ms as number,
    done: state.done as boolean,
  };
}

export interface StartPersistInput {
  readonly goal: string;
  readonly maxLoops?: number;
  readonly deadlineMinutes?: number;
  readonly nowMs?: number;
}

export function startPersist(root: StateRoot, input: StartPersistInput): PersistState {
  const goal = input.goal.trim();
  if (goal === '' || goal.length > 8192) throw new Error('E_PERSIST_GOAL_INVALID');
  const maxLoops = input.maxLoops ?? DEFAULT_PERSIST_LOOPS;
  if (!Number.isSafeInteger(maxLoops) || maxLoops < 1 || maxLoops > MAX_PERSIST_LOOPS) {
    throw new Error('E_PERSIST_MAX_LOOPS_INVALID');
  }
  const deadlineMinutes = input.deadlineMinutes ?? DEFAULT_PERSIST_DEADLINE_MINUTES;
  if (!Number.isSafeInteger(deadlineMinutes) || deadlineMinutes < 1 || deadlineMinutes > MAX_PERSIST_DEADLINE_MINUTES) {
    throw new Error('E_PERSIST_DEADLINE_INVALID');
  }
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('E_PERSIST_CLOCK_INVALID');
  const state: PersistState = {
    schema_version: PERSIST_SCHEMA_VERSION,
    active: true,
    goal,
    max_loops: maxLoops,
    deadline_ms: nowMs + deadlineMinutes * 60_000,
    created_at_ms: nowMs,
    done: false,
  };
  atomicWriteJson(persistFile(root), state);
  return state;
}

/** Deactivate the loop (abort). Idempotent; returns the resulting state. */
export function stopPersist(root: StateRoot): PersistState | null {
  const current = readPersistState(root);
  if (current === null) return null;
  const next: PersistState = { ...current, active: false };
  atomicWriteJson(persistFile(root), next);
  return next;
}

/** Mark the goal satisfied so the next stop halts. Idempotent. */
export function completePersist(root: StateRoot): PersistState | null {
  const current = readPersistState(root);
  if (current === null) return null;
  const next: PersistState = { ...current, active: false, done: true };
  atomicWriteJson(persistFile(root), next);
  return next;
}

export interface PersistStatus {
  readonly present: boolean;
  readonly state: PersistState | null;
}

export function persistStatus(root: StateRoot): PersistStatus {
  const state = readPersistState(root);
  return { present: state !== null, state };
}
