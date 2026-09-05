import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../runtime/atomic.js';
import { WorkflowProjectionStore } from '../runtime/cursor-sdk/store.js';
import type { CursorRuntime, ManagedCursorAgent } from '../runtime/cursor-sdk/types.js';
import type { WorkflowProjection } from '../workflows/projection.js';

export interface HandoffContextInput {
  readonly known_facts?: readonly string[] | undefined;
  readonly unresolved_decisions?: readonly string[] | undefined;
  readonly changed_files?: readonly string[] | undefined;
  readonly next_safe_action?: string | undefined;
}

export interface CompactHandoffArtifact {
  readonly schema_version: 1;
  readonly id: string;
  readonly run_id: string;
  readonly cursor_agent_id: string;
  readonly epoch: number;
  readonly current_phase: string;
  readonly objective: string;
  readonly open_goals: readonly {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly criteria: readonly string[];
  }[];
  readonly open_stories: readonly {
    readonly id: string;
    readonly title: string;
    readonly attempt: number;
    readonly status: string;
  }[];
  readonly open_todos: readonly {
    readonly id: string;
    readonly title: string;
    readonly completed: boolean;
  }[];
  readonly known_facts: readonly string[];
  readonly unresolved_decisions: readonly string[];
  readonly changed_files: readonly string[];
  readonly latest_checks: readonly {
    readonly type: string;
    readonly reference: string;
    readonly verified: boolean;
  }[];
  readonly child_native_run_status: readonly {
    readonly task_id: string;
    readonly agent_id?: string | undefined;
    readonly run_id?: string | undefined;
    readonly status: string;
  }[];
  readonly next_safe_action: string;
  readonly remaining_budgets: {
    readonly iterations_left: number;
    readonly continuations_left: number;
    readonly deadline_at: string;
  };
  readonly created_at: string;
  readonly sha256: string;
}

export function createCompactHandoff(
  projection: WorkflowProjection,
  context?: HandoffContextInput
): CompactHandoffArtifact {
  const handoffId = `handoff-${crypto.randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();

  const openGoals = projection.goals
    .filter((g) => g.status === 'pending' || g.status === 'in_progress')
    .map((g) => ({
      id: g.id,
      title: g.title,
      status: g.status,
      criteria: g.acceptance_criteria,
    }));

  const openStories = projection.stories
    .filter((s) => s.status === 'pending' || s.status === 'in_progress')
    .map((s) => ({
      id: s.id,
      title: s.title,
      attempt: s.attempt,
      status: s.status,
    }));

  const openTodos = projection.todos
    .filter((t) => !t.completed && t.status !== 'cancelled')
    .map((t) => ({
      id: t.id,
      title: t.title,
      completed: t.completed,
    }));

  const latestChecks = projection.evidence.slice(-10).map((e) => ({
    type: e.type,
    reference: e.reference,
    verified: e.verified,
  }));

  const childStatus = projection.child_tasks.map((c) => ({
    task_id: c.task_id,
    agent_id: c.agent_id,
    run_id: c.run_id,
    status: c.status,
  }));

  const consumedIter = projection.budgets.consumed_iterations ?? 0;
  const consumedCont = projection.budgets.consumed_continuations ?? 0;

  const remainingBudgets = {
    iterations_left: Math.max(0, projection.budgets.max_iterations - consumedIter),
    continuations_left: Math.max(0, projection.budgets.max_continuations - consumedCont),
    deadline_at: projection.budgets.deadline_at,
  };

  const nextAction = context?.next_safe_action
    ?? (openTodos.length > 0 && openTodos[0] ? `Execute todo: ${openTodos[0].title}` : 'Proceed to verification or phase completion');

  const body = {
    schema_version: 1 as const,
    id: handoffId,
    run_id: projection.run_id,
    cursor_agent_id: projection.cursor_agent_id,
    epoch: projection.epoch,
    current_phase: projection.phase,
    objective: projection.objective_artifact,
    open_goals: openGoals,
    open_stories: openStories,
    open_todos: openTodos,
    known_facts: context?.known_facts ?? [],
    unresolved_decisions: context?.unresolved_decisions ?? [],
    changed_files: context?.changed_files ?? [],
    latest_checks: latestChecks,
    child_native_run_status: childStatus,
    next_safe_action: nextAction,
    remaining_budgets: remainingBudgets,
    created_at: now,
  };

  const digest = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');

  return {
    ...body,
    sha256: digest,
  };
}

export function saveHandoffArtifact(
  baseDir: string,
  artifact: CompactHandoffArtifact
): string {
  const artifactsDir = path.join(baseDir, '.omcu', 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const filePath = path.join(artifactsDir, `${artifact.id}.json`);
  atomicWriteJson(filePath, artifact);
  return filePath;
}

export function loadHandoffArtifact(
  baseDir: string,
  handoffId: string
): CompactHandoffArtifact | null {
  const filePath = path.join(baseDir, '.omcu', 'artifacts', `${handoffId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw.schema_version !== 1 || typeof raw.id !== 'string') return null;
    return raw as CompactHandoffArtifact;
  } catch {
    return null;
  }
}

