import crypto from 'node:crypto';
import type { RuntimeTarget } from '../runtime/cursor-sdk/types.js';

export type WorkflowStatus = 'active' | 'completed' | 'failed' | 'cancelled' | 'blocked';

export type GoalStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type StoryStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface WorkflowBudgets {
  readonly max_iterations: number;
  readonly max_continuations: number;
  readonly deadline_at: string;
  readonly consumed_iterations?: number;
  readonly consumed_continuations?: number;
}

export interface GoalRecord {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly acceptance_criteria: readonly string[];
  readonly status: GoalStatus;
  readonly created_at: string;
  readonly completed_at?: string | undefined;
}

export interface StoryRecord {
  readonly id: string;
  readonly goal_id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly status: StoryStatus;
  readonly dependencies: readonly string[];
  readonly owner_task_id?: string | undefined;
  readonly owner_agent_id?: string | undefined;
  readonly attempt: number;
  readonly max_attempts?: number | undefined;
  readonly blocker_reason?: string | undefined;
  readonly evidence: readonly string[];
  readonly created_at: string;
  readonly completed_at?: string | undefined;
}

export interface TodoRecord {
  readonly id: string;
  readonly story_id?: string | undefined;
  readonly title: string;
  readonly completed: boolean;
  readonly status: TodoStatus;
  readonly created_at: string;
  readonly completed_at?: string | undefined;
}

export interface ChildTaskReference {
  readonly task_id: string;
  readonly agent_id?: string | undefined;
  readonly run_id?: string | undefined;
  readonly runtime: RuntimeTarget;
  readonly role: string;
  readonly status: string;
}

export interface HandoffArtifactRecord {
  readonly id: string;
  readonly epoch: number;
  readonly phase: string;
  readonly artifact_uri: string;
  readonly summary: string;
  readonly created_at: string;
}

export interface EvidenceReference {
  readonly id: string;
  readonly type: 'test' | 'tool' | 'review' | 'manual' | 'artifact';
  readonly reference: string;
  readonly digest: string;
  readonly verified: boolean;
  readonly created_at: string;
}

export interface WorkflowPhase {
  readonly name: string;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'failed';
  readonly summary?: string | undefined;
}

export interface AcceptanceCriterion {
  readonly description: string;
  readonly met: boolean;
}

/**
 * Canonical OMCU Workflow Projection schema.
 * Rebuildable projection from the OMCU journal referencing Cursor agent/run IDs
 * and immutable artifacts rather than storing model conversation history.
 */
export interface WorkflowProjection {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly cursor_agent_id: string;
  readonly cursor_run_id?: string | null | undefined;
  readonly source_profile: string;
  readonly epoch: number;
  readonly revision: number;
  readonly status: WorkflowStatus;
  readonly phase: string;
  readonly objective_artifact: string;
  readonly budgets: WorkflowBudgets;
  readonly goals: readonly GoalRecord[];
  readonly stories: readonly StoryRecord[];
  readonly todos: readonly TodoRecord[];
  readonly child_tasks: readonly ChildTaskReference[];
  readonly handoffs: readonly HandoffArtifactRecord[];
  readonly evidence: readonly EvidenceReference[];
  readonly failure_fingerprint: string | null;
  readonly cancel_requested: boolean;
  readonly verified: boolean;
  readonly verification_authority: 'omcu-cli-only';
  readonly created_at: string;
  readonly updated_at: string;

  // Internal transaction tracking
  readonly last_event_id?: string | null | undefined;
  readonly consecutive_failures?: number | undefined;

