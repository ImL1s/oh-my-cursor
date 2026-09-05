import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicCreateJson, atomicWriteJson, withDirectoryLock, type AtomicWriteOptions } from '../runtime/atomic.js';
import { Journal, type JournalRecord } from '../runtime/journal.js';
import {
  classifyProcessLiveness,
  processNonceSha256,
  type ProcessIdentity,
  type ProcessIdentityRuntime,
} from '../runtime/process-identity.js';
import type { StateRoot } from '../runtime/state-root.js';
import {
  assertSafeWorkerName,
  readTeamConfig,
  teamConfigPath,
  teamStateDir,
  teamTaskJournalDir,
  teamTasksDir,
  writeTeamConfig,
  type TeamCoordinationConfig,
} from './state-root.js';

export const TEAM_TASK_STATUSES = ['pending', 'blocked', 'in_progress', 'completed', 'failed'] as const;
export type TeamTaskStatus = (typeof TEAM_TASK_STATUSES)[number];

export const MAX_TERMINAL_PAYLOAD_BYTES = 48 * 1024;

const TERMINAL = new Set<TeamTaskStatus>(['completed', 'failed']);
const TRANSITIONS: Readonly<Record<TeamTaskStatus, readonly TeamTaskStatus[]>> = {
  pending: ['in_progress', 'blocked'],
  blocked: ['pending', 'in_progress'],
  in_progress: ['completed', 'failed', 'pending'],
  completed: [],
  failed: [],
};

export const CLAIM_LEASE_MS = 15 * 60 * 1000;
export const MAX_TOTAL_LEASE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WorkerProcessIdentityClaim {
  readonly pid: number;
  readonly start_identity: string;
  readonly start_identity_proven?: boolean;
  readonly nonce_sha256?: string;
}

export function toWorkerProcessIdentityClaim(
  identity: WorkerProcessIdentityClaim | ProcessIdentity | (Pick<WorkerProcessIdentityClaim, 'pid' | 'start_identity'> & { start_identity_proven?: boolean; nonce?: string; nonce_sha256?: string }),
): WorkerProcessIdentityClaim {
  let nonceSha256 = 'nonce_sha256' in identity ? identity.nonce_sha256 : undefined;
  if ('nonce' in identity && typeof (identity as { nonce?: unknown }).nonce === 'string') {
    nonceSha256 = processNonceSha256((identity as { nonce: string }).nonce);
  }
  return {
    pid: identity.pid,
    start_identity: identity.start_identity,
    ...(identity.start_identity_proven !== undefined ? { start_identity_proven: identity.start_identity_proven } : {}),
    ...(nonceSha256 !== undefined ? { nonce_sha256: nonceSha256 } : {}),
  };
}

export interface TeamTaskClaim {
  readonly owner: string;
  readonly generation: number;
  readonly token_sha256: string;
  readonly token?: string;
  readonly worker_process_identity?: WorkerProcessIdentityClaim;
  readonly acquired_at: string;
  readonly renewed_at?: string;
  readonly leased_until: string;
  readonly heartbeat_sequence?: number;
  readonly workspace_generation?: number;
}

export interface TeamTask {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly status: TeamTaskStatus;
  readonly created_at: string;
  readonly version: number;
  readonly last_claim_generation?: number;
  readonly request_id?: string;
  readonly request_payload_sha256?: string;
  /** Immutable owner from the idempotent create request; later claims may rewrite owner. */
  readonly request_owner?: string | null;
  readonly owner?: string;
  readonly blocked_by?: readonly string[];
  readonly claim?: TeamTaskClaim;
  readonly completed_at?: string;
  readonly result?: string;
  readonly error?: string;
}

export type TeamTaskJournalEvent =
  | { readonly kind: 'created'; readonly task: TeamTask }
  | { readonly kind: 'claimed'; readonly task: TeamTask; readonly claim: TeamTaskClaim }
  | { readonly kind: 'renewed'; readonly task: TeamTask; readonly claim: TeamTaskClaim }
  | { readonly kind: 'released'; readonly task: TeamTask }
  | { readonly kind: 'reclaimed'; readonly task: TeamTask; readonly previous_generation: number; readonly new_generation: number; readonly reason?: string }
  | { readonly kind: 'transitioned'; readonly task: TeamTask; readonly from: TeamTaskStatus; readonly to: TeamTaskStatus }
  | { readonly kind: 'reopened'; readonly task: TeamTask; readonly reason?: string };

export type ClaimTaskResult =
  | { readonly ok: true; readonly task: TeamTask; readonly claimToken: string }
  | {
      readonly ok: false;
      readonly error:
        | 'task_not_found'
        | 'claim_conflict'
        | 'worker_not_found'
        | 'already_terminal'
        | 'blocked_dependency'
        | 'worker_alive'
        | 'reconciliation_required';
      readonly dependencies?: readonly string[];
      readonly reason?: string;
    };

export type RenewTaskClaimResult =
  | { readonly ok: true; readonly task: TeamTask }
  | {
      readonly ok: false;
      readonly error:
        | 'task_not_found'
        | 'claim_conflict'
        | 'worker_not_found'
        | 'already_terminal'
        | 'lease_expired'
        | 'lease_limit_exceeded'
        | 'process_dead'
        | 'process_ambiguous'
        | 'process_stale';
      readonly reason?: string;
    };

export type ReclaimTaskResult =
  | {
      readonly ok: true;
      readonly task: TeamTask;
      readonly claimToken: string;
      readonly previousGeneration: number;
      readonly newGeneration: number;
    }
  | {
      readonly ok: false;
      readonly error:
        | 'task_not_found'
        | 'worker_not_found'
        | 'not_in_progress'
        | 'lease_active'
        | 'worker_alive'
        | 'reconciliation_required'
        | 'already_terminal'
        | 'generation_mismatch'
        | 'claim_conflict';
      readonly reason?: string;
      readonly priorGeneration?: number;
      readonly priorOwner?: string;
    };

export type TransitionTaskResult =
  | { readonly ok: true; readonly task: TeamTask }
  | {
      readonly ok: false;
      readonly error: 'task_not_found' | 'claim_conflict' | 'invalid_transition' | 'already_terminal' | 'lease_expired';
    };

export type ReleaseTaskClaimResult =
  | { readonly ok: true; readonly task: TeamTask }
  | {
      readonly ok: false;
      readonly error: 'task_not_found' | 'claim_conflict' | 'already_terminal' | 'lease_expired';
    };

export type ReopenTaskResult =
  | { readonly ok: true; readonly task: TeamTask }
  | {
      readonly ok: false;
      readonly error: 'task_not_found' | 'not_terminal';
    };

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

export interface CreateTaskOptions {
  readonly taskWriteOptions?: AtomicWriteOptions;
  readonly configWriteOptions?: AtomicWriteOptions;
  /** Test seam for a caller-visible failure after both durable writes commit. */
  readonly faultInjector?: (point: 'after_task_and_config_commit_before_response') => void;
}

export interface CreateTaskInput {
  readonly subject: string;
  readonly description: string;
  readonly owner?: string;
  readonly blocked_by?: readonly string[];
  /**
   * Durable idempotency key. Retries with the same key must use the identical
   * canonical payload. Omitting it preserves the legacy at-least-once API.
   */
  readonly request_id?: string;
}

