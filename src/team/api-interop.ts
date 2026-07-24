import type { StateRoot } from '../runtime/state-root.js';
import { listMailboxMessages, markMessageDelivered, sendDirectMessage } from './mailbox.js';
import {
  claimTask,
  createTask,
  getTeamSummary,
  listTasks,
  releaseTaskClaim,
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
  'transition-task-status',
  'release-task-claim',
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
  omcu team api create-task --input '{"team_name":"t1","subject":"x","description":"y"}'
  omcu team api get-summary --input '{"team_name":"t1"}'

Never stamps verified. native_cursor_team remains false.
`;

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

export function resolveTeamApiOperation(name: string): TeamApiOperation | null {
  const normalized = name.trim().toLowerCase().replaceAll('_', '-');
  return (TEAM_API_OPERATIONS as readonly string[]).includes(normalized) ? (normalized as TeamApiOperation) : null;
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
        if (args.blocked_by !== undefined) {
          if (!Array.isArray(args.blocked_by) || !args.blocked_by.every((entry) => typeof entry === 'string')) {
            return fail(operation, 'invalid_input', 'blocked_by must be an array of strings when provided');
          }
        }
        const owner = typeof args.owner === 'string' ? args.owner : undefined;
        const blockedBy = Array.isArray(args.blocked_by) ? args.blocked_by.map(String) : undefined;
        const task = await createTask(root, teamName, {
          subject,
          description,
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
        const result = await releaseTaskClaim(root, teamName, taskId, claimToken, worker);
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
        if (!teamName || !worker || !content) return fail(operation, 'invalid_input', 'team_name, worker, content are required');
        const config = readTeamConfig(root, teamName);
        if (config === null) return fail(operation, 'team_not_found', `Team ${teamName} not found`);
        if (!config.workers.some((entry) => entry.name === worker)) {
          return fail(operation, 'worker_not_found', `Worker ${worker} not found in team ${teamName}`);
        }
        writeWorkerInboxFile(root, teamName, worker, content);
        return ok(operation, { worker });
      }
      default: {
        const _exhaustive: never = operation;
        return fail('unknown', 'unknown_operation', `Unhandled operation ${String(_exhaustive)}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.startsWith('E_') ? message.split(':')[0]! : 'internal_error';
    return fail(operation, code, message);
  }
}
