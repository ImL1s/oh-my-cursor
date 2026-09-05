import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  ATOMIC_STAGE_MARKER_FILE,
  atomicPublishDirectory,
  atomicWriteJson,
  atomicWriteText,
  cleanupAtomicStagingDirectories,
  removeAtomicBootstrapStagingDirectory,
  removeAtomicStagingDirectory,
  withDirectoryLockSync,
  type AtomicDirectoryPublishOptions,
  type AtomicStagingDirectoryMarker,
  type AtomicStagingDirectoryProof,
  type AtomicWriteOptions,
} from '../runtime/atomic.js';
import { currentProcessIdentity } from '../runtime/process-identity.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';

export const LEADER_MAILBOX = 'leader-fixed';

export interface TeamWorkerConfig {
  readonly name: string;
  readonly index: number;
  readonly role: string;
  readonly owned_paths: readonly string[];
}

export interface TeamCoordinationConfig {
  readonly schema_version: 1;
  readonly name: string;
  readonly task: string;
  readonly agent_type: string;
  readonly worker_count: number;
  readonly workers: readonly TeamWorkerConfig[];
  readonly created_at: string;
  readonly next_task_id: number;
  readonly capability_tier: 'experimental-local';
  readonly native_cursor_team: false;
  readonly tmux_session: string | null;
}

export interface TeamCoordinationManifestV2 {
  readonly schema_version: 2;
  readonly team_id: string;
  readonly capability_tier: 'experimental-local';
  readonly native_cursor_team: false;
  readonly workers: readonly string[];
  readonly created_at: string;
}

export function assertSafeTeamName(teamName: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(teamName) || path.basename(teamName) !== teamName) {
    throw new Error('E_TEAM_ID_INVALID');
  }
  return teamName;
}

export function assertSafeWorkerName(workerName: string): string {
  if (workerName === LEADER_MAILBOX) return workerName;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(workerName) || path.basename(workerName) !== workerName) {
    throw new Error('E_TEAM_WORKER_INVALID');
  }
  return workerName;
}

/** Durable OMX-shaped coordination root: `.omcu/state/team/<team>/`. */
export function teamStateDir(root: StateRoot, teamName: string): string {
  return withinStateRoot(root, 'state', 'team', assertSafeTeamName(teamName));
}

export function teamConfigPath(root: StateRoot, teamName: string): string {
  return path.join(teamStateDir(root, teamName), 'config.json');
}

export function teamManifestV2Path(root: StateRoot, teamName: string): string {
  return path.join(teamStateDir(root, teamName), 'manifest.v2.json');
}

export function teamTasksDir(root: StateRoot, teamName: string): string {
  return path.join(teamStateDir(root, teamName), 'tasks');
}

export function teamTaskJournalDir(root: StateRoot, teamName: string, taskId: string): string {
  return path.join(teamStateDir(root, teamName), 'task-journals', taskId);
}

export function teamMailboxDir(root: StateRoot, teamName: string): string {
  return path.join(teamStateDir(root, teamName), 'mailbox');
}

export function teamMailboxPath(root: StateRoot, teamName: string, workerName: string): string {
  return path.join(teamMailboxDir(root, teamName), `${assertSafeWorkerName(workerName)}.json`);
}

export function teamMailboxJournalDir(root: StateRoot, teamName: string, workerName: string): string {
  return path.join(teamStateDir(root, teamName), 'mailbox-journals', assertSafeWorkerName(workerName));
}

export function teamWorkerDir(root: StateRoot, teamName: string, workerName: string): string {
  return path.join(teamStateDir(root, teamName), 'workers', assertSafeWorkerName(workerName));
}

export function teamWorkerInboxPath(root: StateRoot, teamName: string, workerName: string): string {
  return path.join(teamWorkerDir(root, teamName, workerName), 'inbox.md');
}

export function teamWorkerHeartbeatPath(root: StateRoot, teamName: string, workerName: string): string {
  return path.join(teamWorkerDir(root, teamName, workerName), 'heartbeat.json');
}

export function teamExists(root: StateRoot, teamName: string): boolean {
  return fs.existsSync(teamConfigPath(root, teamName));
}

