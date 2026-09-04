import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectStateRoot } from '../../src/runtime/state-root.js';
import { ExperimentalTmuxTeamSupervisor, TeamManifestStore, type TeamManifest, type TeamManifestRepository } from '../../src/team/index.js';
import { listMailboxMessages, sendDirectMessage, markMessageDelivered } from '../../src/team/mailbox.js';
import { initializeTeamState } from '../../src/team/state-root.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-team-'));
  roots.push(workspace);
  let nextPid = 4000;
  let nextPane = 1;
  let sessionAlive = true;
  const panePids = new Map<string, number>();
  const deadPanes = new Set<string>();
  const aliveGroups = new Set<number>();
  const groupProbes: number[] = [];
  const startIdentities = new Map<number, string>();
  const commands: string[][] = [];
  const runner = async (_executable: string, argv: readonly string[]) => {
    commands.push([...argv]);
    if (argv[0] === 'new-session' || argv[0] === 'new-window') { sessionAlive = true; return { code: 0, stdout: `%${nextPane++}\n`, stderr: '' }; }
    if (argv[0] === 'display-message') {
      const target = argv[argv.indexOf('-t') + 1]!;
      let pid = panePids.get(target);
      if (pid === undefined) { pid = nextPid++; panePids.set(target, pid); aliveGroups.add(pid); startIdentities.set(pid, `start-${pid}`); }
      return { code: 0, stdout: argv.at(-1)?.includes('pane_dead') ? `${pid} ${deadPanes.has(target) ? 1 : 0}\n` : `${pid}\n`, stderr: '' };
    }
    if (argv[0] === '-o' && argv[1] === 'pgid=') return { code: 0, stdout: `${argv.at(-1)}\n`, stderr: '' };
    if (argv[0] === 'capture-pane') return { code: 0, stdout: `output:${argv.at(-1)}`, stderr: '' };
    if (argv[0] === 'kill-session') { sessionAlive = false; return { code: 0, stdout: '', stderr: '' }; }
    if (argv[0] === 'has-session') return { code: sessionAlive ? 0 : 1, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const identityObserver = (pid: number) => ({ value: startIdentities.get(pid) ?? `missing-${pid}`, proven: startIdentities.has(pid), source: startIdentities.has(pid) ? 'linux-proc' as const : 'unavailable' as const });
  const groupProbe = (pgid: number) => {
    groupProbes.push(pgid);
    if (aliveGroups.has(pgid)) return;
    const error = new Error('process group absent') as NodeJS.ErrnoException;
    error.code = 'ESRCH';
    throw error;
  };
  return { workspace, panePids, deadPanes, aliveGroups, groupProbes, startIdentities, commands, runner, identityObserver, groupProbe };
}

const workers = (cwd: string) => [
  { id: 'one', objective: 'first', cwd, owned_paths: ['src/one'] },
  { id: 'two', objective: 'second', cwd, owned_paths: ['src/two'] },
] as const;

describe('experimental tmux team supervisor', () => {
  it('retains panes for collection and records stopped only after observed exit', async () => {
    const state = fixture();
    const killed: Array<[number, NodeJS.Signals]> = [];
    const supervisor = new ExperimentalTmuxTeamSupervisor(
      new TeamManifestStore(projectStateRoot(state.workspace)),
      state.runner,
      () => new Date('2026-07-23T00:00:00.000Z'),
      (pgid, signal) => { killed.push([pgid, signal]); state.aliveGroups.delete(pgid); },
      async () => undefined,
      null,
      state.identityObserver,
      state.groupProbe,
    );
    const manifest = await supervisor.start('team-1', workers(state.workspace));
    expect(manifest.workers.map((worker) => worker.process_group_id)).toEqual([4000, 4001]);
    expect(state.commands.filter((argv) => argv[0] === 'set-option' && argv.includes('remain-on-exit'))).toHaveLength(2);
    expect((await supervisor.collect('team-1')).verified).toBe(false);
    const stopped = await supervisor.stop('team-1');
    expect(stopped.stopped_at).not.toBeNull();
    expect(killed).toEqual([[4000, 'SIGTERM'], [4001, 'SIGTERM']]);
  });

  it('does not mark stopped when tmux kill fails', async () => {
    const state = fixture();
    const store = new TeamManifestStore(projectStateRoot(state.workspace));
    const baseRunner = state.runner;
    const runner = async (executable: string, argv: readonly string[], cwd: string) => argv[0] === 'kill-session'
      ? { code: 1, stdout: '', stderr: 'denied' }
      : baseRunner(executable, argv, cwd);
    const supervisor = new ExperimentalTmuxTeamSupervisor(store, runner, undefined, (pgid) => state.aliveGroups.delete(pgid), async () => undefined, null, state.identityObserver, state.groupProbe);
    await supervisor.start('team-stop-fails', workers(state.workspace));
    await expect(supervisor.stop('team-stop-fails')).rejects.toThrow('E_TEAM_TMUX_STOP');
    expect(store.read('team-stop-fails').stopped_at).toBeNull();
  });

  it('escalates TERM to KILL and proves groups exited', async () => {
    const state = fixture();
    const signals: NodeJS.Signals[] = [];
    const supervisor = new ExperimentalTmuxTeamSupervisor(
      new TeamManifestStore(projectStateRoot(state.workspace)),
      state.runner,
      undefined,
      (pgid, signal) => { signals.push(signal); if (signal === 'SIGKILL') state.aliveGroups.delete(pgid); },
      async () => undefined,
      null,
      state.identityObserver,
      state.groupProbe,
    );
    await supervisor.start('team-escalate', [workers(state.workspace)[0]]);
    await supervisor.stop('team-escalate');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(state.groupProbes).toContain(4000);
    expect(state.commands.some((argv) => argv.includes('-g'))).toBe(false);
  });

  it('never signals a live PGID after its recorded pane identity is dead', async () => {
    const state = fixture();
    const signals: NodeJS.Signals[] = [];
    const supervisor = new ExperimentalTmuxTeamSupervisor(
      new TeamManifestStore(projectStateRoot(state.workspace)),
      state.runner,
      undefined,
      (_pgid, signal) => { signals.push(signal); },
      async () => undefined,
      null,
      state.identityObserver,
      state.groupProbe,
    );
    const manifest = await supervisor.start('team-stale-pgid', [workers(state.workspace)[0]]);
    state.deadPanes.add(manifest.workers[0]!.pane_target);
    await expect(supervisor.stop('team-stale-pgid')).rejects.toThrow('E_TEAM_STALE_PROCESS_GROUP_UNVERIFIED');
    expect(signals).toEqual([]);
  });

  it('rolls back tmux and worker groups if manifest persistence fails', async () => {
    const state = fixture();
    let saved: TeamManifest | null = null;
    const failing: TeamManifestRepository = {
      exists: () => false,
      read: () => { if (saved === null) throw new Error('missing'); return saved; },
      write: (manifest) => { saved = manifest; throw new Error('disk full'); },
    };
    const killed: number[] = [];
    const supervisor = new ExperimentalTmuxTeamSupervisor(failing, state.runner, undefined, (pgid) => { killed.push(pgid); state.aliveGroups.delete(pgid); }, async () => undefined, null, state.identityObserver, state.groupProbe);
    await expect(supervisor.start('team-write-fails', [workers(state.workspace)[0]])).rejects.toThrow('disk full');
    expect(state.commands.some((argv) => argv[0] === 'kill-session')).toBe(true);
    expect(killed).toEqual([4000]);
  });

  it('converges on retry when the final stopped manifest write fails after successful kill', async () => {
    const state = fixture();
    const backing = new TeamManifestStore(projectStateRoot(state.workspace));
    let writes = 0;
    const flaky: TeamManifestRepository = {
      exists: (id) => backing.exists(id),
      read: (id) => backing.read(id),
      write: (manifest) => {
        writes += 1;
        if (writes === 3) throw new Error('final write crashed');
        backing.write(manifest);
      },
    };
    const supervisor = new ExperimentalTmuxTeamSupervisor(flaky, state.runner, undefined, (pgid) => state.aliveGroups.delete(pgid), async () => undefined, null, state.identityObserver, state.groupProbe);
    await supervisor.start('team-stop-retry', [workers(state.workspace)[0]]);
    await expect(supervisor.stop('team-stop-retry')).rejects.toThrow('final write crashed');
    expect(backing.read('team-stop-retry')).toMatchObject({ stopping_at: expect.any(String), stopped_at: null });
    const stopped = await supervisor.stop('team-stop-retry');
    expect(stopped.stopped_at).not.toBeNull();
    expect(state.commands.filter((argv) => argv[0] === 'kill-session')).toHaveLength(1);
  });

  it('rejects overlapping ownership before starting tmux', async () => {
    const state = fixture();
    let invoked = false;
    const supervisor = new ExperimentalTmuxTeamSupervisor(new TeamManifestStore(projectStateRoot(state.workspace)), async () => { invoked = true; return { code: 0, stdout: '', stderr: '' }; });
    await expect(supervisor.start('team-2', [
      { id: 'one', objective: 'first', cwd: state.workspace, owned_paths: ['src'] },
      { id: 'two', objective: 'second', cwd: state.workspace, owned_paths: ['src/two'] },
    ])).rejects.toThrow('E_TEAM_PATH_CONFLICT');
    expect(invoked).toBe(false);
  });

  it('initializes mailbox and worker inboxes on start when coordination root is provided', async () => {
    const state = fixture();
    const root = projectStateRoot(state.workspace);
    const supervisor = new ExperimentalTmuxTeamSupervisor(
      new TeamManifestStore(root),
      state.runner,
      () => new Date('2026-07-24T12:00:00.000Z'),
      (pgid) => state.aliveGroups.delete(pgid),
      async () => undefined,
      root,
      state.identityObserver,
      state.groupProbe,
    );
    const manifest = await supervisor.start('team-coord', workers(state.workspace));
    expect(manifest.native_cursor_team).toBe(false);
    expect(fs.existsSync(path.join(state.workspace, '.omcu/state/team/team-coord/config.json'))).toBe(true);
    expect(fs.existsSync(path.join(state.workspace, '.omcu/state/team/team-coord/mailbox/one.json'))).toBe(true);
    expect(fs.existsSync(path.join(state.workspace, '.omcu/state/team/team-coord/mailbox/leader-fixed.json'))).toBe(true);
    expect(fs.readFileSync(path.join(state.workspace, '.omcu/state/team/team-coord/workers/one/inbox.md'), 'utf8')).toContain('Never stamp verified');
    expect(JSON.parse(fs.readFileSync(path.join(state.workspace, '.omcu/state/team/team-coord/manifest.v2.json'), 'utf8')).native_cursor_team).toBe(false);
  });

  it('refuses to signal a reused pane PID with a different start identity', async () => {
    const state = fixture();
    const signals: NodeJS.Signals[] = [];
    const supervisor = new ExperimentalTmuxTeamSupervisor(
      new TeamManifestStore(projectStateRoot(state.workspace)),
      state.runner,
      undefined,
      (_pgid, signal) => { signals.push(signal); },
      async () => undefined,
      null,
      state.identityObserver,
      state.groupProbe,
    );
    const manifest = await supervisor.start('team-pid-reuse', [workers(state.workspace)[0]]);
    state.startIdentities.set(manifest.workers[0]!.pane_pid, 'reused-process-start');
    await expect(supervisor.stop('team-pid-reuse')).rejects.toThrow('E_TEAM_PROCESS_IDENTITY_MISMATCH');
    expect(signals).toEqual([]);
  });

  it('signals a verified group when tmux stop removes the pane leader identity but descendants remain', async () => {
    const state = fixture();
    const signals: NodeJS.Signals[] = [];
    const runner = async (executable: string, argv: readonly string[], cwd: string) => {
      const result = await state.runner(executable, argv, cwd);
      if (argv[0] === 'kill-session') state.startIdentities.delete(4000);
      return result;
    };
    const supervisor = new ExperimentalTmuxTeamSupervisor(
      new TeamManifestStore(projectStateRoot(state.workspace)),
      runner,
      undefined,
      (pgid, signal) => { signals.push(signal); state.aliveGroups.delete(pgid); },
      async () => undefined,
      null,
      state.identityObserver,
      state.groupProbe,
    );
    await supervisor.start('team-pid-race', [workers(state.workspace)[0]]);
    await expect(supervisor.stop('team-pid-race')).resolves.toMatchObject({ stopped_at: expect.any(String) });
    expect(signals).toEqual(['SIGTERM']);
    expect(state.groupProbes).toContain(4000);
    expect(state.commands.some((argv) => argv.includes('-g'))).toBe(false);
  });

  it('treats an ESRCH signal-zero probe as an absent group without sending a signal', async () => {
    const state = fixture();
    const signals: NodeJS.Signals[] = [];
    const runner = async (executable: string, argv: readonly string[], cwd: string) => {
      const result = await state.runner(executable, argv, cwd);
      if (argv[0] === 'kill-session') state.aliveGroups.delete(4000);
      return result;
    };
    const supervisor = new ExperimentalTmuxTeamSupervisor(
      new TeamManifestStore(projectStateRoot(state.workspace)),
      runner,
      undefined,
      (_pgid, signal) => { signals.push(signal); },
      async () => undefined,
      null,
      state.identityObserver,
      state.groupProbe,
    );
    await supervisor.start('team-probe-esrch', [workers(state.workspace)[0]]);
    await expect(supervisor.stop('team-probe-esrch')).resolves.toMatchObject({ stopped_at: expect.any(String) });
    expect(signals).toEqual([]);
    expect(state.commands.some((argv) => argv.includes('-g'))).toBe(false);
  });

  it('treats an EPERM signal-zero probe as live and fails closed after termination attempts', async () => {
    const state = fixture();
    const signals: NodeJS.Signals[] = [];
    const deniedProbe = () => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    };
    const supervisor = new ExperimentalTmuxTeamSupervisor(
      new TeamManifestStore(projectStateRoot(state.workspace)),
      state.runner,
      undefined,
      (pgid, signal) => { signals.push(signal); state.aliveGroups.delete(pgid); },
      async () => undefined,
      null,
      state.identityObserver,
      deniedProbe,
    );
    await supervisor.start('team-probe-eperm', [workers(state.workspace)[0]]);
    await expect(supervisor.stop('team-probe-eperm')).rejects.toThrow('E_TEAM_STOP_INCOMPLETE:groups_alive:4000');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('wraps unexpected signal-zero probe errors with the stable liveness error', async () => {
    const state = fixture();
    const failingProbe = () => {
      const error = new Error('probe failed') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    };
    const supervisor = new ExperimentalTmuxTeamSupervisor(
      new TeamManifestStore(projectStateRoot(state.workspace)),
      state.runner,
      undefined,
      () => undefined,
      async () => undefined,
      null,
      state.identityObserver,
      failingProbe,
    );
    await supervisor.start('team-probe-error', [workers(state.workspace)[0]]);
    await expect(supervisor.stop('team-probe-error')).rejects.toThrow('E_TEAM_LIVENESS_PROBE:EIO');
  });

  it('recomputes TERM survivors and sends KILL only to groups still alive', async () => {
    const state = fixture();
    const signals: Array<[number, NodeJS.Signals]> = [];
    const supervisor = new ExperimentalTmuxTeamSupervisor(
      new TeamManifestStore(projectStateRoot(state.workspace)),
      state.runner,
      undefined,
      (pgid, signal) => {
        signals.push([pgid, signal]);
        if ((signal === 'SIGTERM' && pgid === 4000) || signal === 'SIGKILL') state.aliveGroups.delete(pgid);
      },
      async () => undefined,
      null,
      state.identityObserver,
      state.groupProbe,
    );
    await supervisor.start('team-survivors', workers(state.workspace));
    await supervisor.stop('team-survivors');
    expect(signals).toEqual([[4000, 'SIGTERM'], [4001, 'SIGTERM'], [4001, 'SIGKILL']]);
  });

  it('migrates legacy manifests and rejects absent or corrupt observations with stable errors', async () => {
    const state = fixture();
    const root = projectStateRoot(state.workspace);
    const store = new TeamManifestStore(root);
    expect(() => store.read('missing-team')).toThrow(/^E_TEAM_MANIFEST_ABSENT$/);
    const file = path.join(state.workspace, '.omcu', 'teams', 'legacy-team', 'manifest.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      schema_version: 1,
      team_id: 'legacy-team',
      tmux_session: 'omcu-legacy-team',
      capability_tier: 'experimental-local',
      native_cursor_team: false,
      workers: [{ id: 'one', cwd: state.workspace, owned_paths: ['src/one'], pane_target: '%1', pane_pid: 4000, process_group_id: 4000, argv: ['--print'] }],
      created_at: '2026-07-23T00:00:00.000Z',
    }));
    expect(store.read('legacy-team')).toMatchObject({
      schema_version: 2,
      stopping_at: null,
      workers: [{ pane_start_identity: 'legacy-unproven:4000', pane_start_identity_proven: false }],
    });
    fs.writeFileSync(file, '{raw-secret');
    expect(() => store.read('legacy-team')).toThrow(/^E_TEAM_MANIFEST_CORRUPT$/);
  });

  it('rejects non-canonical and case-equivalent team owned paths before tmux', async () => {
    const state = fixture();
    let invoked = false;
    const supervisor = new ExperimentalTmuxTeamSupervisor(new TeamManifestStore(projectStateRoot(state.workspace)), async () => { invoked = true; return { code: 0, stdout: '', stderr: '' }; });
    await expect(supervisor.start('team-invalid-dot', [
      { id: 'one', objective: 'first', cwd: state.workspace, owned_paths: ['./src'] },
    ])).rejects.toThrow('E_TEAM_PATH_INVALID');
    await expect(supervisor.start('team-invalid-slash', [
      { id: 'one', objective: 'first', cwd: state.workspace, owned_paths: ['src/'] },
    ])).rejects.toThrow('E_TEAM_PATH_INVALID');
    await expect(supervisor.start('team-invalid-backslash', [
      { id: 'one', objective: 'first', cwd: state.workspace, owned_paths: ['src\\a'] },
    ])).rejects.toThrow('E_TEAM_PATH_INVALID');
    await expect(supervisor.start('team-equiv-paths', [
      { id: 'one', objective: 'first', cwd: state.workspace, owned_paths: ['src/a'] },
      { id: 'two', objective: 'second', cwd: state.workspace, owned_paths: ['src/./a'] },
    ])).rejects.toThrow(/E_TEAM_PATH_(INVALID|CONFLICT)/);
    expect(invoked).toBe(false);
  });

  it('prefers authoritative mailbox journal over corrupt legacy JSON file', async () => {
    const state = fixture();
    const root = projectStateRoot(state.workspace);
    const teamName = 'mailbox-corrupt-legacy-team';

    // Set up team config with worker-1 and worker-2
    initializeTeamState(root, {
      teamName,
      task: 'test mailbox resilience',
      workers: [
        { name: 'worker-1', owned_paths: ['src/w1'] },
        { name: 'worker-2', owned_paths: ['src/w2'] },
      ],
    });

    // Send a message using the journal
    const msg = await sendDirectMessage(root, teamName, 'worker-1', 'worker-2', 'hello from worker 1');
    expect(msg.body).toBe('hello from worker 1');

    // Corrupt the legacy JSON mailbox file if present, or create a corrupt one
    const legacyFile = path.join(state.workspace, '.omcu', 'teams', teamName, 'mailboxes', 'worker-2.json');
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, '{corrupted-legacy-json');

    // listMailboxMessages should still succeed from authoritative journal without failing on legacy corruption
    const messages = await listMailboxMessages(root, teamName, 'worker-2');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe('hello from worker 1');

    // markMessageDelivered should still succeed
    const delivered = await markMessageDelivered(root, teamName, 'worker-2', msg.message_id);
    expect(delivered).toBe(true);

    // Subsequent send should still succeed
    const msg2 = await sendDirectMessage(root, teamName, 'worker-1', 'worker-2', 'second message');
    expect(msg2.body).toBe('second message');

    const updatedMessages = await listMailboxMessages(root, teamName, 'worker-2');
    expect(updatedMessages).toHaveLength(2);
  });
});