  // Backward-compatibility aliases for existing callers
  readonly workflowId?: string | undefined;
  readonly cursorAgentId?: string | undefined;
  readonly cursorRunId?: string | undefined;
  readonly target?: RuntimeTarget | undefined;
  readonly goal?: string | undefined;
  readonly phases?: readonly WorkflowPhase[] | undefined;
  readonly acceptanceCriteria?: readonly AcceptanceCriterion[] | undefined;
  readonly evidenceReferences?: readonly string[] | undefined;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export interface CreateWorkflowProjectionInput {
  readonly run_id: string;
  readonly cursor_agent_id: string;
  readonly cursor_run_id?: string | null | undefined;
  readonly source_profile: string;
  readonly epoch?: number | undefined;
  readonly revision?: number | undefined;
  readonly status?: WorkflowStatus | undefined;
  readonly phase: string;
  readonly objective_artifact: string;
  readonly budgets: {
    readonly max_iterations: number;
    readonly max_continuations: number;
    readonly deadline_at: string;
    readonly consumed_iterations?: number | undefined;
    readonly consumed_continuations?: number | undefined;
  };
  readonly goals?: readonly GoalRecord[] | undefined;
  readonly stories?: readonly StoryRecord[] | undefined;
  readonly todos?: readonly TodoRecord[] | undefined;
  readonly child_tasks?: readonly ChildTaskReference[] | undefined;
  readonly handoffs?: readonly HandoffArtifactRecord[] | undefined;
  readonly evidence?: readonly EvidenceReference[] | undefined;
  readonly failure_fingerprint?: string | null | undefined;
  readonly cancel_requested?: boolean | undefined;
  readonly target?: RuntimeTarget | undefined;
}

export function createWorkflowProjection(input: CreateWorkflowProjectionInput): WorkflowProjection {
  const now = new Date().toISOString();
  const runId = input.run_id;
  const cursorAgentId = input.cursor_agent_id;
  const goals = input.goals ?? [];
  const stories = input.stories ?? [];
  const todos = input.todos ?? [];
  const childTasks = input.child_tasks ?? [];
  const handoffs = input.handoffs ?? [];
  const evidence = input.evidence ?? [];

  return {
    schema_version: 1,
    run_id: runId,
    cursor_agent_id: cursorAgentId,
    cursor_run_id: input.cursor_run_id ?? null,
    source_profile: input.source_profile,
    epoch: input.epoch ?? 1,
    revision: input.revision ?? 1,
    status: input.status ?? 'active',
    phase: input.phase,
    objective_artifact: input.objective_artifact,
    budgets: {
      max_iterations: input.budgets.max_iterations,
      max_continuations: input.budgets.max_continuations,
      deadline_at: input.budgets.deadline_at,
      consumed_iterations: input.budgets.consumed_iterations ?? 0,
      consumed_continuations: input.budgets.consumed_continuations ?? 0,
    },
    goals,
    stories,
    todos,
    child_tasks: childTasks,
    handoffs,
    evidence,
    failure_fingerprint: input.failure_fingerprint ?? null,
    cancel_requested: input.cancel_requested ?? false,
    verified: false,
    verification_authority: 'omcu-cli-only',
    created_at: now,
    updated_at: now,

    // Backward-compatibility properties
    workflowId: runId,
    cursorAgentId,
    cursorRunId: input.cursor_run_id ?? undefined,
    target: input.target ?? 'local',
    goal: goals.length > 0 && goals[0] ? goals[0].title : input.objective_artifact,
    phases: [{ name: input.phase, status: 'in_progress' }],
    acceptanceCriteria: goals.flatMap((g) =>
      g.acceptance_criteria.map((c) => ({ description: c, met: g.status === 'completed' }))
    ),
    evidenceReferences: evidence.map((e) => e.reference),
    createdAt: now,
    updatedAt: now,
  };
}

export function digestWorkflowProjection(projection: WorkflowProjection): string {
  const material = {
    schema_version: projection.schema_version,
    run_id: projection.run_id,
    cursor_agent_id: projection.cursor_agent_id,
    cursor_run_id: projection.cursor_run_id,
    source_profile: projection.source_profile,
    epoch: projection.epoch,
    revision: projection.revision,
    status: projection.status,
    phase: projection.phase,
    objective_artifact: projection.objective_artifact,
    budgets: projection.budgets,
    goals: projection.goals,
    stories: projection.stories,
    todos: projection.todos,
    child_tasks: projection.child_tasks,
    handoffs: projection.handoffs,
    evidence: projection.evidence,
    failure_fingerprint: projection.failure_fingerprint,
    cancel_requested: projection.cancel_requested,
    verified: projection.verified,
  };
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex');
}
