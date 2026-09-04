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
  teamStateDir,
  teamWorkerHeartbeatPath,
  teamWorkerInboxPath,
  teamExists,
  writeWorkerInboxFile,
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
    expect(fs.readFileSync(teamWorkerInboxPath(root, 'alpha', 'one'), 'utf8')).toMatch(/\n$/);
    expect(fs.readdirSync(path.dirname(teamWorkerInboxPath(root, 'alpha', 'one')))
      .filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect(path.relative(dir, teamConfigPath(root, 'alpha')).replaceAll('\\', '/')).toBe('.omcu/state/team/alpha/config.json');

    const manifest = JSON.parse(fs.readFileSync(teamManifestV2Path(root, 'alpha'), 'utf8')) as { native_cursor_team: boolean };
    expect(manifest.native_cursor_team).toBe(false);
  });

  it('rolls back last-file and pre-publish failures, then retries cleanly', () => {
    const { root } = workspace();
    const input = {
      teamName: 'retry', task: 'transaction',
      workers: [{ name: 'one', owned_paths: ['a'] }],
      createdAt: '2026-07-31T00:00:00.000Z',
    } as const;
    expect(() => initializeTeamState(root, input, {
      faultInjector: (point) => { if (point === 'before_manifest') throw new Error('E_TEST_LAST_MANIFEST'); },
    })).toThrow('E_TEST_LAST_MANIFEST');
    expect(teamExists(root, 'retry')).toBe(false);
    expect(() => initializeTeamState(root, input, {
      publishOptions: { helperFaults: ['directory_publish'] },
    })).toThrowError(expect.objectContaining({ phase: 'not_committed' }));
    expect(teamExists(root, 'retry')).toBe(false);
    expect(initializeTeamState(root, input).name).toBe('retry');
    expect(fs.readdirSync(path.dirname(teamStateDir(root, 'retry')))
      .filter((name) => name.startsWith('.retry.init-'))).toEqual([]);
  });

  it('removes an unmarked stage when the marker write fails without masking the primary error', () => {
    const { root } = workspace();
    const input = {
      teamName: 'bootstrap', task: 'marker failure',
      workers: [{ name: 'one', owned_paths: ['a'] }],
    } as const;
    let captured: unknown;
    try {
      initializeTeamState(root, input, { markerWriteOptions: { helperFaults: ['write'] } });
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({
      phase: 'not_committed',
      causeError: expect.objectContaining({ message: expect.stringContaining('FAULT_WRITE') }),
    });
    expect(teamExists(root, 'bootstrap')).toBe(false);
    expect(fs.readdirSync(path.dirname(teamStateDir(root, 'bootstrap')))
      .filter((name) => name.startsWith('.bootstrap.init-'))).toEqual([]);
  });

  it('keeps the marker-write error primary when bootstrap cleanup must fail closed', () => {
    const { root } = workspace();
    const parent = path.dirname(teamStateDir(root, 'bootstrap-dual'));
    let captured: unknown;
    try {
      initializeTeamState(root, {
        teamName: 'bootstrap-dual', task: 'dual failure',
        workers: [{ name: 'one', owned_paths: ['a'] }],
      }, {
        markerWriteOptions: {
          faultInjector: (point) => {
            if (point !== 'write') return;
            const stageName = fs.readdirSync(parent).find((name) => name.startsWith('.bootstrap-dual.init-'));
            if (stageName !== undefined) fs.writeFileSync(path.join(parent, stageName, '.omcu-stage.json'), '{}\n');
            throw new Error('E_TEST_MARKER_PRIMARY');
          },
        },
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({
      phase: 'not_committed',
      causeError: expect.objectContaining({ message: 'E_TEST_MARKER_PRIMARY' }),
      cleanupError: expect.objectContaining({ message: expect.stringContaining('STAGE_MARKER_PUBLISHED') }),
    });
    expect(fs.readdirSync(parent).some((name) => name.startsWith('.bootstrap-dual.init-'))).toBe(true);
  });

  it('adopts a complete publish after the publishing helper crashes before response', () => {
    const { root } = workspace();
    const config = initializeTeamState(root, {
      teamName: 'adopt', task: 'publish crash',
      workers: [{ name: 'one', owned_paths: ['a'] }],
    }, { publishOptions: { helperFaults: ['after_commit_crash'] } });
    expect(config.name).toBe('adopt');
    expect(teamExists(root, 'adopt')).toBe(true);
    expect(initializeTeamState(root, {
      teamName: 'adopt', task: 'publish crash',
      workers: [{ name: 'one', owned_paths: ['a'] }],
    }).name).toBe('adopt');
  });

  it.each([
    ['manifest worker order', (root: ReturnType<typeof projectStateRoot>) => {
      fs.writeFileSync(teamManifestV2Path(root, 'strict'), JSON.stringify({
        schema_version: 2,
        team_id: 'strict',
        capability_tier: 'experimental-local',
        native_cursor_team: false,
        workers: ['two', 'one'],
        created_at: '2026-07-31T00:00:00.000Z',
      }));
    }],
    ['dispatch schema', (root: ReturnType<typeof projectStateRoot>) => {
      fs.writeFileSync(path.join(teamStateDir(root, 'strict'), 'dispatch', 'requests.json'), '{}');
    }],
    ['task state', (root: ReturnType<typeof projectStateRoot>) => {
      const tasks = path.join(teamStateDir(root, 'strict'), 'tasks');
      fs.mkdirSync(tasks);
      fs.writeFileSync(path.join(tasks, 'task-1.json'), '{}');
    }],
    ['mailbox identity', (root: ReturnType<typeof projectStateRoot>) => {
      fs.writeFileSync(teamMailboxPath(root, 'strict', 'one'), JSON.stringify({ worker: 'two', messages: [] }));
    }],
    ['heartbeat identity', (root: ReturnType<typeof projectStateRoot>) => {
      fs.writeFileSync(teamWorkerHeartbeatPath(root, 'strict', 'one'), JSON.stringify({
        schema_version: 1, worker: 'two', alive: false, pid: null, turn_count: 0,
        updated_at: '2026-07-31T00:00:00.000Z',
      }));
    }],
    ['inbox content', (root: ReturnType<typeof projectStateRoot>) => {
      fs.writeFileSync(teamWorkerInboxPath(root, 'strict', 'one'), 'wrong\n');
    }],
  ] as const)('rejects incomplete durability adoption with invalid %s', (_label, mutate) => {
    const { root } = workspace();
    const input = {
      teamName: 'strict',
      task: 'exact adoption',
      workers: [
        { name: 'one', role: 'executor', owned_paths: ['a', 'b'] },
        { name: 'two', role: 'reviewer', owned_paths: ['c'] },
      ],
      createdAt: '2026-07-31T00:00:00.000Z',
      tmuxSession: 'omcu-strict',
    } as const;
    initializeTeamState(root, input);
    mutate(root);
    expect(() => initializeTeamState(root, input)).toThrow('E_TEAM_STATE_INCOMPLETE');
  });

  it('requires exact ordered worker input when adopting an existing publish', () => {
    const { root } = workspace();
    initializeTeamState(root, {
      teamName: 'worker-exact', task: 'same',
      workers: [{ name: 'one', role: 'executor', owned_paths: ['a', 'b'] }],
    });
    expect(() => initializeTeamState(root, {
      teamName: 'worker-exact', task: 'same',
      workers: [{ name: 'one', role: 'executor', owned_paths: ['b', 'a'] }],
    })).toThrow('E_TEAM_STATE_INCOMPLETE');
  });

  it('does not adopt an existing publish with a different explicit creation time', () => {
    const { root } = workspace();
    const base = {
      teamName: 'created-at-exact', task: 'same',
      workers: [{ name: 'one', role: 'executor', owned_paths: ['a'] }],
    } as const;
    initializeTeamState(root, { ...base, createdAt: '2026-07-31T00:00:00.000Z' });
    expect(() => initializeTeamState(root, {
      ...base, createdAt: '2026-07-31T00:00:01.000Z',
    })).toThrow('E_TEAM_STATE_INCOMPLETE');
  });
});

describe('team worker inbox atomic publication', () => {
  it('cleans a failed rename without deterministic temp debris', () => {
    const { root } = workspace();
    initializeTeamState(root, {
      teamName: 'fault',
      task: 'atomic inbox',
      workers: [{ name: 'one', owned_paths: ['a'] }],
    });
    const inbox = teamWorkerInboxPath(root, 'fault', 'one');
    expect(() => writeWorkerInboxFile(root, 'fault', 'one', 'replacement', {
      helperFaults: ['rename'],
    })).toThrowError(expect.objectContaining({ phase: 'not_committed' }));
    expect(fs.readFileSync(inbox, 'utf8')).not.toContain('replacement');
    expect(fs.readdirSync(path.dirname(inbox)).filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect(fs.existsSync(`${inbox}.tmp-${process.pid}`)).toBe(false);
  });

  it('does not redirect an inbox commit when its validated parent is swapped', () => {
    const { root } = workspace();
    initializeTeamState(root, {
      teamName: 'swap',
      task: 'confined inbox',
      workers: [{ name: 'one', owned_paths: ['a'] }],
    });
    const workerDir = path.dirname(teamWorkerInboxPath(root, 'swap', 'one'));
    const moved = `${workerDir}-original`;
    const outside = `${workerDir}-outside`;
    fs.mkdirSync(outside);
    expect(() => writeWorkerInboxFile(root, 'swap', 'one', 'redirected', {
      faultInjector: (point) => {
        if (point !== 'rename' || fs.existsSync(moved)) return;
        fs.renameSync(workerDir, moved);
        fs.symlinkSync(outside, workerDir, 'dir');
      },
    })).toThrowError(expect.objectContaining({ phase: 'not_committed' }));
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(path.join(moved, 'inbox.md'), 'utf8')).not.toContain('redirected');
    expect(fs.existsSync(path.join(moved, `inbox.md.tmp-${process.pid}`))).toBe(false);
  });
});

describe('team mailbox primitives', () => {
  it.each(['missing directory', 'missing file'] as const)(
    'lists an empty mailbox without mutating an existing team tree when the mailbox has a %s',
    async (missing) => {
      const { root } = workspace();
      initializeTeamState(root, {
        teamName: 'read-only',
        task: 'snapshot reads',
        workers: [{ name: 'one', owned_paths: ['a'] }],
      });

      const mailbox = teamMailboxPath(root, 'read-only', 'one');
      const mailboxDir = path.dirname(mailbox);
      const observedParent = missing === 'missing directory' ? teamStateDir(root, 'read-only') : mailboxDir;
      if (missing === 'missing directory') fs.rmSync(mailboxDir, { recursive: true });
      else fs.rmSync(mailbox);
      const entriesBefore = fs.readdirSync(observedParent);
      const mtimeBefore = fs.statSync(observedParent).mtimeMs;

      await expect(listMailboxMessages(root, 'read-only', 'one')).resolves.toEqual([]);

      expect(fs.readdirSync(observedParent)).toEqual(entriesBefore);
      expect(fs.statSync(observedParent).mtimeMs).toBe(mtimeBefore);
      expect(fs.existsSync(mailbox)).toBe(false);
      if (missing === 'missing directory') expect(fs.existsSync(mailboxDir)).toBe(false);
    },
  );

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

  it('supports sending messages with body near the 64 KiB limit without E_JOURNAL_RECORD_TOO_LARGE', async () => {
    const { root } = workspace();
    initializeTeamState(root, {
      teamName: 'big-mail',
      task: 'messages',
      workers: [{ name: 'one', owned_paths: ['a'] }, { name: 'two', owned_paths: ['b'] }],
    });

    const largeBody = 'x'.repeat(64 * 1024);
    const message = await sendDirectMessage(root, 'big-mail', 'one', 'two', largeBody);
    expect(message.body).toBe(largeBody);

    const messages = await listMailboxMessages(root, 'big-mail', 'two');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe(largeBody);
  });
});
