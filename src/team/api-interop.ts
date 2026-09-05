import type { StateRoot } from '../runtime/state-root.js';
import { listMailboxMessages, markMessageDelivered, sendDirectMessage } from './mailbox.js';
import {
  claimTask,
  createTask,
  getTeamSummary,
  listTasks,
  reclaimTask,
  releaseTaskClaim,
  renewTaskClaim,
  reopenTask,
  TEAM_TASK_STATUSES,
  transitionTaskStatus,
  type TeamTaskStatus,
} from './tasks.js';
import { readTeamConfig, teamExists, writeWorkerInboxFile } from './state-root.js';

/** P0 subset of OMX `TEAM_API_OPERATIONS` — full 33-op clone is P1+. */
export const TEAM_API_OPERATIONS = [
  'send-message',
  'mailbox-list',
  'mailbox-mark-delivered',
  'create-task',
  'list-tasks',
  'claim-task',
  'renew-task-claim',
  'reclaim-task',
  'transition-task-status',
  'release-task-claim',
  'reopen-task',
  'get-summary',
  'write-worker-inbox',
] as const;

export type TeamApiOperation = (typeof TEAM_API_OPERATIONS)[number];

export type TeamApiEnvelope =
  | { readonly ok: true; readonly operation: TeamApiOperation; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly operation: TeamApiOperation | 'unknown'; readonly error: { readonly code: string; readonly message: string; readonly details?: Record<string, unknown> } };

export const TEAM_API_HELP = `omcu team api <operation> --input '<json>'

P0 operations (OMX-shaped; experimental local; not a native Cursor team):
  ${TEAM_API_OPERATIONS.join('\n  ')}

Examples:
  omcu team api send-message --input '{"team_name":"t1","from_worker":"one","to_worker":"two","body":"hi"}'
  omcu team api mailbox-list --input '{"team_name":"t1","worker":"two"}'
  omcu team api create-task --input '{"team_name":"t1","subject":"x","description":"y","request_id":"client-request-1"}'
  omcu team api get-summary --input '{"team_name":"t1"}'

Never stamps verified. native_cursor_team remains false.
`;

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

const TEAM_TASK_ID_PATTERN = /^\d{1,20}$/;

function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && TEAM_TASK_ID_PATTERN.test(value);
}

function invalidInput(message: string): never {
  throw new Error(`E_TEAM_API_INPUT_INVALID: ${message}`);
}

function requiredString(args: Record<string, unknown>, key: string, maxLength = 64 * 1024): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) invalidInput(`${key} is required`);
  return value.trim();
}

function safeTeamName(args: Record<string, unknown>): string {
  const value = requiredString(args, 'team_name', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) invalidInput('team_name is invalid');
  return value;
}

function safeWorker(args: Record<string, unknown>, key: string): string {
  const value = requiredString(args, key, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) invalidInput(`${key} is invalid`);
  return value;
}

function taskId(args: Record<string, unknown>): string {
  const value = requiredString(args, 'task_id', 20);
  if (!isTaskId(value)) invalidInput('task_id is invalid');
  return value;
}

export function resolveTeamApiOperation(name: string): TeamApiOperation | null {
  const normalized = name.trim().toLowerCase().replaceAll('_', '-');
  return (TEAM_API_OPERATIONS as readonly string[]).includes(normalized) ? (normalized as TeamApiOperation) : null;
}

export function teamApiOperationStateAccess(name: string): 'read-existing' | 'write-ensure' {
  const operation = resolveTeamApiOperation(name);
  return operation !== null && ['mailbox-list', 'list-tasks', 'get-summary'].includes(operation)
    ? 'read-existing'
    : 'write-ensure';
}

