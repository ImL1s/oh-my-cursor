import type { TaskBudget, TaskRecord, TaskRuntime } from '../tasks/types.js';

export interface DagTaskSpec {
  readonly id: string;
  readonly role: string;
  readonly profile?: string | undefined;
  readonly prompt: string;
  readonly dependencies?: readonly string[] | undefined;
  readonly runtime?: TaskRuntime | undefined;
  readonly workspace?: string | undefined;
  readonly worktree?: string | undefined;
  readonly ownedPaths?: readonly string[] | undefined;
  readonly acceptanceCriteria?: readonly string[] | undefined;
  readonly budget?: TaskBudget | undefined;
}

export interface DagDefinition {
  readonly dagId: string;
  readonly description?: string | undefined;
  readonly tasks: readonly DagTaskSpec[];
}

export interface DagRank {
  readonly rankIndex: number;
  readonly tasks: readonly DagTaskSpec[];
}

export interface DagExecutionStatus {
  readonly dagId: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly ranks: readonly DagRank[];
  readonly tasks: Record<string, TaskRecord>;
  readonly canvas?: string | undefined;
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
}

export interface DagRunOptions {
  readonly canvas?: boolean | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onTaskUpdate?: ((task: TaskRecord) => void) | undefined;
  readonly now?: (() => Date) | undefined;
}
