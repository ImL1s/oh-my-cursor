import fs from 'node:fs';
import path from 'node:path';
import { JsonlLocalAgentStore, type LocalAgentStore } from '@cursor/sdk';
import { atomicWriteJson } from '../atomic.js';
import { CursorRuntimeError } from './errors.js';
import type { RuntimeTarget } from './types.js';

export interface ResolveStoreOptions {
  readonly storeType?: 'jsonl' | 'sqlite' | undefined;
  readonly rootDir: string;
}

export async function resolveLocalAgentStore(
  options: ResolveStoreOptions
): Promise<LocalAgentStore> {
  const storeType = options.storeType ?? 'jsonl';
  if (storeType === 'jsonl') {
    fs.mkdirSync(options.rootDir, { recursive: true });
    return new JsonlLocalAgentStore(options.rootDir);
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

export interface WorkflowPhase {
  readonly name: string;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'failed';
  readonly summary?: string | undefined;
}

export interface AcceptanceCriterion {
  readonly description: string;
  readonly met: boolean;
}

export interface WorkflowProjection {
  readonly schema_version: 1;
  readonly workflowId: string;
  readonly cursorAgentId: string;
  readonly cursorRunId?: string | undefined;
  readonly target: RuntimeTarget;
  readonly goal: string;
  readonly phases: readonly WorkflowPhase[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly evidenceReferences: readonly string[];
  readonly sourceProfile?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
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
    const file = this.filePath(projection.workflowId);
    atomicWriteJson(file, projection);
  }

  load(workflowId: string): WorkflowProjection | null {
    const file = this.filePath(workflowId);
    if (!fs.existsSync(file)) return null;
    try {
      const content = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(content) as WorkflowProjection;
      if (parsed.schema_version !== 1 || typeof parsed.workflowId !== 'string') {
        return null;
      }
      return parsed;
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
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as WorkflowProjection;
        if (parsed.schema_version === 1 && typeof parsed.workflowId === 'string') {
          results.push(parsed);
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
      cursorRunId: runId,
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
    const phaseIndex = current.phases.findIndex((p) => p.name === phaseName);
    const newPhases = [...current.phases];
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
    const updated: WorkflowProjection = {
      ...current,
      phases: newPhases,
      updatedAt: new Date().toISOString(),
    };
    this.save(updated);
    return updated;
  }
}
