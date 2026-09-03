import fs from 'node:fs';
import { atomicWriteJson, withDirectoryLockSync } from '../runtime/atomic.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';
import { redactText } from '../runtime/redaction.js';
import { decidePersist, type PersistDecision } from './decision.js';

export const PERSIST_SCHEMA_VERSION = 2 as const;
export const MAX_PERSIST_LOOPS = 500;
export const DEFAULT_PERSIST_LOOPS = 25;
export const DEFAULT_PERSIST_DEADLINE_MINUTES = 120;
export const MAX_PERSIST_DEADLINE_MINUTES = 24 * 60;
export const PERSIST_LOCK_TIMEOUT_MS = 10_000;
const MAX_PERSIST_STATE_BYTES = 64 * 1024;

export interface PersistState {
  readonly schema_version: 2;
  readonly active: boolean;
  readonly goal: string;
  readonly max_loops: number;
  readonly consumed_loops: number;
  readonly last_host_loop_count: number | null;
  readonly revision: number;
  readonly deadline_ms: number;
  readonly created_at_ms: number;
  readonly done: boolean;
  readonly last_event_id: string | null;
  readonly last_decision_at_ms: number | null;
  readonly last_decision_reason: string | null;
  /** Internal transient flag during in-memory migration from v1. */
  readonly legacy_v1?: boolean;
}

