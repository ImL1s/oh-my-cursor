import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeContinuationTransaction } from '../../src/continuation/transaction.js';
import { createWorkflowProjection } from '../../src/workflows/projection.js';
import { WorkflowProjectionStore } from '../../src/runtime/cursor-sdk/store.js';

describe('Continuation Transaction', () => {
  function setupTestEnv() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-continuation-test-'));
    const store = new WorkflowProjectionStore(tempDir);
    return { tempDir, store };
  }

  it('grants continuation when identity, epoch, and budget hold', async () => {
    const { tempDir, store } = setupTestEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-run-1',
        cursor_agent_id: 'agent-123',
        source_profile: 'omc-autopilot',
        phase: 'execute',
        objective_artifact: 'obj-1',
        budgets: {
          max_iterations: 10,
          max_continuations: 5,
          deadline_at: '2026-12-31T23:59:59Z',
          consumed_continuations: 0,
        },
        goals: [
          {
            id: 'g-1',
            title: 'Fix issue',
            acceptance_criteria: ['unit test pass'],
            status: 'in_progress',
            created_at: new Date().toISOString(),
          },
        ],
        todos: [
          {
            id: 't-1',
            title: 'Step 1: Edit code',
            completed: false,
            status: 'pending',
            created_at: new Date().toISOString(),
          },
        ],
      });
      store.save(projection);

      const result = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-run-1',
        cursor_agent_id: 'agent-123',
        epoch: 1,
        event_id: 'event-001',
        hook_event: 'stop',
      });

      expect(result.continue).toBe(true);
      expect(result.reason).toBe('continuation_granted');
      expect(result.continuation_slot_consumed).toBe(true);
      expect(result.followup_message).toBeDefined();
      expect(result.followup_message).toContain('OMCU continuation active');
      expect(result.followup_message).toContain('Continuation 1 (4 remaining');
      expect(result.followup_message).toContain('Step 1: Edit code');

      // Check persisted state
      const reloaded = store.load('wf-run-1');
      expect(reloaded?.budgets.consumed_continuations).toBe(1);
      expect(reloaded?.revision).toBe(2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects mismatched Cursor agent identity', async () => {
    const { tempDir, store } = setupTestEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-run-2',
        cursor_agent_id: 'agent-correct',
        source_profile: 'omc-ralph',
        phase: 'loop',
        objective_artifact: 'obj-2',
        budgets: { max_iterations: 10, max_continuations: 5, deadline_at: '2026-12-31T23:59:59Z' },
      });
      store.save(projection);

      const result = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-run-2',
        cursor_agent_id: 'agent-wrong',
        epoch: 1,
        event_id: 'event-002',
        hook_event: 'stop',
      });

      expect(result.continue).toBe(false);
      expect(result.reason).toBe('mismatched_cursor_agent');
      expect(result.continuation_slot_consumed).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects mismatched epoch across process boundaries', async () => {
    const { tempDir, store } = setupTestEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-run-3',
        cursor_agent_id: 'agent-123',
        source_profile: 'omo-boulder',
        epoch: 2,
        phase: 'momentum_loop',
        objective_artifact: 'obj-3',
        budgets: { max_iterations: 10, max_continuations: 5, deadline_at: '2026-12-31T23:59:59Z' },
      });
      store.save(projection);

      const result = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-run-3',
        cursor_agent_id: 'agent-123',
        epoch: 1, // Stale epoch!
        event_id: 'event-003',
        hook_event: 'stop',
      });

      expect(result.continue).toBe(false);
      expect(result.reason).toBe('mismatched_epoch');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces idempotency and rejects duplicate event IDs', async () => {
    const { tempDir, store } = setupTestEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-run-4',
        cursor_agent_id: 'agent-123',
        source_profile: 'omc-pipeline',
        phase: 'implement',
        objective_artifact: 'obj-4',
        budgets: { max_iterations: 10, max_continuations: 5, deadline_at: '2026-12-31T23:59:59Z' },
        todos: [{ id: 't1', title: 'Work', completed: false, status: 'pending', created_at: '' }],
      });
      store.save(projection);

      const r1 = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-run-4',
        cursor_agent_id: 'agent-123',
        epoch: 1,
        event_id: 'event-dup-1',
        hook_event: 'stop',
      });
      expect(r1.continue).toBe(true);

      const r2 = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-run-4',
        cursor_agent_id: 'agent-123',
        epoch: 1,
        event_id: 'event-dup-1', // Same event ID!
        hook_event: 'stop',
      });
      expect(r2.continue).toBe(false);
      expect(r2.reason).toBe('duplicate_event');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('stops and marks cancelled when cancel_requested is true', async () => {
    const { tempDir, store } = setupTestEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-run-cancel',
        cursor_agent_id: 'agent-cancel',
        source_profile: 'omx-goal',
        phase: 'milestone_execute',
        objective_artifact: 'obj-c',
        cancel_requested: true,
        budgets: { max_iterations: 10, max_continuations: 5, deadline_at: '2026-12-31T23:59:59Z' },
      });
      store.save(projection);

      const result = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-run-cancel',
        cursor_agent_id: 'agent-cancel',
        epoch: 1,
        event_id: 'event-c-1',
        hook_event: 'stop',
      });

      expect(result.continue).toBe(false);
      expect(result.reason).toBe('cancel_requested');
      expect(store.load('wf-run-cancel')?.status).toBe('cancelled');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('enforces exact max_continuations budget and terminates on exhaustion', async () => {
    const { tempDir, store } = setupTestEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-run-budget',
        cursor_agent_id: 'agent-budget',
        source_profile: 'omc-autopilot',
        phase: 'execute',
        objective_artifact: 'obj-b',
        budgets: {
          max_iterations: 10,
          max_continuations: 2,
          deadline_at: '2026-12-31T23:59:59Z',
          consumed_continuations: 1,
        },
        todos: [{ id: 't1', title: 'Work', completed: false, status: 'pending', created_at: '' }],
      });
      store.save(projection);

      // Slot 2 of 2 (should succeed)
      const r1 = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-run-budget',
        cursor_agent_id: 'agent-budget',
        epoch: 1,
        event_id: 'ev-b-1',
        hook_event: 'stop',
      });
      expect(r1.continue).toBe(true);

      // Slot 3 of 2 (budget exhausted!)
      const r2 = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-run-budget',
        cursor_agent_id: 'agent-budget',
        epoch: 1,
        event_id: 'ev-b-2',
        hook_event: 'stop',
      });
      expect(r2.continue).toBe(false);
      expect(r2.reason).toBe('continuation_budget_exhausted');
      expect(store.load('wf-run-budget')?.status).toBe('failed');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed on ambiguous side effects', async () => {
    const { tempDir, store } = setupTestEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-run-ambig',
        cursor_agent_id: 'agent-ambig',
        source_profile: 'omc-autopilot',
        phase: 'execute',
        objective_artifact: 'obj-ambig',
        budgets: { max_iterations: 10, max_continuations: 5, deadline_at: '2026-12-31T23:59:59Z' },
        todos: [{ id: 't1', title: 'Work', completed: false, status: 'pending', created_at: '' }],
      });
      store.save(projection);

      const result = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-run-ambig',
        cursor_agent_id: 'agent-ambig',
        epoch: 1,
        event_id: 'ev-ambig-1',
        hook_event: 'stop',
        ambiguous_side_effect: true,
      });

      expect(result.continue).toBe(false);
      expect(result.reason).toBe('ambiguous_side_effect');
      expect(store.load('wf-run-ambig')?.status).toBe('blocked');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('marks completed when all goals, stories, and todos are satisfied, preserving verified: false', async () => {
    const { tempDir, store } = setupTestEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-run-done',
        cursor_agent_id: 'agent-done',
        source_profile: 'omx-goal',
        phase: 'milestone_execute',
        objective_artifact: 'obj-done',
        budgets: { max_iterations: 10, max_continuations: 5, deadline_at: '2026-12-31T23:59:59Z' },
        goals: [
          {
            id: 'g1',
            title: 'Feature completed',
            acceptance_criteria: ['test passing'],
            status: 'completed',
            created_at: '',
          },
        ],
        stories: [
          {
            id: 's1',
            goal_id: 'g1',
            title: 'Story 1',
            status: 'completed',
            dependencies: [],
            attempt: 1,
            evidence: [],
            created_at: '',
          },
        ],
        todos: [
          { id: 't1', title: 'Todo 1', completed: true, status: 'completed', created_at: '' },
        ],
      });
      store.save(projection);

      const result = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-run-done',
        cursor_agent_id: 'agent-done',
        epoch: 1,
        event_id: 'ev-done-1',
        hook_event: 'stop',
      });

      expect(result.continue).toBe(false);
      expect(result.reason).toBe('all_goals_satisfied');

      const reloaded = store.load('wf-run-done');
      expect(reloaded?.status).toBe('completed');
      expect(reloaded?.verified).toBe(false); // Preserved!
      expect(reloaded?.verification_authority).toBe('omcu-cli-only');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('handles repeated identical failures according to profile policy', async () => {
    const { tempDir, store } = setupTestEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-run-pipe',
        cursor_agent_id: 'agent-pipe',
        source_profile: 'omc-pipeline', // pipeline onRepeatedFailure is 'terminal_failure' (threshold: 2)
        phase: 'implement',
        objective_artifact: 'obj-pipe',
        budgets: { max_iterations: 10, max_continuations: 10, deadline_at: '2026-12-31T23:59:59Z' },
        todos: [{ id: 't1', title: 'Work', completed: false, status: 'pending', created_at: '' }],
      });
      store.save(projection);

      // Failure 1
      const r1 = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-run-pipe',
        cursor_agent_id: 'agent-pipe',
        epoch: 1,
        event_id: 'ev-f-1',
        hook_event: 'stop',
        observed_failure: { command: 'compile', error: 'SyntaxError: unexpected token' },
      });
      expect(r1.continue).toBe(true);

      // Failure 2 (repeated identical failure -> terminal_failure)
      const r2 = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-run-pipe',
        cursor_agent_id: 'agent-pipe',
        epoch: 1,
        event_id: 'ev-f-2',
        hook_event: 'stop',
        observed_failure: { command: 'compile', error: 'SyntaxError: unexpected token' },
      });

      expect(r2.continue).toBe(false);
      expect(r2.reason).toBe('repeated_failure_detected');
      expect(r2.failure_routing).toBe('terminal_failure');
      expect(store.load('wf-run-pipe')?.status).toBe('failed');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent continuation requests so that exactly one continuation slot is granted', async () => {
    const { tempDir, store } = setupTestEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-run-concurrent',
        cursor_agent_id: 'agent-concurrent',
        source_profile: 'omc-autopilot',
        phase: 'execute',
        objective_artifact: 'obj-conc',
        budgets: {
          max_iterations: 10,
          max_continuations: 1, // Only 1 slot left!
          deadline_at: '2026-12-31T23:59:59Z',
          consumed_continuations: 0,
        },
        todos: [{ id: 't1', title: 'Work', completed: false, status: 'pending', created_at: '' }],
      });
      store.save(projection);

      // Fire 5 concurrent requests
      const promises = Array.from({ length: 5 }, (_, idx) =>
        executeContinuationTransaction({
          cwd: tempDir,
          run_id: 'wf-run-concurrent',
          cursor_agent_id: 'agent-concurrent',
          epoch: 1,
          event_id: `ev-concurrent-${idx}`,
          hook_event: 'stop',
        })
      );

      const results = await Promise.all(promises);
      const continued = results.filter((r) => r.continue);
      const refused = results.filter((r) => !r.continue);

      expect(continued).toHaveLength(1);
      expect(refused).toHaveLength(4);
      expect(store.load('wf-run-concurrent')?.budgets.consumed_continuations).toBe(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects continuation when cursor_run_id does not match', async () => {
    const { tempDir, store } = setupTestEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-run-mismatch',
        cursor_agent_id: 'agent-123',
        cursor_run_id: 'cursor-run-aaa',
        source_profile: 'omc-autopilot',
        phase: 'execute',
        objective_artifact: 'obj-run-check',
        budgets: { max_iterations: 10, max_continuations: 5, deadline_at: '2026-12-31T23:59:59Z' },
        todos: [{ id: 't1', title: 'Work', completed: false, status: 'pending', created_at: '' }],
      });
      store.save(projection);

      const result = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-run-mismatch',
        cursor_agent_id: 'agent-123',
        cursor_run_id: 'cursor-run-wrong',
        epoch: 1,
        event_id: 'ev-run-mismatch',
        hook_event: 'stop',
      });

      expect(result.continue).toBe(false);
      expect(result.reason).toBe('mismatched_cursor_run');
      expect(result.continuation_slot_consumed).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects continuation when no open goals, stories, or todos remain', async () => {
    const { tempDir, store } = setupTestEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-no-next-action',
        cursor_agent_id: 'agent-123',
        source_profile: 'omc-autopilot',
        phase: 'execute',
        objective_artifact: 'obj-no-action',
        budgets: { max_iterations: 10, max_continuations: 5, deadline_at: '2026-12-31T23:59:59Z' },
        goals: [
          {
            id: 'g-failed',
            title: 'Unsatisfied goal',
            acceptance_criteria: ['test pass'],
            status: 'failed',
            created_at: '',
          },
        ],
        todos: [
          { id: 't-cancelled', title: 'Cancelled step', completed: false, status: 'cancelled', created_at: '' },
        ],
      });
      store.save(projection);

      const result = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-no-next-action',
        cursor_agent_id: 'agent-123',
        epoch: 1,
        event_id: 'ev-no-action',
        hook_event: 'stop',
      });

      expect(result.continue).toBe(false);
      expect(result.reason).toBe('no_next_action');
      expect(result.continuation_slot_consumed).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects continuation when workflow is already in a terminal phase', async () => {
    const { tempDir, store } = setupTestEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-terminal',
        cursor_agent_id: 'agent-123',
        source_profile: 'omc-autopilot',
        phase: 'completed', // Terminal phase in omc-autopilot
        objective_artifact: 'obj-term',
        budgets: { max_iterations: 10, max_continuations: 5, deadline_at: '2026-12-31T23:59:59Z' },
        todos: [{ id: 't1', title: 'Lingering item', completed: false, status: 'pending', created_at: '' }],
      });
      store.save(projection);

      const result = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-terminal',
        cursor_agent_id: 'agent-123',
        epoch: 1,
        event_id: 'ev-terminal',
        hook_event: 'stop',
      });

      expect(result.continue).toBe(false);
      expect(result.reason).toBe('terminal_phase_reached');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts failure fingerprint from turn_output.error when observed_failure is not provided', async () => {
    const { tempDir, store } = setupTestEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-turn-err',
        cursor_agent_id: 'agent-123',
        source_profile: 'omc-pipeline',
        phase: 'implement',
        objective_artifact: 'obj-turn-err',
        budgets: { max_iterations: 10, max_continuations: 10, deadline_at: '2026-12-31T23:59:59Z' },
        todos: [{ id: 't1', title: 'Work', completed: false, status: 'pending', created_at: '' }],
      });
      store.save(projection);

      const result = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-turn-err',
        cursor_agent_id: 'agent-123',
        epoch: 1,
        event_id: 'ev-turn-err-1',
        hook_event: 'afterAgentResponse',
        turn_output: {
          error: new Error('Command failed with exit code 1'),
          text: 'error output details',
        },
      });

      expect(result.continue).toBe(true);
      expect(result.failure_fingerprint).toBeDefined();
      expect(result.failure_fingerprint).toContain('fp-');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('delivers continuation via afterAgentResponse hook event', async () => {
    const { tempDir, store } = setupTestEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-aar-test',
        cursor_agent_id: 'agent-aar',
        source_profile: 'omc-autopilot',
        phase: 'execute',
        objective_artifact: 'obj-aar',
        budgets: { max_iterations: 10, max_continuations: 5, deadline_at: '2026-12-31T23:59:59Z' },
        todos: [{ id: 't-next', title: 'Next step', completed: false, status: 'pending', created_at: '' }],
      });
      store.save(projection);

      const result = await executeContinuationTransaction({
        cwd: tempDir,
        run_id: 'wf-aar-test',
        cursor_agent_id: 'agent-aar',
        epoch: 1,
        event_id: 'ev-aar-1',
        hook_event: 'afterAgentResponse',
      });

      expect(result.continue).toBe(true);
      expect(result.continuation_slot_consumed).toBe(true);
      expect(result.followup_message).toContain('OMCU continuation active');
      expect(result.followup_message).toContain('Next step');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
