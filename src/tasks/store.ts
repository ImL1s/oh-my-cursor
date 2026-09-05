import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../runtime/atomic.js';
import type { TaskRecord, TaskStatus } from './types.js';

export class TaskStore {
  private readonly dir: string;

  constructor(public readonly workspace: string) {
    this.dir = path.join(path.resolve(workspace), '.omcu', 'tasks');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private taskFilePath(taskId: string): string {
    const sanitized = taskId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.dir, `task-${sanitized}.json`);
  }

  save(task: TaskRecord): void {
    const file = this.taskFilePath(task.taskId);
    atomicWriteJson(file, task);
  }

  get(taskId: string): TaskRecord | null {
    const file = this.taskFilePath(taskId);
    if (!fs.existsSync(file)) return null;
    try {
      const content = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(content) as TaskRecord;
      if (parsed.schema_version !== 1 || typeof parsed.taskId !== 'string') {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  list(filter?: {
    workflowId?: string | undefined;
    parentTaskId?: string | undefined;
    status?: TaskStatus | undefined;
  }): readonly TaskRecord[] {
    if (!fs.existsSync(this.dir)) return [];
    const entries = fs.readdirSync(this.dir);
    const tasks: TaskRecord[] = [];
    for (const entry of entries) {
      if (!entry.startsWith('task-') || !entry.endsWith('.json')) continue;
      const file = path.join(this.dir, entry);
      try {
        const content = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(content) as TaskRecord;
        if (parsed.schema_version === 1 && typeof parsed.taskId === 'string') {
          if (filter?.workflowId !== undefined && parsed.workflowId !== filter.workflowId) continue;
          if (filter?.parentTaskId !== undefined && parsed.parentTaskId !== filter.parentTaskId) continue;
          if (filter?.status !== undefined && parsed.status !== filter.status) continue;
          tasks.push(parsed);
        }
      } catch {
        // Skip malformed records
      }
    }
    return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  update(taskId: string, patch: Partial<TaskRecord>): TaskRecord {
    const current = this.get(taskId);
    if (!current) {
      throw new Error(`E_TASK_NOT_FOUND: task '${taskId}' not found`);
    }
    const updated: TaskRecord = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.save(updated);
    return updated;
  }

  recordNativeRun(
    taskId: string,
    agentId: string,
    runId: string,
    status: TaskStatus = 'running'
  ): TaskRecord {
    return this.update(taskId, {
      agentId,
      runId,
      status,
    });
  }

  delete(taskId: string): boolean {
    const file = this.taskFilePath(taskId);
    if (!fs.existsSync(file)) return false;
    try {
      fs.unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }
}
