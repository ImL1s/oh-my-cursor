import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createCompactHandoff,
  saveHandoffArtifact,
  loadHandoffArtifact,
  resumeWorkflowFromHandoff,
} from '../../src/compaction/handoff.js';
import { createWorkflowProjection } from '../../src/workflows/projection.js';
import { WorkflowProjectionStore } from '../../src/runtime/cursor-sdk/store.js';
import { dispatchHook } from '../../src/hooks/dispatcher.js';
import type { CursorRuntime, ManagedCursorAgent } from '../../src/runtime/cursor-sdk/types.js';

describe('Compaction, Resume, and Native Hook Integration', () => {
  function setupEnv() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-compaction-test-'));
    const store = new WorkflowProjectionStore(tempDir);
    return { tempDir, store };
  }

  it('generates a compact handoff artifact containing all context boundary data', () => {
    const projection = createWorkflowProjection({
      run_id: 'wf-compact-1',
      cursor_agent_id: 'agent-compact-1',
      source_profile: 'omc-autopilot',
      phase: 'execute',
      objective_artifact: 'artifact:objective-compact',
      budgets: {
        max_iterations: 20,
        max_continuations: 50,
        deadline_at: '2026-12-01T00:00:00Z',
        consumed_iterations: 5,
        consumed_continuations: 8,
      },
      goals: [
        {
          id: 'goal-c1',
          title: 'Primary Goal',
          acceptance_criteria: ['100% tests pass'],
          status: 'in_progress',
          created_at: '',
        },
      ],
      stories: [
        {
          id: 'story-c1',
          goal_id: 'goal-c1',
          title: 'Implement database models',
          status: 'in_progress',
          dependencies: [],
          attempt: 2,
          evidence: [],
          created_at: '',
        },
      ],
      todos: [
        { id: 'todo-c1', title: 'Add schema migration', completed: false, status: 'pending', created_at: '' },
      ],
      evidence: [
        {
          id: 'ev-c1',
          type: 'test',
          reference: 'npm test tests/models.test.ts',
          digest: 'sha256-mock',
          verified: false,
          created_at: '',
        },
      ],
    });

    const handoff = createCompactHandoff(projection, {
      known_facts: ['Postgres connection verified', 'PR branch created'],
      unresolved_decisions: ['Should we use enum or string for status'],
      changed_files: ['src/models/user.ts'],
      next_safe_action: 'Run migration and verify schema',
    });

    expect(handoff.schema_version).toBe(1);
    expect(handoff.run_id).toBe('wf-compact-1');
    expect(handoff.cursor_agent_id).toBe('agent-compact-1');
    expect(handoff.current_phase).toBe('execute');
    expect(handoff.open_goals).toHaveLength(1);
    expect(handoff.open_stories).toHaveLength(1);
    expect(handoff.open_todos).toHaveLength(1);
    expect(handoff.known_facts).toContain('Postgres connection verified');
    expect(handoff.unresolved_decisions).toContain('Should we use enum or string for status');
    expect(handoff.changed_files).toContain('src/models/user.ts');
    expect(handoff.next_safe_action).toBe('Run migration and verify schema');
    expect(handoff.remaining_budgets.continuations_left).toBe(42);
    expect(handoff.sha256).toBeDefined();
  });

  it('persists and loads handoff artifact from filesystem', () => {
    const { tempDir } = setupEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-handoff-io',
        cursor_agent_id: 'agent-h-1',
        source_profile: 'omx-goal',
        phase: 'milestone_execute',
        objective_artifact: 'obj-h',
        budgets: { max_iterations: 10, max_continuations: 20, deadline_at: '2026-12-01T00:00:00Z' },
      });

      const handoff = createCompactHandoff(projection);
      const savedPath = saveHandoffArtifact(tempDir, handoff);
      expect(fs.existsSync(savedPath)).toBe(true);

      const loaded = loadHandoffArtifact(tempDir, handoff.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.id).toBe(handoff.id);
      expect(loaded?.run_id).toBe('wf-handoff-io');
      expect(loaded?.sha256).toBe(handoff.sha256);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resumes workflow via resumeWorkflowFromHandoff, advances epoch, and invokes Agent.resume', async () => {
    const { tempDir, store } = setupEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-resume-test',
        cursor_agent_id: 'cursor-agent-target',
        source_profile: 'omc-autopilot',
        phase: 'execute',
        epoch: 1,
        revision: 1,
        objective_artifact: 'obj-target',
        budgets: { max_iterations: 20, max_continuations: 40, deadline_at: '2026-12-01T00:00:00Z' },
      });
      store.save(projection);

      const mockManagedAgent: ManagedCursorAgent = {
        agentId: 'cursor-agent-target',
        target: 'local',
        send: vi.fn(),
        close: vi.fn(),
        [Symbol.asyncDispose]: vi.fn(),
      };

      const mockRuntime: CursorRuntime = {
        target: 'local',
        prompt: vi.fn(),
        createAgent: vi.fn(),
        resumeAgent: vi.fn().mockResolvedValue(mockManagedAgent),
        getAgent: vi.fn(),
        getRun: vi.fn(),
        listRuns: vi.fn(),
        dispose: vi.fn(),
        [Symbol.asyncDispose]: vi.fn(),
      };

      const result = await resumeWorkflowFromHandoff({
        baseDir: tempDir,
        run_id: 'wf-resume-test',
        cursor_agent_id: 'cursor-agent-target',
        runtime: mockRuntime,
      });

      expect(result.managedAgent).toBe(mockManagedAgent);
      expect(result.projection.epoch).toBe(2); // Advanced epoch!
      expect(result.projection.revision).toBe(2);
      expect(mockRuntime.resumeAgent).toHaveBeenCalledWith('cursor-agent-target');

      // Check updated projection persisted
      const reloaded = store.load('wf-resume-test');
      expect(reloaded?.epoch).toBe(2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects resume when Cursor agent identity does not match', async () => {
    const { tempDir, store } = setupEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-mismatch',
        cursor_agent_id: 'cursor-agent-legit',
        source_profile: 'omc-autopilot',
        phase: 'execute',
        objective_artifact: 'obj-m',
        budgets: { max_iterations: 10, max_continuations: 20, deadline_at: '2026-12-01T00:00:00Z' },
      });
      store.save(projection);

      const mockRuntime = {
        resumeAgent: vi.fn(),
      } as unknown as CursorRuntime;

      await expect(
        resumeWorkflowFromHandoff({
          baseDir: tempDir,
          run_id: 'wf-mismatch',
          cursor_agent_id: 'cursor-agent-imposter',
          runtime: mockRuntime,
        })
      ).rejects.toThrow('E_CURSOR_IDENTITY_MISMATCH');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('delivers native followup_message via dispatchHook stop event for active workflow', async () => {
    const { tempDir, store } = setupEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-hook-test',
        cursor_agent_id: 'agent-hook-123',
        source_profile: 'omo-boulder',
        phase: 'start_work',
        objective_artifact: 'obj-hook',
        budgets: { max_iterations: 20, max_continuations: 30, deadline_at: '2026-12-01T00:00:00Z' },
        todos: [{ id: 't1', title: 'Push forward', completed: false, status: 'pending', created_at: '' }],
      });
      store.save(projection);

      const dispatchResult = await dispatchHook(
        'stop',
        {
          agent_id: 'agent-hook-123',
          run_id: 'wf-hook-test',
          status: 'completed',
        },
        { cwd: tempDir }
      );

      expect(dispatchResult.success).toBe(true);
      expect(dispatchResult.response.followup_message).toBeDefined();
      expect(String(dispatchResult.response.followup_message)).toContain('OMCU continuation active');
      expect(String(dispatchResult.response.followup_message)).toContain('OMO Boulder');

      // Verify continuation count was persisted
      const reloaded = store.load('wf-hook-test');
      expect(reloaded?.budgets.consumed_continuations).toBe(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('records review evidence via dispatchHook afterAgentResponse event', async () => {
    const { tempDir, store } = setupEnv();
    try {
      const projection = createWorkflowProjection({
        run_id: 'wf-evidence-test',
        cursor_agent_id: 'agent-evidence-123',
        source_profile: 'omc-autopilot',
        phase: 'review',
        objective_artifact: 'obj-ev',
        budgets: { max_iterations: 20, max_continuations: 30, deadline_at: '2026-12-01T00:00:00Z' },
      });
      store.save(projection);

      const dispatchResult = await dispatchHook(
        'afterAgentResponse',
        {
          agent_id: 'agent-evidence-123',
          run_id: 'wf-evidence-test',
          agent_response: 'All unit tests PASS with 100% coverage. Review verdict: approved.',
        },
        { cwd: tempDir }
      );

      expect(dispatchResult.success).toBe(true);

      const reloaded = store.load('wf-evidence-test');
      expect(reloaded?.evidence.length).toBeGreaterThan(0);
      expect(reloaded?.evidence[0]?.type).toBe('review');
      expect(reloaded?.verified).toBe(false); // Authoritative verified remains false!
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
