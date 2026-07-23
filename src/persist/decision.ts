import { MAX_PERSIST_LOOPS, normalizePersistState, type PersistState } from './state.js';

export interface PersistHookInput {
  readonly status?: unknown;
  readonly loop_count?: unknown;
}

export interface PersistDecision {
  readonly continue: boolean;
  readonly reason: string;
  readonly followup_message?: string;
  readonly loop_count?: number;
}

/**
 * The single source of truth for whether a stopped Cursor turn should continue.
 *
 * Safety posture: OPT-IN. Continues ONLY when a valid, active persist state is
 * present AND every guard passes. Any doubt — missing/malformed state, a
 * non-'completed' status (user abort or hard error), an exhausted loop budget,
 * a passed deadline, or an operator-set done flag — returns a normal stop.
 * Cursor owns the loop_count budget (bounded by loop_limit); the omcu CLI owns
 * the goal/ceiling/deadline/done flag. This function never mutates state.
 */
export function decidePersist(rawState: unknown, hookInput: unknown, nowMs: number): PersistDecision {
  const state = normalizePersistState(rawState);
  if (state === null || state.active !== true) return { continue: false, reason: 'no_active_persist_state' };

  const input = (hookInput && typeof hookInput === 'object' && !Array.isArray(hookInput)
    ? hookInput : {}) as PersistHookInput;

  // Fail-safe: continue ONLY on an explicit clean 'completed'. A missing or
  // non-string status is treated as a non-completed turn (abort/error/unknown)
  // and halts — never default an incomplete payload into a continuation.
  if (input.status !== 'completed') {
    const label = typeof input.status === 'string' ? input.status : 'missing';
    return { continue: false, reason: `status_${label}` };
  }

  if (state.done === true) return { continue: false, reason: 'goal_marked_done' };

  if (!Number.isSafeInteger(nowMs) || nowMs >= state.deadline_ms) {
    return { continue: false, reason: 'deadline_reached' };
  }

  const rawLoop = Number(input.loop_count);
  const observedLoops = Number.isFinite(rawLoop) && rawLoop >= 0 ? Math.floor(rawLoop) : 0;
  if (observedLoops >= state.max_loops) return { continue: false, reason: 'loop_budget_exhausted' };

  return {
    continue: true,
    reason: 'persist_active',
    loop_count: observedLoops,
    followup_message: buildFollowupMessage(state, observedLoops),
  };
}

/** The continuation directive injected back into the same agent turn. */
export function buildFollowupMessage(state: PersistState, observedLoops: number): string {
  const remaining = Math.max(0, Math.min(MAX_PERSIST_LOOPS, state.max_loops) - observedLoops);
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