/** Pure argv/domain preflight. Call before materializing project state. */
export function validateTeamApiOperationInput(
  operationName: string,
  args: Record<string, unknown>,
): TeamApiOperation {
  const operation = resolveTeamApiOperation(operationName);
  if (operation === null) throw new Error(`E_TEAM_API_OPERATION_INVALID: ${operationName}`);
  safeTeamName(args);
  switch (operation) {
    case 'send-message':
      safeWorker(args, 'from_worker');
      safeWorker(args, 'to_worker');
      requiredString(args, 'body');
      break;
    case 'mailbox-list':
      safeWorker(args, 'worker');
      if (args.include_delivered !== undefined && typeof args.include_delivered !== 'boolean') {
        invalidInput('include_delivered must be a boolean');
      }
      break;
    case 'mailbox-mark-delivered':
      safeWorker(args, 'worker');
      requiredString(args, 'message_id', 256);
      break;
    case 'create-task':
      requiredString(args, 'subject');
      requiredString(args, 'description');
      if (args.owner !== undefined) safeWorker(args, 'owner');
      if (args.request_id !== undefined) {
        const requestId = requiredString(args, 'request_id', 256);
        if (/[\u0000-\u001f\u007f]/.test(requestId)) invalidInput('request_id is invalid');
      }
      if (args.blocked_by !== undefined && (!Array.isArray(args.blocked_by)
        || args.blocked_by.some((entry) => !isTaskId(entry)))) {
        invalidInput('blocked_by must be an array of task ids');
      }
      break;
    case 'list-tasks':
    case 'get-summary':
      break;
    case 'claim-task':
      taskId(args);
      safeWorker(args, 'worker');
      if (args.expected_version !== undefined && (!isFiniteInteger(args.expected_version) || args.expected_version < 1)) {
        invalidInput('expected_version must be a positive integer');
      }
      break;
    case 'renew-task-claim':
      taskId(args);
      safeWorker(args, 'worker');
      requiredString(args, 'claim_token', 512);
      if (args.generation !== undefined && (!isFiniteInteger(args.generation) || args.generation < 1)) {
        invalidInput('generation must be a positive integer');
      }
      if (args.lease_ms !== undefined && (!isFiniteInteger(args.lease_ms) || args.lease_ms < 1)) {
        invalidInput('lease_ms must be a positive integer');
      }
      if (args.heartbeat_sequence !== undefined && (!isFiniteInteger(args.heartbeat_sequence) || args.heartbeat_sequence < 0)) {
        invalidInput('heartbeat_sequence must be a non-negative integer');
      }
      break;
    case 'reclaim-task':
      taskId(args);
      safeWorker(args, 'worker');
      if (args.reason !== undefined && typeof args.reason !== 'string') {
        invalidInput('reason must be a string');
      }
      if (args.force !== undefined && typeof args.force !== 'boolean') {
        invalidInput('force must be a boolean');
      }
      if (args.lease_ms !== undefined && (!isFiniteInteger(args.lease_ms) || args.lease_ms < 1)) {
        invalidInput('lease_ms must be a positive integer');
      }
      break;
    case 'transition-task-status': {
      taskId(args);
      const allowed = new Set<string>(TEAM_TASK_STATUSES);
      const from = requiredString(args, 'from', 32);
      const to = requiredString(args, 'to', 32);
      if (!allowed.has(from) || !allowed.has(to)) invalidInput('from and to must be valid task statuses');
      requiredString(args, 'claim_token', 512);
      if (args.result !== undefined && typeof args.result !== 'string') invalidInput('result must be a string');
      if (args.error !== undefined && typeof args.error !== 'string') invalidInput('error must be a string');
      if (args.generation !== undefined && (!isFiniteInteger(args.generation) || args.generation < 1)) {
        invalidInput('generation must be a positive integer');
      }
      if (args.expected_version !== undefined && (!isFiniteInteger(args.expected_version) || args.expected_version < 1)) {
        invalidInput('expected_version must be a positive integer');
      }
      if (args.workspace_generation !== undefined && (!isFiniteInteger(args.workspace_generation) || args.workspace_generation < 1)) {
        invalidInput('workspace_generation must be a positive integer');
      }
      break;
    }
    case 'release-task-claim':
      taskId(args);
      safeWorker(args, 'worker');
      requiredString(args, 'claim_token', 512);
      if (args.generation !== undefined && (!isFiniteInteger(args.generation) || args.generation < 1)) {
        invalidInput('generation must be a positive integer');
      }
      if (args.expected_version !== undefined && (!isFiniteInteger(args.expected_version) || args.expected_version < 1)) {
        invalidInput('expected_version must be a positive integer');
      }
      break;
    case 'reopen-task':
      taskId(args);
      if (args.reason !== undefined && typeof args.reason !== 'string') {
        invalidInput('reason must be a string');
      }
      break;
    case 'write-worker-inbox':
      safeWorker(args, 'worker');
      requiredString(args, 'content');
      if (!/^[a-f0-9]{64}$/.test(requiredString(args, 'expected_sha256', 64))) {
        invalidInput('expected_sha256 must be lowercase sha256');
      }
      break;
    default: {
      const _exhaustive: never = operation;
      return _exhaustive;
    }
  }
  return operation;
}

