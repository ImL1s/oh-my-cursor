export type CursorNativeHookEvent =
  | 'sessionStart'
  | 'beforeSubmitPrompt'
  | 'preToolUse'
  | 'postToolUse'
  | 'afterAgentResponse'
  | 'preCompact'
  | 'stop'
  | 'subagentStop';

export const CURSOR_NATIVE_HOOK_EVENTS: readonly CursorNativeHookEvent[] = [
  'sessionStart',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'afterAgentResponse',
  'preCompact',
  'stop',
  'subagentStop',
] as const;

export type HookExecutionTier = 1 | 2 | 3 | 4 | 5;

export const HOOK_TIER_NAMES: Readonly<Record<HookExecutionTier, string>> = {
  1: 'safety_permission',
  2: 'input_context',
  3: 'routing_workflow',
  4: 'output_recovery',
  5: 'trace_notification',
} as const;

export type HookFailurePolicy = 'fail_open' | 'fail_closed';
export type HookStateAccess = 'read' | 'write' | 'none';
export type HookAction = 'pass' | 'deny' | 'continue' | 'modify';

export interface HookExecutionContext {
  readonly event: CursorNativeHookEvent;
  readonly rawInput: unknown;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly loopCount?: number | undefined;
  readonly toolName?: string | undefined;
  readonly toolInput?: Readonly<Record<string, unknown>> | undefined;
  readonly toolOutput?: unknown | undefined;
  readonly agentResponse?: string | undefined;
  readonly prompt?: string | undefined;
  readonly timestamp: number;
}

export interface HookHandlerResult {
  readonly handled: boolean;
  readonly action?: HookAction | undefined;
  readonly reason?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly followupMessage?: string | undefined;
  readonly injectedContext?: string | undefined;
  readonly modifiedPrompt?: string | undefined;
  readonly auditPassed?: boolean | undefined;
  readonly auditErrors?: readonly string[] | undefined;
  readonly recoveryHints?: readonly string[] | undefined;
  readonly traceRecord?: Readonly<Record<string, unknown>> | undefined;
  readonly outputPayload?: Readonly<Record<string, unknown>> | undefined;
}

export interface HookHandlerDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly event: CursorNativeHookEvent;
  readonly tier: HookExecutionTier;
  readonly priority: number;
  readonly matcher?: string | undefined;
  readonly loopLimit?: number | undefined;
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly failurePolicy: HookFailurePolicy;
  readonly sourceAnalogs: Readonly<Record<string, string>>;
  readonly canonicalContractId?: string | undefined;
  readonly stateAccess: HookStateAccess;
  readonly immutable: boolean;
  readonly supportedRuntimes: readonly ('local' | 'cloud' | 'interactive')[];
  handler(context: HookExecutionContext): Promise<HookHandlerResult> | HookHandlerResult;
}

export type HookTraceEventType = 'native_hook' | 'sdk_event' | 'domain_event';

export interface HookTraceEntry {
  readonly id: string;
  readonly runId: string;
  readonly event: string;
  readonly eventType: HookTraceEventType;
  readonly handlerId?: string | undefined;
  readonly tier?: HookExecutionTier | undefined;
  readonly status: 'success' | 'denied' | 'continued' | 'failed' | 'bypassed';
  readonly durationMs: number;
  readonly timestamp: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

export type HookDoctorCategory =
  | 'native_hook_installed'
  | 'native_hook_observed_live'
  | 'sdk_event_observed'
  | 'omcu_domain_event'
  | 'unsupported_not_run';

export interface HookDoctorItem {
  readonly name: string;
  readonly category: HookDoctorCategory;
  readonly status: 'ok' | 'warning' | 'error' | 'not_run';
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

export interface HookDoctorReport {
  readonly ok: boolean;
  readonly installedHooks: readonly string[];
  readonly items: readonly HookDoctorItem[];
  readonly timestamp: string;
}