export function readTeamConfig(root: StateRoot, teamName: string): TeamCoordinationConfig | null {
  const file = teamConfigPath(root, teamName);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as TeamCoordinationConfig;
    if (parsed.schema_version !== 1 || parsed.name !== teamName || parsed.native_cursor_team !== false) {
      throw new Error('E_TEAM_CONFIG_INVALID');
    }
    if (
      typeof parsed.next_task_id !== 'number'
      || !Number.isSafeInteger(parsed.next_task_id)
      || parsed.next_task_id < 1
    ) {
      throw new Error('E_TEAM_CONFIG_INVALID');
    }
    return parsed;
  } catch (error) {
    if ((error as Error).message === 'E_TEAM_CONFIG_INVALID') throw error;
    throw new Error('E_TEAM_CONFIG_CORRUPT');
  }
}

export function writeTeamConfig(root: StateRoot, config: TeamCoordinationConfig): void {
  atomicWriteJson(teamConfigPath(root, config.name), config);
}

export interface InitializeTeamStateInput {
  readonly teamName: string;
  readonly task: string;
  readonly workers: readonly { readonly name: string; readonly owned_paths: readonly string[]; readonly role?: string }[];
  readonly createdAt?: string;
  readonly tmuxSession?: string | null;
  readonly inboxContents?: Readonly<Record<string, string>>;
}

export interface InitializeTeamStateOptions {
  readonly faultInjector?: (point: 'before_manifest' | 'before_publish') => void;
  /** Test-only marker write fault seam. */
  readonly markerWriteOptions?: AtomicWriteOptions;
  readonly publishOptions?: AtomicDirectoryPublishOptions;
}

