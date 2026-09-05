import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/application.js';
import { projectStateRoot } from '../../src/runtime/state-root.js';
import {
  createTask,
  executeTeamApiOperation,
  initializeTeamState,
  resolveTeamApiOperation,
  TEAM_API_OPERATIONS,
  listTasks,
  readTask,
  readTeamConfig,
  TeamManifestStore,
  teamWorkerInboxPath,
  validateTeamApiOperationInput,
} from '../../src/team/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function makeMockProcessRuntime(options: {
  alivePids?: Set<number>;
  startTimes?: Map<number, string>;
  ambiguousPids?: Map<number, string>;
  platform?: NodeJS.Platform;
}) {
  const alive = options.alivePids ?? new Set<number>();
  const startTimes = options.startTimes ?? new Map<number, string>();
  const ambiguous = options.ambiguousPids ?? new Map<number, string>();
  const platform = options.platform ?? 'darwin';
  return {
    platform,
    readFile: () => '',
    execFile: (_file: string, args: readonly string[]) => {
      const pidStr = args[args.indexOf('-p') + 1];
      const pid = Number(pidStr);
      const customTime = startTimes.get(pid);
      if (customTime !== undefined) {
        return `${customTime}\n`;
      }
      return 'Mon Sep  5 00:00:00 2026\n';
    },
    probePid: (pid: number) => {
      if (ambiguous.has(pid)) {
        return { status: 'ambiguous' as const, reason: ambiguous.get(pid)! };
      }
      if (alive.has(pid)) {
        return { status: 'alive' as const };
      }
      return { status: 'dead' as const };
    },
  };
}

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

