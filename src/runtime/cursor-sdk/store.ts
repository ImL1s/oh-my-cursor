import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LocalAgentStore } from '@cursor/sdk';
import { atomicWriteJson } from '../atomic.js';
import { CursorRuntimeError } from './errors.js';
import type { RuntimeTarget } from './types.js';
import type {
  WorkflowProjection,
  WorkflowPhase,
  AcceptanceCriterion,
} from '../../workflows/projection.js';

export type {
  WorkflowProjection,
  WorkflowPhase,
  AcceptanceCriterion,
} from '../../workflows/projection.js';

export interface ResolveStoreOptions {
  readonly storeType?: 'jsonl' | 'sqlite' | undefined;
  readonly rootDir: string;
}

export async function resolveLocalAgentStore(
  options: ResolveStoreOptions
): Promise<LocalAgentStore> {
  const storeType = options.storeType ?? 'jsonl';
  if (storeType === 'jsonl') {
    try {
      fs.mkdirSync(options.rootDir, { recursive: true });
      const { JsonlLocalAgentStore } = await import('@cursor/sdk');
      return new JsonlLocalAgentStore(options.rootDir);
    } catch (error) {
      throw new CursorRuntimeError(
        'E_RUNTIME_STARTUP',
        `Failed to initialize JsonlLocalAgentStore: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
  if (storeType === 'sqlite') {
    try {
      fs.mkdirSync(options.rootDir, { recursive: true });
      const { SqliteLocalAgentStore } = await import('@cursor/sdk/sqlite');
      return await SqliteLocalAgentStore.open({
        workspaceRef: options.rootDir,
        stateRoot: options.rootDir,
      });
    } catch (error) {
      throw new CursorRuntimeError(
        'E_RUNTIME_STARTUP',
        `Failed to initialize SqliteLocalAgentStore: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
  throw new CursorRuntimeError(
    'E_RUNTIME_STARTUP',
    `Unsupported agent store type: ${String(storeType)}`
  );
}

function normalizeLoadedProjection(raw: Record<string, any>): WorkflowProjection | null {
  const id = raw.run_id ?? raw.workflowId;
  if (typeof id !== 'string' || !id.trim()) return null;

  const now = new Date().toISOString();
  const cursorAgentId = raw.cursor_agent_id ?? raw.cursorAgentId ?? '';
  const cursorRunId = raw.cursor_run_id ?? raw.cursorRunId ?? undefined;
  const sourceProfile = raw.source_profile ?? raw.sourceProfile ?? 'omc-autopilot';
  const target: RuntimeTarget = raw.target ?? 'local';
  const goals = raw.goals ?? (raw.goal ? [{
    id: 'goal-1',
    title: raw.goal,
    acceptance_criteria: Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria.map((c: any) => c.description ?? String(c)) : [],
    status: 'in_progress',
    created_at: raw.createdAt ?? raw.created_at ?? now,
  }] : []);

  const rawPhases: WorkflowPhase[] = Array.isArray(raw.phases)
    ? raw.phases
    : (raw.phase ? [{ name: raw.phase, status: 'in_progress' }] : [{ name: 'execution', status: 'in_progress' }]);

  const phase = raw.phase ?? (rawPhases[0]?.name ?? 'execution');
  const objective = raw.objective_artifact ?? raw.goal ?? '';

  const budgets = raw.budgets ?? {
    max_iterations: 20,
    max_continuations: 50,
    deadline_at: new Date(Date.now() + 86400000).toISOString(),
    consumed_iterations: 0,
    consumed_continuations: 0,
  };

  const stories = raw.stories ?? [];
  const todos = raw.todos ?? [];
  const childTasks = raw.child_tasks ?? [];
  const handoffs = raw.handoffs ?? [];
  const evidence = raw.evidence ?? (Array.isArray(raw.evidenceReferences) ? raw.evidenceReferences.map((ref: string) => ({
    id: `ev-${crypto.randomUUID().slice(0, 8)}`,
    type: 'test' as const,
    reference: ref,
    digest: '',
    verified: false,
    created_at: now,
  })) : []);

  const createdAt = raw.created_at ?? raw.createdAt ?? now;
  const updatedAt = raw.updated_at ?? raw.updatedAt ?? now;

  return {
    schema_version: 1,
    run_id: id,
    cursor_agent_id: cursorAgentId,
    cursor_run_id: cursorRunId ?? null,
    source_profile: sourceProfile,
    epoch: raw.epoch ?? 1,
    revision: raw.revision ?? 1,
    status: raw.status ?? 'active',
    phase,
    objective_artifact: objective,
    budgets: {
      max_iterations: budgets.max_iterations ?? 20,
      max_continuations: budgets.max_continuations ?? 50,
      deadline_at: budgets.deadline_at ?? new Date(Date.now() + 86400000).toISOString(),
      consumed_iterations: budgets.consumed_iterations ?? 0,
      consumed_continuations: budgets.consumed_continuations ?? 0,
    },
    goals,
    stories,
    todos,
    child_tasks: childTasks,
    handoffs,
    evidence,
    failure_fingerprint: raw.failure_fingerprint ?? null,
    cancel_requested: raw.cancel_requested ?? false,
    verified: raw.verified ?? false,
    verification_authority: 'omcu-cli-only',
    created_at: createdAt,
    updated_at: updatedAt,

    last_event_id: raw.last_event_id ?? null,
    consecutive_failures: typeof raw.consecutive_failures === 'number' ? raw.consecutive_failures : 0,

    // Backward-compat aliases
    workflowId: id,
    cursorAgentId,
    cursorRunId,
    target,
    goal: raw.goal ?? objective,
    phases: rawPhases,
    acceptanceCriteria: raw.acceptanceCriteria ?? goals.flatMap((g: any) =>
      (g.acceptance_criteria ?? []).map((c: string) => ({ description: c, met: g.status === 'completed' }))
    ),
    evidenceReferences: raw.evidenceReferences ?? evidence.map((e: any) => e.reference),
    createdAt,
    updatedAt,
  };
}

export class WorkflowProjectionStore {
  private readonly dir: string;

  constructor(baseDir: string) {
    this.dir = path.join(baseDir, '.omcu', 'workflows');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private filePath(workflowId: string): string {
    const sanitized = workflowId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${sanitized}.json`);
  }

  save(projection: WorkflowProjection): void {
    const id = projection.run_id ?? projection.workflowId;
    const file = this.filePath(id);
    atomicWriteJson(file, projection);
  }

  load(workflowId: string): WorkflowProjection | null {
    const file = this.filePath(workflowId);
    if (!fs.existsSync(file)) return null;
    try {
      const content = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(content) as Record<string, any>;
      if (parsed.schema_version !== 1 && (parsed.schema_version !== undefined || (!parsed.workflowId && !parsed.run_id))) return null;
      return normalizeLoadedProjection(parsed);
    } catch {
      return null;
    }
  }

  list(): readonly WorkflowProjection[] {
    if (!fs.existsSync(this.dir)) return [];
    const entries = fs.readdirSync(this.dir);
    const results: WorkflowProjection[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const file = path.join(this.dir, entry);
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
        if (parsed.schema_version === 1) {
          const normalized = normalizeLoadedProjection(parsed);
          if (normalized) results.push(normalized);
        }
      } catch {
        // Skip corrupt or unreadable files
      }
    }
    return results;
  }

  linkRun(workflowId: string, runId: string): WorkflowProjection {
    const current = this.load(workflowId);
    if (!current) {
      throw new CursorRuntimeError(
        'E_RUNTIME_TERMINAL',
        `Workflow projection not found: ${workflowId}`
      );
    }
    const updated: WorkflowProjection = {
      ...current,
      cursor_run_id: runId,
      cursorRunId: runId,
      updated_at: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.save(updated);
    return updated;
  }

  updatePhase(
    workflowId: string,
    phaseName: string,
    status: WorkflowPhase['status'],
    summary?: string
  ): WorkflowProjection {
    const current = this.load(workflowId);
    if (!current) {
      throw new CursorRuntimeError(
        'E_RUNTIME_TERMINAL',
        `Workflow projection not found: ${workflowId}`
      );
    }
    const currentPhases = current.phases ?? [];
    const phaseIndex = currentPhases.findIndex((p) => p.name === phaseName);
    const newPhases = [...currentPhases];
    const newPhase: WorkflowPhase = {
      name: phaseName,
      status,
      ...(summary !== undefined ? { summary } : {}),
    };
    if (phaseIndex >= 0) {
      newPhases[phaseIndex] = newPhase;
    } else {
      newPhases.push(newPhase);
    }
    const now = new Date().toISOString();
    const updated: WorkflowProjection = {
      ...current,
      phase: phaseName,
      phases: newPhases,
      updated_at: now,
      updatedAt: now,
    };
    this.save(updated);
    return updated;
  }
}