function fail(operation: TeamApiOperation | 'unknown', code: string, message: string, details?: Record<string, unknown>): TeamApiEnvelope {
  return details === undefined
    ? { ok: false, operation, error: { code, message } }
    : { ok: false, operation, error: { code, message, details } };
}

function ok(operation: TeamApiOperation, data: Record<string, unknown>): TeamApiEnvelope {
  return { ok: true, operation, data };
}

function taskOpResult(
  operation: TeamApiOperation,
  result: { readonly ok: boolean; readonly error?: string } & Record<string, unknown>,
): TeamApiEnvelope {
  if (!result.ok) {
    const code = result.error ?? 'internal_error';
    const { ok: _ignored, error: _error, ...details } = result;
    return Object.keys(details).length > 0
      ? fail(operation, code, code, details)
      : fail(operation, code, code);
  }
  return ok(operation, result);
}

export async function executeTeamApiOperation(
  operationName: string,
  args: Record<string, unknown>,
  root: StateRoot,
): Promise<TeamApiEnvelope> {
  const operation = resolveTeamApiOperation(operationName);
  if (operation === null) {
    return fail('unknown', 'unknown_operation', `Unknown operation "${operationName}". P0 ops: ${TEAM_API_OPERATIONS.join(', ')}`);
  }

  try {
    validateTeamApiOperationInput(operation, args);
    switch (operation) {
      case 'send-message': {
        const teamName = String(args.team_name ?? '').trim();
        const fromWorker = String(args.from_worker ?? '').trim();
        const toWorker = String(args.to_worker ?? '').trim();
        const body = String(args.body ?? '').trim();
        if (!fromWorker) return fail(operation, 'invalid_input', 'from_worker is required');
        if (!teamName || !toWorker || !body) return fail(operation, 'invalid_input', 'team_name, from_worker, to_worker, body are required');
        if (!teamExists(root, teamName)) return fail(operation, 'team_not_found', `Team ${teamName} not found`);
        const message = await sendDirectMessage(root, teamName, fromWorker, toWorker, body);
        return ok(operation, { message });
      }
      case 'mailbox-list': {
        const teamName = String(args.team_name ?? '').trim();
        const worker = String(args.worker ?? '').trim();
        if (!teamName || !worker) return fail(operation, 'invalid_input', 'team_name and worker are required');
        if (!teamExists(root, teamName)) return fail(operation, 'team_not_found', `Team ${teamName} not found`);
        const includeDelivered = args.include_delivered !== false;
        const messages = await listMailboxMessages(root, teamName, worker, { includeDelivered });
        return ok(operation, { worker, count: messages.length, messages });
      }
      case 'mailbox-mark-delivered': {
        const teamName = String(args.team_name ?? '').trim();
        const worker = String(args.worker ?? '').trim();
        const messageId = String(args.message_id ?? '').trim();
        if (!teamName || !worker || !messageId) return fail(operation, 'invalid_input', 'team_name, worker, message_id are required');
        if (!teamExists(root, teamName)) return fail(operation, 'team_not_found', `Team ${teamName} not found`);
        const updated = await markMessageDelivered(root, teamName, worker, messageId);
        if (!updated) return fail(operation, 'message_not_found', `Message ${messageId} not found for worker ${worker}`);
        return ok(operation, { worker, message_id: messageId, updated });
      }
      case 'create-task': {
        const teamName = String(args.team_name ?? '').trim();
        const subject = String(args.subject ?? '').trim();
        const description = String(args.description ?? '').trim();
        if (!teamName || !subject || !description) return fail(operation, 'invalid_input', 'team_name, subject, description are required');
        if (args.owner !== undefined && typeof args.owner !== 'string') {
          return fail(operation, 'invalid_input', 'owner must be a string when provided');
        }
        if (args.request_id !== undefined && typeof args.request_id !== 'string') {
          return fail(operation, 'invalid_input', 'request_id must be a string when provided');
        }
        if (args.blocked_by !== undefined) {
          if (!Array.isArray(args.blocked_by) || !args.blocked_by.every((entry) => typeof entry === 'string')) {
            return fail(operation, 'invalid_input', 'blocked_by must be an array of strings when provided');
          }
        }
        const owner = typeof args.owner === 'string' ? args.owner : undefined;
        const requestId = typeof args.request_id === 'string' ? args.request_id : undefined;
        const blockedBy = Array.isArray(args.blocked_by) ? args.blocked_by.map(String) : undefined;
        const task = await createTask(root, teamName, {
          subject,
          description,
          ...(requestId !== undefined ? { request_id: requestId } : {}),
          ...(owner !== undefined ? { owner } : {}),
          ...(blockedBy !== undefined ? { blocked_by: blockedBy } : {}),
        });
        return ok(operation, { task });
      }
      case 'list-tasks': {
        const teamName = String(args.team_name ?? '').trim();
        if (!teamName) return fail(operation, 'invalid_input', 'team_name is required');
        if (!teamExists(root, teamName)) return fail(operation, 'team_not_found', `Team ${teamName} not found`);
        const tasks = await listTasks(root, teamName);
        return ok(operation, { count: tasks.length, tasks });
      }
      case 'claim-task': {
        const teamName = String(args.team_name ?? '').trim();
        const taskId = String(args.task_id ?? '').trim();
        const worker = String(args.worker ?? '').trim();
        if (!teamName || !taskId || !worker) return fail(operation, 'invalid_input', 'team_name, task_id, worker are required');
        const rawExpected = args.expected_version;
        if (rawExpected !== undefined && (!isFiniteInteger(rawExpected) || rawExpected < 1)) {
          return fail(operation, 'invalid_input', 'expected_version must be a positive integer when provided');
        }
        const result = await claimTask(root, teamName, taskId, worker, (rawExpected as number | undefined) ?? null);
        return taskOpResult(operation, result as { ok: boolean; error?: string } & Record<string, unknown>);
      }
      case 'renew-task-claim': {
        const teamName = String(args.team_name ?? '').trim();
        const taskId = String(args.task_id ?? '').trim();
        const worker = String(args.worker ?? '').trim();
        const claimToken = String(args.claim_token ?? '').trim();
        if (!teamName || !taskId || !worker || !claimToken) {
          return fail(operation, 'invalid_input', 'team_name, task_id, worker, claim_token are required');
        }
        const generation = isFiniteInteger(args.generation) ? (args.generation as number) : undefined;
        const leaseMs = isFiniteInteger(args.lease_ms) ? (args.lease_ms as number) : undefined;
        const heartbeatSequence = isFiniteInteger(args.heartbeat_sequence) ? (args.heartbeat_sequence as number) : undefined;
        const result = await renewTaskClaim(root, teamName, taskId, worker, claimToken, {
          ...(generation !== undefined ? { generation } : {}),
          ...(leaseMs !== undefined ? { leaseMs } : {}),
          ...(heartbeatSequence !== undefined ? { heartbeatSequence } : {}),
        });
        return taskOpResult(operation, result as { ok: boolean; error?: string } & Record<string, unknown>);
      }
      case 'reclaim-task': {
        const teamName = String(args.team_name ?? '').trim();
        const taskId = String(args.task_id ?? '').trim();
        const worker = String(args.worker ?? '').trim();
        if (!teamName || !taskId || !worker) {
          return fail(operation, 'invalid_input', 'team_name, task_id, worker are required');
        }
        const reason = typeof args.reason === 'string' ? args.reason : undefined;
        const force = args.force === true;
        const leaseMs = isFiniteInteger(args.lease_ms) ? (args.lease_ms as number) : undefined;
        const result = await reclaimTask(root, teamName, taskId, worker, {
          ...(reason !== undefined ? { reason } : {}),
          ...(force ? { force: true } : {}),
          ...(leaseMs !== undefined ? { leaseMs } : {}),
        });
        return taskOpResult(operation, result as { ok: boolean; error?: string } & Record<string, unknown>);
      }
      case 'transition-task-status': {
        const teamName = String(args.team_name ?? '').trim();
        const taskId = String(args.task_id ?? '').trim();
        const from = String(args.from ?? '').trim();
        const to = String(args.to ?? '').trim();
        const claimToken = String(args.claim_token ?? '').trim();
        if (!teamName || !taskId || !from || !to || !claimToken) {
          return fail(operation, 'invalid_input', 'team_name, task_id, from, to, claim_token are required');
        }
        const allowed = new Set<string>(TEAM_TASK_STATUSES);
        if (!allowed.has(from) || !allowed.has(to)) {
          return fail(operation, 'invalid_input', 'from and to must be valid task statuses');
        }
        if (args.result !== undefined && typeof args.result !== 'string') {
          return fail(operation, 'invalid_input', 'result must be a string when provided');
        }
        if (args.error !== undefined && typeof args.error !== 'string') {
          return fail(operation, 'invalid_input', 'error must be a string when provided');
        }
        const generation = isFiniteInteger(args.generation) ? (args.generation as number) : undefined;
        const expectedVersion = isFiniteInteger(args.expected_version) ? (args.expected_version as number) : undefined;
        const workspaceGeneration = isFiniteInteger(args.workspace_generation) ? (args.workspace_generation as number) : undefined;
        const result = await transitionTaskStatus(
          root,
          teamName,
          taskId,
          from as TeamTaskStatus,
          to as TeamTaskStatus,
          claimToken,
          {
            ...(typeof args.result === 'string' ? { result: args.result } : {}),
            ...(typeof args.error === 'string' ? { error: args.error } : {}),
            ...(generation !== undefined ? { generation } : {}),
            ...(expectedVersion !== undefined ? { expectedVersion } : {}),
            ...(workspaceGeneration !== undefined ? { workspaceGeneration } : {}),
          },
        );
        return taskOpResult(operation, result as { ok: boolean; error?: string } & Record<string, unknown>);
      }
      case 'release-task-claim': {
        const teamName = String(args.team_name ?? '').trim();
        const taskId = String(args.task_id ?? '').trim();
        const claimToken = String(args.claim_token ?? '').trim();
        const worker = String(args.worker ?? '').trim();
        if (!teamName || !taskId || !claimToken || !worker) {
          return fail(operation, 'invalid_input', 'team_name, task_id, claim_token, worker are required');
        }
        const generation = isFiniteInteger(args.generation) ? (args.generation as number) : undefined;
        const expectedVersion = isFiniteInteger(args.expected_version) ? (args.expected_version as number) : undefined;
        const result = await releaseTaskClaim(root, teamName, taskId, claimToken, worker, undefined, {
          ...(generation !== undefined ? { generation } : {}),
          ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        });
        return taskOpResult(operation, result as { ok: boolean; error?: string } & Record<string, unknown>);
      }
      case 'reopen-task': {
        const teamName = String(args.team_name ?? '').trim();
        const taskId = String(args.task_id ?? '').trim();
        if (!teamName || !taskId) {
          return fail(operation, 'invalid_input', 'team_name and task_id are required');
        }
        const reason = typeof args.reason === 'string' ? args.reason : undefined;
        const result = await reopenTask(root, teamName, taskId, {
          ...(reason !== undefined ? { reason } : {}),
        });
        return taskOpResult(operation, result as { ok: boolean; error?: string } & Record<string, unknown>);
      }
      case 'get-summary': {
        const teamName = String(args.team_name ?? '').trim();
        if (!teamName) return fail(operation, 'invalid_input', 'team_name is required');
        const summary = await getTeamSummary(root, teamName);
        if (summary === null) return fail(operation, 'team_not_found', `Team ${teamName} not found`);
        return ok(operation, { summary });
      }
      case 'write-worker-inbox': {
        const teamName = String(args.team_name ?? '').trim();
        const worker = String(args.worker ?? '').trim();
        const content = String(args.content ?? '').trim();
        const expectedSha256 = String(args.expected_sha256 ?? '').trim();
        if (!teamName || !worker || !content || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
          return fail(operation, 'invalid_input', 'team_name, worker, content, and lowercase expected_sha256 are required');
        }
        const config = readTeamConfig(root, teamName);
        if (config === null) return fail(operation, 'team_not_found', `Team ${teamName} not found`);
        if (!config.workers.some((entry) => entry.name === worker)) {
          return fail(operation, 'worker_not_found', `Worker ${worker} not found in team ${teamName}`);
        }
        const sha256 = writeWorkerInboxFile(root, teamName, worker, content, {}, expectedSha256);
        return ok(operation, { worker, sha256 });
      }
      default: {
        const _exhaustive: never = operation;
        return fail('unknown', 'unknown_operation', `Unhandled operation ${String(_exhaustive)}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let code = 'internal_error';
    if (message.startsWith('E_TEAM_API_INPUT_INVALID')) {
      code = 'invalid_input';
    } else if (message.startsWith('E_')) {
      code = message.split(':')[0]!;
    }
    return fail(operation, code, message);
  }
}
