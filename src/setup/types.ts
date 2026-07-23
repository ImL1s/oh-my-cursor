export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  }): Promise<CommandResult>;
}

export type SetupCheckStatus = 'pass' | 'warn' | 'fail';

export interface SetupCheck {
  readonly id: string;
  readonly status: SetupCheckStatus;
  readonly message: string;
  readonly detail?: unknown;
}