export function persistFile(root: StateRoot): string {
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
  if (state.schema_version !== 1 && state.schema_version !== 2) return null;
  if (typeof state.active !== 'boolean') return null;
  if (typeof state.goal !== 'string' || state.goal.trim() === '' || state.goal.length > 8192) return null;
  if (!Number.isSafeInteger(state.max_loops) || (state.max_loops as number) < 1 || (state.max_loops as number) > MAX_PERSIST_LOOPS) return null;
  if (!Number.isSafeInteger(state.deadline_ms) || (state.deadline_ms as number) <= 0) return null;
  if (!Number.isSafeInteger(state.created_at_ms) || (state.created_at_ms as number) <= 0) return null;
  if (typeof state.done !== 'boolean') return null;

  if (state.schema_version === 1) {
    return {
      schema_version: 2,
      active: state.active as boolean,
      goal: state.goal as string,
      max_loops: state.max_loops as number,
      consumed_loops: Number.isSafeInteger(state.consumed_loops) && (state.consumed_loops as number) >= 0
        ? (state.consumed_loops as number) : 0,
      last_host_loop_count: Number.isSafeInteger(state.last_host_loop_count) && (state.last_host_loop_count as number) >= 0
        ? (state.last_host_loop_count as number) : null,
      revision: Number.isSafeInteger(state.revision) && (state.revision as number) >= 0
        ? (state.revision as number) : 0,
      deadline_ms: state.deadline_ms as number,
      created_at_ms: state.created_at_ms as number,
      done: state.done as boolean,
      last_event_id: typeof state.last_event_id === 'string' ? state.last_event_id : null,
      last_decision_at_ms: Number.isSafeInteger(state.last_decision_at_ms) && (state.last_decision_at_ms as number) >= 0
        ? (state.last_decision_at_ms as number) : null,
      last_decision_reason: typeof state.last_decision_reason === 'string' ? state.last_decision_reason : null,
      legacy_v1: true,
    };
  }

  // Schema version 2
  if (!Number.isSafeInteger(state.consumed_loops) || (state.consumed_loops as number) < 0 || (state.consumed_loops as number) > MAX_PERSIST_LOOPS) return null;
  if (state.last_host_loop_count !== null && (!Number.isSafeInteger(state.last_host_loop_count) || (state.last_host_loop_count as number) < 0 || (state.last_host_loop_count as number) > MAX_PERSIST_LOOPS)) return null;
  if (!Number.isSafeInteger(state.revision) || (state.revision as number) < 0) return null;
  if (state.last_event_id !== null && (typeof state.last_event_id !== 'string' || state.last_event_id.length > 256)) return null;
  if (state.last_decision_at_ms !== null && (!Number.isSafeInteger(state.last_decision_at_ms) || (state.last_decision_at_ms as number) < 0)) return null;
  if (state.last_decision_reason !== null && state.last_decision_reason !== undefined && typeof state.last_decision_reason !== 'string') return null;

  return {
    schema_version: 2,
    active: state.active as boolean,
    goal: state.goal as string,
    max_loops: state.max_loops as number,
    consumed_loops: state.consumed_loops as number,
    last_host_loop_count: state.last_host_loop_count as number | null,
    revision: state.revision as number,
    deadline_ms: state.deadline_ms as number,
    created_at_ms: state.created_at_ms as number,
    done: state.done as boolean,
    last_event_id: state.last_event_id as string | null,
    last_decision_at_ms: state.last_decision_at_ms as number | null,
    last_decision_reason: (state.last_decision_reason as string | null) ?? null,
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

  return withDirectoryLockSync(persistFile(root), () => {
    const current = readPersistState(root);
    const revision = (current?.revision ?? 0) + 1;
    const state: PersistState = {
      schema_version: PERSIST_SCHEMA_VERSION,
      active: true,
      goal: redactText(goal, 8192),
      max_loops: maxLoops,
      consumed_loops: 0,
      last_host_loop_count: null,
      revision,
      deadline_ms: nowMs + deadlineMinutes * 60_000,
      created_at_ms: nowMs,
      done: false,
      last_event_id: null,
      last_decision_at_ms: null,
      last_decision_reason: null,
    };
    atomicWriteJson(persistFile(root), state);
    return state;
  }, PERSIST_LOCK_TIMEOUT_MS, { errorPrefix: 'E_PERSIST_LOCK' });
}

/** Deactivate the loop (abort). Idempotent; returns the resulting state. */
export function stopPersist(root: StateRoot): PersistState | null {
  if (!fs.existsSync(persistFile(root))) return null;
  return withDirectoryLockSync(persistFile(root), () => {
    const current = readPersistState(root);
    if (current === null) return null;
    const next: PersistState = {
      ...current,
      schema_version: PERSIST_SCHEMA_VERSION,
      active: false,
      revision: current.revision + 1,
      last_decision_reason: 'stopped_by_operator',
    };
    atomicWriteJson(persistFile(root), next);
    return next;
  }, PERSIST_LOCK_TIMEOUT_MS, { errorPrefix: 'E_PERSIST_LOCK' });
}

/** Mark the goal satisfied so the next stop halts. Idempotent. */
export function completePersist(root: StateRoot): PersistState | null {
  if (!fs.existsSync(persistFile(root))) return null;
  return withDirectoryLockSync(persistFile(root), () => {
    const current = readPersistState(root);
    if (current === null) return null;
    const next: PersistState = {
      ...current,
      schema_version: PERSIST_SCHEMA_VERSION,
      active: false,
      done: true,
      revision: current.revision + 1,
      last_decision_reason: 'completed_by_operator',
    };
    atomicWriteJson(persistFile(root), next);
    return next;
  }, PERSIST_LOCK_TIMEOUT_MS, { errorPrefix: 'E_PERSIST_LOCK' });
}

export interface PersistStatus {
  readonly present: boolean;
  readonly state: PersistState | null;
  readonly consumed_loops: number | null;
  readonly remaining_loops: number | null;
  readonly deadline_ms: number | null;
  readonly revision: number | null;
  readonly last_decision_reason: string | null;
}

export function persistStatus(root: StateRoot): PersistStatus {
  const state = readPersistState(root);
  if (state === null) {
    return {
      present: false,
      state: null,
      consumed_loops: null,
      remaining_loops: null,
      deadline_ms: null,
      revision: null,
      last_decision_reason: null,
    };
  }
  return {
    present: true,
    state,
    consumed_loops: state.consumed_loops,
    remaining_loops: Math.max(0, state.max_loops - state.consumed_loops),
    deadline_ms: state.deadline_ms,
    revision: state.revision,
    last_decision_reason: state.last_decision_reason ?? null,
  };
}

/** Execute a decision under lock, mutating state when continuation is granted. */
export function executePersistDecision(root: StateRoot, hookInput: unknown, nowMs = Date.now()): PersistDecision {
  if (!fs.existsSync(persistFile(root))) {
    return { continue: false, reason: 'no_active_persist_state' };
  }
  return withDirectoryLockSync(persistFile(root), () => {
    const current = readPersistState(root);
    const decision = decidePersist(current, hookInput, nowMs);
    if (decision.continue && decision.next_state) {
      atomicWriteJson(persistFile(root), decision.next_state);
    }
    return {
      continue: decision.continue,
      reason: decision.reason,
      ...(decision.loop_count !== undefined ? { loop_count: decision.loop_count } : {}),
      ...(decision.followup_message !== undefined ? { followup_message: decision.followup_message } : {}),
      ...(decision.next_state?.revision !== undefined ? { revision: decision.next_state.revision } : {}),
    };
  }, PERSIST_LOCK_TIMEOUT_MS, { errorPrefix: 'E_PERSIST_LOCK' });
}
