import { buildPrintArgv } from '../host/cursor-agent.js';
import { assertExclusivePathClaims } from '../modes/path-claims.js';
import type { StateRoot } from '../runtime/state-root.js';
import type { TeamManifestRepository } from './manifest.js';
import { initializeTeamState, removeTeamState, teamExists } from './state-root.js';
import type { ProcessGroupKiller, TeamCollection, TeamCommandRunner, TeamManifest, TeamWorkerManifest, TeamWorkerSpec } from './types.js';

const STOP_POLLS = 5;
const STOP_POLL_MS = 200;

export class ExperimentalTmuxTeamSupervisor {
  constructor(
    private readonly manifests: TeamManifestRepository,
    private readonly runner: TeamCommandRunner,
    private readonly now: () => Date = () => new Date(),
    private readonly killGroup: ProcessGroupKiller = (pgid, signal) => process.kill(-pgid, signal),
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly coordinationRoot: StateRoot | null = null,
  ) {}

  async start(teamId: string, workers: readonly TeamWorkerSpec[]): Promise<TeamManifest> {
    if (this.manifests.exists(teamId)) throw new Error('E_TEAM_EXISTS');
    if (this.coordinationRoot !== null && teamExists(this.coordinationRoot, teamId)) throw new Error('E_TEAM_STATE_EXISTS');
    validateWorkers(workers);
    const session = `omcu-${teamId}`;
    const createdAt = this.now().toISOString();
    let coordinationInitialized = false;
    if (this.coordinationRoot !== null) {
      const inboxContents: Record<string, string> = {};
      for (const worker of workers) {
        inboxContents[worker.id] = [
          `# Worker inbox — ${worker.id}`,
          '',
          `Team: ${teamId}`,
          `Objective: ${worker.objective}`,
          `Owned paths: ${worker.owned_paths.join(', ')}`,
          '',
          'Experimental local tmux coordination (`omcu team`), not a native Cursor team.',
          'Use `omcu team api` for mailbox/tasks. Never stamp verified.',
          '',
        ].join('\n');
      }
      initializeTeamState(this.coordinationRoot, {
        teamName: teamId,
        task: workers.map((worker) => worker.objective).join(' | '),
        workers: workers.map((worker) => ({ name: worker.id, owned_paths: worker.owned_paths })),
        createdAt,
        tmuxSession: session,
        inboxContents,
      });
      coordinationInitialized = true;
    }
    const workerManifests: TeamWorkerManifest[] = [];
    let sessionStarted = false;
    try {
      for (const [index, worker] of workers.entries()) {
        const argv = buildPrintArgv(teamPrompt(worker), { format: 'stream-json', mode: 'ask' });
        const tmuxArgs = index === 0
          ? ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', session, '-n', worker.id, '-c', worker.cwd]
          : ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', session, '-n', worker.id, '-c', worker.cwd];
        const created = await this.runner('tmux', tmuxArgs, worker.cwd);
        if (created.code !== 0) throw new Error(`E_TEAM_TMUX_START:${created.stderr}`);
        sessionStarted = true;
        const paneTarget = created.stdout.trim();
        if (!/^%\d+$/.test(paneTarget)) throw new Error('E_TEAM_PANE_TARGET_UNOBSERVED');
        const retained = await this.runner('tmux', ['set-option', '-p', '-t', paneTarget, 'remain-on-exit', 'on'], worker.cwd);
        if (retained.code !== 0) throw new Error(`E_TEAM_TMUX_RETAIN:${retained.stderr}`);
        const launched = await this.runner('tmux', ['respawn-pane', '-k', '-t', paneTarget, 'cursor-agent', ...argv], worker.cwd);
        if (launched.code !== 0) throw new Error(`E_TEAM_TMUX_LAUNCH:${launched.stderr}`);
        const panePid = await this.observePanePid(paneTarget, worker.cwd);
        const pgid = await this.observeProcessGroup(panePid, worker.cwd);
        workerManifests.push({ id: worker.id, cwd: worker.cwd, owned_paths: [...worker.owned_paths], pane_target: paneTarget, pane_pid: panePid, process_group_id: pgid, argv });
      }
      const manifest: TeamManifest = { schema_version: 1, team_id: teamId, tmux_session: session, capability_tier: 'experimental-local', native_cursor_team: false, workers: workerManifests, created_at: createdAt, stopping_at: null, stopping_worker_ids: null, stopped_at: null };
      this.manifests.write(manifest);
      return manifest;
    } catch (error) {
      if (coordinationInitialized && this.coordinationRoot !== null) {
        try { removeTeamState(this.coordinationRoot, teamId); } catch { /* best-effort rollback */ }
      }
      if (sessionStarted) await this.cleanupFailedStart(session, workerManifests, workers[0]?.cwd ?? process.cwd(), error);
      throw error;
    }
  }

