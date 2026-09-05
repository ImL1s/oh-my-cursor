import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectStateRoot } from '../../src/runtime/state-root.js';
import {
  createTask,
  executeTeamApiOperation,
  initializeTeamState,
  resolveTeamApiOperation,
  TEAM_API_OPERATIONS,
  listTasks,
  readTeamConfig,
  teamWorkerInboxPath,
  validateTeamApiOperationInput,
} from '../../src/team/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function workspace(teamName = 'api-team') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-api-'));
  roots.push(dir);
  const root = projectStateRoot(dir);
  initializeTeamState(root, {
    teamName,
    task: 'api parity',
    workers: [
      { name: 'one', owned_paths: ['src/one'] },
      { name: 'two', owned_paths: ['src/two'] },
    ],
  });
  return { dir, root, teamName };
}

describe('team api interop (P0)', () => {
  it('resolves only the P0 operation set', () => {
    expect(TEAM_API_OPERATIONS).toEqual([
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
    ]);
    expect(resolveTeamApiOperation('send_message')).toBe('send-message');
    expect(resolveTeamApiOperation('broadcast')).toBeNull();
  });

  it('runs create → claim → transition → mailbox → summary → inbox', async () => {
    const { root, teamName } = workspace();

    const created = await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'ship',
      description: 'do the thing',
    }, root);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = (created.data.task as { id: string }).id;
    expect(taskId).toBe('1');

    const claimed = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: taskId,
      worker: 'one',
    }, root);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.data).toMatchObject({ ok: true });
    const claimToken = (claimed.data as { claimToken: string }).claimToken;

    const conflict = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: taskId,
      worker: 'two',
    }, root);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.error.code).toBe('claim_conflict');

    const transitioned = await executeTeamApiOperation('transition-task-status', {
      team_name: teamName,
      task_id: taskId,
      from: 'in_progress',
      to: 'completed',
      claim_token: claimToken,
      result: 'done',
    }, root);
    expect(transitioned.ok).toBe(true);
    if (!transitioned.ok) return;
    expect(transitioned.data).toMatchObject({ ok: true });

    const message = await executeTeamApiOperation('send-message', {
      team_name: teamName,
      from_worker: 'one',
      to_worker: 'two',
      body: 'finished',
    }, root);
    expect(message.ok).toBe(true);
    if (!message.ok) return;
    const messageId = (message.data.message as { message_id: string }).message_id;

    const listed = await executeTeamApiOperation('mailbox-list', {
      team_name: teamName,
      worker: 'two',
    }, root);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.count).toBe(1);

    const delivered = await executeTeamApiOperation('mailbox-mark-delivered', {
      team_name: teamName,
      worker: 'two',
      message_id: messageId,
    }, root);
    expect(delivered.ok).toBe(true);
    if (!delivered.ok) return;
    expect(delivered.data.updated).toBe(true);

    const summary = await executeTeamApiOperation('get-summary', { team_name: teamName }, root);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.data.summary).toMatchObject({
      native_cursor_team: false,
      verified: false,
      tasks: { total: 1, completed: 1 },
    });

    const inbox = await executeTeamApiOperation('write-worker-inbox', {
      team_name: teamName,
      worker: 'two',
      content: 'next assignment',
      expected_sha256: crypto.createHash('sha256')
        .update(fs.readFileSync(teamWorkerInboxPath(root, teamName, 'two'))).digest('hex'),
    }, root);
    expect(inbox.ok).toBe(true);
    expect(fs.readFileSync(teamWorkerInboxPath(root, teamName, 'two'), 'utf8')).toBe('next assignment\n');
    expect(fs.readdirSync(path.dirname(teamWorkerInboxPath(root, teamName, 'two')))
      .filter((name) => name.includes('.tmp-'))).toEqual([]);

    const listedTasks = await executeTeamApiOperation('list-tasks', { team_name: teamName }, root);
    expect(listedTasks.ok).toBe(true);
    if (!listedTasks.ok) return;
    expect(listedTasks.data.count).toBe(1);
  }, 20_000);

  it('fences concurrent whole-inbox replacements by expected digest', async () => {
    const { root, teamName } = workspace('inbox-fence');
    const file = teamWorkerInboxPath(root, teamName, 'one');
    const expected = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const [left, right] = await Promise.all([
      executeTeamApiOperation('write-worker-inbox', {
        team_name: teamName, worker: 'one', content: 'left', expected_sha256: expected,
      }, root),
      executeTeamApiOperation('write-worker-inbox', {
        team_name: teamName, worker: 'one', content: 'right', expected_sha256: expected,
      }, root),
    ]);
    expect([left.ok, right.ok].filter(Boolean)).toHaveLength(1);
    const rejected = left.ok ? right : left;
    if (!rejected.ok) expect(rejected.error.code).toBe('E_TEAM_INBOX_CONFLICT');
    expect(['left\n', 'right\n']).toContain(fs.readFileSync(file, 'utf8'));
  });

  it('supports release-task-claim back to pending', async () => {
    const { root, teamName } = workspace('release-team');
    await executeTeamApiOperation('create-task', { team_name: teamName, subject: 'a', description: 'b' }, root);
    const claimed = await executeTeamApiOperation('claim-task', { team_name: teamName, task_id: '1', worker: 'one' }, root);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const claimToken = (claimed.data as { claimToken: string }).claimToken;
    const released = await executeTeamApiOperation('release-task-claim', {
      team_name: teamName,
      task_id: '1',
      claim_token: claimToken,
      worker: 'one',
    }, root);
    expect(released.ok).toBe(true);
    if (!released.ok) return;
    expect(released.data).toMatchObject({ ok: true });
    expect((released.data as { task: { status: string } }).task.status).toBe('pending');
  });

  it('rejects task ids beyond the persisted 20-digit limit', async () => {
    const { root, teamName } = workspace('task-id-limit');
    const taskId = '1'.repeat(21);
    for (const [operation, input] of [
      ['claim-task', { team_name: teamName, task_id: taskId, worker: 'one' }],
      ['transition-task-status', {
        team_name: teamName, task_id: taskId, from: 'pending', to: 'in_progress', claim_token: 'token',
      }],
      ['release-task-claim', { team_name: teamName, task_id: taskId, worker: 'one', claim_token: 'token' }],
    ] as const) {
      const result = await executeTeamApiOperation(operation, input, root);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_input');
    }
  });

  it('rejects blocked_by task ids beyond the persisted 20-digit limit during preflight', () => {
    expect(() => validateTeamApiOperationInput('create-task', {
      team_name: 'task-id-limit',
      subject: 'blocked task',
      description: 'wait for dependency',
      blocked_by: ['1'.repeat(21)],
    })).toThrow('E_TEAM_API_INPUT_INVALID: blocked_by must be an array of task ids');
  });

  it('recovers task-first publication without holes and serializes concurrent creators', async () => {
    const { root, teamName } = workspace('task-transaction');
    const request = { subject: 'recover me', description: 'same request' };
    await expect(createTask(root, teamName, request, () => new Date('2026-07-31T00:00:00.000Z'), {
      configWriteOptions: { helperFaults: ['rename'] },
    })).rejects.toMatchObject({ phase: 'not_committed' });
    expect(readTeamConfig(root, teamName)?.next_task_id).toBe(1);
    expect((await listTasks(root, teamName)).map((task) => task.id)).toEqual(['1']);

    const recovered = await createTask(root, teamName, request, () => new Date('2026-07-31T00:00:01.000Z'));
    expect(recovered.id).toBe('1');
    expect(readTeamConfig(root, teamName)?.next_task_id).toBe(2);

    const created = await Promise.all(Array.from({ length: 6 }, (_, index) => createTask(root, teamName, {
      subject: `concurrent-${index}`,
      description: `task-${index}`,
    })));
    expect(created.map((task) => Number(task.id)).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);
    expect((await listTasks(root, teamName)).map((task) => Number(task.id))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(readTeamConfig(root, teamName)?.next_task_id).toBe(8);
  });

  it('deduplicates create-task by request_id and rejects a conflicting canonical payload', async () => {
    const { root, teamName } = workspace('task-idempotency');
    const first = await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: ' ship ',
      description: ' once ',
      blocked_by: [],
      request_id: 'request-42',
    }, root);
    const retry = await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'ship',
      description: 'once',
      blocked_by: [],
      request_id: 'request-42',
    }, root);
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect((retry.data.task as { id: string }).id).toBe((first.data.task as { id: string }).id);
    expect((retry.data.task as { request_id: string }).request_id).toBe('request-42');
    expect(await listTasks(root, teamName)).toHaveLength(1);

    const claimed = await executeTeamApiOperation('claim-task', {
      team_name: teamName, task_id: '1', worker: 'one',
    }, root);
    expect(claimed.ok).toBe(true);
    const afterClaimRetry = await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'ship',
      description: 'once',
      blocked_by: [],
      request_id: 'request-42',
    }, root);
    expect(afterClaimRetry.ok).toBe(true);
    if (afterClaimRetry.ok) {
      expect(afterClaimRetry.data.task).toMatchObject({ id: '1', status: 'in_progress', request_id: 'request-42' });
    }

    const conflict = await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'different',
      description: 'once',
      blocked_by: [],
      request_id: 'request-42',
    }, root);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe('E_TEAM_TASK_IDEMPOTENCY_CONFLICT');
  });

  it('retries safely after task and config commit but before the response', async () => {
    const { root, teamName } = workspace('task-response-crash');
    const request = { subject: 'durable', description: 'retry me', request_id: 'response-crash-1' };
    await expect(createTask(root, teamName, request, undefined, {
      faultInjector: () => { throw new Error('E_TEST_RESPONSE_CRASH'); },
    })).rejects.toThrow('E_TEST_RESPONSE_CRASH');
    expect(readTeamConfig(root, teamName)?.next_task_id).toBe(2);
    expect(await listTasks(root, teamName)).toHaveLength(1);

    const retry = await createTask(root, teamName, request);
    expect(retry.id).toBe('1');
    expect(retry.request_id).toBe('response-crash-1');
    expect(readTeamConfig(root, teamName)?.next_task_id).toBe(2);
    expect(await listTasks(root, teamName)).toHaveLength(1);
  });

  it('rejects an idempotent retry when the persisted payload no longer matches its digest', async () => {
    const { root, teamName } = workspace('task-idempotency-corrupt');
    await createTask(root, teamName, {
      subject: 'original',
      description: 'payload',
      request_id: 'request-corrupt-1',
    });
    const file = path.join(root.path, 'state', 'team', teamName, 'tasks', 'task-1.json');
    const tampered = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, `${JSON.stringify({ ...tampered, subject: 'tampered' }, null, 2)}\n`);

    const retry = await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'original',
      description: 'payload',
      request_id: 'request-corrupt-1',
    }, root);
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.error.code).toBe('E_TEAM_TASK_IDEMPOTENCY_CORRUPT');
  });

  it('rejects unknown ops without inventing success', async () => {
    const { root, teamName } = workspace('unknown-op');
    const result = await executeTeamApiOperation('broadcast', { team_name: teamName }, root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unknown_operation');
  });

  it('rejects create-task with unknown owner', async () => {
    const { root, teamName } = workspace('unknown-owner');
    const result = await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'x',
      description: 'y',
      owner: 'ghost',
    }, root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_TEAM_WORKER_NOT_FOUND');
  });

  it('rejects create-task when owner/blocked_by have wrong types', async () => {
    const { root, teamName } = workspace('bad-types');
    const badOwner = await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'x',
      description: 'y',
      owner: 7 as unknown as string,
    }, root);
    expect(badOwner.ok).toBe(false);
    if (!badOwner.ok) expect(badOwner.error.code).toBe('invalid_input');

    const badBlocked = await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'x',
      description: 'y',
      blocked_by: '1' as unknown as string[],
    }, root);
    expect(badBlocked.ok).toBe(false);
    if (!badBlocked.ok) expect(badBlocked.error.code).toBe('invalid_input');

    const badRequestId = await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'x',
      description: 'y',
      request_id: 7 as unknown as string,
    }, root);
    expect(badRequestId.ok).toBe(false);
    if (!badRequestId.ok) expect(badRequestId.error.code).toBe('invalid_input');
  });

  it('returns message_not_found when marking unknown message delivered', async () => {
    const { root, teamName } = workspace('missing-msg');
    const result = await executeTeamApiOperation('mailbox-mark-delivered', {
      team_name: teamName,
      worker: 'one',
      message_id: 'does-not-exist',
    }, root);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('message_not_found');
  });

  it('renews, reclaims, and reopens tasks via Team API with generation fencing', async () => {
    const { root, teamName } = workspace('lifecycle-api');

    const created = await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'lifecycle task',
      description: 'full lifecycle test',
    }, root);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = (created.data.task as { id: string }).id;

    // Claim
    const claimed = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: taskId,
      worker: 'one',
    }, root);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const claimToken = (claimed.data as { claimToken: string }).claimToken;
    const taskClaimed = claimed.data.task as { claim: { generation: number; heartbeat_sequence?: number } };
    expect(taskClaimed.claim.generation).toBe(1);

    // Renew
    const renewed = await executeTeamApiOperation('renew-task-claim', {
      team_name: teamName,
      task_id: taskId,
      worker: 'one',
      claim_token: claimToken,
      generation: 1,
      lease_ms: 60000,
    }, root);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    const taskRenewed = renewed.data.task as { claim: { heartbeat_sequence?: number } };
    expect(taskRenewed.claim.heartbeat_sequence).toBe(1);

    // Reclaim with force
    const reclaimed = await executeTeamApiOperation('reclaim-task', {
      team_name: teamName,
      task_id: taskId,
      worker: 'two',
      force: true,
      reason: 'handover to worker two',
    }, root);
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) return;
    expect(reclaimed.data.previousGeneration).toBe(1);
    expect(reclaimed.data.newGeneration).toBe(2);
    const worker2Token = (reclaimed.data as { claimToken: string }).claimToken;

    // Old worker token/generation fails to transition
    const oldTransition = await executeTeamApiOperation('transition-task-status', {
      team_name: teamName,
      task_id: taskId,
      from: 'in_progress',
      to: 'completed',
      claim_token: claimToken,
      generation: 1,
    }, root);
    expect(oldTransition.ok).toBe(false);
    if (oldTransition.ok) return;
    expect(oldTransition.error.code).toBe('claim_conflict');

    // Worker 2 completes task with generation 2
    const complete = await executeTeamApiOperation('transition-task-status', {
      team_name: teamName,
      task_id: taskId,
      from: 'in_progress',
      to: 'completed',
      claim_token: worker2Token,
      generation: 2,
      result: 'all done',
    }, root);
    expect(complete.ok).toBe(true);

    // Reopen task
    const reopened = await executeTeamApiOperation('reopen-task', {
      team_name: teamName,
      task_id: taskId,
      reason: 're-evaluating results',
    }, root);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const taskReopened = reopened.data.task as { status: string; last_claim_generation?: number };
    expect(taskReopened.status).toBe('pending');
    expect(taskReopened.last_claim_generation).toBe(2);
  });
});
