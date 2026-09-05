import { TaskRunner } from '../tasks/runner.js';
import { TaskStore } from '../tasks/store.js';
import type { TaskRecord } from '../tasks/types.js';
import { renderDagCanvas } from './canvas.js';
import { validateRankEditOwnership } from './conflicts.js';
import { stitchBoundedUpstreamContext } from './context.js';
import type { DagDefinition, DagExecutionStatus, DagRunOptions } from './types.js';
import { validateDag } from './validator.js';

export class DagRunner {
  private readonly store: TaskStore;
  private readonly taskRunner: TaskRunner;

  constructor(public readonly workspace: string, store?: TaskStore, taskRunner?: TaskRunner) {
    this.store = store ?? new TaskStore(workspace);
    this.taskRunner = taskRunner ?? new TaskRunner(workspace, this.store);
  }

  async run(dag: DagDefinition, options?: DagRunOptions): Promise<DagExecutionStatus> {
    const startedAt = (options?.now ? options.now() : new Date()).toISOString();

    // 1. Validate DAG structure and compute ranks
    const { ranks } = validateDag(dag);

    // 2. Validate edit ownership conflicts among concurrent siblings in each rank
    validateRankEditOwnership(ranks, this.workspace);

    const taskRecords: Record<string, TaskRecord> = {};
    const upstreamOutputs = new Map<string, { role: string; output: string }>();

    // Initialize all tasks as pending in store
    for (const rank of ranks) {
      for (const spec of rank.tasks) {
        const record = this.taskRunner.createTask({
          taskId: spec.id,
          workflowId: dag.dagId,
          role: spec.role,
          ...(spec.profile !== undefined ? { profile: spec.profile } : {}),
          prompt: spec.prompt,
          ...(spec.dependencies !== undefined ? { dependencies: spec.dependencies } : {}),
          runtime: spec.runtime ?? 'local',
          workspace: spec.workspace ?? this.workspace,
          ...(spec.worktree !== undefined ? { worktree: spec.worktree } : {}),
          ...(spec.ownedPaths !== undefined ? { ownedPaths: spec.ownedPaths } : {}),
          ...(spec.acceptanceCriteria !== undefined ? { acceptanceCriteria: spec.acceptanceCriteria } : {}),
        });
        taskRecords[spec.id] = record;
        options?.onTaskUpdate?.(record);
      }
    }

    let dagAborted = false;

    // 3. Execute ranks sequentially
    for (const rank of ranks) {
      if (options?.signal?.aborted) {
        dagAborted = true;
        break;
      }

      // Run each rank concurrently
      await Promise.all(
        rank.tasks.map(async (spec) => {
          if (options?.signal?.aborted) {
            dagAborted = true;
            return;
          }

          // Check if any upstream dependency failed or was skipped
          let shouldSkip = false;
          let failedDepId: string | undefined;

          if (spec.dependencies && spec.dependencies.length > 0) {
            for (const depId of spec.dependencies) {
              const depRecord = taskRecords[depId];
              if (!depRecord || depRecord.status !== 'completed') {
                shouldSkip = true;
                failedDepId = depId;
                break;
              }
            }
          }

          if (shouldSkip) {
            const skippedRecord = this.store.update(spec.id, {
              status: 'skipped',
              blockerReason: `upstream_dependency_failed:${failedDepId ?? 'unknown'}`,
              completedAt: (options?.now ? options.now() : new Date()).toISOString(),
            });
            taskRecords[spec.id] = skippedRecord;
            options?.onTaskUpdate?.(skippedRecord);
            return;
          }

          // Stitch bounded upstream context
          const promptWithUpstream = stitchBoundedUpstreamContext(spec, upstreamOutputs);

          // Update task prompt with stitched context if needed
          if (promptWithUpstream !== spec.prompt) {
            this.store.update(spec.id, { prompt: promptWithUpstream });
          }

          // Execute task via TaskRunner
          const completedRecord = await this.taskRunner.run(spec.id, {
            signal: options?.signal,
            now: options?.now,
          });

          taskRecords[spec.id] = completedRecord;
          options?.onTaskUpdate?.(completedRecord);

          if (completedRecord.status === 'completed' && completedRecord.output !== undefined) {
            upstreamOutputs.set(spec.id, {
              role: spec.role,
              output: completedRecord.output,
            });
          }
        })
      );

      if (dagAborted) {
        break;
      }
    }

    // Mark remaining pending tasks as cancelled if aborted
    if (dagAborted) {
      for (const [id, record] of Object.entries(taskRecords)) {
        if (record.status === 'pending' || record.status === 'running') {
          const cancelled = this.store.update(id, {
            status: 'cancelled',
            blockerReason: 'dag_aborted',
            completedAt: (options?.now ? options.now() : new Date()).toISOString(),
          });
          taskRecords[id] = cancelled;
        }
      }
    }

    const completedAt = (options?.now ? options.now() : new Date()).toISOString();
    const allStatuses = Object.values(taskRecords).map((t) => t.status);

    let overallStatus: DagExecutionStatus['status'];
    if (dagAborted || allStatuses.includes('cancelled')) {
      overallStatus = 'cancelled';
    } else if (allStatuses.includes('failed')) {
      overallStatus = 'failed';
    } else if (allStatuses.every((s) => s === 'completed' || s === 'skipped')) {
      overallStatus = 'completed';
    } else {
      overallStatus = 'failed';
    }

    const canvas = options?.canvas ? renderDagCanvas(dag, ranks, taskRecords) : undefined;

    return {
      dagId: dag.dagId,
      status: overallStatus,
      ranks,
      tasks: taskRecords,
      ...(canvas ? { canvas } : {}),
      startedAt,
      completedAt,
    };
  }
}
