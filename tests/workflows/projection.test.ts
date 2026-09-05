import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createWorkflowProjection,
  digestWorkflowProjection,
  type WorkflowProjection,
} from '../../src/workflows/projection.js';
import { WorkflowProjectionStore } from '../../src/runtime/cursor-sdk/store.js';

describe('WorkflowProjection and Store', () => {
  it('creates canonical workflow projection with all required fields', () => {
    const projection = createWorkflowProjection({
      run_id: 'omcu-run-101',
      cursor_agent_id: 'cursor-agent-abc',
      source_profile: 'omc-autopilot',
      phase: 'interview',
      objective_artifact: 'artifact:objective-1',
      budgets: {
        max_iterations: 20,
        max_continuations: 50,
        deadline_at: '2026-10-01T00:00:00.000Z',
      },
      goals: [
        {
          id: 'goal-1',
          title: 'Implement feature',
          acceptance_criteria: ['unit tests pass', 'type check clean'],
          status: 'in_progress',
          created_at: '2026-09-06T00:00:00.000Z',
        },
      ],
      stories: [
        {
          id: 'story-1',
          goal_id: 'goal-1',
          title: 'Setup initial files',
          status: 'in_progress',
          dependencies: [],
          attempt: 1,
          evidence: [],
          created_at: '2026-09-06T00:00:00.000Z',
        },
      ],
      todos: [
        {
          id: 'todo-1',
          title: 'Write test file',
          completed: false,
          status: 'pending',
          created_at: '2026-09-06T00:00:00.000Z',
        },
      ],
    });

    expect(projection.schema_version).toBe(1);
    expect(projection.run_id).toBe('omcu-run-101');
    expect(projection.cursor_agent_id).toBe('cursor-agent-abc');
    expect(projection.source_profile).toBe('omc-autopilot');
    expect(projection.epoch).toBe(1);
    expect(projection.revision).toBe(1);
    expect(projection.status).toBe('active');
    expect(projection.phase).toBe('interview');
    expect(projection.budgets.max_continuations).toBe(50);
    expect(projection.budgets.consumed_continuations).toBe(0);
    expect(projection.goals).toHaveLength(1);
    expect(projection.stories).toHaveLength(1);
    expect(projection.todos).toHaveLength(1);
    expect(projection.cancel_requested).toBe(false);
    expect(projection.verified).toBe(false);
    expect(projection.verification_authority).toBe('omcu-cli-only');

    // Backward-compatibility properties
    expect(projection.workflowId).toBe('omcu-run-101');
    expect(projection.cursorAgentId).toBe('cursor-agent-abc');
  });

  it('produces deterministic digests for identical projections', () => {
    const p1 = createWorkflowProjection({
      run_id: 'run-test',
      cursor_agent_id: 'agent-1',
      source_profile: 'omx-goal',
      phase: 'goal_intake',
      objective_artifact: 'art-1',
      budgets: { max_iterations: 10, max_continuations: 20, deadline_at: '2026-12-01T00:00:00Z' },
    });

    const p2 = createWorkflowProjection({
      run_id: 'run-test',
      cursor_agent_id: 'agent-1',
      source_profile: 'omx-goal',
      phase: 'goal_intake',
      objective_artifact: 'art-1',
      budgets: { max_iterations: 10, max_continuations: 20, deadline_at: '2026-12-01T00:00:00Z' },
    });

    expect(digestWorkflowProjection(p1)).toBe(digestWorkflowProjection(p2));
  });

  it('persists and reloads projections via WorkflowProjectionStore', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-proj-store-'));
    try {
      const store = new WorkflowProjectionStore(tempDir);
      const projection = createWorkflowProjection({
        run_id: 'run-persistence-1',
        cursor_agent_id: 'agent-pers-1',
        source_profile: 'omo-boulder',
        phase: 'start_work',
        objective_artifact: 'boulder-plan',
        budgets: { max_iterations: 20, max_continuations: 40, deadline_at: '2026-11-01T00:00:00Z' },
        goals: [
          {
            id: 'goal-boulder',
            title: 'Push the boulder',
            acceptance_criteria: ['never stop'],
            status: 'in_progress',
            created_at: new Date().toISOString(),
          },
        ],
      });

      store.save(projection);
      const loaded = store.load('run-persistence-1');
      expect(loaded).not.toBeNull();
      expect(loaded?.run_id).toBe('run-persistence-1');
      expect(loaded?.cursor_agent_id).toBe('agent-pers-1');
      expect(loaded?.source_profile).toBe('omo-boulder');
      expect(loaded?.goals[0]?.title).toBe('Push the boulder');
      expect(loaded?.workflowId).toBe('run-persistence-1');
      expect(loaded?.cursorAgentId).toBe('agent-pers-1');

      // Update phase
      const updated = store.updatePhase('run-persistence-1', 'momentum_loop', 'in_progress');
      expect(updated.phase).toBe('momentum_loop');

      // List projections
      const list = store.list();
      expect(list).toHaveLength(1);
      expect(list[0].run_id).toBe('run-persistence-1');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('loads legacy projection and normalizes missing fields gracefully', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-legacy-store-'));
    try {
      const storeDir = path.join(tempDir, '.omcu', 'workflows');
      fs.mkdirSync(storeDir, { recursive: true });
      const legacyRaw = {
        schema_version: 1,
        workflowId: 'legacy-wf-99',
        cursorAgentId: 'agent-legacy-99',
        target: 'local',
        goal: 'Legacy Goal',
        phases: [{ name: 'phase-1', status: 'in_progress' }],
        acceptanceCriteria: [{ description: 'legacy crit', met: false }],
        evidenceReferences: ['ev-1'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      fs.writeFileSync(path.join(storeDir, 'legacy-wf-99.json'), JSON.stringify(legacyRaw));

      const store = new WorkflowProjectionStore(tempDir);
      const loaded = store.load('legacy-wf-99');
      expect(loaded).not.toBeNull();
      expect(loaded?.run_id).toBe('legacy-wf-99');
      expect(loaded?.cursor_agent_id).toBe('agent-legacy-99');
      expect(loaded?.status).toBe('active');
      expect(loaded?.goals[0]?.title).toBe('Legacy Goal');
      expect(loaded?.budgets.max_continuations).toBe(50);
      expect(loaded?.verified).toBe(false);
      expect(loaded?.verification_authority).toBe('omcu-cli-only');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
