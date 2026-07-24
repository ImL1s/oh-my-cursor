import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectStateRoot } from '../../src/runtime/state-root.js';
import {
  initializeTeamState,
  LEADER_MAILBOX,
  listMailboxMessages,
  markMessageDelivered,
  sendDirectMessage,
  teamConfigPath,
  teamMailboxPath,
  teamManifestV2Path,
  teamWorkerHeartbeatPath,
  teamWorkerInboxPath,
} from '../../src/team/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-mailbox-'));
  roots.push(dir);
  return { dir, root: projectStateRoot(dir) };
}

describe('team coordination state root', () => {
  it('creates OMX-shaped durable layout under .omcu/state/team/<team>/', () => {
    const { dir, root } = workspace();
    const config = initializeTeamState(root, {
      teamName: 'alpha',
      task: 'ship mailbox',
      workers: [
        { name: 'one', owned_paths: ['src/one'] },
        { name: 'two', owned_paths: ['src/two'] },
      ],
      createdAt: '2026-07-24T00:00:00.000Z',
      tmuxSession: 'omcu-alpha',
    });

    expect(config.native_cursor_team).toBe(false);
    expect(fs.existsSync(teamConfigPath(root, 'alpha'))).toBe(true);
    expect(fs.existsSync(teamManifestV2Path(root, 'alpha'))).toBe(true);
    expect(fs.existsSync(teamMailboxPath(root, 'alpha', LEADER_MAILBOX))).toBe(true);
    expect(fs.existsSync(teamMailboxPath(root, 'alpha', 'one'))).toBe(true);
    expect(fs.existsSync(teamMailboxPath(root, 'alpha', 'two'))).toBe(true);
    expect(fs.existsSync(teamWorkerInboxPath(root, 'alpha', 'one'))).toBe(true);
    expect(fs.existsSync(teamWorkerHeartbeatPath(root, 'alpha', 'two'))).toBe(true);
    expect(fs.readFileSync(teamWorkerInboxPath(root, 'alpha', 'one'), 'utf8')).toContain('Never stamp verified');
    expect(path.relative(dir, teamConfigPath(root, 'alpha')).replaceAll('\\', '/')).toBe('.omcu/state/team/alpha/config.json');

    const manifest = JSON.parse(fs.readFileSync(teamManifestV2Path(root, 'alpha'), 'utf8')) as { native_cursor_team: boolean };
    expect(manifest.native_cursor_team).toBe(false);
  });
});

describe('team mailbox primitives', () => {
  it('roundtrips send / list / mark-delivered and fails closed on corrupt mailbox', async () => {
    const { root } = workspace();
    initializeTeamState(root, {
      teamName: 'mail',
      task: 'messages',
      workers: [{ name: 'one', owned_paths: ['a'] }, { name: 'two', owned_paths: ['b'] }],
    });

    const message = await sendDirectMessage(root, 'mail', 'one', 'two', 'hello');
    expect(message.body).toBe('hello');
    expect(message.delivered_at).toBeUndefined();

    const listed = await listMailboxMessages(root, 'mail', 'two');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.message_id).toBe(message.message_id);

    const updated = await markMessageDelivered(root, 'mail', 'two', message.message_id);
    expect(updated).toBe(true);
    const after = await listMailboxMessages(root, 'mail', 'two', { includeDelivered: false });
    expect(after).toHaveLength(0);
    const all = await listMailboxMessages(root, 'mail', 'two', { includeDelivered: true });
    expect(all[0]?.delivered_at).toBeTruthy();

    // dedupe undelivered identical body
    const again = await sendDirectMessage(root, 'mail', 'one', 'two', 'next');
    const dup = await sendDirectMessage(root, 'mail', 'one', 'two', 'next');
    expect(dup.message_id).toBe(again.message_id);

    fs.writeFileSync(teamMailboxPath(root, 'mail', 'two'), '{not-json', 'utf8');
    await expect(listMailboxMessages(root, 'mail', 'two')).rejects.toThrow('E_TEAM_MAILBOX_CORRUPT');

    fs.writeFileSync(
      teamMailboxPath(root, 'mail', 'one'),
      JSON.stringify({ worker: 'one', messages: [{}] }),
      'utf8',
    );
    await expect(listMailboxMessages(root, 'mail', 'one')).rejects.toThrow('E_TEAM_MAILBOX_CORRUPT');

    await expect(sendDirectMessage(root, 'mail', 'ghost', 'two', 'nope')).rejects.toThrow('E_TEAM_WORKER_NOT_FOUND');
  });
});
