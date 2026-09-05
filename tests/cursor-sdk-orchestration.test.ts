import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, type Run, type RunResult, type SDKAgent } from '@cursor/sdk';
import {
  createCursorRuntime,
  WorkflowProjectionStore,
  type WorkflowProjection,
} from '../src/runtime/cursor-sdk/index.js';

describe('Cursor SDK Orchestration Slices (Local & Cloud)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-sdk-orch-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('Local Vertical Slice: deep-interview -> plan -> execute -> review -> resume', () => {
    it('executes end-to-end local workflow pipeline with thin projection tracking', async () => {
      const projectionStore = new WorkflowProjectionStore(tempDir);
      const localRuntime = createCursorRuntime({
        target: 'local',
        cwd: tempDir,
        model: 'claude-3-5-sonnet',
      });

      // 1. Initial Projection creation
      const workflow: WorkflowProjection = {
        schema_version: 1,
        workflowId: 'wf-local-slice-01',
        cursorAgentId: 'agent-local-1',
        target: 'local',
        goal: 'Refactor database indexing',
        phases: [
          { name: 'deep-interview', status: 'pending' },
          { name: 'plan', status: 'pending' },
          { name: 'execute', status: 'pending' },
          { name: 'review', status: 'pending' },
        ],
        acceptanceCriteria: [
          { description: 'Indexes are created', met: false },
        ],
        evidenceReferences: [],
        sourceProfile: 'autopilot',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      projectionStore.save(workflow);

      // 2. Deep-interview phase completes
      projectionStore.updatePhase('wf-local-slice-01', 'deep-interview', 'completed', 'Ambiguity resolved to 0.0');

      // 3. Plan artifact generated
      const planArtifactPath = path.join(tempDir, 'PLAN.md');
      fs.writeFileSync(planArtifactPath, '# Plan\n1. Add index to users.email\n');
      projectionStore.updatePhase('wf-local-slice-01', 'plan', 'completed', 'Plan committed to PLAN.md');

      // 4. SDK local executor runs via agent.send()
      const fakeRun: Partial<Run> = {
        id: 'run-exec-100',
        agentId: 'agent-local-1',
        status: 'running',
        supports: (op) => op === 'wait' || op === 'stream',
        unsupportedReason: () => undefined,
        async *stream() {
          yield { type: 'text-delta', delta: 'Creating index...' } as any;
        },
        wait: async () => ({ id: 'run-exec-100', status: 'completed', result: 'Index created' } as RunResult),
      };

      const fakeAgent: Partial<SDKAgent> = {
        agentId: 'agent-local-1',
        send: vi.fn().mockResolvedValue(fakeRun as Run),
        close: vi.fn(),
      };
      vi.spyOn(Agent, 'create').mockResolvedValue(fakeAgent as SDKAgent);

      const agent = await localRuntime.createAgent();
      const runHandle = await agent.send('Execute index migration according to PLAN.md');
      projectionStore.linkRun('wf-local-slice-01', runHandle.runId);

      const runRes = await runHandle.wait();
      expect(runRes.status).toBe('completed');
      projectionStore.updatePhase('wf-local-slice-01', 'execute', 'completed', 'Migration successful');

      // 5. Review phase validates completion
      projectionStore.updatePhase('wf-local-slice-01', 'review', 'completed', 'Review clear');

      // 6. Resume verification across boundary
      const resumeSpy = vi.spyOn(Agent, 'resume').mockResolvedValue(fakeAgent as SDKAgent);
      const resumedAgent = await localRuntime.resumeAgent('agent-local-1');
      expect(resumeSpy).toHaveBeenCalledWith('agent-local-1', expect.any(Object));
      expect(resumedAgent.agentId).toBe('agent-local-1');

      // 7. Verify final workflow projection state
      const finalWf = projectionStore.load('wf-local-slice-01');
      expect(finalWf?.cursorAgentId).toBe('agent-local-1');
      expect(finalWf?.cursorRunId).toBe('run-exec-100');
      expect(finalWf?.phases.every((p) => p.status === 'completed')).toBe(true);
    });
  });

  describe('DAG Parallel Task Execution: rank scheduling & downstream failure skip', () => {
    interface DagTask {
      id: string;
      rank: number;
      dependencies: string[];
      execute: () => Promise<string>;
    }

    it('executes tasks in topological rank order and skips dependents on upstream failure', async () => {
      const executionLog: string[] = [];

      // DAG structure:
      // Rank 0: Task A (success), Task B (fails)
      // Rank 1: Task C (depends on A), Task D (depends on B)
      const tasks: DagTask[] = [
        {
          id: 'task-a',
          rank: 0,
          dependencies: [],
          execute: async () => {
            executionLog.push('task-a:done');
            return 'A_OK';
          },
        },
        {
          id: 'task-b',
          rank: 0,
          dependencies: [],
          execute: async () => {
            executionLog.push('task-b:failed');
            throw new Error('Task B crashed');
          },
        },
        {
          id: 'task-c',
          rank: 1,
          dependencies: ['task-a'],
          execute: async () => {
            executionLog.push('task-c:done');
            return 'C_OK';
          },
        },
        {
          id: 'task-d',
          rank: 1,
          dependencies: ['task-b'],
          execute: async () => {
            executionLog.push('task-d:done');
            return 'D_OK';
          },
        },
      ];

      const completed = new Set<string>();
      const failed = new Set<string>();
      const skipped = new Set<string>();

      // Group by rank
      const ranks = [0, 1];
      for (const rank of ranks) {
        const rankTasks = tasks.filter((t) => t.rank === rank);
        await Promise.all(
          rankTasks.map(async (task) => {
            // Check if any dependency failed or was skipped
            const dependencyFailed = task.dependencies.some((dep) => failed.has(dep) || skipped.has(dep));
            if (dependencyFailed) {
              skipped.add(task.id);
              executionLog.push(`${task.id}:skipped`);
              return;
            }
            try {
              await task.execute();
              completed.add(task.id);
            } catch {
              failed.add(task.id);
            }
          })
        );
      }

      expect(completed.has('task-a')).toBe(true);
      expect(failed.has('task-b')).toBe(true);
      expect(completed.has('task-c')).toBe(true);
      expect(skipped.has('task-d')).toBe(true);

      expect(executionLog).toContain('task-a:done');
      expect(executionLog).toContain('task-b:failed');
      expect(executionLog).toContain('task-c:done');
      expect(executionLog).toContain('task-d:skipped');
    });
  });

  describe('Cloud Vertical Slice: planner -> cloud workers -> structured handoff -> verifier', () => {
    it('dispatches cloud agents and verifies handoff envelope without polluting local state', async () => {
      const cloudRuntime = createCursorRuntime({
        target: 'cloud',
      });
      expect(cloudRuntime.target).toBe('cloud');

      // Verify Cloud Run Handle maintains cloud identity
      const fakeCloudRun: Partial<Run> = {
        id: 'cloud-run-888',
        agentId: 'cloud-agent-777',
        status: 'completed',
        supports: (op) => op === 'wait',
        unsupportedReason: () => undefined,
        wait: async () => ({
          id: 'cloud-run-888',
          status: 'completed',
          result: JSON.stringify({
            handoff: {
              summary: 'Cloud worker completed branch isolation',
              artifacts: ['https://cursor.com/artifacts/123'],
              verificationStatus: 'verified',
            },
          }),
        } as RunResult),
      };

      const fakeCloudAgent: Partial<SDKAgent> = {
        agentId: 'cloud-agent-777',
        send: vi.fn().mockResolvedValue(fakeCloudRun as Run),
        close: vi.fn(),
      };
      vi.spyOn(Agent, 'create').mockResolvedValue(fakeCloudAgent as SDKAgent);

      const agent = await cloudRuntime.createAgent();
      expect(agent.target).toBe('cloud');

      const handle = await agent.send('Plan and dispatch cloud workers');
      expect(handle.target).toBe('cloud');

      const result = await handle.wait();
      expect(result.status).toBe('completed');
      const payload = JSON.parse(result.result ?? '{}');
      expect(payload.handoff.verificationStatus).toBe('verified');
      expect(payload.handoff.artifacts).toHaveLength(1);
    });
  });
});