export interface ClaimTaskOptions {
  readonly expectedVersion?: number | null;
  readonly leaseMs?: number;
  readonly processIdentity?: WorkerProcessIdentityClaim | null;
  readonly processRuntime?: ProcessIdentityRuntime;
  readonly taskWriteOptions?: AtomicWriteOptions;
  readonly now?: () => Date;
}

export interface RenewTaskClaimOptions {
  readonly leaseMs?: number;
  readonly maxTotalLeaseMs?: number;
  readonly generation?: number;
  readonly heartbeatSequence?: number;
  readonly processRuntime?: ProcessIdentityRuntime;
  readonly taskWriteOptions?: AtomicWriteOptions;
  readonly now?: () => Date;
}

export interface ReclaimTaskOptions {
  readonly reason?: string;
  readonly force?: boolean;
  readonly expectedGeneration?: number;
  readonly expectedVersion?: number;
  readonly killProcess?: (pid: number) => void;
  readonly processRuntime?: ProcessIdentityRuntime;
  readonly leaseMs?: number;
  readonly newProcessIdentity?: WorkerProcessIdentityClaim | null;
  readonly taskWriteOptions?: AtomicWriteOptions;
  readonly now?: () => Date;
}

export interface TransitionTaskTerminalData {
  readonly result?: string;
  readonly error?: string;
  readonly generation?: number;
  readonly expectedVersion?: number;
  readonly workspaceGeneration?: number;
  readonly taskWriteOptions?: AtomicWriteOptions;
  readonly now?: () => Date;
}

export interface ReleaseTaskOptions {
  readonly generation?: number;
  readonly expectedVersion?: number;
  readonly taskWriteOptions?: AtomicWriteOptions;
  readonly now?: () => Date;
}

export interface ReopenTaskOptions {
  readonly reason?: string;
  readonly now?: () => Date;
  readonly taskWriteOptions?: AtomicWriteOptions;
}

function assertTaskId(taskId: string): string {
  if (!/^\d{1,20}$/.test(taskId)) throw new Error('E_TEAM_TASK_ID_INVALID');
  return taskId;
}

function taskFilePath(root: StateRoot, teamName: string, taskId: string): string {
  return path.join(teamTasksDir(root, teamName), `task-${assertTaskId(taskId)}.json`);
}

function teamDependencyCoordinationPath(root: StateRoot, teamName: string): string {
  return path.join(teamTasksDir(root, teamName), '.dependency-lock');
}

async function withDependencyCoordinationLock<T>(root: StateRoot, teamName: string, fn: () => Promise<T> | T): Promise<T> {
  return withDirectoryLock(teamDependencyCoordinationPath(root, teamName), fn);
}

function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 35) return false;
  const time = Date.parse(value);
  return Number.isFinite(time);
}

function isValidWorkerName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function isClaim(value: unknown): value is TeamTaskClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (!isValidWorkerName(c.owner)) return false;
  if (c.generation !== undefined && (!Number.isSafeInteger(c.generation) || (c.generation as number) < 1)) return false;
  if (c.token_sha256 !== undefined && (typeof c.token_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(c.token_sha256))) return false;
  if (c.token !== undefined && (typeof c.token !== 'string' || c.token.trim() === '')) return false;
  if (c.token_sha256 === undefined && c.token === undefined) return false;
  if (!isValidIsoTimestamp(c.leased_until)) return false;
  if (c.acquired_at !== undefined && !isValidIsoTimestamp(c.acquired_at)) return false;
  if (c.renewed_at !== undefined && !isValidIsoTimestamp(c.renewed_at)) return false;
  if (c.heartbeat_sequence !== undefined && (!Number.isSafeInteger(c.heartbeat_sequence) || (c.heartbeat_sequence as number) < 0)) return false;
  if (c.workspace_generation !== undefined && (!Number.isSafeInteger(c.workspace_generation) || (c.workspace_generation as number) < 1)) return false;
  if (c.worker_process_identity !== undefined) {
    if (!c.worker_process_identity || typeof c.worker_process_identity !== 'object' || Array.isArray(c.worker_process_identity)) return false;
    const wpi = c.worker_process_identity as Record<string, unknown>;
    if (!Number.isSafeInteger(wpi.pid) || (wpi.pid as number) <= 0) return false;
    if (typeof wpi.start_identity !== 'string' || wpi.start_identity.trim() === '') return false;
    if (wpi.start_identity_proven !== undefined && typeof wpi.start_identity_proven !== 'boolean') return false;
    if (wpi.nonce_sha256 !== undefined && (typeof wpi.nonce_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(wpi.nonce_sha256))) return false;
  }
  return true;
}

function isTeamTask(value: unknown): value is TeamTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  if (typeof task.id !== 'string' || !/^\d{1,20}$/.test(task.id)) return false;
  if (typeof task.subject !== 'string' || task.subject.length > 64 * 1024) return false;
  if (typeof task.description !== 'string' || task.description.length > 64 * 1024) return false;
  if (typeof task.status !== 'string' || !(TEAM_TASK_STATUSES as readonly string[]).includes(task.status)) return false;
  if (!isValidIsoTimestamp(task.created_at)) return false;
  if (typeof task.version !== 'number' || !Number.isSafeInteger(task.version) || task.version < 1) return false;
  if (task.last_claim_generation !== undefined && (!Number.isSafeInteger(task.last_claim_generation) || (task.last_claim_generation as number) < 0)) return false;

  if (task.request_id !== undefined && (typeof task.request_id !== 'string' || !isRequestId(task.request_id))) return false;
  if (task.request_payload_sha256 !== undefined && (typeof task.request_payload_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(task.request_payload_sha256))) return false;
  if (task.request_owner !== undefined && task.request_owner !== null && !isValidWorkerName(task.request_owner)) return false;
  if ((task.request_id === undefined) !== (task.request_payload_sha256 === undefined)) return false;
  if ((task.request_id === undefined) !== (task.request_owner === undefined)) return false;

  if (task.owner !== undefined && !isValidWorkerName(task.owner)) return false;

  if (task.blocked_by !== undefined) {
    if (!Array.isArray(task.blocked_by)) return false;
    for (const dep of task.blocked_by) {
      if (typeof dep !== 'string' || !/^\d{1,20}$/.test(dep)) return false;
    }
  }

  if (task.claim !== undefined) {
    if (!isClaim(task.claim)) return false;
    if (typeof task.last_claim_generation === 'number' && typeof task.claim.generation === 'number') {
      if (task.claim.generation > task.last_claim_generation) return false;
    }
  }

  if (task.completed_at !== undefined && !isValidIsoTimestamp(task.completed_at)) return false;
  if (task.result !== undefined && (typeof task.result !== 'string' || task.result.length > 64 * 1024)) return false;
  if (task.error !== undefined && (typeof task.error !== 'string' || task.error.length > 64 * 1024)) return false;

  if (task.status === 'pending') {
    if (task.claim !== undefined) return false;
    if (task.completed_at !== undefined || task.result !== undefined || task.error !== undefined) return false;
  } else if (task.status === 'blocked') {
    if (task.claim !== undefined) return false;
    if (task.completed_at !== undefined || task.result !== undefined || task.error !== undefined) return false;
    if (!task.blocked_by || task.blocked_by.length === 0) return false;
  } else if (task.status === 'in_progress') {
    if (task.claim === undefined || task.owner === undefined) return false;
    if (task.claim.owner !== task.owner) return false;
    if (task.completed_at !== undefined || task.result !== undefined || task.error !== undefined) return false;
  } else if (task.status === 'completed') {
    if (task.claim !== undefined) return false;
    if (task.completed_at === undefined) return false;
    if (task.error !== undefined) return false;
  } else if (task.status === 'failed') {
    if (task.claim !== undefined) return false;
    if (task.completed_at === undefined) return false;
    if (task.result !== undefined) return false;
  }

  return true;
}

