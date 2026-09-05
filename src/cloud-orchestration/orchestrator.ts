import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '@cursor/sdk';
import { atomicWriteJson } from '../runtime/atomic.js';
import { createCursorRuntime } from '../runtime/cursor-sdk/runtime.js';
import type {
  CloudHandoff,
  CloudPlan,
  CloudPlannedTask,
  CloudOrchestratorOptions,
  CreateCloudTaskInput,
} from './types.js';

async function getSdkAgent(): Promise<typeof Agent> {
  const sdk = await import('@cursor/sdk');
  return sdk.Agent;
}

export const DEFAULT_MAX_DELEGATION_DEPTH = 1;

export class CloudOrchestrator {
  private readonly plansDir: string;
  private readonly handoffsDir: string;

  constructor(public readonly workspace: string) {
    this.plansDir = path.join(path.resolve(workspace), '.omcu', 'artifacts', 'cloud');
    this.handoffsDir = path.join(this.plansDir, 'handoffs');
    fs.mkdirSync(this.plansDir, { recursive: true });
    fs.mkdirSync(this.handoffsDir, { recursive: true });
  }

  private planFile(planId: string): string {
    const sanitized = planId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.plansDir, `plan-${sanitized}.json`);
  }

  private handoffFile(handoffId: string): string {
    const sanitized = handoffId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.handoffsDir, `handoff-${sanitized}.json`);
  }

  savePlan(plan: CloudPlan): void {
    atomicWriteJson(this.planFile(plan.planId), plan);
  }

  loadPlan(planId: string): CloudPlan | null {
    const file = this.planFile(planId);
    if (!fs.existsSync(file)) return null;
    try {
      const content = fs.readFileSync(file, 'utf8');
      return JSON.parse(content) as CloudPlan;
    } catch {
      return null;
    }
  }

  saveHandoff(handoff: CloudHandoff): void {
    atomicWriteJson(this.handoffFile(handoff.handoffId), handoff);
  }

  loadHandoff(handoffId: string): CloudHandoff | null {
    const file = this.handoffFile(handoffId);
    if (!fs.existsSync(file)) return null;
    try {
      const content = fs.readFileSync(file, 'utf8');
      return JSON.parse(content) as CloudHandoff;
    } catch {
      return null;
    }
  }

  async createPlan(
    goal: string,
    tasksInput: readonly CreateCloudTaskInput[],
    options?: CloudOrchestratorOptions
  ): Promise<CloudPlan> {
    const maxDepth = options?.maxDelegationDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
    const planId = `plan-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const plannerId = `planner-${crypto.randomBytes(4).toString('hex')}`;
    const now = (options?.now ? options.now() : new Date()).toISOString();

    const tasks: CloudPlannedTask[] = [];
    for (const input of tasksInput) {
      const depth = input.subplannerDepth ?? 1;
      if (depth > maxDepth) {
        throw new Error(
          `E_SUBPLANNER_DEPTH_EXCEEDED: subplanner depth ${depth} exceeds maximum delegation depth ${maxDepth}`
        );
      }
      tasks.push({
        taskId: input.taskId ?? `task-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        title: input.title,
        role: input.role,
        ...(input.profile !== undefined ? { profile: input.profile } : {}),
        scope: input.scope,
        ...(input.isolatedBranch !== undefined ? { isolatedBranch: input.isolatedBranch } : {}),
        prompt: input.prompt,
        status: 'pending',
        subplannerDepth: depth,
      });
    }

    const plan: CloudPlan = {
      schema_version: 1,
      planId,
      goal,
      plannerId,
      tasks,
      status: 'planning',
      createdAt: now,
      updatedAt: now,
    };

    this.savePlan(plan);
    return plan;
  }

  async executePlan(planId: string, options?: CloudOrchestratorOptions): Promise<CloudPlan> {
    let plan = this.loadPlan(planId);
    if (!plan) {
      throw new Error(`E_PLAN_NOT_FOUND: cloud plan '${planId}' not found`);
    }

    const nowFn = options?.now ?? (() => new Date());

    // 1. Check cancellation before starting
    if (options?.signal?.aborted) {
      return this.cancelPlan(planId);
    }

    plan = {
      ...plan,
      status: 'executing',
      updatedAt: nowFn().toISOString(),
    };
    this.savePlan(plan);

    const updatedTasks: CloudPlannedTask[] = [...plan.tasks];

    // 2. Execute isolated workers concurrently
    const workerPromises = updatedTasks.map(async (task, index) => {
      // If already completed (e.g. from prior run or late handoff), do not duplicate execution!
      if (task.status === 'completed' || task.status === 'verified') {
        return;
      }

      if (options?.signal?.aborted) {
        updatedTasks[index] = {
          ...task,
          status: 'cancelled',
          completedAt: nowFn().toISOString(),
        };
        return;
      }

      // Planners publish tasks, isolated workers run with cloud target
      const cloudRuntime = createCursorRuntime({ target: 'cloud' });
      let agent;
      let runHandle;
      try {
        agent = await cloudRuntime.createAgent();
        const isolatedPrompt = [
          `Task Scope: ${task.scope}`,
          task.isolatedBranch ? `Isolated Branch: ${task.isolatedBranch}` : '',
          `Objective: ${task.prompt}`,
          'Return a structured handoff with summary, PR URL or branch, and artifact references.',
        ]
          .filter(Boolean)
          .join('\n\n');

        runHandle = await agent.send(isolatedPrompt);
        updatedTasks[index] = {
          ...task,
          status: 'running',
          cloudAgentId: runHandle.agentId,
          cloudRunId: runHandle.runId,
        };

        const result = await runHandle.wait();
        await agent.close();

        if (result.error) {
          updatedTasks[index] = {
            ...updatedTasks[index]!,
            status: 'failed',
            completedAt: nowFn().toISOString(),
          };
          return;
        }

        const outputText = (result as { result?: string }).result
          ?? (result as { text?: string }).text
          ?? 'Worker completed';

        const handoffId = `handoff-${task.taskId}-${Date.now()}`;
        const workerHandoff: CloudHandoff = {
          handoffId,
          fromTaskId: task.taskId,
          toTaskId: plan!.plannerId,
          role: 'worker',
          branch: task.isolatedBranch,
          prUrl: task.prUrl,
          summary: outputText,
          artifacts: [],
          createdAt: nowFn().toISOString(),
        };
        this.saveHandoff(workerHandoff);

        updatedTasks[index] = {
          ...updatedTasks[index]!,
          status: 'completed',
          workerHandoff,
          completedAt: nowFn().toISOString(),
        };
      } catch (error) {
        if (agent) {
          await agent.close().catch(() => {});
        }
        updatedTasks[index] = {
          ...task,
          status: options?.signal?.aborted ? 'cancelled' : 'failed',
          completedAt: nowFn().toISOString(),
        };
      }
    });

    await Promise.all(workerPromises);

    // Check if cancelled during worker runs
    if (options?.signal?.aborted) {
      return this.cancelPlan(planId);
    }

    const anyWorkerFailed = updatedTasks.some((t) => t.status === 'failed');
    if (anyWorkerFailed) {
      plan = {
        ...plan,
        tasks: updatedTasks,
        status: 'failed',
        updatedAt: nowFn().toISOString(),
      };
      this.savePlan(plan);
      return plan;
    }

    // 3. Verifier phase
    plan = {
      ...plan,
      tasks: updatedTasks,
      status: 'verifying',
      updatedAt: nowFn().toISOString(),
    };
    this.savePlan(plan);

    const verifierTaskId = `verifier-${Date.now()}`;
    const verifierRuntime = createCursorRuntime({ target: 'cloud' });
    let verifierPassed = true;
    let verifierFeedback = 'Verification passed';

    try {
      const verifierAgent = await verifierRuntime.createAgent();
      const lateHandoffNotes = (plan.lateHandoffs ?? []).map(
        (h) => `Late Handoff for ${h.fromTaskId} (${h.role}): ${h.summary}`
      );
      const verifierPrompt = [
        `Verify the completed workers for plan '${plan.planId}' (${plan.goal}).`,
        ...updatedTasks.map(
          (t) => `Worker ${t.taskId}: ${t.workerHandoff?.summary ?? 'No summary'}`
        ),
        ...lateHandoffNotes,
      ].join('\n\n');

      const vRun = await verifierAgent.send(verifierPrompt);
      const vResult = await vRun.wait();
      await verifierAgent.close();

      if (vResult.error) {
        verifierPassed = false;
        verifierFeedback = vResult.error.message || 'Verifier failed';
      } else {
        verifierPassed = true;
        verifierFeedback = (vResult as { result?: string }).result ?? 'Verification clear';
      }
    } catch {
      verifierPassed = false;
      verifierFeedback = 'Verifier execution error';
    }

    const verifierHandoff: CloudHandoff = {
      handoffId: `handoff-verdict-${Date.now()}`,
      fromTaskId: verifierTaskId,
      toTaskId: plan.plannerId,
      role: 'verifier',
      summary: verifierFeedback,
      artifacts: [],
      verdict: {
        passed: verifierPassed,
        feedback: verifierFeedback,
      },
      createdAt: nowFn().toISOString(),
    };
    this.saveHandoff(verifierHandoff);

    // Re-check stored plan to see if late handoffs arrived during verifier execution
    const stored = this.loadPlan(planId);
    const existingLateHandoffs = stored?.lateHandoffs ?? plan.lateHandoffs;
    const initialLateCount = plan.lateHandoffs?.length ?? 0;
    const currentLateCount = existingLateHandoffs?.length ?? 0;
    const hasUnverifiedLateHandoffs = currentLateCount > initialLateCount;

    // Update tasks with verifier handoff
    const finalTasks = updatedTasks.map((t) => ({
      ...t,
      status: (verifierPassed ? 'verified' : 'failed') as CloudPlannedTask['status'],
      verifierHandoff,
    }));

    plan = {
      ...plan,
      tasks: finalTasks,
      status: hasUnverifiedLateHandoffs ? 'replanning' : (verifierPassed ? 'completed' : 'failed'),
      verifierTaskId,
      lateHandoffs: existingLateHandoffs,
      updatedAt: nowFn().toISOString(),
    };
    this.savePlan(plan);
    return plan;
  }

  /**
   * Ingest a late handoff without duplicating completed workers.
   * Resumes and triggers replanning with the new handoff input.
   */
  async ingestLateHandoff(planId: string, handoff: CloudHandoff): Promise<CloudPlan> {
    const plan = this.loadPlan(planId);
    if (!plan) {
      throw new Error(`E_PLAN_NOT_FOUND: cloud plan '${planId}' not found`);
    }

    this.saveHandoff(handoff);

    const lateHandoffs = [...(plan.lateHandoffs ?? []), handoff];
    const taskIndex = plan.tasks.findIndex((t) => t.taskId === handoff.fromTaskId);

    const updatedTasks = [...plan.tasks];
    if (taskIndex >= 0) {
      const existingTask = updatedTasks[taskIndex]!;
      // Preserve completed status if already completed — do not re-run worker!
      updatedTasks[taskIndex] = {
        ...existingTask,
        workerHandoff: handoff,
        status: existingTask.status === 'completed' || existingTask.status === 'verified'
          ? existingTask.status
          : 'completed',
        completedAt: existingTask.completedAt ?? new Date().toISOString(),
      };
    }

    // Set plan to 'replanning' state rather than duplicate execution
    const updatedPlan: CloudPlan = {
      ...plan,
      tasks: updatedTasks,
      lateHandoffs,
      status: 'replanning',
      updatedAt: new Date().toISOString(),
    };

    this.savePlan(updatedPlan);
    return updatedPlan;
  }

  /**
   * Propagates parent cancellation to all active child runs.
   */
  async cancelPlan(planId: string): Promise<CloudPlan> {
    const plan = this.loadPlan(planId);
    if (!plan) {
      throw new Error(`E_PLAN_NOT_FOUND: cloud plan '${planId}' not found`);
    }

    const now = new Date().toISOString();
    const updatedTasks: CloudPlannedTask[] = [];
    const agentClass = await getSdkAgent();

    for (const task of plan.tasks) {
      if (task.status === 'running' || task.status === 'pending') {
        if (task.cloudRunId) {
          try {
            await agentClass.cancelRun(task.cloudRunId);
          } catch {
            // Best-effort
          }
        }
        updatedTasks.push({
          ...task,
          status: 'cancelled',
          completedAt: now,
        });
      } else {
        updatedTasks.push(task);
      }
    }

    const cancelledPlan: CloudPlan = {
      ...plan,
      tasks: updatedTasks,
      status: 'cancelled',
      updatedAt: now,
    };

    this.savePlan(cancelledPlan);
    return cancelledPlan;
  }
}
