export interface GitIdentity {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly headSha: string;
  readonly isClean: boolean;
  readonly upstream?: string | undefined;
}

export interface WorktreeEntry {
  readonly path: string;
  readonly head: string;
  readonly branch: string;
  readonly isBare: boolean;
  readonly isDetached: boolean;
}

export interface WorktreeOptions {
  readonly action: 'create' | 'list' | 'remove' | 'prune';
  readonly branch?: string | undefined;
  readonly path?: string | undefined;
  readonly commit?: string | undefined;
}

export interface CommandExecutionOptions {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

export interface CommandExecutionResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly spilled?: boolean | undefined;
  readonly artifactPath?: string | undefined;
}