function normalizeTask(task: TeamTask): TeamTask {
  let normalized = task;
  let normalizedClaim = task.claim;
  if (normalizedClaim) {
    let updatedClaim = normalizedClaim;
    if (!normalizedClaim.token_sha256 && normalizedClaim.token) {
      updatedClaim = {
        ...updatedClaim,
        token_sha256: crypto.createHash('sha256').update(normalizedClaim.token).digest('hex'),
      };
    }
    if (updatedClaim.generation === undefined) {
      updatedClaim = {
        ...updatedClaim,
        generation: 1,
      };
    }
    if (updatedClaim.acquired_at === undefined) {
      const leasedUntilMs = Date.parse(updatedClaim.leased_until);
      const createdAtMs = Date.parse(task.created_at);
      let derivedMs: number;
      if (Number.isFinite(leasedUntilMs)) {
        derivedMs = leasedUntilMs - CLAIM_LEASE_MS;
        if (Number.isFinite(createdAtMs)) {
          derivedMs = Math.max(createdAtMs, derivedMs);
        }
        if (derivedMs > leasedUntilMs) {
          derivedMs = leasedUntilMs;
        }
      } else if (Number.isFinite(createdAtMs)) {
        derivedMs = createdAtMs;
      } else {
        derivedMs = 0;
      }
      updatedClaim = {
        ...updatedClaim,
        acquired_at: new Date(derivedMs).toISOString(),
      };
    }
    normalizedClaim = updatedClaim;
    normalized = {
      ...normalized,
      claim: normalizedClaim,
    };
  }

  if (normalized.last_claim_generation === undefined) {
    normalized = {
      ...normalized,
      last_claim_generation: normalizedClaim ? normalizedClaim.generation : 0,
    };
  }
  return normalized;
}

function taskJournal(
  root: StateRoot,
  teamName: string,
  taskId: string,
  now: () => Date,
): Journal<TeamTaskJournalEvent> {
  const dir = teamTaskJournalDir(root, teamName, taskId);
  return new Journal<TeamTaskJournalEvent>(dir, `team/${teamName}/task/${taskId}`, {
    now,
    maxRecordBytes: 64 * 1024,
    maxSegmentBytes: 2 * 1024 * 1024,
  });
}

async function appendTaskJournalEvent(
  root: StateRoot,
  teamName: string,
  taskId: string,
  event: TeamTaskJournalEvent,
  now: () => Date,
): Promise<void> {
  const journal = taskJournal(root, teamName, taskId, now);
  await journal.append({
    kind: event.kind,
    payload: event,
    at: now().toISOString(),
  });
}

export function rebuildTaskFromJournal(root: StateRoot, teamName: string, taskId: string): TeamTask | null {
  try {
    const journal = taskJournal(root, teamName, taskId, () => new Date());
    const head = journal.readHead();
    if (head === null || head.head_sequence === 0) return null;
    const records = journal.readRange();
    let currentTask: TeamTask | null = null;
    for (const record of records) {
      const p = (record as JournalRecord<TeamTaskJournalEvent>).payload;
      if (p && 'task' in p && p.task) {
        currentTask = p.task;
      }
    }
    return currentTask;
  } catch {
    return null;
  }
}

function leaseExpired(claim: TeamTaskClaim | undefined, now: Date): boolean {
  if (!claim) return false;
  const t = Date.parse(claim.leased_until);
  if (Number.isNaN(t)) throw new Error('E_TEAM_TASK_CORRUPT');
  return t <= now.getTime();
}

function verifyClaimToken(claim: TeamTaskClaim, candidateToken: string): boolean {
  const trimmed = candidateToken.trim();
  if (trimmed === '') return false;
  const hash = crypto.createHash('sha256').update(trimmed).digest('hex');
  if (claim.token_sha256 && claim.token_sha256 === hash) return true;
  if (claim.token && claim.token === trimmed) return true;
  return false;
}

function classifyWorkerClaimLiveness(
  identity: WorkerProcessIdentityClaim,
  source?: ProcessIdentityRuntime,
): ReturnType<typeof classifyProcessLiveness> {
  return classifyProcessLiveness({
    pid: identity.pid,
    start_identity: identity.start_identity,
    start_identity_proven: identity.start_identity_proven ?? false,
  }, source);
}

function readTaskUnlocked(root: StateRoot, teamName: string, taskId: string): TeamTask | null {
  const file = taskFilePath(root, teamName, taskId);
  if (!fs.existsSync(file)) {
    const recovered = rebuildTaskFromJournal(root, teamName, taskId);
    if (recovered && isTeamTask(recovered) && recovered.id === taskId) {
      writeTaskUnlocked(root, teamName, recovered);
      return normalizeTask(recovered);
    }
    return null;
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isTeamTask(parsed) || parsed.id !== taskId) {
      const recovered = rebuildTaskFromJournal(root, teamName, taskId);
      if (recovered && isTeamTask(recovered) && recovered.id === taskId) {
        writeTaskUnlocked(root, teamName, recovered);
        return normalizeTask(recovered);
      }
      throw new Error('E_TEAM_TASK_CORRUPT');
    }
    return normalizeTask(parsed);
  } catch (error) {
    if ((error as Error).message === 'E_TEAM_TASK_CORRUPT') throw error;
    const recovered = rebuildTaskFromJournal(root, teamName, taskId);
    if (recovered && isTeamTask(recovered) && recovered.id === taskId) {
      writeTaskUnlocked(root, teamName, recovered);
      return normalizeTask(recovered);
    }
    throw new Error('E_TEAM_TASK_CORRUPT');
  }
}

function writeTaskUnlocked(root: StateRoot, teamName: string, task: TeamTask, options?: AtomicWriteOptions): void {
  atomicWriteJson(taskFilePath(root, teamName, task.id), task, options);
}

async function commitTaskWithJournal(
  root: StateRoot,
  teamName: string,
  taskId: string,
  event: TeamTaskJournalEvent,
  task: TeamTask,
  previousTask: TeamTask | null,
  nowFn: () => Date,
  writeOptions?: AtomicWriteOptions,
): Promise<void> {
  await appendTaskJournalEvent(root, teamName, taskId, event, nowFn);
  try {
    writeTaskUnlocked(root, teamName, task, writeOptions);
  } catch (error) {
    if (previousTask !== null) {
      const lastClaimGen = Math.max(
        task.last_claim_generation ?? 0,
        task.claim?.generation ?? 0,
        previousTask.last_claim_generation ?? 0,
        previousTask.claim?.generation ?? 0,
      );
      const isClaimOp = event.kind === 'claimed' || event.kind === 'reclaimed';
      const { owner: _prevOwner, claim: _prevClaim, ...baseTask } = previousTask;
      const reconciledTask: TeamTask = {
        ...baseTask,
        version: task.version + 1,
        ...(lastClaimGen > 0 ? { last_claim_generation: lastClaimGen } : {}),
        ...(isClaimOp
          ? {
              status: previousTask.status === 'in_progress' ? 'pending' : previousTask.status,
            }
          : {
              ...(previousTask.owner !== undefined ? { owner: previousTask.owner } : {}),
              ...(previousTask.claim !== undefined ? { claim: previousTask.claim } : {}),
            }),
      };

      try {
        await appendTaskJournalEvent(
          root,
          teamName,
          taskId,
          {
            kind: 'released',
            task: reconciledTask,
          },
          nowFn,
        );
      } catch {
        // best effort journal reconciliation
      }

      const filePath = taskFilePath(root, teamName, taskId);
      try {
        writeTaskUnlocked(root, teamName, reconciledTask);
      } catch {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // best effort unlink
        }
      }
    } else {
      const filePath = taskFilePath(root, teamName, taskId);
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // best effort cleanup
      }
    }
    throw error;
  }
}

