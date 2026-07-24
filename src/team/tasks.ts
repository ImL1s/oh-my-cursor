import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, withDirectoryLock } from '../runtime/atomic.js';
import type { StateRoot } from '../runtime/state-root.js';
import {
  assertSafeWorkerName,
  readTeamConfig,
  teamConfigPath,
  teamTasksDir,
  writeTeamConfig,
  type TeamCoordinationConfig,
} from './state-root.js';

export const TEAM_TASK_STATUSES = ['pending', 'blocked', 'in_progress', 'completed', 'failed'] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

const TERMINAL = new Set<TeamTaskStatus>(['completed', 'failed']);
const TRANSITIONS: Readonly<Record<TeamTaskStatus, readonly TeamTaskStatus[]>> = {
  pending: [],
  blocked: [],
  in_progress: ['completed', 'failed'],
  completed: [],
  failed: [],
};

export const CLAIM_LEASE_MS = 15 * 60 * 1000;

export interface TeamTaskClaim {
  readonly owner: string;
  readonly token: string;
  readonly leased_until: string;
}

export interface TeamTask {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly status: TeamTaskStatus;
  readonly created_at: string;
  readonly version: number;
  readonly owner?: string;
  readonly blocked_by?: readonly string[];
  readonly claim?: TeamTaskClaim;
  readonly completed_at?: string;
  readonly result?: string;
  readonly error?: string;
}

export type ClaimTaskResult =
  | { readonly ok: true; readonly task: TeamTask; readonly claimToken: string }
  | { readonly ok: false; readonly error: 'task_not_found' | 'claim_conflict' | 'worker_not_found' | 'already_terminal' | 'blocked_dependency'; readonly dependencies?: readonly string[] };

export type TransitionTaskResult =
  | { readonly ok: true; readonly task: TeamTask }
  | { readonly ok: false; readonly error: 'task_not_found' | 'claim_conflict' | 'invalid_transition' | 'already_terminal' | 'lease_expired' };

export type ReleaseTaskClaimResult =
  | { readonly ok: true; readonly task: TeamTask }
  | { readonly ok: false; readonly error: 'task_not_found' | 'claim_conflict' | 'already_terminal' | 'lease_expired' };

export interface TeamSummary {
  readonly teamName: string;
  readonly workerCount: number;
  readonly native_cursor_team: false;
  readonly verified: false;
  readonly tasks: {
    readonly total: number;
    readonly pending: number;
    readonly blocked: number;
    readonly in_progress: number;
    readonly completed: number;
    readonly failed: number;
  };
  readonly workers: readonly { readonly name: string }[];
}

function assertTaskId(taskId: string): string {
  if (!/^\d{1,20}$/.test(taskId)) throw new Error('E_TEAM_TASK_ID_INVALID');
  return taskId;
}

function taskFilePath(root: StateRoot, teamName: string, taskId: string): string {
  return path.join(teamTasksDir(root, teamName), `task-${assertTaskId(taskId)}.json`);
}

function isTeamTask(value: unknown): value is TeamTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  return typeof task.id === 'string'
    && /^\d{1,20}$/.test(task.id)
    && typeof task.subject === 'string'
    && typeof task.description === 'string'
    && typeof task.status === 'string'
    && (TEAM_TASK_STATUSES as readonly string[]).includes(task.status)
    && typeof task.created_at === 'string'
    && typeof task.version === 'number'
    && Number.isInteger(task.version)
    && task.version >= 1;
}

function leaseExpired(claim: TeamTaskClaim | undefined, now: Date): boolean {
  if (!claim) return false;
  return new Date(claim.leased_until) <= now;
}

function readTaskUnlocked(root: StateRoot, teamName: string, taskId: string): TeamTask | null {
  const file = taskFilePath(root, teamName, taskId);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!isTeamTask(parsed) || parsed.id !== taskId) throw new Error('E_TEAM_TASK_CORRUPT');
    return parsed;
  } catch (error) {
    if ((error as Error).message === 'E_TEAM_TASK_CORRUPT') throw error;
    throw new Error('E_TEAM_TASK_CORRUPT');
  }
}

function writeTaskUnlocked(root: StateRoot, teamName: string, task: TeamTask): void {
  atomicWriteJson(taskFilePath(root, teamName, task.id), task);
}

