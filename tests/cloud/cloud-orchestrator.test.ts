import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, type Run, type RunResult, type SDKAgent } from '@cursor/sdk';
import { CloudOrchestrator, type CloudHandoff } from '../../src/cloud-orchestration/index.js';

describe('Cloud Orchestrator (Official Orchestrate Pattern)', () => {
  let tempDir: string;
  let orchestrator: CloudOrchestrator;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-cloud-test-'));
    orchestrator = new CloudOrchestrator(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('enforces maximum delegation depth (defaults to 1)', async () => {
    await expect(
      orchestrator.createPlan('Goal', [
        {
          title: 'Subplanner task',
          role: 'omcu-planner',
          scope: 'sub-scope',
          prompt: 'Recursive plan',
          subplannerDepth: 2, // Exceeds default max depth of 1
        },
      ])
    ).rejects.toThrow(/E_SUBPLANNER_DEPTH_EXCEEDED/);
  });

  it('executes isolated cloud workers, verifier verdict, and creates structured handoffs', async () => {
    const executedPrompts: string[] = [];

    vi.spyOn(Agent, 'create').mockImplementation(async (options) => {
      // In cloud orchestrator, agentOptions must target cloud
      expect(options.cloud).toBeDefined();

      let runMsg = '';
      const fakeRun: Partial<Run> = {
        id: `cloud-run-${Math.random()}`,
        agentId: 'cloud-agent',
        status: 'running',
        supports: () => true,
        unsupportedReason: () => undefined,
        wait: async () => {
          if (runMsg.includes('Verify the completed workers')) {
            return {
              id: 'verif-run',
              status: 'completed',
              result: 'All checks passed: clean diff and tests green.',
            } as RunResult;
          }
          return {
            id: 'worker-run',
            status: 'completed',
            result: 'Implemented feature in branch feat/isolated-1.',
          } as RunResult;
        },
      };

      const fakeAgent: Partial<SDKAgent> = {
        agentId: 'cloud-agent',
        send: vi.fn().mockImplementation(async (msg: string) => {
          runMsg = msg;
          executedPrompts.push(msg);
          return fakeRun as Run;
        }),
        close: vi.fn(),
      };

      return fakeAgent as SDKAgent;
    });

    const plan = await orchestrator.createPlan('Add OAuth2 integration', [
      {
        taskId: 'cloud-task-1',
        title: 'Implement OAuth provider',
        role: 'omcu-worker',
        scope: 'src/auth/',
        isolatedBranch: 'feat/oauth-provider',
        prompt: 'Build OAuth provider service',
      },
      {
        taskId: 'cloud-task-2',
        title: 'Add OAuth unit tests',
        role: 'omcu-worker',
        scope: 'tests/auth/',
        isolatedBranch: 'feat/oauth-tests',
        prompt: 'Write unit tests for OAuth',
      },
    ]);

    expect(plan.status).toBe('planning');
    expect(plan.tasks).toHaveLength(2);

    const executed = await orchestrator.executePlan(plan.planId);

    expect(executed.status).toBe('completed');
    expect(executed.tasks[0]?.status).toBe('verified');
    expect(executed.tasks[1]?.status).toBe('verified');

    // Structured handoff checks
    expect(executed.tasks[0]?.workerHandoff).toBeDefined();
    expect(executed.tasks[0]?.workerHandoff?.branch).toBe('feat/oauth-provider');
    expect(executed.tasks[0]?.verifierHandoff?.verdict?.passed).toBe(true);

    // Verify handoffs are saved to disk
    const handoff0 = orchestrator.loadHandoff(executed.tasks[0]!.workerHandoff!.handoffId);
    expect(handoff0).not.toBeNull();
    expect(handoff0?.fromTaskId).toBe('cloud-task-1');
  });

  it('late handoff causes replanning without duplicate execution of completed workers', async () => {
    // Initial completed plan with worker 1 completed
    const initialPlan = await orchestrator.createPlan('Refactor service', [
      {
        taskId: 'worker-done',
        title: 'Initial worker',
        role: 'omcu-worker',
        scope: 'core',
        prompt: 'Core work',
      },
    ]);

    // Mark task as completed
    const completedPlan = {
      ...initialPlan,
      status: 'completed' as const,
      tasks: [
        {
          ...initialPlan.tasks[0]!,
          status: 'completed' as const,
          completedAt: new Date().toISOString(),
        },
      ],
    };
    orchestrator.savePlan(completedPlan);

    // Ingest late handoff from another or updated worker
    const lateHandoff: CloudHandoff = {
      handoffId: 'late-handoff-001',
      fromTaskId: 'worker-done',
      toTaskId: initialPlan.plannerId,
      role: 'worker',
      branch: 'feat/late-update',
      summary: 'Late update arrived with extra migration',
      artifacts: ['migration.sql'],
      createdAt: new Date().toISOString(),
    };

    const replanned = await orchestrator.ingestLateHandoff(initialPlan.planId, lateHandoff);

    expect(replanned.status).toBe('replanning');
    expect(replanned.lateHandoffs).toHaveLength(1);
    expect(replanned.lateHandoffs![0]?.summary).toContain('Late update arrived');

    // Completed worker was NOT duplicated or reset to pending
    expect(replanned.tasks[0]?.status).toBe('completed');
    expect(replanned.tasks[0]?.workerHandoff?.handoffId).toBe('late-handoff-001');
  });

  it('parent cancellation propagates to all active child runs', async () => {
    let cancelRunCalledWith: string | null = null;
    vi.spyOn(Agent, 'cancelRun').mockImplementation(async (runId) => {
      cancelRunCalledWith = runId;
    });

    const plan = await orchestrator.createPlan('Deploy cluster', [
      {
        taskId: 'deploy-task-1',
        title: 'Provision node 1',
        role: 'omcu-worker',
        scope: 'infra',
        prompt: 'Provision node 1',
      },
    ]);

    // Simulate task running with native cloudRunId
    const runningPlan = {
      ...plan,
      status: 'executing' as const,
      tasks: [
        {
          ...plan.tasks[0]!,
          status: 'running' as const,
          cloudAgentId: 'agent-cloud-1',
          cloudRunId: 'run-cloud-1',
        },
      ],
    };
    orchestrator.savePlan(runningPlan);

    const cancelled = await orchestrator.cancelPlan(plan.planId);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.tasks[0]?.status).toBe('cancelled');
    expect(cancelRunCalledWith).toBe('run-cloud-1');
  });

  it('incorporates late handoffs into verifier prompt and preserves replanning on late arrival', async () => {
    const executedPrompts: string[] = [];
    let verifierRunning = false;

    vi.spyOn(Agent, 'create').mockImplementation(async () => {
      let runMsg = '';
      const fakeRun: Partial<Run> = {
        id: `cloud-run-late-${Math.random()}`,
        agentId: 'cloud-agent',
        status: 'running',
        supports: () => true,
        unsupportedReason: () => undefined,
        wait: async () => {
          if (runMsg.includes('Verify the completed workers')) {
            verifierRunning = true;
            // Let the test inject a late handoff during verification
            await new Promise((resolve) => setTimeout(resolve, 50));
            return {
              id: 'verif-run',
              status: 'completed',
              result: 'All checks passed.',
            } as RunResult;
          }
          return {
            id: 'worker-run',
            status: 'completed',
            result: 'Initial worker completed.',
          } as RunResult;
        },
      };

      const fakeAgent: Partial<SDKAgent> = {
        agentId: 'cloud-agent',
        send: vi.fn().mockImplementation(async (msg: string) => {
          runMsg = msg;
          executedPrompts.push(msg);
          return fakeRun as Run;
        }),
        close: vi.fn(),
      };

      return fakeAgent as SDKAgent;
    });

    const plan = await orchestrator.createPlan('Goal with late handoffs', [
      {
        taskId: 't1',
        title: 'Task 1',
        role: 'omcu-worker',
        scope: 'scope1',
        prompt: 'Work 1',
      },
    ]);

    // Add an existing late handoff before execute
    const existingLateHandoff: CloudHandoff = {
      handoffId: 'late-1',
      fromTaskId: 'external-dep',
      toTaskId: plan.plannerId,
      role: 'worker',
      summary: 'External service deployed to staging',
      artifacts: ['service.env'],
      createdAt: new Date().toISOString(),
    };
    await orchestrator.ingestLateHandoff(plan.planId, existingLateHandoff);

    // Ingest another late handoff asynchronously while verifier is running
    const executePromise = orchestrator.executePlan(plan.planId);

    // Wait until verifier is running
    while (!verifierRunning) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const midFlightLateHandoff: CloudHandoff = {
      handoffId: 'late-2',
      fromTaskId: 'hotfix-worker',
      toTaskId: plan.plannerId,
      role: 'worker',
      summary: 'Critical hotfix patch arrived during verification',
      artifacts: ['patch.diff'],
      createdAt: new Date().toISOString(),
    };
    await orchestrator.ingestLateHandoff(plan.planId, midFlightLateHandoff);

    const finalPlan = await executePromise;

    // 1. Verifier prompt should have included the existing late handoff
    const verifierPrompt = executedPrompts.find((p) => p.includes('Verify the completed workers'))!;
    expect(verifierPrompt).toContain('External service deployed to staging');

    // 2. Because a new late handoff arrived during verification, final status must be replanning
    expect(finalPlan.status).toBe('replanning');
    expect(finalPlan.lateHandoffs).toHaveLength(2);

    // 3. Disk record must preserve both late handoffs
    const reloaded = orchestrator.loadPlan(plan.planId);
    expect(reloaded?.status).toBe('replanning');
    expect(reloaded?.lateHandoffs).toHaveLength(2);
  });
});