function checkDependencyCycle(
  root: StateRoot,
  teamName: string,
  candidateTaskId: string,
  blockedBy: readonly string[],
): void {
  const inStack = new Set<string>([candidateTaskId]);
  const visited = new Set<string>();

  function dfs(currentId: string): void {
    if (inStack.has(currentId)) {
      throw new Error('E_TEAM_TASK_DEPENDENCY_CYCLE');
    }
    if (visited.has(currentId)) return;
    inStack.add(currentId);
    const task = readTaskUnlocked(root, teamName, currentId);
    if (task && task.blocked_by) {
      for (const dep of task.blocked_by) {
        dfs(dep);
      }
    }
    inStack.delete(currentId);
    visited.add(currentId);
  }

  for (const dep of blockedBy) {
    if (dep === candidateTaskId) {
      throw new Error('E_TEAM_TASK_DEPENDENCY_CYCLE');
    }
    dfs(dep);
  }
}

function enumerateAllTaskIds(root: StateRoot, teamName: string): Set<string> {
  const taskIds = new Set<string>();

  const tasksDir = teamTasksDir(root, teamName);
  if (fs.existsSync(tasksDir)) {
    for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = /^task-(\d{1,20})\.json$/.exec(entry.name);
      if (match) {
        taskIds.add(match[1]!);
      }
    }
  }

  const journalsBaseDir = path.join(teamStateDir(root, teamName), 'task-journals');
  if (fs.existsSync(journalsBaseDir)) {
    for (const entry of fs.readdirSync(journalsBaseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (/^\d{1,20}$/.test(entry.name)) {
        taskIds.add(entry.name);
      }
    }
  }

  return taskIds;
}

async function unblockDependentTasks(root: StateRoot, teamName: string, completedTaskId: string, now: () => Date): Promise<void> {
  const taskIds = enumerateAllTaskIds(root, teamName);
  for (const otherId of taskIds) {
    if (otherId === completedTaskId) continue;
    await withDirectoryLock(taskFilePath(root, teamName, otherId), async () => {
      const other = readTaskUnlocked(root, teamName, otherId);
      if (other && other.status === 'blocked' && other.blocked_by && other.blocked_by.includes(completedTaskId)) {
        const stillIncomplete = other.blocked_by.filter((depId) => {
          const dep = readTaskUnlocked(root, teamName, depId);
          return dep === null || dep.status !== 'completed';
        });
        if (stillIncomplete.length === 0) {
          const unblocked: TeamTask = {
            ...other,
            status: 'pending',
            version: other.version + 1,
          };
          await commitTaskWithJournal(
            root,
            teamName,
            otherId,
            {
              kind: 'transitioned',
              task: unblocked,
              from: 'blocked',
              to: 'pending',
            },
            unblocked,
            other,
            now,
          );
        }
      }
    });
  }
}

async function reblockDependentTasks(
  root: StateRoot,
  teamName: string,
  reopenedTaskId: string,
  now: () => Date,
  writeOptions?: AtomicWriteOptions,
): Promise<void> {
  const toCheck = new Set<string>([reopenedTaskId]);
  while (toCheck.size > 0) {
    const currentUncompletedId = toCheck.values().next().value as string;
    toCheck.delete(currentUncompletedId);

    const taskIds = enumerateAllTaskIds(root, teamName);
    for (const otherId of taskIds) {
      if (otherId === currentUncompletedId) continue;

      await withDirectoryLock(taskFilePath(root, teamName, otherId), async () => {
        const other = readTaskUnlocked(root, teamName, otherId);
        if (other && other.status !== 'blocked' && other.blocked_by && other.blocked_by.includes(currentUncompletedId)) {
          const priorStatus = other.status;
          const {
            owner: _o,
            claim: _c,
            completed_at: _ca,
            result: _res,
            error: _err,
            ...rest
          } = other;
          const preserveOwner = priorStatus === 'pending' && other.claim === undefined && other.owner !== undefined;
          const reblocked: TeamTask = {
            ...rest,
            status: 'blocked',
            version: other.version + 1,
            ...(preserveOwner ? { owner: other.owner } : {}),
          };
          const event: TeamTaskJournalEvent = (priorStatus === 'completed' || priorStatus === 'failed')
            ? {
                kind: 'reopened',
                task: reblocked,
                reason: `prerequisite_${currentUncompletedId}_reopened`,
              }
            : {
                kind: 'transitioned',
                task: reblocked,
                from: priorStatus,
                to: 'blocked',
              };
          await commitTaskWithJournal(
            root,
            teamName,
            otherId,
            event,
            reblocked,
            other,
            now,
            writeOptions,
          );
          toCheck.add(otherId);
        }
      });
    }
  }
}

