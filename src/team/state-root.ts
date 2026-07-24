import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../runtime/atomic.js';
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

export function teamMailboxDir(root: StateRoot, teamName: string): string {
  return path.join(teamStateDir(root, teamName), 'mailbox');
}

export function teamMailboxPath(root: StateRoot, teamName: string, workerName: string): string {
  return path.join(teamMailboxDir(root, teamName), `${assertSafeWorkerName(workerName)}.json`);
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

export function initializeTeamState(root: StateRoot, input: InitializeTeamStateInput): TeamCoordinationConfig {
  const teamName = assertSafeTeamName(input.teamName);
  if (teamExists(root, teamName)) throw new Error('E_TEAM_STATE_EXISTS');
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

  const dir = teamStateDir(root, teamName);
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, 'mailbox'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, 'workers'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, 'dispatch'), { recursive: true, mode: 0o700 });

  atomicWriteJson(path.join(dir, 'dispatch', 'requests.json'), []);
  atomicWriteJson(teamMailboxPath(root, teamName, LEADER_MAILBOX), { worker: LEADER_MAILBOX, messages: [] });

  for (const worker of workerConfigs) {
    fs.mkdirSync(teamWorkerDir(root, teamName, worker.name), { recursive: true, mode: 0o700 });
    atomicWriteJson(teamMailboxPath(root, teamName, worker.name), { worker: worker.name, messages: [] });
    atomicWriteJson(teamWorkerHeartbeatPath(root, teamName, worker.name), {
      schema_version: 1,
      worker: worker.name,
      alive: false,
      pid: null,
      turn_count: 0,
      updated_at: createdAt,
    });
    const inbox = input.inboxContents?.[worker.name]
      ?? defaultWorkerInbox(teamName, worker.name, input.task);
    writeWorkerInboxFile(root, teamName, worker.name, inbox);
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
  writeTeamConfig(root, config);

  const manifest: TeamCoordinationManifestV2 = {
    schema_version: 2,
    team_id: teamName,
    capability_tier: 'experimental-local',
    native_cursor_team: false,
    workers: workerConfigs.map((worker) => worker.name),
    created_at: createdAt,
  };
  atomicWriteJson(teamManifestV2Path(root, teamName), manifest);
  return config;
}

export function writeWorkerInboxFile(root: StateRoot, teamName: string, workerName: string, content: string): void {
  const file = teamWorkerInboxPath(root, teamName, workerName);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content.endsWith('\n') ? content : `${content}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
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