describe('team api interop (P0)', { timeout: 20_000 }, () => {
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
  }, 15_000);

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

    // Reject unsafe heartbeat_sequence (e.g. 1e100)
    const unsafeHeartbeat = await executeTeamApiOperation('renew-task-claim', {
      team_name: teamName,
      task_id: taskId,
      worker: 'one',
      claim_token: claimToken,
      generation: 1,
      heartbeat_sequence: 1e100,
    }, root);
    expect(unsafeHeartbeat.ok).toBe(false);

    // Reject sequence without increment headroom (Number.MAX_SAFE_INTEGER)
    const maxSafeHeartbeat = await executeTeamApiOperation('renew-task-claim', {
      team_name: teamName,
      task_id: taskId,
      worker: 'one',
      claim_token: claimToken,
      generation: 1,
      heartbeat_sequence: Number.MAX_SAFE_INTEGER,
    }, root);
    expect(maxSafeHeartbeat.ok).toBe(false);

    // Reject non-monotonic heartbeat_sequence (<= current sequence)
    const nonMonotonic = await executeTeamApiOperation('renew-task-claim', {
      team_name: teamName,
      task_id: taskId,
      worker: 'one',
      claim_token: claimToken,
      generation: 1,
      heartbeat_sequence: 1,
    }, root);
    expect(nonMonotonic.ok).toBe(false);

    // Reclaim with force without supervisor authority fails
    const unauthorizedReclaim = await executeTeamApiOperation('reclaim-task', {
      team_name: teamName,
      task_id: taskId,
      worker: 'two',
      force: true,
      expected_generation: 1,
      reason: 'handover to worker two',
    }, root);
    expect(unauthorizedReclaim.ok).toBe(false);
    if (!unauthorizedReclaim.ok) {
      expect(unauthorizedReclaim.error.code).toBe('unauthorized');
    }

    // Reclaim with force under supervisor authority succeeds
    const reclaimed = await executeTeamApiOperation('reclaim-task', {
      team_name: teamName,
      task_id: taskId,
      worker: 'two',
      force: true,
      expected_generation: 1,
      reason: 'handover to worker two',
    }, root, { isSupervisor: true });
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

    // Reopen task fails without supervisor authority
    const unauthReopen = await executeTeamApiOperation('reopen-task', {
      team_name: teamName,
      task_id: taskId,
      reason: 're-evaluating results',
    }, root);
    expect(unauthReopen.ok).toBe(false);
    if (!unauthReopen.ok) {
      expect(unauthReopen.error.code).toBe('unauthorized');
    }

    // Reopen task succeeds with supervisor authority
    const reopened = await executeTeamApiOperation('reopen-task', {
      team_name: teamName,
      task_id: taskId,
      reason: 're-evaluating results',
    }, root, { isSupervisor: true });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const taskReopened = reopened.data.task as { status: string; last_claim_generation?: number };
    expect(taskReopened.status).toBe('pending');
    expect(taskReopened.last_claim_generation).toBe(2);
  });

  it('rejects claim-task, renew-task-claim, and reclaim-task when lease_ms exceeds MAX_TOTAL_LEASE_MS', async () => {
    const { root, teamName } = workspace();

    const created = await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'Lease API Cap',
      description: 'Check cap',
    }, root);
    expect(created.ok).toBe(true);

    const excessiveLease = 25 * 60 * 60 * 1000; // 25 hours > 24 hours

    // claim-task rejects
    const badClaim = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'one',
      lease_ms: excessiveLease,
    }, root);
    expect(badClaim.ok).toBe(false);
    if (!badClaim.ok) expect(badClaim.error.code).toBe('invalid_input');

    // claim normal
    const claimed = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'one',
      lease_ms: 60000,
    }, root);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const token = (claimed.data as { claimToken: string }).claimToken;

    // renew-task-claim rejects
    const badRenew = await executeTeamApiOperation('renew-task-claim', {
      team_name: teamName,
      task_id: '1',
      worker: 'one',
      claim_token: token,
      lease_ms: excessiveLease,
    }, root);
    expect(badRenew.ok).toBe(false);
    if (!badRenew.ok) expect(badRenew.error.code).toBe('invalid_input');

    // reclaim-task rejects
    const badReclaim = await executeTeamApiOperation('reclaim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'one',
      lease_ms: excessiveLease,
    }, root);
    expect(badReclaim.ok).toBe(false);
    if (!badReclaim.ok) expect(badReclaim.error.code).toBe('invalid_input');
  });

  it('requires supervisor authority to reopen tasks', async () => {
    const { root, teamName } = workspace();
    await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'Reopen Auth',
      description: 'Check authority',
    }, root);

    const claimed = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'one',
    }, root);
    expect(claimed.ok).toBe(true);
    const token = (claimed.data as { claimToken: string }).claimToken;

    const completed = await executeTeamApiOperation('transition-task-status', {
      team_name: teamName,
      task_id: '1',
      from: 'in_progress',
      to: 'completed',
      claim_token: token,
      result: 'finished',
    }, root);
    expect(completed.ok).toBe(true);

    // Call reopen without supervisor authority -> rejected
    const unauth = await executeTeamApiOperation('reopen-task', {
      team_name: teamName,
      task_id: '1',
      reason: 'need rework',
    }, root);
    expect(unauth.ok).toBe(false);
    if (!unauth.ok) {
      expect(unauth.error.code).toBe('unauthorized');
      expect(unauth.error.message).toContain('supervisor');
    }

    // Call reopen with supervisor authority -> succeeded
    const auth = await executeTeamApiOperation('reopen-task', {
      team_name: teamName,
      task_id: '1',
      reason: 'supervisor approval for rework',
    }, root, { isSupervisor: true });
    expect(auth.ok).toBe(true);
    const task = await readTask(root, teamName, '1');
    expect(task.status).toBe('pending');
  });

  it('resolves long-lived worker identity from manifest or args and hashes process nonce', async () => {
    const { dir, root, teamName } = workspace();

    // 1. Without manifest or args: claim has no process identity (does NOT bind short-lived CLI process)
    await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'CLI Task',
      description: 'Check worker identity resolution',
    }, root);

    const claimWithoutManifest = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'one',
    }, root);
    expect(claimWithoutManifest.ok).toBe(true);
    const taskWithout = await readTask(root, teamName, '1');
    expect(taskWithout?.claim?.worker_process_identity).toBeUndefined();

    // Release for next test
    const token1 = (claimWithoutManifest.data as { claimToken: string }).claimToken;
    await executeTeamApiOperation('release-task-claim', {
      team_name: teamName,
      task_id: '1',
      claim_token: token1,
      worker: 'one',
    }, root);

    // 2. With manifest: claim automatically attaches long-lived pane process identity
    const store = new TeamManifestStore(root);
    store.write({
      schema_version: 2,
      team_id: teamName,
      capability_tier: 'experimental-local',
      native_cursor_team: false,
      tmux_session: `omcu-${teamName}`,
      workers: [
        {
          id: 'one',
          role: 'worker',
          cwd: dir,
          owned_paths: ['src/one'],
          pane_target: '%1',
          pane_pid: 12345,
          pane_start_identity: 'darwin:worker-pane-start-12345',
          pane_start_identity_proven: true,
          process_group_id: 12345,
          argv: ['omcu', 'worker'],
        },
      ],
      created_at: '2026-07-31T00:00:00.000Z',
      stopping_at: null,
      stopping_worker_ids: null,
      stopped_at: null,
    });

    const claimWithManifest = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'one',
    }, root, {
      processRuntime: makeMockProcessRuntime({
        alivePids: new Set([12345]),
        startTimes: new Map([[12345, 'worker-pane-start-12345']]),
      }),
    });
    expect(claimWithManifest.ok).toBe(true);
    const taskWith = await readTask(root, teamName, '1');
    expect(taskWith?.claim?.worker_process_identity).toEqual({
      pid: 12345,
      start_identity: 'darwin:worker-pane-start-12345',
      start_identity_proven: true,
    });

    // 3. Reclaim with explicit process_identity in args (containing raw nonce):
    // Hashes nonce into nonce_sha256 and never exposes raw nonce
    const rawNonce = crypto.randomBytes(32).toString('hex');
    const expectedHash = crypto.createHash('sha256').update(rawNonce).digest('hex');

    const reclaimWithArgs = await executeTeamApiOperation('reclaim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'one',
      force: true,
      expected_generation: 2,
      process_identity: {
        pid: 67890,
        start_identity: 'darwin:custom-start-id',
        nonce: rawNonce,
        start_identity_proven: true,
      },
    }, root, {
      isSupervisor: true,
      processRuntime: makeMockProcessRuntime({
        alivePids: new Set([67890]), // Prior worker 12345 is dead; new worker 67890 is active
        startTimes: new Map([[12345, 'worker-pane-start-12345'], [67890, 'custom-start-id']]),
      }),
    });
    expect(reclaimWithArgs.ok).toBe(true);

    const taskReclaimed = await readTask(root, teamName, '1');
    expect(taskReclaimed?.claim?.worker_process_identity).toEqual({
      pid: 67890,
      start_identity: 'darwin:custom-start-id',
      start_identity_proven: true,
      nonce_sha256: expectedHash,
    });
    // Verify raw nonce is not saved
    expect((taskReclaimed?.claim?.worker_process_identity as Record<string, unknown>).nonce).toBeUndefined();
  });

  it('rejects unprivileged caller attempting to override supervisor manifest with spoofed process_identity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-spoof-guard-'));
    roots.push(dir);
    const root = projectStateRoot(dir);
    const teamName = 'spoof-guard-team';
    initializeTeamState(root, {
      teamName,
      task: 'anti-spoof test',
      workers: [
        { name: 'worker-1', owned_paths: ['src/w1'] },
      ],
    });

    const store = new TeamManifestStore(root);
    store.write({
      schema_version: 2,
      team_id: teamName,
      capability_tier: 'experimental-local',
      native_cursor_team: false,
      tmux_session: `omcu-${teamName}`,
      workers: [
        {
          id: 'worker-1',
          role: 'worker',
          cwd: dir,
          owned_paths: ['src/w1'],
          pane_target: '%1',
          pane_pid: 11111,
          pane_start_identity: 'darwin:start-11111',
          pane_start_identity_proven: true,
          process_group_id: 11111,
          argv: ['omcu', 'worker'],
        },
      ],
      created_at: '2026-07-31T00:00:00.000Z',
      stopping_at: null,
      stopping_worker_ids: null,
      stopped_at: null,
    });

    await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'Task 1',
      description: 'Desc 1',
    }, root);

    // Unprivileged worker tries to claim task supplying PID 99999 (attempting to bind to another process)
    const spoofClaim = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'worker-1',
      process_identity: {
        pid: 99999,
        start_identity: 'darwin:start-99999',
        start_identity_proven: true,
      },
    }, root, {
      processRuntime: makeMockProcessRuntime({
        alivePids: new Set([11111, 99999]),
        startTimes: new Map([[11111, 'start-11111'], [99999, 'start-99999']]),
      }),
    });

    // Spoofed PID is rejected; worker_process_identity_required returned
    expect(spoofClaim.ok).toBe(false);
    expect((spoofClaim as { error?: { code: string } }).error?.code).toBe('worker_process_identity_required');
  });

  it('rejects caller-supplied process_identity when candidate process is dead or stale', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-dead-proc-'));
    roots.push(dir);
    const root = projectStateRoot(dir);
    const teamName = 'dead-proc-team';
    initializeTeamState(root, {
      teamName,
      task: 'dead proc test',
      workers: [
        { name: 'worker-1', owned_paths: ['src/w1'] },
      ],
    });

    await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'Task 1',
      description: 'Desc 1',
    }, root);

    // Caller provides dead process PID 54321
    const deadClaim = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'worker-1',
      process_identity: {
        pid: 54321,
        start_identity: 'darwin:start-54321',
        start_identity_proven: true,
      },
    }, root, {
      processRuntime: makeMockProcessRuntime({
        alivePids: new Set([]), // 54321 is dead
      }),
    });

    expect(deadClaim.ok).toBe(false);
    expect((deadClaim as { error?: { code: string } }).error?.code).toBe('worker_process_identity_required');
  });

  it('rejects claim-task in tmux-supervised team before worker identity is published in manifest', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-tmux-team-'));
    roots.push(dir);
    const root = projectStateRoot(dir);
    const teamName = 'tmux-guard-team';
    initializeTeamState(root, {
      teamName,
      task: 'tmux guard test',
      tmuxSession: 'omcu-tmux-guard-team',
      workers: [
        { name: 'worker-a', owned_paths: ['src/a'] },
        { name: 'worker-b', owned_paths: ['src/b'] },
      ],
    });

    await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'Guarded Task',
      description: 'Must have process identity',
    }, root);

    // 1. Without manifest published, claim must fail closed
    const claimEarly = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'worker-a',
    }, root);
    expect(claimEarly.ok).toBe(false);
    expect((claimEarly as { error?: { code: string } }).error?.code).toBe('worker_process_identity_required');

    // 2. Supervisor publishes manifest with worker identities
    const store = new TeamManifestStore(root);
    store.write({
      schema_version: 2,
      team_id: teamName,
      capability_tier: 'experimental-local',
      native_cursor_team: false,
      tmux_session: 'omcu-tmux-guard-team',
      workers: [
        {
          id: 'worker-a',
          role: 'worker',
          cwd: dir,
          owned_paths: ['src/a'],
          pane_target: '%1',
          pane_pid: 24680,
          pane_start_identity: 'darwin:start-pane-24680',
          pane_start_identity_proven: true,
          process_group_id: 24680,
          argv: ['omcu', 'worker'],
        },
      ],
      created_at: '2026-07-31T00:00:00.000Z',
      stopping_at: null,
      stopping_worker_ids: null,
      stopped_at: null,
    });

    // 3. Now claim succeeds and carries worker process identity
    const claimAfter = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'worker-a',
    }, root, {
      processRuntime: makeMockProcessRuntime({
        alivePids: new Set([24680]),
        startTimes: new Map([[24680, 'start-pane-24680']]),
      }),
    });
    expect(claimAfter.ok).toBe(true);
    const task = await readTask(root, teamName, '1');
    expect(task?.claim?.worker_process_identity).toEqual({
      pid: 24680,
      start_identity: 'darwin:start-pane-24680',
      start_identity_proven: true,
    });

    // 4. Dead worker identity is rejected
    await executeTeamApiOperation('release-task-claim', {
      team_name: teamName,
      task_id: '1',
      claim_token: (claimAfter.data as { claimToken: string }).claimToken,
      worker: 'worker-a',
    }, root);

    const claimDead = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'worker-a',
    }, root, {
      processRuntime: makeMockProcessRuntime({
        alivePids: new Set(),
      }),
    });
    expect(claimDead.ok).toBe(false);
    expect((claimDead as { error?: { code: string } }).error?.code).toBe('worker_process_identity_required');

    // 5. Stopped team is rejected
    store.write({
      ...store.read(teamName),
      stopping_at: '2026-07-31T00:59:00.000Z',
      stopping_worker_ids: ['worker-a'],
      stopped_at: '2026-07-31T01:00:00.000Z',
    });
    const claimStopped = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'worker-a',
    }, root, {
      processRuntime: makeMockProcessRuntime({
        alivePids: new Set([24680]),
        startTimes: new Map([[24680, 'start-pane-24680']]),
      }),
    });
    expect(claimStopped.ok).toBe(false);
    expect((claimStopped as { error?: { code: string } }).error?.code).toBe('worker_process_identity_required');

    // 6. Stopping team (stopping_at set, stopped_at null) is also rejected
    store.write({
      ...store.read(teamName),
      stopping_at: '2026-07-31T00:59:00.000Z',
      stopping_worker_ids: ['worker-a'],
      stopped_at: null,
    });
    const claimStopping = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'worker-a',
    }, root, {
      processRuntime: makeMockProcessRuntime({
        alivePids: new Set([24680]),
        startTimes: new Map([[24680, 'start-pane-24680']]),
      }),
    });
    expect(claimStopping.ok).toBe(false);
    expect((claimStopping as { error?: { code: string } }).error?.code).toBe('worker_process_identity_required');
  });

  it('rejects reopen-task via CLI without --supervisor flag and succeeds with --supervisor', async () => {
    const { dir, root, teamName } = workspace();
    await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'CLI Reopen',
      description: 'Check flag',
    }, root);
    const claim = await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'one',
    }, root);
    expect(claim.ok).toBe(true);
    const token = (claim.data as { claimToken: string }).claimToken;
    await executeTeamApiOperation('transition-task-status', {
      team_name: teamName,
      task_id: '1',
      from: 'in_progress',
      to: 'completed',
      claim_token: token,
      result: 'done',
    }, root);

    const stdout1: string[] = [];
    const stderr1: string[] = [];
    const exitWithout = await runCli([
      'team', 'api', 'reopen-task',
      '--input', JSON.stringify({ team_name: teamName, task_id: '1', reason: 'reopen without flag' }),
    ], { cwd: dir, packageRoot: path.resolve('.') }, {
      stdout: (text) => stdout1.push(text),
      stderr: (text) => stderr1.push(text),
    });
    expect(exitWithout).toBe(1);
    expect(stdout1.join('')).toContain('unauthorized');

    const stdout2: string[] = [];
    const stderr2: string[] = [];
    const exitWith = await runCli([
      'team', 'api', 'reopen-task',
      '--input', JSON.stringify({ team_name: teamName, task_id: '1', reason: 'reopen with flag' }),
      '--supervisor',
    ], { cwd: dir, packageRoot: path.resolve('.') }, {
      stdout: (text) => stdout2.push(text),
      stderr: (text) => stderr2.push(text),
    });
    expect(exitWith).toBe(0);
    const task = await readTask(root, teamName, '1');
    expect(task?.status).toBe('pending');
  });

  it('validates expected_generation on forced reclaim via team API', async () => {
    const { root, teamName } = workspace();
    await executeTeamApiOperation('create-task', {
      team_name: teamName,
      subject: 'Task 1',
      description: 'Desc',
    }, root);
    await executeTeamApiOperation('claim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'one',
    }, root);

    // 1. Force reclaim without expected_generation or expected_version returns invalid_input
    const noExp = await executeTeamApiOperation('reclaim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'two',
      force: true,
    }, root, { isSupervisor: true });
    expect(noExp.ok).toBe(false);
    if (!noExp.ok) {
      expect(noExp.error.code).toBe('invalid_input');
      expect(noExp.error.message).toContain('Forced reclaim requires expected_generation or expected_version');
    }

    // 2. Force reclaim with mismatched expected_generation returns generation_mismatch
    const mismatch = await executeTeamApiOperation('reclaim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'two',
      force: true,
      expected_generation: 99,
    }, root, { isSupervisor: true });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error.code).toBe('generation_mismatch');
    }

    // 3. Force reclaim with matching expected_generation succeeds
    const match = await executeTeamApiOperation('reclaim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'two',
      force: true,
      expected_generation: 1,
    }, root, { isSupervisor: true });
    expect(match.ok).toBe(true);
    if (!match.ok) return;
    expect(match.data.previousGeneration).toBe(1);
    expect(match.data.newGeneration).toBe(2);
  });

  it('rejects malformed reclaim generation and version fences during preflight and execution', async () => {
    const { root, teamName } = workspace('reclaim-fence-validation');

    expect(() => validateTeamApiOperationInput('reclaim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'two',
      expected_generation: '1' as unknown as number,
    })).toThrow('E_TEAM_API_INPUT_INVALID: expected_generation must be a positive integer');

    expect(() => validateTeamApiOperationInput('reclaim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'two',
      expected_generation: 0,
    })).toThrow('E_TEAM_API_INPUT_INVALID: expected_generation must be a positive integer');

    expect(() => validateTeamApiOperationInput('reclaim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'two',
      expected_generation: 1e100,
    })).toThrow('E_TEAM_API_INPUT_INVALID: expected_generation must be a positive integer');

    expect(() => validateTeamApiOperationInput('reclaim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'two',
      generation: '1' as unknown as number,
    })).toThrow('E_TEAM_API_INPUT_INVALID: generation must be a positive integer');

    expect(() => validateTeamApiOperationInput('reclaim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'two',
      expected_version: '1' as unknown as number,
    })).toThrow('E_TEAM_API_INPUT_INVALID: expected_version must be a positive integer');

    const execResult = await executeTeamApiOperation('reclaim-task', {
      team_name: teamName,
      task_id: '1',
      worker: 'two',
      expected_generation: '1' as unknown as number,
    }, root);
    expect(execResult.ok).toBe(false);
    if (!execResult.ok) {
      expect(execResult.error.code).toBe('invalid_input');
      expect(execResult.error.message).toContain('expected_generation must be a positive integer');
    }
  });

  it('rejects malformed process_identity in claim-task and reclaim-task preflight', () => {
    for (const op of ['claim-task', 'reclaim-task'] as const) {
      const base = { team_name: 'team-a', task_id: '1', worker: 'worker-1' };

      expect(() => validateTeamApiOperationInput(op, { ...base, process_identity: 'not-an-object' }))
        .toThrow('E_TEAM_API_INPUT_INVALID: process_identity must be an object');
      expect(() => validateTeamApiOperationInput(op, { ...base, process_identity: null }))
        .toThrow('E_TEAM_API_INPUT_INVALID: process_identity must be an object');
      expect(() => validateTeamApiOperationInput(op, { ...base, process_identity: [] }))
        .toThrow('E_TEAM_API_INPUT_INVALID: process_identity must be an object');

      expect(() => validateTeamApiOperationInput(op, { ...base, process_identity: { pid: -1, start_identity: 'start' } }))
        .toThrow('E_TEAM_API_INPUT_INVALID: process_identity.pid must be a positive integer');
      expect(() => validateTeamApiOperationInput(op, { ...base, process_identity: { pid: 0, start_identity: 'start' } }))
        .toThrow('E_TEAM_API_INPUT_INVALID: process_identity.pid must be a positive integer');
      expect(() => validateTeamApiOperationInput(op, { ...base, process_identity: { pid: 1.5, start_identity: 'start' } }))
        .toThrow('E_TEAM_API_INPUT_INVALID: process_identity.pid must be a positive integer');

      expect(() => validateTeamApiOperationInput(op, { ...base, process_identity: { pid: 100, start_identity: '' } }))
        .toThrow('E_TEAM_API_INPUT_INVALID: process_identity.start_identity must be a non-empty string');
      expect(() => validateTeamApiOperationInput(op, { ...base, process_identity: { pid: 100, start_identity: '  ' } }))
        .toThrow('E_TEAM_API_INPUT_INVALID: process_identity.start_identity must be a non-empty string');

      expect(() => validateTeamApiOperationInput(op, { ...base, process_identity: { pid: 100, start_identity: 'start', start_identity_proven: 'yes' } }))
        .toThrow('E_TEAM_API_INPUT_INVALID: process_identity.start_identity_proven must be a boolean');

      expect(() => validateTeamApiOperationInput(op, { ...base, process_identity: { pid: 100, start_identity: 'start', nonce: '' } }))
        .toThrow('E_TEAM_API_INPUT_INVALID: process_identity.nonce must be a non-empty string');

      expect(() => validateTeamApiOperationInput(op, { ...base, process_identity: { pid: 100, start_identity: 'start', nonce_sha256: 'invalid-hex' } }))
        .toThrow('E_TEAM_API_INPUT_INVALID: process_identity.nonce_sha256 must be a 64-character hex string');
    }
  });

  it('rejects oversized task payload during create-task preflight', () => {
    expect(() => validateTeamApiOperationInput('create-task', {
      team_name: 'team-a',
      subject: 'Large Task',
      description: 'x'.repeat(61 * 1024),
    })).toThrow('E_TEAM_API_INPUT_INVALID: task subject and description must not exceed 60 KiB combined');
  });
});