export function canTransitionTaskStatus(from: TeamTaskStatus, to: TeamTaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export async function listTasks(root: StateRoot, teamName: string): Promise<readonly TeamTask[]> {
  const taskIds = enumerateAllTaskIds(root, teamName);
  const tasks: TeamTask[] = [];
  for (const id of taskIds) {
    const task = readTaskUnlocked(root, teamName, id);
    if (task) tasks.push(task);
  }
  tasks.sort((left, right) => Number(left.id) - Number(right.id));
  return tasks;
}

export async function readTask(root: StateRoot, teamName: string, taskId: string): Promise<TeamTask | null> {
  let id: string;
  try {
    id = assertTaskId(taskId);
  } catch {
    return null;
  }
  return readTaskUnlocked(root, teamName, id);
}

export async function createTask(
  root: StateRoot,
  teamName: string,
  input: CreateTaskInput,
  nowOrOptions: (() => Date) | CreateTaskOptions = () => new Date(),
  options: CreateTaskOptions = {},
): Promise<TeamTask> {
  let nowFn = () => new Date();
  let actualOptions = options;
  if (typeof nowOrOptions === 'function') {
    nowFn = nowOrOptions;
    actualOptions = options;
  } else if (typeof nowOrOptions === 'object' && nowOrOptions !== null) {
    actualOptions = nowOrOptions;
  }

  const subject = input.subject.trim();
  const description = input.description.trim();
  if (subject === '' || description === '') throw new Error('E_TEAM_TASK_FIELDS_REQUIRED');
  const requestId = input.request_id === undefined ? undefined : assertRequestId(input.request_id);

  const hasDependencies = Array.isArray(input.blocked_by) && input.blocked_by.length > 0;
  const withCoordination = hasDependencies
    ? (fn: () => Promise<TeamTask>) => withDependencyCoordinationLock(root, teamName, fn)
    : (fn: () => Promise<TeamTask>) => fn();

  return withCoordination(async () => {
    return withDirectoryLock(teamConfigPath(root, teamName), async () => {
      const config = readTeamConfig(root, teamName);
      if (config === null) throw new Error('E_TEAM_NOT_FOUND');
      let workingConfig = config;

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
        if (id === String(workingConfig.next_task_id)) {
          throw new Error('E_TEAM_TASK_DEPENDENCY_CYCLE');
        }
        if (readTaskUnlocked(root, teamName, id) === null) {
          throw new Error('E_TEAM_BLOCKED_BY_NOT_FOUND');
        }
        blockedBy.push(id);
      }
      checkDependencyCycle(root, teamName, String(workingConfig.next_task_id), blockedBy);
    }

    const requestPayloadSha256 = requestId === undefined ? undefined : canonicalTaskRequestSha256({
      subject,
      description,
      ...(owner === undefined ? {} : { owner }),
      ...(blockedBy === undefined ? {} : { blocked_by: blockedBy }),
    });
    if (requestId !== undefined) {
      const existing = findTaskByRequestId(root, teamName, requestId);
      if (existing !== undefined) {
        if (existing.request_payload_sha256 !== requestPayloadSha256) {
          throw new Error('E_TEAM_TASK_IDEMPOTENCY_CONFLICT');
        }
        const nextTaskId = Number(existing.id) + 1;
        if (Number.isSafeInteger(nextTaskId) && config.next_task_id < nextTaskId) {
          const repaired = { ...config, next_task_id: nextTaskId };
          try {
            atomicWriteJson(teamConfigPath(root, teamName), repaired, options.configWriteOptions);
          } catch (error) {
            if ((error as { phase?: string }).phase !== 'commit_durability_unknown'
              || readTeamConfig(root, teamName)?.next_task_id !== nextTaskId) throw error;
          }
        }
        return existing;
      }
    }

    while (true) {
      const occupied = readTaskUnlocked(root, teamName, String(workingConfig.next_task_id));
      if (occupied === null) break;
      const repaired: TeamCoordinationConfig = {
        ...workingConfig,
        next_task_id: workingConfig.next_task_id + 1,
      };
      writeTeamConfig(root, repaired);
      if (sameTaskRequest(occupied, {
        subject,
        description,
        ...(requestId === undefined ? {} : { request_id: requestId }),
        ...(owner === undefined ? {} : { owner }),
        ...(blockedBy === undefined ? {} : { blocked_by: blockedBy }),
      })) return occupied;
      workingConfig = repaired;
    }
    const nextId = String(workingConfig.next_task_id);
    let initialStatus: TeamTaskStatus = 'pending';
    if (blockedBy !== undefined && blockedBy.length > 0) {
      const incomplete = blockedBy.filter((depId) => {
        const dep = readTaskUnlocked(root, teamName, depId);
        return dep === null || dep.status !== 'completed';
      });
      if (incomplete.length > 0) {
        initialStatus = 'blocked';
      }
    }
    const task: TeamTask = {
      id: nextId,
      subject,
      description,
      status: initialStatus,
      created_at: nowFn().toISOString(),
      version: 1,
      last_claim_generation: 0,
      ...(requestId !== undefined ? {
        request_id: requestId,
        request_payload_sha256: requestPayloadSha256!,
        request_owner: owner ?? null,
      } : {}),
      ...(owner !== undefined ? { owner } : {}),
      ...(blockedBy !== undefined ? { blocked_by: blockedBy } : {}),
    };
    atomicCreateJson(taskFilePath(root, teamName, task.id), task, actualOptions.taskWriteOptions);
    await appendTaskJournalEvent(root, teamName, task.id, { kind: 'created', task }, nowFn);
    const next: TeamCoordinationConfig = { ...workingConfig, next_task_id: workingConfig.next_task_id + 1 };
    try {
      atomicWriteJson(teamConfigPath(root, teamName), next, actualOptions.configWriteOptions);
    } catch (error) {
      if ((error as { phase?: string }).phase === 'commit_durability_unknown') {
        const observed = readTeamConfig(root, teamName);
        if (observed?.next_task_id === next.next_task_id) {
          actualOptions.faultInjector?.('after_task_and_config_commit_before_response');
          return task;
        }
      }
      throw error;
    }
    actualOptions.faultInjector?.('after_task_and_config_commit_before_response');
    return task;
  });
});
}

function isRequestId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

function findTaskByRequestId(root: StateRoot, teamName: string, requestId: string): TeamTask | undefined {
  const taskIds = enumerateAllTaskIds(root, teamName);
  let found: TeamTask | undefined;
  for (const id of taskIds) {
    const task = readTaskUnlocked(root, teamName, id);
    if (task?.request_id !== requestId) continue;
    const expectedPayload = canonicalTaskRequestSha256({
      subject: task.subject,
      description: task.description,
      ...(task.request_owner === null || task.request_owner === undefined ? {} : { owner: task.request_owner }),
      ...(task.blocked_by === undefined ? {} : { blocked_by: task.blocked_by }),
    });
    if (task.request_payload_sha256 !== expectedPayload) throw new Error('E_TEAM_TASK_IDEMPOTENCY_CORRUPT');
    if (found !== undefined) throw new Error('E_TEAM_TASK_IDEMPOTENCY_CORRUPT');
    found = task;
  }
  return found;
}

function assertRequestId(value: string): string {
  if (!isRequestId(value)) throw new Error('E_TEAM_TASK_REQUEST_ID_INVALID');
  return value;
}

function canonicalTaskRequestSha256(
  input: { readonly subject: string; readonly description: string; readonly owner?: string; readonly blocked_by?: readonly string[] },
): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    subject: input.subject,
    description: input.description,
    owner: input.owner ?? null,
    blocked_by: input.blocked_by ?? [],
  })).digest('hex');
}

function requestMetadata(task: TeamTask): Partial<Pick<TeamTask, 'request_id' | 'request_payload_sha256' | 'request_owner'>> {
  return task.request_id === undefined || task.request_payload_sha256 === undefined || task.request_owner === undefined
    ? {}
    : {
      request_id: task.request_id,
      request_payload_sha256: task.request_payload_sha256,
      request_owner: task.request_owner,
    };
}

function sameTaskRequest(
  task: TeamTask,
  input: CreateTaskInput,
): boolean {
  return task.version === 1 && (task.status === 'pending' || task.status === 'blocked')
    && task.request_id === input.request_id
    && task.subject === input.subject
    && task.description === input.description
    && task.owner === input.owner
    && JSON.stringify(task.blocked_by ?? []) === JSON.stringify(input.blocked_by ?? []);
}

