import type {
  AgentMessage,
  AgentRecord,
  LocalAgentStore,
  ModelSelection,
  RunRecord,
  RunResult,
  SDKCustomTool,
  SDKMessage,
  SendOptions,
} from '@cursor/sdk';

export type RuntimeTarget = 'local' | 'cloud';

export type SupportedOperation = 'cancel' | 'stream' | 'wait' | 'conversation';

export interface CursorRunHandle {
  readonly agentId: string;
  readonly runId: string;
  readonly requestId?: string | undefined;
  readonly target: RuntimeTarget;
  readonly model?: ModelSelection | undefined;
  readonly status: string;
  supports(op: SupportedOperation): boolean;
  unsupportedReason(op: SupportedOperation): string | undefined;
  stream(): AsyncIterable<SDKMessage>;
  wait(): Promise<RunResult>;
  cancel(): Promise<void>;
}

export interface ManagedCursorAgent extends AsyncDisposable {
  readonly agentId: string;
  readonly target: RuntimeTarget;
  send(message: string | AgentMessage, options?: SendOptions): Promise<CursorRunHandle>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface AutoReviewArgs {
  readonly toolName: string;
  readonly toolArgs: unknown;
  readonly toolCallId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly runId?: string | undefined;
}

export interface AutoReviewDecision {
  readonly allowed: boolean;
  readonly reason?: string | undefined;
}

export type AutoReviewHandler = (
  args: AutoReviewArgs
) => Promise<AutoReviewDecision> | AutoReviewDecision;

export interface CursorRuntimeOptions {
  readonly target: RuntimeTarget;
  readonly cwd?: string | undefined;
  readonly model?: string | ModelSelection | undefined;
  readonly store?: LocalAgentStore | undefined;
  readonly storeType?: 'jsonl' | 'sqlite' | undefined;
  readonly storePath?: string | undefined;
  readonly customTools?: Record<string, SDKCustomTool> | undefined;
  readonly autoReview?: AutoReviewHandler | undefined;
}

export interface PromptInput {
  readonly prompt: string;
  readonly target: RuntimeTarget;
  readonly cwd?: string | undefined;
  readonly model?: string | ModelSelection | undefined;
  readonly customTools?: Record<string, SDKCustomTool> | undefined;
}

export interface PromptOutput {
  readonly text: string;
  readonly agentId?: string | undefined;
  readonly runId?: string | undefined;
  readonly result?: RunResult | undefined;
}

export interface CursorRuntime extends AsyncDisposable {
  readonly target: RuntimeTarget;
  prompt(input: PromptInput): Promise<PromptOutput>;
  createAgent(options?: Partial<CursorRuntimeOptions>): Promise<ManagedCursorAgent>;
  resumeAgent(agentId: string, options?: Partial<CursorRuntimeOptions>): Promise<ManagedCursorAgent>;
  getAgent(agentId: string): Promise<AgentRecord | null>;
  getRun(runId: string): Promise<RunRecord | null>;
  listRuns(agentId?: string): Promise<readonly RunRecord[]>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
