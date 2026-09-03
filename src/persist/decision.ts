import crypto from 'node:crypto';
import { MAX_PERSIST_LOOPS, normalizePersistState, type PersistState } from './state.js';

export interface PersistHookInput {
  readonly status?: unknown;
  readonly loop_count?: unknown;
  readonly event_id?: unknown;
  readonly eventId?: unknown;
  readonly session_id?: unknown;
  readonly sessionId?: unknown;
  readonly turn_id?: unknown;
  readonly turnId?: unknown;
}

export interface PersistDecision {
  readonly continue: boolean;
  readonly reason: string;
  readonly followup_message?: string;
  readonly loop_count?: number;
  readonly revision?: number;
  readonly next_state?: PersistState;
}

export function boundId(value: string, maxLen = 128): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLen) return trimmed;
  const hash = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 16);
  return `${trimmed.slice(0, maxLen - 17)}_${hash}`;
}

export function deriveEventId(input: PersistHookInput): string {
  if (typeof input.event_id === 'string' && input.event_id.trim() !== '') {
    return boundId(input.event_id);
  }
  if (typeof input.eventId === 'string' && input.eventId.trim() !== '') {
    return boundId(input.eventId);
  }
  const parts: string[] = [];
  if (typeof input.session_id === 'string' && input.session_id.trim() !== '') {
    parts.push(`session:${boundId(input.session_id, 64)}`);
  } else if (typeof input.sessionId === 'string' && input.sessionId.trim() !== '') {
    parts.push(`session:${boundId(input.sessionId, 64)}`);
  }
  if (typeof input.turn_id === 'string' && input.turn_id.trim() !== '') {
    parts.push(`turn:${boundId(input.turn_id, 64)}`);
  } else if (typeof input.turnId === 'string' && input.turnId.trim() !== '') {
    parts.push(`turn:${boundId(input.turnId, 64)}`);
  }
  parts.push(`loop:${input.loop_count}`);
  return boundId(parts.join(':'), 128);
}

/**
 * The single source of truth for whether a stopped Cursor turn should continue.
 *
 * Safety posture: OPT-IN. Continues ONLY when a valid, active persist state is
 * present AND every guard passes. Any doubt — missing/malformed state, a
 * non-'completed' status (user abort or hard error), an exhausted loop budget,
 * a passed deadline, a missing/decreased/duplicate host counter, or an operator-set
 * done flag — returns a normal stop.
 */
export function decidePersist(rawState: unknown, hookInput: unknown, nowMs: number): PersistDecision {
  const state = normalizePersistState(rawState);
  if (state === null) return { continue: false, reason: 'no_active_persist_state' };
  if (state.active !== true && state.done !== true) return { continue: false, reason: 'no_active_persist_state' };

  const input = (hookInput && typeof hookInput === 'object' && !Array.isArray(hookInput)
    ? hookInput : {}) as PersistHookInput;

  // Fail-safe: continue ONLY on an explicit clean 'completed'.
  if (input.status !== 'completed') {
    const label = typeof input.status === 'string' && input.status.trim() !== ''
      ? input.status.trim() : 'missing';
    return { continue: false, reason: `status_${label}` };
  }

  if (state.done === true) return { continue: false, reason: 'goal_marked_done' };
  if (state.active !== true) return { continue: false, reason: 'no_active_persist_state' };

  if (!Number.isSafeInteger(nowMs) || nowMs <= 0 || nowMs >= state.deadline_ms) {
    return { continue: false, reason: 'deadline_reached' };
  }

  const rawLoop = input.loop_count;
  if (
    rawLoop === undefined ||
    rawLoop === null ||
    typeof rawLoop !== 'number' ||
    !Number.isSafeInteger(rawLoop) ||
    rawLoop < 0 ||
    rawLoop > MAX_PERSIST_LOOPS
  ) {
    return { continue: false, reason: 'loop_count_invalid' };
  }

  if (state.last_host_loop_count !== null && rawLoop < state.last_host_loop_count) {
    return { continue: false, reason: 'loop_count_decreased' };
  }

  const baselineConsumed = state.legacy_v1
    ? Math.max(state.consumed_loops, rawLoop)
    : state.consumed_loops;

  if (baselineConsumed >= state.max_loops || rawLoop >= state.max_loops) {
    return { continue: false, reason: 'loop_budget_exhausted' };
  }

  const eventId = deriveEventId(input);
  if (state.last_event_id !== null && eventId === state.last_event_id) {
    return { continue: false, reason: 'duplicate_event' };
  }
  if (state.last_host_loop_count !== null && rawLoop === state.last_host_loop_count) {
    return { continue: false, reason: 'duplicate_event' };
  }

  const nextConsumed = baselineConsumed + 1;
  const decisionAtMs = Math.max(nowMs, state.last_decision_at_ms ?? state.created_at_ms);
  const next_state: PersistState = {
    schema_version: 2,
    active: true,
    goal: state.goal,
    max_loops: state.max_loops,
    consumed_loops: nextConsumed,
    last_host_loop_count: rawLoop,
    revision: state.revision + 1,
    deadline_ms: state.deadline_ms,
    created_at_ms: state.created_at_ms,
    done: false,
    last_event_id: eventId,
    last_decision_at_ms: decisionAtMs,
    last_decision_reason: 'persist_active',
  };

  return {
    continue: true,
    reason: 'persist_active',
    loop_count: rawLoop,
    revision: next_state.revision,
    next_state,
    followup_message: buildFollowupMessage(state, baselineConsumed),
  };
}

/** The continuation directive injected back into the same agent turn. */
export function buildFollowupMessage(state: PersistState, observedLoops: number): string {
  const remaining = Math.max(0, Math.min(MAX_PERSIST_LOOPS, state.max_loops) - (observedLoops + 1));
  return [
    'OMCU persistent execution is active — the boulder never stops.',
    `Goal: ${state.goal}`,
    `Continuation ${observedLoops + 1} (about ${remaining} left before the hard cap).`,
    'Do NOT idle-stop or ask for confirmation on obvious next steps. Re-read the current repository truth and .omcu run state, then take the smallest reversible next step toward the goal and run targeted verification.',
    'Never fabricate completion: do not claim passes/verified/done. Verification requires fresh evidence and the omcu CLI verification transition.',
    'When the goal is genuinely met with evidence, run `omcu persist done` and then stop. To abort this loop entirely, run `omcu persist stop`.',
    'If you are truly blocked on something only the user can decide, state the blocker plainly and stop.',
  ].join('\n');
}
