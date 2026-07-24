import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectStateRoot } from '../../src/runtime/state-root.js';
import { ExperimentalTmuxTeamSupervisor, TeamManifestStore, type TeamManifest, type TeamManifestRepository } from '../../src/team/index.js';

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
  const commands: string[][] = [];
  const runner = async (_executable: string, argv: readonly string[]) => {
    commands.push([...argv]);
    if (argv[0] === 'new-session' || argv[0] === 'new-window') { sessionAlive = true; return { code: 0, stdout: `%${nextPane++}\n`, stderr: '' }; }
    if (argv[0] === 'display-message') {
      const target = argv[argv.indexOf('-t') + 1]!;
      let pid = panePids.get(target);
      if (pid === undefined) { pid = nextPid++; panePids.set(target, pid); aliveGroups.add(pid); }
      return { code: 0, stdout: argv.at(-1)?.includes('pane_dead') ? `${pid} ${deadPanes.has(target) ? 1 : 0}\n` : `${pid}\n`, stderr: '' };
    }
    if (argv[0] === '-o' && argv[1] === 'pgid=') return { code: 0, stdout: `${argv.at(-1)}\n`, stderr: '' };
    if (argv[0] === '-o' && argv[1] === 'pid=') {
      const pgid = Number(argv.at(-1));
      return { code: aliveGroups.has(pgid) ? 0 : 1, stdout: aliveGroups.has(pgid) ? `${pgid}\n` : '', stderr: '' };
    }
    if (argv[0] === 'capture-pane') return { code: 0, stdout: `output:${argv.at(-1)}`, stderr: '' };
    if (argv[0] === 'kill-session') { sessionAlive = false; return { code: 0, stdout: '', stderr: '' }; }
    if (argv[0] === 'has-session') return { code: sessionAlive ? 0 : 1, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { workspace, panePids, deadPanes, aliveGroups, commands, runner };
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
    const supervisor = new ExperimentalTmuxTeamSupervisor(store, runner, undefined, (pgid) => state.aliveGroups.delete(pgid), async () => undefined);
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
    );
    await supervisor.start('team-escalate', [workers(state.workspace)[0]]);
    await supervisor.stop('team-escalate');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
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
    const supervisor = new ExperimentalTmuxTeamSupervisor(failing, state.runner, undefined, (pgid) => { killed.push(pgid); state.aliveGroups.delete(pgid); }, async () => undefined);
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
    const supervisor = new ExperimentalTmuxTeamSupervisor(flaky, state.runner, undefined, (pgid) => state.aliveGroups.delete(pgid), async () => undefined);
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
    );
    const manifest = await supervisor.start('team-coord', workers(state.workspace));
    expect(manifest.native_cursor_team).toBe(false);
    expect(fs.existsSync(path.join(state.workspace, '.omcu/state/team/team-coord/config.json'))).toBe(true);
    expect(fs.existsSync(path.join(state.workspace, '.omcu/state/team/team-coord/mailbox/one.json'))).toBe(true);
    expect(fs.existsSync(path.join(state.workspace, '.omcu/state/team/team-coord/mailbox/leader-fixed.json'))).toBe(true);
    expect(fs.readFileSync(path.join(state.workspace, '.omcu/state/team/team-coord/workers/one/inbox.md'), 'utf8')).toContain('Never stamp verified');
    expect(JSON.parse(fs.readFileSync(path.join(state.workspace, '.omcu/state/team/team-coord/manifest.v2.json'), 'utf8')).native_cursor_team).toBe(false);
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
});
