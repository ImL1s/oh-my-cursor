import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectStateRoot } from '../../src/runtime/state-root.js';
import {
  executeTeamApiOperation,
  initializeTeamState,
  resolveTeamApiOperation,
  TEAM_API_OPERATIONS,
  teamWorkerInboxPath,
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
      'transition-task-status',
      'release-task-claim',
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
    }, root);
    expect(inbox.ok).toBe(true);
    expect(fs.readFileSync(teamWorkerInboxPath(root, teamName, 'two'), 'utf8')).toContain('next assignment');

    const listedTasks = await executeTeamApiOperation('list-tasks', { team_name: teamName }, root);
    expect(listedTasks.ok).toBe(true);
    if (!listedTasks.ok) return;
    expect(listedTasks.data.count).toBe(1);
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
});
