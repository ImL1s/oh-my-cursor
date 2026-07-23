import { describe, expect, it } from 'vitest';
import { buildFollowupMessage, decidePersist } from '../../src/persist/decision.js';
import type { PersistState } from '../../src/persist/state.js';

const NOW = 1_000_000;
function active(overrides: Partial<PersistState> = {}): PersistState {
  return {
    schema_version: 1,
    active: true,
    goal: 'reach >=95% Stage A run',
    max_loops: 25,
    deadline_ms: NOW + 60_000,
    created_at_ms: NOW - 1000,
    done: false,
    ...overrides,
  };
}

describe('persist decision core', () => {
  it('continues a completed turn while every guard passes', () => {
    const decision = decidePersist(active(), { status: 'completed', loop_count: 3 }, NOW);
    expect(decision.continue).toBe(true);
    expect(decision.reason).toBe('persist_active');
    expect(decision.loop_count).toBe(3);
    expect(decision.followup_message).toContain('the boulder never stops');
    expect(decision.followup_message).toContain('reach >=95% Stage A run');
  });

  it('treats a missing loop_count as zero and still continues', () => {
    const decision = decidePersist(active(), { status: 'completed' }, NOW);
    expect(decision.continue).toBe(true);
    expect(decision.loop_count).toBe(0);
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

  it('treats malformed hook input as an empty completed turn', () => {
    expect(decidePersist(active(), null, NOW).continue).toBe(true);
    expect(decidePersist(active(), 'garbage', NOW).continue).toBe(true);
    expect(decidePersist(active(), [], NOW).continue).toBe(true);
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
