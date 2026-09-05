export type TaskRuntime = 'local' | 'cloud';

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'skipped';

export type TaskErrorKind = 'startup' | 'run' | 'cancelled' | 'ambiguous';

export interface TaskError {
  readonly kind: TaskErrorKind;
  readonly message: string;
  readonly details?: unknown;
}

export interface TaskBudget {
  readonly maxTokens?: number | undefined;
  readonly maxTimeMs?: number | undefined;
  readonly maxRetries?: number | undefined;
}

export interface TaskRecord {
  readonly schema_version: 1;
  readonly taskId: string;
  readonly workflowId?: string | undefined;
  readonly parentTaskId?: string | undefined;
  readonly childTaskIds?: readonly string[] | undefined;
  readonly agentId?: string | undefined;
  readonly runId?: string | undefined;
  readonly role: string;
  readonly profile?: string | undefined;
  readonly model?: string | undefined;
  readonly runtime: TaskRuntime;
  readonly prompt: string;
  readonly dependencies?: readonly string[] | undefined;
  readonly plannerScope?: string | undefined;
  readonly workspace: string;
  readonly worktree?: string | undefined;
  readonly ownedPaths?: readonly string[] | undefined;
  readonly contextDigest?: string | undefined;
  readonly acceptanceCriteria?: readonly string[] | undefined;
  readonly evidenceArtifacts?: readonly string[] | undefined;
  readonly handoffArtifacts?: readonly string[] | undefined;
  readonly status: TaskStatus;
  readonly blockerReason?: string | undefined;
  readonly error?: TaskError | undefined;
  readonly output?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string | undefined;
  readonly budget?: TaskBudget | undefined;
}

export interface CreateTaskInput {
  readonly taskId?: string | undefined;
  readonly workflowId?: string | undefined;
  readonly parentTaskId?: string | undefined;
  readonly role: string;
  readonly profile?: string | undefined;
  readonly model?: string | undefined;
  readonly runtime?: TaskRuntime | undefined;
  readonly prompt: string;
  readonly dependencies?: readonly string[] | undefined;
  readonly plannerScope?: string | undefined;
  readonly workspace?: string | undefined;
  readonly worktree?: string | undefined;
  readonly ownedPaths?: readonly string[] | undefined;
  readonly contextDigest?: string | undefined;
  readonly acceptanceCriteria?: readonly string[] | undefined;
  readonly budget?: TaskBudget | undefined;
}