  async collect(teamId: string): Promise<TeamCollection> {
    const manifest = this.manifests.read(teamId);
    const outputs: Record<string, string> = {};
    for (const worker of manifest.workers) {
      const captured = await this.runner('tmux', ['capture-pane', '-p', '-S', '-', '-t', worker.pane_target], worker.cwd);
      outputs[worker.id] = captured.code === 0 ? captured.stdout : `[unavailable: ${captured.stderr}]`;
    }
    return { team_id: teamId, outputs, collected_at: this.now().toISOString(), verified: false, verification_authority: 'omcu-cli-only' };
  }

  async stop(teamId: string): Promise<TeamManifest> {
    let manifest = this.manifests.read(teamId);
    if (manifest.stopped_at !== null) return manifest;
    let boundWorkers = manifest.stopping_worker_ids === null
      ? manifest.workers
      : manifest.workers.filter((worker) => manifest.stopping_worker_ids?.includes(worker.id));
    if (manifest.stopping_at === null) {
      boundWorkers = await this.assertRecordedIdentities(manifest.workers);
      manifest = { ...manifest, stopping_at: this.now().toISOString(), stopping_worker_ids: boundWorkers.map((worker) => worker.id) };
      this.manifests.write(manifest);
    }
    const cwd = manifest.workers[0]?.cwd ?? process.cwd();
    const sessionExists = await this.runner('tmux', ['has-session', '-t', manifest.tmux_session], cwd);
    if (sessionExists.code === 0) {
      const killedSession = await this.runner('tmux', ['kill-session', '-t', manifest.tmux_session], cwd);
      if (killedSession.code !== 0) throw new Error(`E_TEAM_TMUX_STOP:${killedSession.stderr}`);
    }
    await this.terminateGroups(boundWorkers);
    const sessionStillExists = await this.runner('tmux', ['has-session', '-t', manifest.tmux_session], cwd);
    if (sessionStillExists.code === 0) throw new Error('E_TEAM_STOP_INCOMPLETE:session_alive');
    const alive = await this.aliveGroups(manifest.workers);
    if (alive.length > 0) throw new Error(`E_TEAM_STOP_INCOMPLETE:groups_alive:${alive.join(',')}`);
    const stopped = { ...manifest, stopped_at: this.now().toISOString() };
    this.manifests.write(stopped);
    return stopped;
  }

  private async observePanePid(target: string, cwd: string): Promise<number> {
    const observed = await this.runner('tmux', ['display-message', '-p', '-t', target, '#{pane_pid}'], cwd);
    const pid = Number.parseInt(observed.stdout.trim(), 10);
    if (observed.code !== 0 || !Number.isSafeInteger(pid) || pid <= 1) throw new Error('E_TEAM_PANE_IDENTITY_UNOBSERVED');
    return pid;
  }

  private async observeProcessGroup(pid: number, cwd: string): Promise<number> {
    const observed = await this.runner('ps', ['-o', 'pgid=', '-p', String(pid)], cwd);
    const pgid = Number.parseInt(observed.stdout.trim(), 10);
    if (observed.code !== 0 || !Number.isSafeInteger(pgid) || pgid <= 1) throw new Error('E_TEAM_PROCESS_GROUP_UNOBSERVED');
    return pgid;
  }