export async function claimTask(
  root: StateRoot,
  teamName: string,
  taskId: string,
  workerName: string,
  expectedVersionOrOptions: number | null | ClaimTaskOptions = null,
  nowOrOptions: (() => Date) | ClaimTaskOptions = () => new Date(),
  options: ClaimTaskOptions = {},
): Promise<ClaimTaskResult> {
  const worker = assertSafeWorkerName(workerName);
  const id = assertTaskId(taskId);
  const config = readTeamConfig(root, teamName);
  if (config === null) return { ok: false, error: 'task_not_found' };
  if (!config.workers.some((entry) => entry.name === worker)) return { ok: false, error: 'worker_not_found' };

  let actualOptions: ClaimTaskOptions = {};
  let expVersion: number | null = null;
  let nowFn = () => new Date();

  if (expectedVersionOrOptions !== null && typeof expectedVersionOrOptions === 'object') {
    actualOptions = expectedVersionOrOptions;
    expVersion = actualOptions.expectedVersion ?? null;
    nowFn = actualOptions.now ?? (() => new Date());
  } else {
    expVersion = (typeof expectedVersionOrOptions === 'number' && Number.isInteger(expectedVersionOrOptions))
      ? expectedVersionOrOptions
      : null;
    if (typeof nowOrOptions === 'function') {
      nowFn = nowOrOptions;
      actualOptions = options;
      if (actualOptions.now) nowFn = actualOptions.now;
      if (actualOptions.expectedVersion !== undefined && expVersion === null) {
        expVersion = actualOptions.expectedVersion;
      }
    } else if (typeof nowOrOptions === 'object' && nowOrOptions !== null) {
      actualOptions = nowOrOptions;
      nowFn = actualOptions.now ?? (() => new Date());
      if (actualOptions.expectedVersion !== undefined && expVersion === null) {
        expVersion = actualOptions.expectedVersion;
      }
    } else {
      actualOptions = options;
      if (actualOptions.now) nowFn = actualOptions.now;
      if (actualOptions.expectedVersion !== undefined && expVersion === null) {
        expVersion = actualOptions.expectedVersion;
      }
    }
  }

  return withDirectoryLock(taskFilePath(root, teamName, id), async () => {
    const current = readTaskUnlocked(root, teamName, id);
    if (current === null) return { ok: false, error: 'task_not_found' as const };
    if (expVersion !== null && current.version !== expVersion) return { ok: false, error: 'claim_conflict' as const };
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
      if (!leaseExpired(working.claim, nowFn())) return { ok: false, error: 'claim_conflict' as const };
      if (working.claim?.worker_process_identity) {
        const liveness = classifyWorkerClaimLiveness(working.claim.worker_process_identity, actualOptions.processRuntime);
        if (liveness.status === 'active') {
          return { ok: false, error: 'worker_alive' as const, reason: 'prior worker process is still active' };
        }
        if (liveness.status === 'ambiguous') {
          return { ok: false, error: 'reconciliation_required' as const, reason: liveness.reason };
        }
      }
      working = {
        id: working.id,
        subject: working.subject,
        description: working.description,
        status: 'pending',
        created_at: working.created_at,
        version: working.version + 1,
        ...(working.last_claim_generation !== undefined ? { last_claim_generation: working.last_claim_generation } : {}),
        ...requestMetadata(working),
        ...(working.blocked_by !== undefined ? { blocked_by: working.blocked_by } : {}),
      };
    }

    if (working.claim && !leaseExpired(working.claim, nowFn())) return { ok: false, error: 'claim_conflict' as const };
    if (working.owner && working.owner !== worker) return { ok: false, error: 'claim_conflict' as const };

    const newGeneration = Math.max(working.last_claim_generation ?? 0, working.claim?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(newGeneration)) throw new Error('E_TEAM_TASK_GENERATION_OVERFLOW');
    const claimToken = crypto.randomUUID();
    const tokenSha256 = crypto.createHash('sha256').update(claimToken).digest('hex');
    const leaseMs = Math.min(Math.max(1, actualOptions.leaseMs ?? CLAIM_LEASE_MS), MAX_TOTAL_LEASE_MS);
    const leasedUntil = new Date(nowFn().getTime() + leaseMs).toISOString();

    const claim: TeamTaskClaim = {
      owner: worker,
      generation: newGeneration,
      token_sha256: tokenSha256,
      acquired_at: nowFn().toISOString(),
      leased_until: leasedUntil,
      heartbeat_sequence: 0,
      workspace_generation: newGeneration,
      ...(actualOptions.processIdentity ? { worker_process_identity: toWorkerProcessIdentityClaim(actualOptions.processIdentity) } : {}),
    };

    const updated: TeamTask = {
      id: working.id,
      subject: working.subject,
      description: working.description,
      status: 'in_progress',
      created_at: working.created_at,
      version: working.version + 1,
      last_claim_generation: newGeneration,
      ...requestMetadata(working),
      owner: worker,
      claim,
      ...(working.blocked_by !== undefined ? { blocked_by: working.blocked_by } : {}),
    };
    await commitTaskWithJournal(
      root,
      teamName,
      updated.id,
      {
        kind: 'claimed',
        task: updated,
        claim,
      },
      updated,
      working,
      nowFn,
      actualOptions.taskWriteOptions,
    );
    return { ok: true as const, task: updated, claimToken };
  });
}

export async function renewTaskClaim(
  root: StateRoot,
  teamName: string,
  taskId: string,
  workerName: string,
  claimToken: string,
  options: RenewTaskClaimOptions = {},
  now: () => Date = options.now ?? (() => new Date()),
): Promise<RenewTaskClaimResult> {
  const worker = assertSafeWorkerName(workerName);
  const id = assertTaskId(taskId);
  const config = readTeamConfig(root, teamName);
  if (config === null) return { ok: false, error: 'task_not_found' };
  if (!config.workers.some((entry) => entry.name === worker)) return { ok: false, error: 'worker_not_found' };

  return withDirectoryLock(taskFilePath(root, teamName, id), async () => {
    const current = readTaskUnlocked(root, teamName, id);
    if (current === null) return { ok: false, error: 'task_not_found' as const };
    if (TERMINAL.has(current.status)) return { ok: false, error: 'already_terminal' as const };
    if (current.status !== 'in_progress' || !current.claim || !current.owner) {
      return { ok: false, error: 'claim_conflict' as const };
    }
    if (current.owner !== worker || current.claim.owner !== worker) {
      return { ok: false, error: 'claim_conflict' as const };
    }
    if (options.generation !== undefined && current.claim.generation !== options.generation) {
      return { ok: false, error: 'claim_conflict' as const };
    }
    if (!verifyClaimToken(current.claim, claimToken)) {
      return { ok: false, error: 'claim_conflict' as const };
    }
    if (leaseExpired(current.claim, now())) {
      return { ok: false, error: 'lease_expired' as const };
    }

    const leaseMs = options.leaseMs ?? CLAIM_LEASE_MS;
    const maxTotalMs = options.maxTotalLeaseMs ?? MAX_TOTAL_LEASE_MS;
    const currentLeasedUntilMs = Date.parse(current.claim.leased_until);
    const requestedLeasedUntilMs = now().getTime() + leaseMs;
    const targetDeadlineMs = Number.isFinite(currentLeasedUntilMs)
      ? Math.max(currentLeasedUntilMs, requestedLeasedUntilMs)
      : requestedLeasedUntilMs;
    const newLeasedUntil = new Date(targetDeadlineMs);
    const acquiredAtTime = Date.parse(current.claim.acquired_at);
    if (Number.isFinite(acquiredAtTime) && newLeasedUntil.getTime() - acquiredAtTime > maxTotalMs) {
      return { ok: false, error: 'lease_limit_exceeded' as const };
    }

    if (current.claim.worker_process_identity) {
      const liveness = classifyWorkerClaimLiveness(current.claim.worker_process_identity, options.processRuntime);
      if (liveness.status === 'dead') return { ok: false, error: 'process_dead' as const };
      if (liveness.status === 'stale') return { ok: false, error: 'process_stale' as const };
      if (liveness.status === 'ambiguous') {
        return { ok: false, error: 'process_ambiguous' as const, reason: liveness.reason };
      }
    }

    const currentHeartbeat = current.claim.heartbeat_sequence ?? 0;
    let nextHeartbeat: number;
    if (options.heartbeatSequence !== undefined) {
      if (!Number.isSafeInteger(options.heartbeatSequence) || options.heartbeatSequence <= currentHeartbeat) {
        return { ok: false, error: 'claim_conflict' as const };
      }
      nextHeartbeat = options.heartbeatSequence;
    } else {
      nextHeartbeat = currentHeartbeat + 1;
      if (!Number.isSafeInteger(nextHeartbeat)) {
        throw new Error('E_TEAM_TASK_HEARTBEAT_OVERFLOW');
      }
    }

    const updatedClaim: TeamTaskClaim = {
      ...current.claim,
      renewed_at: now().toISOString(),
      leased_until: newLeasedUntil.toISOString(),
      heartbeat_sequence: nextHeartbeat,
    };

    const updated: TeamTask = {
      ...current,
      version: current.version + 1,
      claim: updatedClaim,
    };
    await commitTaskWithJournal(
      root,
      teamName,
      updated.id,
      {
        kind: 'renewed',
        task: updated,
        claim: updatedClaim,
      },
      updated,
      current,
      now,
      options.taskWriteOptions,
    );
    return { ok: true as const, task: updated };
  });
}

