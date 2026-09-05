import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, type Run, type RunResult, type SDKAgent } from '@cursor/sdk';
import {
  DagRunner,
  renderDagCanvas,
  validateDag,
  validateRankEditOwnership,
  type DagDefinition,
} from '../../src/dag/index.js';

describe('Local DAG Executor (Official Cookbook DAG Pattern)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-dag-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('DAG Validation & Rank Computation', () => {
    it('computes topological ranks for a valid DAG', () => {
      const dag: DagDefinition = {
        dagId: 'dag-valid-1',
        tasks: [
          { id: 'task-a', role: 'omcu-analyst', prompt: 'Analyze' },
          { id: 'task-b', role: 'omcu-analyst', prompt: 'Analyze another part' },
          { id: 'task-c', role: 'omcu-worker', prompt: 'Implement', dependencies: ['task-a', 'task-b'] },
          { id: 'task-d', role: 'omcu-verifier', prompt: 'Verify', dependencies: ['task-c'] },
        ],
      };

      const result = validateDag(dag);
      expect(result.ranks).toHaveLength(3);
      expect(result.ranks[0]?.tasks.map((t) => t.id).sort()).toEqual(['task-a', 'task-b']);
      expect(result.ranks[1]?.tasks.map((t) => t.id)).toEqual(['task-c']);
      expect(result.ranks[2]?.tasks.map((t) => t.id)).toEqual(['task-d']);
    });

    it('rejects self-dependencies', () => {
      const dag: DagDefinition = {
        dagId: 'dag-self-dep',
        tasks: [
          { id: 'task-self', role: 'omcu-worker', prompt: 'Do work', dependencies: ['task-self'] },
        ],
      };
      expect(() => validateDag(dag)).toThrow(/E_DAG_SELF_DEPENDENCY/);
    });

    it('rejects missing dependencies', () => {
      const dag: DagDefinition = {
        dagId: 'dag-missing-dep',
        tasks: [
          { id: 'task-1', role: 'omcu-worker', prompt: 'Do work', dependencies: ['ghost-task'] },
        ],
      };
      expect(() => validateDag(dag)).toThrow(/E_DAG_DEPENDENCY_NOT_FOUND/);
    });

    it('rejects cyclic dependencies', () => {
      const dag: DagDefinition = {
        dagId: 'dag-cycle',
        tasks: [
          { id: 'task-1', role: 'omcu-worker', prompt: 'Task 1', dependencies: ['task-2'] },
          { id: 'task-2', role: 'omcu-worker', prompt: 'Task 2', dependencies: ['task-3'] },
          { id: 'task-3', role: 'omcu-worker', prompt: 'Task 3', dependencies: ['task-1'] },
        ],
      };
      expect(() => validateDag(dag)).toThrow(/E_DAG_CYCLE/);
    });
  });

  describe('Local Edit Ownership Conflict Validation', () => {
    it('rejects concurrent tasks in the same rank claiming overlapping owned paths', () => {
      const dag: DagDefinition = {
        dagId: 'dag-conflict',
        tasks: [
          {
            id: 'worker-1',
            role: 'omcu-worker',
            prompt: 'Edit auth',
            ownedPaths: ['src/auth/login.ts'],
          },
          {
            id: 'worker-2',
            role: 'omcu-worker',
            prompt: 'Edit same auth module',
            ownedPaths: ['src/auth/login.ts'],
          },
        ],
      };

      const { ranks } = validateDag(dag);
      expect(() => validateRankEditOwnership(ranks, tempDir)).toThrow(/E_DAG_OWNERSHIP_CONFLICT/);
    });

    it('allows concurrent tasks with non-overlapping paths in the same workspace', () => {
      const dag: DagDefinition = {
        dagId: 'dag-non-overlapping',
        tasks: [
          {
            id: 'worker-auth',
            role: 'omcu-worker',
            prompt: 'Edit auth',
            ownedPaths: ['src/auth/login.ts'],
          },
          {
            id: 'worker-db',
            role: 'omcu-worker',
            prompt: 'Edit db',
            ownedPaths: ['src/db/client.ts'],
          },
        ],
      };

      const { ranks } = validateDag(dag);
      expect(() => validateRankEditOwnership(ranks, tempDir)).not.toThrow();
    });

    it('allows concurrent tasks when isolated in distinct worktrees', () => {
      const dag: DagDefinition = {
        dagId: 'dag-worktree-isolated',
        tasks: [
          {
            id: 'worker-wt1',
            role: 'omcu-worker',
            prompt: 'Edit in wt1',
            worktree: path.join(tempDir, 'wt1'),
            ownedPaths: ['src/index.ts'],
          },
          {
            id: 'worker-wt2',
            role: 'omcu-worker',
            prompt: 'Edit in wt2',
            worktree: path.join(tempDir, 'wt2'),
            ownedPaths: ['src/index.ts'],
          },
        ],
      };

      const { ranks } = validateDag(dag);
      expect(() => validateRankEditOwnership(ranks, tempDir)).not.toThrow();
    });
  });

  describe('DAG Execution & Dependency Skip', () => {
    it('executes parallel ranks and skips downstream tasks when upstream fails', async () => {
      const capturedPrompts: string[] = [];
      const createSpy = vi.spyOn(Agent, 'create').mockImplementation(async () => {
        let runPrompt = '';
        const fakeRun: Partial<Run> = {
          id: `run-${Date.now()}-${Math.random()}`,
          agentId: 'fake-agent',
          status: 'running',
          supports: () => true,
          unsupportedReason: () => undefined,
          wait: async () => {
            if (runPrompt.includes('Task A fails')) {
              return { id: 'run-err', status: 'failed', error: { message: 'Syntax error' } } as RunResult;
            }
            return { id: 'run-ok', status: 'completed', result: 'Output from task' } as RunResult;
          },
        };

        const fakeAgent: Partial<SDKAgent> = {
          agentId: 'fake-agent',
          send: vi.fn().mockImplementation(async (msg: string) => {
            runPrompt = msg;
            capturedPrompts.push(msg);
            return fakeRun as Run;
          }),
          close: vi.fn(),
        };

        return fakeAgent as SDKAgent;
      });

      const dag: DagDefinition = {
        dagId: 'dag-skip-test',
        tasks: [
          { id: 'task-a', role: 'omcu-worker', prompt: 'Task A fails' },
          { id: 'task-b', role: 'omcu-worker', prompt: 'Task B succeeds' },
          { id: 'task-c', role: 'omcu-worker', prompt: 'Task C dependent on A', dependencies: ['task-a'] },
          { id: 'task-d', role: 'omcu-worker', prompt: 'Task D dependent on B', dependencies: ['task-b'] },
          { id: 'task-e', role: 'omcu-worker', prompt: 'Task E dependent on C and D', dependencies: ['task-c', 'task-d'] },
        ],
      };

      const runner = new DagRunner(tempDir);
      const status = await runner.run(dag, { canvas: true });

      expect(status.status).toBe('failed');
      expect(status.tasks['task-a']?.status).toBe('failed');
      expect(status.tasks['task-b']?.status).toBe('completed');
      expect(status.tasks['task-c']?.status).toBe('skipped');
      expect(status.tasks['task-c']?.blockerReason).toContain('upstream_dependency_failed:task-a');
      expect(status.tasks['task-d']?.status).toBe('completed');
      expect(status.tasks['task-e']?.status).toBe('skipped');

      // Verify canvas rendered
      expect(status.canvas).toBeDefined();
      expect(status.canvas).toContain('[✓] task-b');
      expect(status.canvas).toContain('[✗] task-a');
      expect(status.canvas).toContain('[⏭] task-c');
    });

    it('stitches bounded upstream context and asserts minimal context', async () => {
      const receivedPrompts: string[] = [];

      vi.spyOn(Agent, 'create').mockImplementation(async () => {
        const fakeRun: Partial<Run> = {
          id: 'run-stitch',
          agentId: 'agent-stitch',
          status: 'running',
          supports: () => true,
          unsupportedReason: () => undefined,
          wait: async () => ({
            id: 'run-stitch',
            status: 'completed',
            result: 'Analysis completed: found 3 security issues.',
          } as RunResult),
        };

        const fakeAgent: Partial<SDKAgent> = {
          agentId: 'agent-stitch',
          send: vi.fn().mockImplementation(async (msg: string) => {
            receivedPrompts.push(msg);
            return fakeRun as Run;
          }),
          close: vi.fn(),
        };

        return fakeAgent as SDKAgent;
      });

      const dag: DagDefinition = {
        dagId: 'dag-context-test',
        tasks: [
          { id: 'upstream-task', role: 'omcu-analyst', prompt: 'Scan for issues' },
          { id: 'downstream-task', role: 'omcu-worker', prompt: 'Fix issues', dependencies: ['upstream-task'] },
        ],
      };

      const runner = new DagRunner(tempDir);
      const res = await runner.run(dag);

      expect(res.status).toBe('completed');
      // Downstream prompt should contain bounded output from upstream
      const downstreamPrompt = receivedPrompts[1];
      expect(downstreamPrompt).toContain('Bounded Upstream Output: Task \'upstream-task\'');
      expect(downstreamPrompt).toContain('Analysis completed: found 3 security issues.');
      // Should NOT contain raw transcript formatting
      expect(downstreamPrompt).not.toContain('ConversationTurn');
    });

    it('respects maxConcurrency option during rank execution', async () => {
      let activeRuns = 0;
      let peakConcurrency = 0;

      vi.spyOn(Agent, 'create').mockImplementation(async () => {
        const fakeRun: Partial<Run> = {
          id: `run-concurrency-${Math.random()}`,
          agentId: 'agent-concurrency',
          status: 'running',
          supports: () => true,
          unsupportedReason: () => undefined,
          wait: async () => {
            activeRuns++;
            peakConcurrency = Math.max(peakConcurrency, activeRuns);
            // Simulate work duration
            await new Promise((resolve) => setTimeout(resolve, 30));
            activeRuns--;
            return {
              id: 'run-done',
              status: 'completed',
              result: 'Worker completed',
            } as RunResult;
          },
        };

        const fakeAgent: Partial<SDKAgent> = {
          agentId: 'agent-concurrency',
          send: vi.fn().mockResolvedValue(fakeRun as Run),
          close: vi.fn(),
        };

        return fakeAgent as SDKAgent;
      });

      const dag: DagDefinition = {
        dagId: 'dag-concurrency-test',
        tasks: [
          { id: 't1', role: 'omcu-worker', prompt: 'Work 1' },
          { id: 't2', role: 'omcu-worker', prompt: 'Work 2' },
          { id: 't3', role: 'omcu-worker', prompt: 'Work 3' },
          { id: 't4', role: 'omcu-worker', prompt: 'Work 4' },
        ],
      };

      const runner = new DagRunner(tempDir);
      const res = await runner.run(dag, { maxConcurrency: 2 });

      expect(res.status).toBe('completed');
      expect(peakConcurrency).toBeLessThanOrEqual(2);
    });

    it('forwards task budget to task record and bounds total upstream context', async () => {
      const capturedPrompts: string[] = [];
      vi.spyOn(Agent, 'create').mockImplementation(async () => {
        const fakeRun: Partial<Run> = {
          id: 'run-budget',
          agentId: 'agent-budget',
          status: 'running',
          supports: () => true,
          unsupportedReason: () => undefined,
          wait: async () => ({
            id: 'run-budget',
            status: 'completed',
            result: 'A'.repeat(2000),
          } as RunResult),
        };

        const fakeAgent: Partial<SDKAgent> = {
          agentId: 'agent-budget',
          send: vi.fn().mockImplementation(async (msg: string) => {
            capturedPrompts.push(msg);
            return fakeRun as Run;
          }),
          close: vi.fn(),
        };

        return fakeAgent as SDKAgent;
      });

      // 6 upstream tasks each returning 2000 chars
      const dag: DagDefinition = {
        dagId: 'dag-budget-total-context',
        tasks: [
          { id: 'u1', role: 'omcu-worker', prompt: 'P1', budget: { maxTokens: 500 } },
          { id: 'u2', role: 'omcu-worker', prompt: 'P2' },
          { id: 'u3', role: 'omcu-worker', prompt: 'P3' },
          { id: 'u4', role: 'omcu-worker', prompt: 'P4' },
          { id: 'u5', role: 'omcu-worker', prompt: 'P5' },
          { id: 'u6', role: 'omcu-worker', prompt: 'P6' },
          {
            id: 'downstream-fanin',
            role: 'omcu-verifier',
            prompt: 'Verify all',
            dependencies: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'],
          },
        ],
      };

      const runner = new DagRunner(tempDir);
      const res = await runner.run(dag);

      expect(res.status).toBe('completed');
      expect(res.tasks['u1']?.budget?.maxTokens).toBe(500);

      // Downstream prompt should not explode in length and should have total context truncation
      const fanInPrompt = capturedPrompts[capturedPrompts.length - 1]!;
      expect(fanInPrompt).toContain('total upstream context truncated to 8192 chars');
      expect(res.tasks['downstream-fanin']?.prompt.length).toBeLessThan(8300);
      expect(fanInPrompt.length).toBeLessThan(11000);
    });
  });
});
