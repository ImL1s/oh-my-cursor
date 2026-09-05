import type { WorkflowProjection } from '../workflows/projection.js';

export type ContinuationHookEvent = 'stop' | 'afterAgentResponse';

export interface FailureFingerprintInput {
  readonly command?: string | undefined;
  readonly tool?: string | undefined;
  readonly error?: string | Error | undefined;
  readonly exitCode?: number | null | undefined;
  readonly output?: string | undefined;
}

export type FailureRoutingAction =
  | 'rework'
  | 'replan'
  | 'specialist'
  | 'human_blocker'
  | 'terminal_failure';

export interface ContinuationTransactionOptions {
  readonly cwd: string;
  readonly run_id: string;
  readonly cursor_agent_id: string;
  readonly cursor_run_id?: string | null | undefined;
  readonly epoch: number;
  readonly event_id: string;
  readonly hook_event: ContinuationHookEvent;
  readonly hook_status?: string | undefined;
  readonly turn_output?: {
    readonly text?: string | undefined;
    readonly tool_calls?: readonly unknown[] | undefined;
    readonly error?: unknown | undefined;
  } | undefined;
  readonly observed_failure?: FailureFingerprintInput | undefined;
  readonly ambiguous_side_effect?: boolean | undefined;
  readonly now_ms?: number | undefined;
}

export interface ContinuationTransactionResult {
  readonly continue: boolean;
  readonly reason: string;
  readonly followup_message?: string | undefined;
  readonly refusal_reason?: string | undefined;
  readonly next_projection?: WorkflowProjection | undefined;
  readonly failure_routing?: FailureRoutingAction | undefined;
  readonly failure_fingerprint?: string | undefined;
  readonly continuation_slot_consumed: boolean;
}
