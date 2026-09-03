import { describe, expect, it } from 'vitest';
import { buildFollowupMessage, decidePersist, deriveEventId } from '../../src/persist/decision.js';
import type { PersistState } from '../../src/persist/state.js';

const NOW = 1_000_000;
function active(overrides: Partial<PersistState> = {}): PersistState {
  return {
    schema_version: 2,
    active: true,
    goal: 'reach >=95% Stage A run',
    max_loops: 25,
    consumed_loops: 0,
    last_host_loop_count: null,
    revision: 1,
    deadline_ms: NOW + 60_000,
    created_at_ms: NOW - 1000,
    done: false,
    last_event_id: null,
    last_decision_at_ms: null,
    last_decision_reason: null,
    ...overrides,
  };
}

describe('persist decision core', () => {
  it('continues a completed turn while every guard passes', () => {
    const decision = decidePersist(active(), { status: 'completed', loop_count: 3 }, NOW);
    expect(decision.continue).toBe(true);
    expect(decision.reason).toBe('persist_active');
    expect(decision.loop_count).toBe(3);
    expect(decision.next_state?.consumed_loops).toBe(1);
    expect(decision.next_state?.last_host_loop_count).toBe(3);
    expect(decision.followup_message).toContain('the boulder never stops');
    expect(decision.followup_message).toContain('reach >=95% Stage A run');
  });

  it('fails closed when loop_count is missing, negative, non-integer, non-finite, or huge', () => {
    for (const badLoop of [undefined, null, '0', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 501]) {
      const decision = decidePersist(active(), { status: 'completed', loop_count: badLoop }, NOW);
      expect(decision.continue).toBe(false);
      expect(decision.reason).toBe('loop_count_invalid');
    }
  });

  it('rejects a counter lower than the last observed host counter', () => {
    const state = active({ consumed_loops: 4, last_host_loop_count: 5 });
    const decision = decidePersist(state, { status: 'completed', loop_count: 4 }, NOW);
    expect(decision.continue).toBe(false);
    expect(decision.reason).toBe('loop_count_decreased');
  });

  it('deduplicates duplicate events by identity or same host loop count', () => {
    const state = active({
      consumed_loops: 2,
      last_host_loop_count: 2,
      last_event_id: 'turn:t1:loop:2',
    });
    // Same event ID
    const dup1 = decidePersist(state, { status: 'completed', loop_count: 2, event_id: 'turn:t1:loop:2' }, NOW);
    expect(dup1.continue).toBe(false);
    expect(dup1.reason).toBe('duplicate_event');

    // Same loop count without advancing
    const dup2 = decidePersist(state, { status: 'completed', loop_count: 2 }, NOW);
    expect(dup2.continue).toBe(false);
    expect(dup2.reason).toBe('duplicate_event');
  });

  it('never continues without an active, valid persist state', () => {
    for (const raw of [null, {}, { schema_version: 1 }, active({ active: false }), 'nope', 42, []]) {
      expect(decidePersist(raw, { status: 'completed', loop_count: 1 }, NOW)).toEqual({
        continue: false, reason: 'no_active_persist_state',
      });
    }
  });

  it('halts on any non-completed status (user abort or hard error)', () => {
    for (const status of ['aborted', 'error', 'cancelled', 'unknown']) {
      const decision = decidePersist(active(), { status, loop_count: 1 }, NOW);
      expect(decision.continue).toBe(false);
      expect(decision.reason).toBe(`status_${status}`);
    }
  });

  it('fail-safe: a missing or non-string status never continues', () => {
    expect(decidePersist(active(), { loop_count: 1 }, NOW)).toEqual({ continue: false, reason: 'status_missing' });
    expect(decidePersist(active(), { status: 1, loop_count: 1 }, NOW).continue).toBe(false);
    expect(decidePersist(active(), { status: null }, NOW).continue).toBe(false);
    expect(decidePersist(active(), {}, NOW)).toEqual({ continue: false, reason: 'status_missing' });
  });

  it('halts once the goal is marked done', () => {
    expect(decidePersist(active({ done: true }), { status: 'completed', loop_count: 1 }, NOW)).toEqual({
      continue: false, reason: 'goal_marked_done',
    });
  });

  it('halts at the deadline', () => {
    expect(decidePersist(active({ deadline_ms: NOW }), { status: 'completed', loop_count: 0 }, NOW).reason)
      .toBe('deadline_reached');
    expect(decidePersist(active(), { status: 'completed', loop_count: 0 }, Number.NaN).reason)
      .toBe('deadline_reached');
  });

  it('halts when the loop budget is exhausted (Cursor loop_count at/over the ceiling)', () => {
    expect(decidePersist(active({ max_loops: 5 }), { status: 'completed', loop_count: 5 }, NOW).reason)
      .toBe('loop_budget_exhausted');
    expect(decidePersist(active({ max_loops: 5 }), { status: 'completed', loop_count: 9 }, NOW).reason)
      .toBe('loop_budget_exhausted');
    expect(decidePersist(active({ max_loops: 5 }), { status: 'completed', loop_count: 4 }, NOW).continue)
      .toBe(true);
  });

  it('halts when consumed_loops reaches max_loops even if host counter is lower', () => {
    const state = active({ max_loops: 5, consumed_loops: 5, last_host_loop_count: 3 });
    const decision = decidePersist(state, { status: 'completed', loop_count: 4 }, NOW);
    expect(decision.continue).toBe(false);
    expect(decision.reason).toBe('loop_budget_exhausted');
  });

  it('v1 migration does not reset an active loop to a fresh budget', () => {
    const legacyV1: Record<string, unknown> = {
      schema_version: 1,
      active: true,
      goal: 'migrated task',
      max_loops: 10,
      deadline_ms: NOW + 60_000,
      created_at_ms: NOW - 5_000,
      done: false,
    };
    // Host has already executed 7 loops
    const decision = decidePersist(legacyV1, { status: 'completed', loop_count: 7 }, NOW);
    expect(decision.continue).toBe(true);
    // consumed_loops should be initialized from host loop (7) + 1 = 8, not 0 + 1 = 1
    expect(decision.next_state?.consumed_loops).toBe(8);

    // If host has already executed 10 loops, budget is exhausted immediately
    const exhausted = decidePersist(legacyV1, { status: 'completed', loop_count: 10 }, NOW);
    expect(exhausted.continue).toBe(false);
    expect(exhausted.reason).toBe('loop_budget_exhausted');
  });

  it('fail-safe: malformed hook input (missing status) never continues', () => {
    expect(decidePersist(active(), null, NOW).continue).toBe(false);
    expect(decidePersist(active(), 'garbage', NOW).continue).toBe(false);
    expect(decidePersist(active(), [], NOW).continue).toBe(false);
  });

  it('derives stable non-secret event IDs from input fields', () => {
    expect(deriveEventId({ event_id: 'custom-1', loop_count: 0 })).toBe('custom-1');
    expect(deriveEventId({ eventId: 'custom-2', loop_count: 0 })).toBe('custom-2');
    expect(deriveEventId({ session_id: 's1', turn_id: 't2', loop_count: 3 })).toBe('session:s1:turn:t2:loop:3');
    expect(deriveEventId({ loop_count: 5 })).toBe('loop:5');
  });

  it('bounds overlong event IDs to prevent state bloat/corruption', () => {
    const huge = 'a'.repeat(500);
    const id = deriveEventId({ event_id: huge });
    expect(id.length).toBeLessThanOrEqual(128);
    expect(id).toMatch(/^[a-z]+_[0-9a-f]{16}$/);

    const hugeParts = deriveEventId({ session_id: huge, turn_id: huge, loop_count: 1 });
    expect(hugeParts.length).toBeLessThanOrEqual(128);
  });

  it('builds a follow-up that never fabricates completion', () => {
    const message = buildFollowupMessage(active(), 2);
    expect(message).toContain('Continuation 3');
    expect(message).toContain('omcu persist done');
    expect(message).toContain('omcu persist stop');
    expect(message).toMatch(/Never fabricate completion/i);
    expect(message).not.toMatch(/"verified"\s*:\s*true|passes\s*:\s*true/);
  });
});
