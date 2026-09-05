export interface TeamWorkerSpec { readonly id: string; readonly objective: string; readonly cwd: string; readonly owned_paths: readonly string[] }
export interface TeamWorkerManifest {
  readonly id: string;
  readonly cwd: string;
  readonly owned_paths: readonly string[];
  readonly pane_target: string;
  readonly pane_pid: number;
  readonly pane_start_identity: string;
  readonly pane_start_identity_proven: boolean;
  readonly process_group_id: number;
  readonly argv: readonly string[];
}
export interface TeamManifest {
  readonly schema_version: 2;
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

export interface NativeTeamWorkerManifest {
  readonly id: string;
  readonly role?: string | undefined;
  readonly cwd: string;
  readonly owned_paths: readonly string[];
  readonly agent_id: string;
  readonly run_id: string;
  readonly status: string;
  readonly runtime: 'local' | 'cloud';
}

export interface NativeTeamManifest {
  readonly schema_version: 2;
  readonly team_id: string;
  readonly capability_tier: 'native-cursor-team';
  readonly native_cursor_team: true;
  readonly workers: readonly NativeTeamWorkerManifest[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly stopped_at: string | null;
}

export interface NativeTeamStatus {
  readonly team_id: string;
  readonly capability_tier: 'native-cursor-team';
  readonly native_cursor_team: true;
  readonly active: boolean;
  readonly workers: readonly {
    readonly id: string;
    readonly agent_id: string;
    readonly run_id: string;
    readonly status: string;
    readonly runtime: 'local' | 'cloud';
  }[];
}