export interface ResumeWorkflowOptions {
  readonly baseDir: string;
  readonly run_id: string;
  readonly cursor_agent_id: string;
  readonly runtime: CursorRuntime;
  readonly handoffId?: string | undefined;
}

export interface ResumeWorkflowResult {
  readonly managedAgent: ManagedCursorAgent;
  readonly projection: WorkflowProjection;
  readonly handoff: CompactHandoffArtifact | null;
}

/**
 * Resumes a workflow across process boundaries using Agent.resume and the bounded handoff artifact.
 * Rejects missing or mismatched Cursor agent identities.
 */
export async function resumeWorkflowFromHandoff(
  options: ResumeWorkflowOptions
): Promise<ResumeWorkflowResult> {
  const store = new WorkflowProjectionStore(options.baseDir);
  const projection = store.load(options.run_id);

  if (!projection) {
    throw new Error(`E_WORKFLOW_NOT_FOUND: Workflow ${options.run_id} not found`);
  }

  // Reject resuming cancelled workflow
  if (projection.status === 'cancelled') {
    throw new Error(`E_WORKFLOW_CANCELLED: Cannot resume cancelled workflow '${options.run_id}'`);
  }

  // Enforce exact Cursor Agent identity match
  if (projection.cursor_agent_id !== options.cursor_agent_id) {
    throw new Error(
      `E_CURSOR_IDENTITY_MISMATCH: Workflow requires Cursor agent '${projection.cursor_agent_id}', but was invoked with '${options.cursor_agent_id}'`
    );
  }

  // Load and validate handoff artifact if present
  let handoff: CompactHandoffArtifact | null = null;
  if (options.handoffId) {
    handoff = loadHandoffArtifact(options.baseDir, options.handoffId);
    if (!handoff) {
      throw new Error(`E_HANDOFF_NOT_FOUND: Handoff artifact '${options.handoffId}' not found`);
    }
  } else if (projection.handoffs.length > 0) {
    const latestHandoffRef = projection.handoffs[projection.handoffs.length - 1];
    if (latestHandoffRef) {
      handoff = loadHandoffArtifact(options.baseDir, latestHandoffRef.id);
    }
  }

  if (handoff) {
    if (handoff.run_id !== projection.run_id || handoff.cursor_agent_id !== projection.cursor_agent_id) {
      throw new Error(
        `E_HANDOFF_MISMATCH: Handoff artifact belongs to run '${handoff.run_id}' / agent '${handoff.cursor_agent_id}', expected '${projection.run_id}' / '${projection.cursor_agent_id}'`
      );
    }
    const { sha256, ...body } = handoff;
    const expectedSha = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (sha256 !== expectedSha) {
      throw new Error(`E_HANDOFF_CORRUPT: Handoff artifact '${handoff.id}' checksum mismatch`);
    }
  }

  // Advance epoch across process boundary restart
  const nextEpoch = projection.epoch + 1;
  const updatedHandoffs = handoff && !projection.handoffs.some((h) => h.id === handoff!.id)
    ? [
        ...projection.handoffs,
        {
          id: handoff.id,
          epoch: handoff.epoch,
          phase: handoff.current_phase,
          artifact_uri: `.omcu/artifacts/${handoff.id}.json`,
          summary: `Handoff before resume: ${handoff.next_safe_action}`,
          created_at: handoff.created_at,
        },
      ]
    : projection.handoffs;

  const updatedProjection: WorkflowProjection = {
    ...projection,
    epoch: nextEpoch,
    revision: projection.revision + 1,
    status: 'active',
    handoffs: updatedHandoffs,
    updated_at: new Date().toISOString(),
  };

  // Resume the native Cursor agent via Cursor SDK before committing projection update
  const managedAgent = await options.runtime.resumeAgent(options.cursor_agent_id);
  store.save(updatedProjection);

  return {
    managedAgent,
    projection: updatedProjection,
    handoff,
  };
}