export function canTransitionTaskStatus(from: TeamTaskStatus, to: TeamTaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export async function listTasks(root: StateRoot, teamName: string): Promise<readonly TeamTask[]> {
  const dir = teamTasksDir(root, teamName);
  if (!fs.existsSync(dir)) return [];
  const tasks: TeamTask[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const match = /^task-(\d+)\.json$/.exec(entry.name);
    if (!match) continue;
    const task = readTaskUnlocked(root, teamName, match[1]!);
    if (task) tasks.push(task);
  }
  tasks.sort((left, right) => Number(left.id) - Number(right.id));
  return tasks;
}

export async function createTask(
  root: StateRoot,
  teamName: string,
  input: { readonly subject: string; readonly description: string; readonly owner?: string; readonly blocked_by?: readonly string[] },
  now: () => Date = () => new Date(),
): Promise<TeamTask> {
  const subject = input.subject.trim();
  const description = input.description.trim();
  if (subject === '' || description === '') throw new Error('E_TEAM_TASK_FIELDS_REQUIRED');

  return withDirectoryLock(teamConfigPath(root, teamName), () => {
    const config = readTeamConfig(root, teamName);
    if (config === null) throw new Error('E_TEAM_NOT_FOUND');

    let owner: string | undefined;
    if (input.owner !== undefined) {
      owner = assertSafeWorkerName(input.owner);
      if (!config.workers.some((entry) => entry.name === owner)) {
        throw new Error('E_TEAM_WORKER_NOT_FOUND');
      }
    }

    let blockedBy: string[] | undefined;
    if (input.blocked_by !== undefined) {
      blockedBy = [];
      for (const depId of input.blocked_by) {
        const id = assertTaskId(depId);
        if (readTaskUnlocked(root, teamName, id) === null) {
          throw new Error('E_TEAM_BLOCKED_BY_NOT_FOUND');
        }
        blockedBy.push(id);
      }
    }

    const nextId = String(config.next_task_id);
    if (readTaskUnlocked(root, teamName, nextId) !== null) {
      throw new Error('E_TEAM_TASK_ID_COLLISION');
    }
    const task: TeamTask = {
      id: nextId,
      subject,
      description,
      status: 'pending',
      created_at: now().toISOString(),
      version: 1,
      ...(owner !== undefined ? { owner } : {}),
      ...(blockedBy !== undefined ? { blocked_by: blockedBy } : {}),
    };
    const next: TeamCoordinationConfig = { ...config, next_task_id: config.next_task_id + 1 };
    writeTeamConfig(root, next);
    writeTaskUnlocked(root, teamName, task);
    return task;
  });
}

export async function claimTask(
  root: StateRoot,
  teamName: string,
  taskId: string,
  workerName: string,
  expectedVersion: number | null = null,
  now: () => Date = () => new Date(),
): Promise<ClaimTaskResult> {
  const worker = assertSafeWorkerName(workerName);
  const id = assertTaskId(taskId);
  const config = readTeamConfig(root, teamName);
  if (config === null) return { ok: false, error: 'task_not_found' };
  if (!config.workers.some((entry) => entry.name === worker)) return { ok: false, error: 'worker_not_found' };

  return withDirectoryLock(taskFilePath(root, teamName, id), () => {
    const current = readTaskUnlocked(root, teamName, id);
    if (current === null) return { ok: false, error: 'task_not_found' as const };
    if (expectedVersion !== null && current.version !== expectedVersion) return { ok: false, error: 'claim_conflict' as const };
    if (TERMINAL.has(current.status)) return { ok: false, error: 'already_terminal' as const };

    const deps = current.blocked_by ?? [];
    if (deps.length > 0) {
      const incomplete = deps.filter((depId) => {
        const dep = readTaskUnlocked(root, teamName, depId);
        return dep === null || dep.status !== 'completed';
      });
      if (incomplete.length > 0) return { ok: false, error: 'blocked_dependency' as const, dependencies: incomplete };
    }

    let working = current;
    if (working.status === 'in_progress') {
      if (!leaseExpired(working.claim, now())) return { ok: false, error: 'claim_conflict' as const };
      working = {
        id: working.id,
        subject: working.subject,
        description: working.description,
        status: 'pending',
        created_at: working.created_at,
        version: working.version + 1,
        ...(working.blocked_by !== undefined ? { blocked_by: working.blocked_by } : {}),
      };
    }

    if (working.claim && !leaseExpired(working.claim, now())) return { ok: false, error: 'claim_conflict' as const };
    if (working.owner && working.owner !== worker) return { ok: false, error: 'claim_conflict' as const };

    const claimToken = crypto.randomUUID();
    const updated: TeamTask = {
      id: working.id,
      subject: working.subject,
      description: working.description,
      status: 'in_progress',
      created_at: working.created_at,
      version: working.version + 1,
      owner: worker,
      claim: { owner: worker, token: claimToken, leased_until: new Date(now().getTime() + CLAIM_LEASE_MS).toISOString() },
      ...(working.blocked_by !== undefined ? { blocked_by: working.blocked_by } : {}),
    };
    writeTaskUnlocked(root, teamName, updated);
    return { ok: true as const, task: updated, claimToken };
  });
}

export async function transitionTaskStatus(
  root: StateRoot,
  teamName: string,
  taskId: string,
  from: TeamTaskStatus,
  to: TeamTaskStatus,
  claimToken: string,
  terminalData: { readonly result?: string; readonly error?: string } = {},
  now: () => Date = () => new Date(),
): Promise<TransitionTaskResult> {
  if (!canTransitionTaskStatus(from, to)) return { ok: false, error: 'invalid_transition' };
  const id = assertTaskId(taskId);
  const token = claimToken.trim();
  if (token === '') return { ok: false, error: 'claim_conflict' };

  return withDirectoryLock(taskFilePath(root, teamName, id), () => {
    const current = readTaskUnlocked(root, teamName, id);
    if (current === null) return { ok: false, error: 'task_not_found' as const };
    if (TERMINAL.has(current.status)) return { ok: false, error: 'already_terminal' as const };
    if (current.status !== from || !canTransitionTaskStatus(current.status, to)) return { ok: false, error: 'invalid_transition' as const };
    if (!current.owner || !current.claim || current.claim.owner !== current.owner || current.claim.token !== token) {
      return { ok: false, error: 'claim_conflict' as const };
    }
    if (leaseExpired(current.claim, now())) return { ok: false, error: 'lease_expired' as const };

    const updated: TeamTask = {
      id: current.id,
      subject: current.subject,
      description: current.description,
      status: to,
      created_at: current.created_at,
      version: current.version + 1,
      owner: current.owner,
      completed_at: now().toISOString(),
      ...(current.blocked_by !== undefined ? { blocked_by: current.blocked_by } : {}),
      ...(to === 'completed' && terminalData.result !== undefined ? { result: terminalData.result } : {}),
      ...(to === 'failed' && terminalData.error !== undefined ? { error: terminalData.error } : {}),
    };
    writeTaskUnlocked(root, teamName, updated);
    return { ok: true as const, task: updated };
  });
}

export async function releaseTaskClaim(
  root: StateRoot,
  teamName: string,
  taskId: string,
  claimToken: string,
  workerName: string,
  now: () => Date = () => new Date(),
): Promise<ReleaseTaskClaimResult> {
  const id = assertTaskId(taskId);
  const worker = assertSafeWorkerName(workerName);
  const token = claimToken.trim();

  return withDirectoryLock(taskFilePath(root, teamName, id), () => {
    const current = readTaskUnlocked(root, teamName, id);
    if (current === null) return { ok: false, error: 'task_not_found' as const };
    if (current.status === 'pending' && current.claim === undefined && current.owner === undefined) {
      return { ok: true as const, task: current };
    }
    if (TERMINAL.has(current.status)) return { ok: false, error: 'already_terminal' as const };
    if (!current.owner || current.owner !== worker || !current.claim || current.claim.token !== token) {
      return { ok: false, error: 'claim_conflict' as const };
    }
    if (leaseExpired(current.claim, now())) return { ok: false, error: 'lease_expired' as const };

    const updated: TeamTask = {
      id: current.id,
      subject: current.subject,
      description: current.description,
      status: 'pending',
      created_at: current.created_at,
      version: current.version + 1,
      ...(current.blocked_by !== undefined ? { blocked_by: current.blocked_by } : {}),
    };
    writeTaskUnlocked(root, teamName, updated);
    return { ok: true as const, task: updated };
  });
}

export async function getTeamSummary(root: StateRoot, teamName: string): Promise<TeamSummary | null> {
  const config = readTeamConfig(root, teamName);
  if (config === null) return null;
  const tasks = await listTasks(root, teamName);
  const counts = { total: tasks.length, pending: 0, blocked: 0, in_progress: 0, completed: 0, failed: 0 };
  for (const task of tasks) {
    if (task.status === 'pending') counts.pending += 1;
    else if (task.status === 'blocked') counts.blocked += 1;
    else if (task.status === 'in_progress') counts.in_progress += 1;
    else if (task.status === 'completed') counts.completed += 1;
    else if (task.status === 'failed') counts.failed += 1;
  }
  return {
    teamName: config.name,
    workerCount: config.worker_count,
    native_cursor_team: false,
    verified: false,
    tasks: counts,
    workers: config.workers.map((worker) => ({ name: worker.name })),
  };
}