export async function reclaimTask(
  root: StateRoot,
  teamName: string,
  taskId: string,
  newWorkerName: string,
  options: ReclaimTaskOptions = {},
  now: () => Date = options.now ?? (() => new Date()),
): Promise<ReclaimTaskResult> {
  const worker = assertSafeWorkerName(newWorkerName);
  const id = assertTaskId(taskId);
  const config = readTeamConfig(root, teamName);
  if (config === null) return { ok: false, error: 'task_not_found' };
  if (!config.workers.some((entry) => entry.name === worker)) return { ok: false, error: 'worker_not_found' };

  return withDirectoryLock(taskFilePath(root, teamName, id), async () => {
    const current = readTaskUnlocked(root, teamName, id);
    if (current === null) return { ok: false, error: 'task_not_found' as const };
    if (TERMINAL.has(current.status)) return { ok: false, error: 'already_terminal' as const };
    if (current.status !== 'in_progress' || !current.claim) {
      return { ok: false, error: 'not_in_progress' as const };
    }

    if (options.force) {
      if (options.expectedGeneration === undefined && options.expectedVersion === undefined) {
        return {
          ok: false,
          error: 'generation_mismatch' as const,
          reason: 'Forced reclaim requires expectedGeneration or expectedVersion to guard against stale overrides',
          priorGeneration: current.claim.generation,
          priorOwner: current.claim.owner,
        };
      }
    }

    if (options.expectedGeneration !== undefined && current.claim.generation !== options.expectedGeneration) {
      return {
        ok: false,
        error: 'generation_mismatch' as const,
        reason: `Task generation ${current.claim.generation} does not match expected generation ${options.expectedGeneration}`,
        priorGeneration: current.claim.generation,
        priorOwner: current.claim.owner,
      };
    }

    if (options.expectedVersion !== undefined && current.version !== options.expectedVersion) {
      return {
        ok: false,
        error: 'claim_conflict' as const,
        reason: `Task version ${current.version} does not match expected version ${options.expectedVersion}`,
        priorGeneration: current.claim.generation,
        priorOwner: current.claim.owner,
      };
    }

    if (!leaseExpired(current.claim, now()) && !options.force) {
      return { ok: false, error: 'lease_active' as const };
    }

    if (current.claim.worker_process_identity) {
      let liveness = classifyWorkerClaimLiveness(current.claim.worker_process_identity, options.processRuntime);
      if (liveness.status === 'active') {
        if (options.force && options.killProcess) {
          try {
            options.killProcess(current.claim.worker_process_identity.pid);
          } catch {
            // best effort kill
          }
          liveness = classifyWorkerClaimLiveness(current.claim.worker_process_identity, options.processRuntime);
        }
        if (liveness.status === 'active' && !options.force) {
          return {
            ok: false,
            error: 'worker_alive' as const,
            reason: 'prior worker process is still active',
            priorGeneration: current.claim.generation,
            priorOwner: current.claim.owner,
          };
        }
      }
      if (liveness.status === 'ambiguous' && !options.force) {
        return {
          ok: false,
          error: 'reconciliation_required' as const,
          reason: liveness.reason,
          priorGeneration: current.claim.generation,
          priorOwner: current.claim.owner,
        };
      }
    }

    const priorGeneration = current.claim.generation;
    const newGeneration = Math.max(current.last_claim_generation ?? 0, priorGeneration) + 1;
    if (!Number.isSafeInteger(newGeneration)) throw new Error('E_TEAM_TASK_GENERATION_OVERFLOW');
    const claimToken = crypto.randomUUID();
    const tokenSha256 = crypto.createHash('sha256').update(claimToken).digest('hex');
    const leaseMs = Math.min(Math.max(1, options.leaseMs ?? CLAIM_LEASE_MS), MAX_TOTAL_LEASE_MS);

    const claim: TeamTaskClaim = {
      owner: worker,
      generation: newGeneration,
      token_sha256: tokenSha256,
      acquired_at: now().toISOString(),
      leased_until: new Date(now().getTime() + leaseMs).toISOString(),
      heartbeat_sequence: 0,
      workspace_generation: newGeneration,
      ...(options.newProcessIdentity ? { worker_process_identity: toWorkerProcessIdentityClaim(options.newProcessIdentity) } : {}),
    };

    const updated: TeamTask = {
      ...current,
      owner: worker,
      version: current.version + 1,
      last_claim_generation: newGeneration,
      claim,
    };
    await commitTaskWithJournal(
      root,
      teamName,
      updated.id,
      {
        kind: 'reclaimed',
        task: updated,
        previous_generation: priorGeneration,
        new_generation: newGeneration,
        ...(options.reason !== undefined ? { reason: options.reason } : {}),
      },
      updated,
      current,
      now,
      options.taskWriteOptions,
    );
    return {
      ok: true as const,
      task: updated,
      claimToken,
      previousGeneration: priorGeneration,
      newGeneration,
    };
  });
}

