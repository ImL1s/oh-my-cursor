import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent } from '@cursor/sdk';
import { getAgentRole } from '../agents/catalog.js';
import { createSdkAgentProfile } from '../runtime/cursor-sdk/agents.js';
import { CursorRuntimeError } from '../runtime/cursor-sdk/errors.js';
import { createCursorRuntime } from '../runtime/cursor-sdk/runtime.js';
import type { CursorRunHandle, ManagedCursorAgent } from '../runtime/cursor-sdk/types.js';
import { TaskStore } from './store.js';
import type { CreateTaskInput, TaskError, TaskRecord } from './types.js';

async function getSdkAgent(): Promise<typeof Agent> {
  const sdk = await import('@cursor/sdk');
  return sdk.Agent;
}

export interface TaskRunOptions {
  readonly background?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => Date) | undefined;
}

export class TaskRunner {
  private readonly store: TaskStore;

  constructor(public readonly workspace: string, store?: TaskStore) {
    this.store = store ?? new TaskStore(workspace);
  }

  createTask(input: CreateTaskInput): TaskRecord {
    const now = new Date().toISOString();
    const taskId = input.taskId ?? `task-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const task: TaskRecord = {
      schema_version: 1,
      taskId,
      ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
      ...(input.parentTaskId !== undefined ? { parentTaskId: input.parentTaskId } : {}),
      role: input.role,
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      runtime: input.runtime ?? 'local',
      prompt: input.prompt,
      ...(input.dependencies !== undefined ? { dependencies: input.dependencies } : {}),
      ...(input.plannerScope !== undefined ? { plannerScope: input.plannerScope } : {}),
      workspace: input.workspace ?? this.workspace,
      ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
      ...(input.ownedPaths !== undefined ? { ownedPaths: input.ownedPaths } : {}),
      ...(input.contextDigest !== undefined ? { contextDigest: input.contextDigest } : {}),
      ...(input.acceptanceCriteria !== undefined ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
      ...(input.budget !== undefined ? { budget: input.budget } : {}),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.store.save(task);
    return task;
  }

  async run(taskOrId: string | TaskRecord, options?: TaskRunOptions): Promise<TaskRecord> {
    const nowFn = options?.now ?? (() => new Date());
    let task = typeof taskOrId === 'string' ? this.store.get(taskOrId) : taskOrId;
    if (!task) {
      throw new Error(`E_TASK_NOT_FOUND: task '${String(taskOrId)}' not found`);
    }

    // Resolve system prompt and profile if role is registered
    let systemPrompt: string | undefined;
    let selectedModel = task.model;
    const roleDef = getAgentRole(task.role);
    if (roleDef) {
      try {
        const sdkProfile = createSdkAgentProfile(roleDef, task.profile);
        systemPrompt = sdkProfile.systemPrompt;
        if (!selectedModel) {
          selectedModel = sdkProfile.model;
        }
      } catch {
        // Fallback gracefully if profile composition fails
      }
    }

    const workingDir = task.worktree ?? task.workspace ?? this.workspace;
    const runtime = createCursorRuntime({
      target: task.runtime,
      cwd: workingDir,
      ...(selectedModel ? { model: selectedModel } : {}),
    });

    let agent: ManagedCursorAgent | null = null;
    let runHandle: CursorRunHandle | null = null;

    try {
      agent = await runtime.createAgent();
    } catch (error) {
      const taskError: TaskError = {
        kind: 'startup',
        message: error instanceof Error ? error.message : String(error),
      };
      return this.store.update(task.taskId, {
        status: 'failed',
        error: taskError,
        blockerReason: 'startup_error',
        completedAt: nowFn().toISOString(),
      });
    }

    // Build user message including systemPrompt preface if present
    const messagePrompt = systemPrompt ? `${systemPrompt}\n\n${task.prompt}` : task.prompt;

    try {
      runHandle = await agent.send(messagePrompt);
    } catch (error) {
      await agent.close();
      const taskError: TaskError = {
        kind: 'startup',
        message: error instanceof Error ? error.message : String(error),
      };
      return this.store.update(task.taskId, {
        status: 'failed',
        error: taskError,
        blockerReason: 'startup_error',
        completedAt: nowFn().toISOString(),
      });
    }

    // Immediately record native agentId and runId
    task = this.store.update(task.taskId, {
      agentId: runHandle.agentId,
      runId: runHandle.runId,
      status: 'running',
    });

    // Background mode: return native IDs immediately without waiting
    if (options?.background) {
      return task;
    }

    // Foreground mode: handle cancellation or wait
    let abortListener: (() => void) | undefined;
    if (options?.signal) {
      if (options.signal.aborted) {
        try {
          await runHandle.cancel();
        } catch {
          // Best effort
        }
        await agent.close();
        return this.store.update(task.taskId, {
          status: 'cancelled',
          error: { kind: 'cancelled', message: 'Task cancelled by signal' },
          blockerReason: 'user_abort',
          completedAt: nowFn().toISOString(),
        });
      }
      abortListener = () => {
        runHandle?.cancel().catch(() => {});
      };
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    let timeoutTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeoutPromise = task.budget?.maxTimeMs && task.budget.maxTimeMs > 0
      ? new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            timedOut = true;
            runHandle?.cancel().catch(() => {});
            reject(new Error(`E_TASK_TIMEOUT: task exceeded maximum time budget of ${task.budget!.maxTimeMs}ms`));
          }, task.budget!.maxTimeMs);
        })
      : null;

    try {
      const result = timeoutPromise
        ? await Promise.race([runHandle.wait(), timeoutPromise])
        : await runHandle.wait();
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (abortListener && options?.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }
      await agent.close();

      if (result.error) {
        return this.store.update(task.taskId, {
          status: 'failed',
          error: {
            kind: 'run',
            message: result.error.message || result.error.code || 'Run failed',
          },
          blockerReason: 'run_error',
          completedAt: nowFn().toISOString(),
        });
      }

      const outputText = (result as { result?: string }).result
        ?? (result as { text?: string }).text
        ?? '';

      // Record evidence artifact if output is non-empty
      let evidenceArtifacts = task.evidenceArtifacts ? [...task.evidenceArtifacts] : [];
      if (outputText.trim() !== '') {
        const artifactsDir = path.join(this.workspace, '.omcu', 'artifacts', 'tasks');
        fs.mkdirSync(artifactsDir, { recursive: true });
        const artifactPath = path.join(artifactsDir, `${task.taskId}-output.md`);
        fs.writeFileSync(artifactPath, outputText, 'utf8');
        evidenceArtifacts.push(artifactPath);
      }

      return this.store.update(task.taskId, {
        status: 'completed',
        output: outputText,
        evidenceArtifacts,
        completedAt: nowFn().toISOString(),
      });
    } catch (error) {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (abortListener && options?.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }
      await agent.close();

      if (timedOut) {
        return this.store.update(task.taskId, {
          status: 'failed',
          error: {
            kind: 'run',
            message: `Task exceeded maximum execution time budget of ${task.budget!.maxTimeMs}ms`,
          },
          blockerReason: 'task_timeout',
          completedAt: nowFn().toISOString(),
        });
      }

      if (options?.signal?.aborted) {
        return this.store.update(task.taskId, {
          status: 'cancelled',
          error: { kind: 'cancelled', message: 'Task cancelled' },
          blockerReason: 'user_abort',
          completedAt: nowFn().toISOString(),
        });
      }

      const isCursorError = error instanceof CursorRuntimeError;
      const errorKind = isCursorError && error.code === 'E_UNSUPPORTED_OPERATION'
        ? 'ambiguous'
        : isCursorError && error.code === 'E_RUNTIME_TERMINAL'
          ? 'run'
          : 'ambiguous';

      return this.store.update(task.taskId, {
        status: 'failed',
        error: {
          kind: errorKind,
          message: error instanceof Error ? error.message : String(error),
        },
        blockerReason: 'execution_error',
        completedAt: nowFn().toISOString(),
      });
    }
  }

  async cancel(taskId: string): Promise<TaskRecord> {
    const task = this.store.get(taskId);
    if (!task) {
      throw new Error(`E_TASK_NOT_FOUND: task '${taskId}' not found`);
    }

    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      return task;
    }

    if (task.runId) {
      try {
        const agentClass = await getSdkAgent();
        await agentClass.cancelRun(task.runId);
      } catch {
        // Fallback: Agent.cancelRun may fail if already cancelled or unsupported
      }
    }

    return this.store.update(taskId, {
      status: 'cancelled',
      error: { kind: 'cancelled', message: 'Task cancelled by operator' },
      blockerReason: 'user_abort',
      completedAt: new Date().toISOString(),
    });
  }

  async resume(taskId: string, followUpPrompt?: string): Promise<TaskRecord> {
    const task = this.store.get(taskId);
    if (!task) {
      throw new Error(`E_TASK_NOT_FOUND: task '${taskId}' not found`);
    }
    if (!task.agentId) {
      throw new Error(`E_TASK_CANNOT_RESUME: task '${taskId}' does not have a native agentId`);
    }

    const workingDir = task.worktree ?? task.workspace ?? this.workspace;
    const runtime = createCursorRuntime({
      target: task.runtime,
      cwd: workingDir,
      ...(task.model ? { model: task.model } : {}),
    });

    const agent = await runtime.resumeAgent(task.agentId);
    try {
      const prompt = followUpPrompt ?? `Resume execution of task ${task.taskId}. Prompt: ${task.prompt}`;
      const runHandle = await agent.send(prompt);

      this.store.update(task.taskId, {
        runId: runHandle.runId,
        status: 'running',
        updatedAt: new Date().toISOString(),
      });

      const result = await runHandle.wait();
      await agent.close();

      if (result.error) {
        return this.store.update(task.taskId, {
          status: 'failed',
          error: {
            kind: 'run',
            message: result.error.message || result.error.code || 'Resumed run failed',
          },
          completedAt: new Date().toISOString(),
        });
      }

      const outputText = (result as { result?: string }).result
        ?? (result as { text?: string }).text
        ?? '';

      return this.store.update(task.taskId, {
        status: 'completed',
        output: outputText,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      await agent.close();
      return this.store.update(task.taskId, {
        status: 'failed',
        error: {
          kind: 'ambiguous',
          message: error instanceof Error ? error.message : String(error),
        },
        completedAt: new Date().toISOString(),
      });
    }
  }
}