  private async assertRecordedIdentities(workers: readonly TeamWorkerManifest[]): Promise<TeamWorkerManifest[]> {
    const bound: TeamWorkerManifest[] = [];
    for (const worker of workers) {
      const observed = await this.runner('tmux', ['display-message', '-p', '-t', worker.pane_target, '#{pane_pid} #{pane_dead}'], worker.cwd);
      const [pidText, deadText] = observed.stdout.trim().split(/\s+/);
      const panePid = Number.parseInt(pidText ?? '', 10);
      if (observed.code !== 0 || panePid !== worker.pane_pid || !['0', '1'].includes(deadText ?? '')) throw new Error(`E_TEAM_PROCESS_IDENTITY_MISMATCH:${worker.id}`);
      if (deadText === '0') {
        const pgid = await this.observeProcessGroup(panePid, worker.cwd);
        if (pgid !== worker.process_group_id) throw new Error(`E_TEAM_PROCESS_IDENTITY_MISMATCH:${worker.id}`);
        bound.push(worker);
      } else if ((await this.aliveGroups([worker])).length > 0) {
        throw new Error(`E_TEAM_STALE_PROCESS_GROUP_UNVERIFIED:${worker.id}`);
      }
    }
    return bound;
  }

  private signal(workers: readonly TeamWorkerManifest[], signal: NodeJS.Signals): void {
    for (const worker of workers) {
      try { this.killGroup(worker.process_group_id, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }

  private async aliveGroups(workers: readonly TeamWorkerManifest[]): Promise<number[]> {
    const alive: number[] = [];
    for (const worker of workers) {
      const observed = await this.runner('ps', ['-o', 'pid=', '-g', String(worker.process_group_id)], worker.cwd);
      if (observed.code === 0 && observed.stdout.trim() !== '') alive.push(worker.process_group_id);
      else if (observed.code !== 0 && observed.code !== 1) throw new Error(`E_TEAM_LIVENESS_PROBE:${observed.stderr}`);
    }
    return alive;
  }

  private async waitForExit(workers: readonly TeamWorkerManifest[]): Promise<number[]> {
    for (let attempt = 0; attempt < STOP_POLLS; attempt += 1) {
      const alive = await this.aliveGroups(workers);
      if (alive.length === 0) return [];
      await this.sleep(STOP_POLL_MS);
    }
    return this.aliveGroups(workers);
  }

  private async terminateGroups(workers: readonly TeamWorkerManifest[]): Promise<void> {
    this.signal(workers, 'SIGTERM');
    if ((await this.waitForExit(workers)).length === 0) return;
    this.signal(workers, 'SIGKILL');
    const alive = await this.waitForExit(workers);
    if (alive.length > 0) throw new Error(`E_TEAM_STOP_INCOMPLETE:groups_alive:${alive.join(',')}`);
  }

  private async cleanupFailedStart(session: string, workers: readonly TeamWorkerManifest[], cwd: string, original: unknown): Promise<never> {
    const kill = await this.runner('tmux', ['kill-session', '-t', session], cwd);
    try {
      if (workers.length > 0) await this.terminateGroups(workers);
    } catch (cleanupError) {
      throw new Error(`E_TEAM_START_ROLLBACK_FAILED:${String(original)}:${String(cleanupError)}`);
    }
    if (kill.code !== 0) throw new Error(`E_TEAM_START_ROLLBACK_FAILED:${String(original)}:${kill.stderr}`);
    const stillExists = await this.runner('tmux', ['has-session', '-t', session], cwd);
    if (stillExists.code === 0) throw new Error(`E_TEAM_START_ROLLBACK_FAILED:${String(original)}:session_alive`);
    throw original;
  }
}

function validateWorkers(workers: readonly TeamWorkerSpec[]): void {
  if (workers.length === 0 || workers.length > 8) throw new Error('E_TEAM_WORKER_COUNT_INVALID');
  const ids = new Set<string>();
  for (const worker of workers) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(worker.id) || ids.has(worker.id) || worker.objective.trim() === '' || worker.owned_paths.length === 0) throw new Error('E_TEAM_WORKER_INVALID');
    ids.add(worker.id);
  }
  assertExclusivePathClaims(
    workers.map((worker) => ({ ownerId: worker.id, paths: worker.owned_paths })),
    {
      invalid: 'E_TEAM_PATH_INVALID',
      conflict: (owner, claimant) => `E_TEAM_PATH_CONFLICT:${owner}:${claimant}`,
    },
  );
}

function teamPrompt(worker: TeamWorkerSpec): string { return [`Experimental local tmux worker ${worker.id}.`, `Objective: ${worker.objective}`, `Declared exclusive ownership: ${worker.owned_paths.join(', ')}`, 'Do not edit outside owned paths. This is not a native Cursor team or workflow. Return evidence; never set verified state.'].join('\n\n'); }
