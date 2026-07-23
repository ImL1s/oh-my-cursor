export interface TeamWorkerSpec { readonly id: string; readonly objective: string; readonly cwd: string; readonly owned_paths: readonly string[] }
export interface TeamWorkerManifest { readonly id: string; readonly cwd: string; readonly owned_paths: readonly string[]; readonly pane_target: string; readonly pane_pid: number; readonly process_group_id: number; readonly argv: readonly string[] }
export interface TeamManifest {
  readonly schema_version: 1;
  readonly team_id: string;
  readonly tmux_session: string;
  readonly capability_tier: 'experimental-local';
  readonly native_cursor_team: false;
  readonly workers: readonly TeamWorkerManifest[];
  readonly created_at: string;
  readonly stopping_at: string | null;
  readonly stopping_worker_ids: readonly string[] | null;
  readonly stopped_at: string | null;
}
export interface TeamCollection { readonly team_id: string; readonly outputs: Readonly<Record<string, string>>; readonly collected_at: string; readonly verified: false; readonly verification_authority: 'omcu-cli-only' }
export interface TeamCommandResult { readonly code: number; readonly stdout: string; readonly stderr: string }
export type TeamCommandRunner = (executable: string, argv: readonly string[], cwd: string) => Promise<TeamCommandResult>;
export type ProcessGroupKiller = (processGroupId: number, signal: NodeJS.Signals) => void;