export async function transitionTaskStatus(
  root: StateRoot,
  teamName: string,
  taskId: string,
  from: TeamTaskStatus,
  to: TeamTaskStatus,
  claimToken: string,
  terminalData: TransitionTaskTerminalData = {},
  now: () => Date = terminalData.now ?? (() => new Date()),
): Promise<TransitionTaskResult> {
  if (!canTransitionTaskStatus(from, to)) return { ok: false, error: 'invalid_transition' };
  const id = assertTaskId(taskId);
  const token = claimToken.trim();
  if (token === '') return { ok: false, error: 'claim_conflict' };
  const nowFn = terminalData.now ?? now;
  if (terminalData.result !== undefined && (typeof terminalData.result !== 'string' || Buffer.byteLength(terminalData.result, 'utf8') > MAX_TERMINAL_PAYLOAD_BYTES)) {
    return { ok: false, error: 'invalid_transition' };
  }
  if (terminalData.error !== undefined && (typeof terminalData.error !== 'string' || Buffer.byteLength(terminalData.error, 'utf8') > MAX_TERMINAL_PAYLOAD_BYTES)) {
    return { ok: false, error: 'invalid_transition' };
  }

  const executeTransition = async (): Promise<TransitionTaskResult> => {
    const result = await withDirectoryLock(taskFilePath(root, teamName, id), async (): Promise<TransitionTaskResult> => {
      const current = readTaskUnlocked(root, teamName, id);
      if (current === null) return { ok: false, error: 'task_not_found' as const };
      if (TERMINAL.has(current.status)) return { ok: false, error: 'already_terminal' as const };
      if (current.status !== from || !canTransitionTaskStatus(current.status, to)) {
        return { ok: false, error: 'invalid_transition' as const };
      }
      if (!current.owner || !current.claim || current.claim.owner !== current.owner || !verifyClaimToken(current.claim, token)) {
        return { ok: false, error: 'claim_conflict' as const };
      }
      if (terminalData.generation !== undefined && current.claim.generation !== terminalData.generation) {
        return { ok: false, error: 'claim_conflict' as const };
      }
      if (terminalData.workspaceGeneration !== undefined && current.claim.workspace_generation !== terminalData.workspaceGeneration) {
        return { ok: false, error: 'claim_conflict' as const };
      }
      if (terminalData.expectedVersion !== undefined && current.version !== terminalData.expectedVersion) {
        return { ok: false, error: 'claim_conflict' as const };
      }
      if (leaseExpired(current.claim, nowFn())) return { ok: false, error: 'lease_expired' as const };
      if (to === 'completed' && current.blocked_by && current.blocked_by.length > 0) {
        for (const depId of current.blocked_by) {
          const dep = readTaskUnlocked(root, teamName, depId);
          if (dep === null || dep.status !== 'completed') {
            return { ok: false, error: 'invalid_transition' as const };
          }
        }
      }

      const updated: TeamTask = {
        id: current.id,
        subject: current.subject,
        description: current.description,
        status: to,
        created_at: current.created_at,
        version: current.version + 1,
        ...(current.last_claim_generation !== undefined ? { last_claim_generation: current.last_claim_generation } : {}),
        ...requestMetadata(current),
        owner: current.owner,
        ...(TERMINAL.has(to) ? { completed_at: nowFn().toISOString() } : {}),
        ...(current.blocked_by !== undefined ? { blocked_by: current.blocked_by } : {}),
        ...(to === 'completed' && terminalData.result !== undefined ? { result: terminalData.result } : {}),
        ...(to === 'failed' && terminalData.error !== undefined ? { error: terminalData.error } : {}),
      };

      const event: TeamTaskJournalEvent = {
        kind: 'transitioned',
        task: updated,
        from,
        to,
      };
      const serializedProbe = JSON.stringify({
        kind: event.kind,
        payload: event,
        at: nowFn().toISOString(),
      });
      if (Buffer.byteLength(serializedProbe, 'utf8') > 60 * 1024) {
        return { ok: false, error: 'invalid_transition' as const };
      }

      await commitTaskWithJournal(
        root,
        teamName,
        updated.id,
        event,
        updated,
        current,
        nowFn,
        terminalData.taskWriteOptions,
      );
      return { ok: true as const, task: updated };
    });

    if (result.ok && to === 'completed') {
      await unblockDependentTasks(root, teamName, id, nowFn);
    }
    return result;
  };

  if (to === 'completed') {
    return withDependencyCoordinationLock(root, teamName, () => executeTransition());
  }
  return executeTransition();
}

export async function releaseTaskClaim(
  root: StateRoot,
  teamName: string,
  taskId: string,
  claimToken: string,
  workerName: string,
  nowOrOptions: (() => Date) | ReleaseTaskOptions = () => new Date(),
  options: ReleaseTaskOptions = {},
): Promise<ReleaseTaskClaimResult> {
  const id = assertTaskId(taskId);
  const worker = assertSafeWorkerName(workerName);
  const token = claimToken.trim();

  let actualOptions = options;
  let nowFn = () => new Date();
  if (typeof nowOrOptions === 'function') {
    nowFn = nowOrOptions;
    actualOptions = options;
  } else if (typeof nowOrOptions === 'object' && nowOrOptions !== null) {
    actualOptions = nowOrOptions;
  }
  if (actualOptions.now) nowFn = actualOptions.now;

  return withDirectoryLock(taskFilePath(root, teamName, id), async () => {
    const current = readTaskUnlocked(root, teamName, id);
    if (current === null) return { ok: false, error: 'task_not_found' as const };
    if (current.status === 'pending' && current.claim === undefined && current.owner === undefined) {
      return { ok: true as const, task: current };
    }
    if (TERMINAL.has(current.status)) return { ok: false, error: 'already_terminal' as const };
    if (!current.owner || current.owner !== worker || !current.claim || !verifyClaimToken(current.claim, token)) {
      return { ok: false, error: 'claim_conflict' as const };
    }
    if (actualOptions.generation !== undefined && current.claim.generation !== actualOptions.generation) {
      return { ok: false, error: 'claim_conflict' as const };
    }
    if (actualOptions.expectedVersion !== undefined && current.version !== actualOptions.expectedVersion) {
      return { ok: false, error: 'claim_conflict' as const };
    }
    if (leaseExpired(current.claim, nowFn())) return { ok: false, error: 'lease_expired' as const };

    const updated: TeamTask = {
      id: current.id,
      subject: current.subject,
      description: current.description,
      status: 'pending',
      created_at: current.created_at,
      version: current.version + 1,
      ...(current.last_claim_generation !== undefined ? { last_claim_generation: current.last_claim_generation } : {}),
      ...requestMetadata(current),
      ...(current.blocked_by !== undefined ? { blocked_by: current.blocked_by } : {}),
    };
    await commitTaskWithJournal(
      root,
      teamName,
      updated.id,
      {
        kind: 'released',
        task: updated,
      },
      updated,
      current,
      nowFn,
      actualOptions.taskWriteOptions,
    );
    return { ok: true as const, task: updated };
  });
}

export async function reopenTask(
  root: StateRoot,
  teamName: string,
  taskId: string,
  options: ReopenTaskOptions = {},
  now: () => Date = options.now ?? (() => new Date()),
): Promise<ReopenTaskResult> {
  const id = assertTaskId(taskId);
  return withDependencyCoordinationLock(root, teamName, async (): Promise<ReopenTaskResult> => {
    const result = await withDirectoryLock(taskFilePath(root, teamName, id), async (): Promise<ReopenTaskResult> => {
      const current = readTaskUnlocked(root, teamName, id);
      if (current === null) return { ok: false, error: 'task_not_found' as const };
      if (!TERMINAL.has(current.status)) return { ok: false, error: 'not_terminal' as const };

      let newStatus: TeamTaskStatus = 'pending';
      if (current.blocked_by && current.blocked_by.length > 0) {
        const incomplete = current.blocked_by.filter((depId) => {
          const dep = readTaskUnlocked(root, teamName, depId);
          return dep === null || dep.status !== 'completed';
        });
        if (incomplete.length > 0) {
          newStatus = 'blocked';
        }
      }

      const updated: TeamTask = {
        id: current.id,
        subject: current.subject,
        description: current.description,
        status: newStatus,
        created_at: current.created_at,
        version: current.version + 1,
        ...(current.last_claim_generation !== undefined ? { last_claim_generation: current.last_claim_generation } : {}),
        ...requestMetadata(current),
        ...(current.blocked_by !== undefined ? { blocked_by: current.blocked_by } : {}),
      };
      await commitTaskWithJournal(
        root,
        teamName,
        updated.id,
        {
          kind: 'reopened',
          task: updated,
          ...(options.reason !== undefined ? { reason: options.reason } : {}),
        },
        updated,
        current,
        now,
        options.taskWriteOptions,
      );
      return { ok: true as const, task: updated };
    });

    if (result.ok) {
      await reblockDependentTasks(root, teamName, id, now, options.taskWriteOptions);
    }
    return result;
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
