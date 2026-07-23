import type { CursorAgentAdapter } from '../host/cursor-agent.js';

export interface ModeContext {
  readonly adapter: CursorAgentAdapter;
  readonly cwd: string;
  readonly now?: () => Date;
}

export interface AdvisoryGate {
  readonly gate: string;
  readonly passed: boolean;
  readonly evidence_sha256: string | null;
  readonly verified: false;
  readonly verification_authority: 'omcu-cli-only';
}

export interface CommandResult { readonly code: number; readonly stdout: string; readonly stderr: string }
export type CommandRunner = (executable: string, argv: readonly string[], cwd: string) => Promise<CommandResult>;