export function initializeTeamState(
  root: StateRoot,
  input: InitializeTeamStateInput,
  options: InitializeTeamStateOptions = {},
): TeamCoordinationConfig {
  const teamName = assertSafeTeamName(input.teamName);
  if (input.workers.length === 0 || input.workers.length > 8) throw new Error('E_TEAM_WORKER_COUNT_INVALID');

  const createdAt = input.createdAt ?? new Date().toISOString();
  const workerConfigs: TeamWorkerConfig[] = input.workers.map((worker, index) => ({
    name: assertSafeWorkerName(worker.name),
    index: index + 1,
    role: worker.role ?? 'executor',
    owned_paths: [...worker.owned_paths],
  }));

  const names = new Set<string>();
  for (const worker of workerConfigs) {
    if (names.has(worker.name)) throw new Error('E_TEAM_WORKER_INVALID');
    names.add(worker.name);
  }

  const config: TeamCoordinationConfig = {
    schema_version: 1,
    name: teamName,
    task: input.task,
    agent_type: 'executor',
    worker_count: workerConfigs.length,
    workers: workerConfigs,
    created_at: createdAt,
    next_task_id: 1,
    capability_tier: 'experimental-local',
    native_cursor_team: false,
    tmux_session: input.tmuxSession ?? null,
  };
  const manifest: TeamCoordinationManifestV2 = {
    schema_version: 2,
    team_id: teamName,
    capability_tier: 'experimental-local',
    native_cursor_team: false,
    workers: workerConfigs.map((worker) => worker.name),
    created_at: createdAt,
  };

  const dir = teamStateDir(root, teamName);
  const stagePrefix = `.${teamName}.init-`;
  return withDirectoryLockSync(dir, () => {
    if (fs.existsSync(dir)) {
      const existing = readCompleteTeamState(root, teamName, input);
      if (existing !== null) return existing;
      throw new Error('E_TEAM_STATE_INCOMPLETE');
    }
    cleanupAtomicStagingDirectories(dir, stagePrefix);
    const parent = fs.realpathSync(path.dirname(dir));
    const stage = path.join(parent, `${stagePrefix}${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(stage, { mode: 0o700 });
    const stageStat = fs.lstatSync(stage);
    const identity = currentProcessIdentity();
    const marker: AtomicStagingDirectoryMarker = {
      schema_version: 1,
      target: path.basename(dir),
      token: crypto.randomBytes(32).toString('hex'),
      stage_dev: stageStat.dev,
      stage_ino: stageStat.ino,
      creator: {
        pid: identity.pid,
        start_identity: identity.start_identity,
        start_identity_proven: identity.start_identity_proven,
      },
    };
    const stageProof: AtomicStagingDirectoryProof = { dev: stageStat.dev, ino: stageStat.ino, marker };
    let markerPublished = false;
    let published = false;
    let primaryFailed = false;
    let primaryError: unknown;
    try {
      atomicWriteJson(path.join(stage, ATOMIC_STAGE_MARKER_FILE), marker, options.markerWriteOptions);
      markerPublished = true;
      atomicWriteJson(path.join(stage, 'dispatch', 'requests.json'), []);
      atomicWriteJson(path.join(stage, 'mailbox', `${LEADER_MAILBOX}.json`), { worker: LEADER_MAILBOX, messages: [] });
      for (const worker of workerConfigs) {
        atomicWriteJson(path.join(stage, 'mailbox', `${worker.name}.json`), { worker: worker.name, messages: [] });
        atomicWriteJson(path.join(stage, 'workers', worker.name, 'heartbeat.json'), {
          schema_version: 1,
          worker: worker.name,
          alive: false,
          pid: null,
          turn_count: 0,
          updated_at: createdAt,
        });
        const inbox = input.inboxContents?.[worker.name]
          ?? defaultWorkerInbox(teamName, worker.name, input.task);
        atomicWriteText(
          path.join(stage, 'workers', worker.name, 'inbox.md'),
          inbox.endsWith('\n') ? inbox : `${inbox}\n`,
          { mode: 0o600 },
        );
      }
      atomicWriteJson(path.join(stage, 'config.json'), config);
      options.faultInjector?.('before_manifest');
      atomicWriteJson(path.join(stage, 'manifest.v2.json'), manifest);
      options.faultInjector?.('before_publish');
      try {
        atomicPublishDirectory(stage, dir, stageProof, options.publishOptions);
        published = true;
      } catch (error) {
        if ((error as { phase?: string }).phase === 'commit_durability_unknown') {
          const adopted = readCompleteTeamState(root, teamName, input);
          if (adopted !== null) {
            published = true;
            return adopted;
          }
        }
        throw error;
      }
      return config;
    } catch (error) {
      primaryFailed = true;
      primaryError = error;
      throw error;
    } finally {
      if (!published && fs.existsSync(stage)) {
        try {
          if (markerPublished) removeAtomicStagingDirectory(stage, dir, stageProof);
          else removeAtomicBootstrapStagingDirectory(stage, dir, stagePrefix, stageProof);
        } catch (cleanupError) {
          if (!primaryFailed) throw cleanupError;
          if (primaryError instanceof Error) {
            try {
              Object.defineProperty(primaryError, 'cleanupError', { value: cleanupError, configurable: true });
              if (primaryError.cause === undefined) {
                Object.defineProperty(primaryError, 'cause', { value: cleanupError, configurable: true });
              }
            } catch { /* preserve the primary failure even if it is non-extensible */ }
          }
        }
      }
    }
  }, 2_000, { errorPrefix: 'E_TEAM_INIT_LOCK' });
}

function readCompleteTeamState(
  root: StateRoot,
  teamName: string,
  input: InitializeTeamStateInput,
): TeamCoordinationConfig | null {
  const config = readTeamConfig(root, teamName);
  if (config === null) return null;
  try {
    if (!isExactTeamConfig(config, teamName)) return null;
    const expectedWorkers = input.workers.map((worker, index) => ({
      name: assertSafeWorkerName(worker.name),
      index: index + 1,
      role: worker.role ?? 'executor',
      owned_paths: [...worker.owned_paths],
    }));
    if (config.task !== input.task || config.tmux_session !== (input.tmuxSession ?? null)
      || (input.createdAt !== undefined && config.created_at !== input.createdAt)
      || JSON.stringify(config.workers) !== JSON.stringify(expectedWorkers)) return null;

    const manifest = readExactJson(teamManifestV2Path(root, teamName));
    if (!isExactManifest(manifest, config)) return null;
    const dispatch = readExactJson(path.join(teamStateDir(root, teamName), 'dispatch', 'requests.json'));
    if (!Array.isArray(dispatch) || dispatch.length !== 0) return null;
    if (fs.existsSync(teamTasksDir(root, teamName))
      && fs.readdirSync(teamTasksDir(root, teamName)).some((name) => /^task-\d+\.json$/.test(name))) return null;
    if (!isExactMailbox(readExactJson(teamMailboxPath(root, teamName, LEADER_MAILBOX)), LEADER_MAILBOX)) return null;
    for (const worker of config.workers) {
      if (!isExactMailbox(readExactJson(teamMailboxPath(root, teamName, worker.name)), worker.name)) return null;
      if (!isExactHeartbeat(readExactJson(teamWorkerHeartbeatPath(root, teamName, worker.name)), worker.name, config.created_at)) return null;
      const expectedInbox = input.inboxContents?.[worker.name]
        ?? defaultWorkerInbox(teamName, worker.name, input.task);
      const normalizedInbox = expectedInbox.endsWith('\n') ? expectedInbox : `${expectedInbox}\n`;
      if (fs.readFileSync(teamWorkerInboxPath(root, teamName, worker.name), 'utf8') !== normalizedInbox) return null;
    }
    return config;
  } catch {
    return null;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function readExactJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

function isExactTeamConfig(config: TeamCoordinationConfig, teamName: string): boolean {
  const row = config as unknown as Record<string, unknown>;
  if (!hasExactKeys(row, [
    'schema_version', 'name', 'task', 'agent_type', 'worker_count', 'workers', 'created_at',
    'next_task_id', 'capability_tier', 'native_cursor_team', 'tmux_session',
  ])) return false;
  if (config.schema_version !== 1 || config.name !== teamName || typeof config.task !== 'string'
    || config.agent_type !== 'executor' || config.capability_tier !== 'experimental-local'
    || config.native_cursor_team !== false || typeof config.created_at !== 'string'
    || (config.tmux_session !== null && typeof config.tmux_session !== 'string')
    || !Number.isSafeInteger(config.worker_count) || config.worker_count !== config.workers.length
    || !Number.isSafeInteger(config.next_task_id) || config.next_task_id !== 1) return false;
  const names = new Set<string>();
  return config.workers.every((worker, index) => {
    const item = worker as unknown as Record<string, unknown>;
    if (!hasExactKeys(item, ['name', 'index', 'role', 'owned_paths'])
      || typeof worker.name !== 'string' || typeof worker.role !== 'string'
      || worker.index !== index + 1 || !Array.isArray(worker.owned_paths)
      || !worker.owned_paths.every((ownedPath) => typeof ownedPath === 'string')
      || names.has(worker.name)) return false;
    names.add(worker.name);
    return true;
  });
}

function isExactManifest(value: unknown, config: TeamCoordinationConfig): value is TeamCoordinationManifestV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  return hasExactKeys(manifest, [
    'schema_version', 'team_id', 'capability_tier', 'native_cursor_team', 'workers', 'created_at',
  ]) && manifest.schema_version === 2
    && manifest.team_id === config.name
    && manifest.capability_tier === 'experimental-local'
    && manifest.native_cursor_team === false
    && manifest.created_at === config.created_at
    && JSON.stringify(manifest.workers) === JSON.stringify(config.workers.map((worker) => worker.name));
}

function isExactMailbox(value: unknown, worker: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mailbox = value as Record<string, unknown>;
  return hasExactKeys(mailbox, ['worker', 'messages'])
    && mailbox.worker === worker && Array.isArray(mailbox.messages) && mailbox.messages.length === 0;
}

function isExactHeartbeat(value: unknown, worker: string, createdAt: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const heartbeat = value as Record<string, unknown>;
  return hasExactKeys(heartbeat, ['schema_version', 'worker', 'alive', 'pid', 'turn_count', 'updated_at'])
    && heartbeat.schema_version === 1 && heartbeat.worker === worker && heartbeat.alive === false
    && heartbeat.pid === null && heartbeat.turn_count === 0 && heartbeat.updated_at === createdAt;
}

export function writeWorkerInboxFile(
  root: StateRoot,
  teamName: string,
  workerName: string,
  content: string,
  options: AtomicWriteOptions = {},
  expectedSha256?: string,
): string {
  const file = teamWorkerInboxPath(root, teamName, workerName);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withDirectoryLockSync(file, () => {
    if (expectedSha256 !== undefined) {
      const current = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (current !== expectedSha256) throw new Error('E_TEAM_INBOX_CONFLICT');
    }
    const normalized = content.endsWith('\n') ? content : `${content}\n`;
    atomicWriteText(file, normalized, { ...options, mode: 0o600 });
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }, 2_000, { errorPrefix: 'E_TEAM_INBOX_LOCK' });
}

export function removeTeamState(root: StateRoot, teamName: string): void {
  const dir = teamStateDir(root, teamName);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function defaultWorkerInbox(teamName: string, workerName: string, task: string): string {
  return [
    `# Worker inbox — ${workerName}`,
    '',
    `Team: ${teamName}`,
    `Task: ${task}`,
    '',
    'This is experimental local tmux coordination (`omcu team`), not a native Cursor team.',
    'Read mailbox via `omcu team api mailbox-list`. Never stamp verified.',
    '',
  ].join('\n');
}
