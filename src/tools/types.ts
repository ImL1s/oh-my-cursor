import type {
  SDKCustomToolContext,
  SDKCustomToolResult,
  SDKJsonValue,
} from '@cursor/sdk';

export type ToolProvider = 'native' | 'sdk-custom' | 'mcp' | 'domain';

export type SideEffectClassification = 'readOnly' | 'destructive' | 'idempotent';

export interface ToolExecutionContext {
  readonly projectRoot?: string | undefined;
  readonly agentId?: string | undefined;
  readonly runId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface SpilledArtifactReference {
  readonly spilled: true;
  readonly artifactPath: string;
  readonly sizeBytes: number;
  readonly preview: string;
  readonly mimeType?: string | undefined;
}

export interface ToolDefinition {
  readonly name: string;
  readonly aliases?: readonly string[] | undefined;
  readonly description: string;
  readonly provider: ToolProvider;
  readonly sideEffect: SideEffectClassification;
  readonly inputSchema?: Record<string, SDKJsonValue> | undefined;
  readonly outputSchema?: Record<string, SDKJsonValue> | undefined;
  readonly permissionResource?: string | undefined;
  readonly allowedAgents?: readonly string[] | undefined;
  readonly deniedAgents?: readonly string[] | undefined;
  readonly runtimeRequirements?: readonly string[] | undefined;
  readonly idempotency?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxInlineBytes?: number | undefined;
  readonly sourceAnalogs?: Record<string, string> | undefined;
  readonly execute: (
    args: Record<string, SDKJsonValue>,
    context: SDKCustomToolContext,
    env?: ToolExecutionContext | undefined
  ) => Promise<SDKCustomToolResult> | SDKCustomToolResult;
}

export type ToolErrorCode =
  | 'E_TOOL_NOT_FOUND'
  | 'E_TOOL_ALREADY_REGISTERED'
  | 'E_TOOL_EXECUTION_FAILED'
  | 'E_TOOL_TIMEOUT'
  | 'E_TOOL_PERMISSION_DENIED'
  | 'E_LSP_UNAVAILABLE'
  | 'E_LSP_ERROR'
  | 'E_LSP_TIMEOUT'
  | 'E_AST_PARSER_UNAVAILABLE'
  | 'E_HASH_MISMATCH'
  | 'E_STALE_EDIT'
  | 'E_WORKTREE_LOCK_FAILED'
  | 'E_UNSAFE_URL'
  | 'E_VISUAL_EVIDENCE_MISSING';

export class ToolError extends Error {
  public readonly code: ToolErrorCode;
  public readonly details?: unknown;

  constructor(code: ToolErrorCode, message: string, details?: unknown) {
    super(`${code}: ${message}`);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}
