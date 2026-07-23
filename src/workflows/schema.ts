import crypto from 'node:crypto';

export type CapabilityTier = 'cursor-backed' | 'experimental-local' | 'unsupported';
export type WorkflowStageMode = 'plan' | 'ask';
export type WorkflowReceiptStatus = 'passed' | 'failed' | 'blocked' | 'unsupported';

export interface WorkflowStageDefinition {
  readonly id: string;
  readonly prompt: string;
  readonly mode: WorkflowStageMode;
  readonly depends_on: readonly string[];
  readonly max_attempts: number;
}

export interface WorkflowDefinition {
  readonly schema_version: 1;
  readonly name: string;
  readonly version: string;
  readonly capability_tier: CapabilityTier;
  readonly unsupported_reason?: string;
  readonly stages: readonly WorkflowStageDefinition[];
  readonly definition_sha256: string;
}

export interface WorkflowPlanTask {
  readonly task_id: string;
  readonly stage_id: string;
  readonly declaration_index: number;
  readonly depends_on: readonly string[];
}

export interface WorkflowPlan {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly workflow_name: string;
  readonly workflow_version: string;
  readonly definition_sha256: string;
  readonly objective: string;
  readonly tasks: readonly WorkflowPlanTask[];
  readonly plan_sha256: string;
}

export interface WorkflowReceipt {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly status: WorkflowReceiptStatus;
  readonly invoked_argv: readonly string[];
  readonly exit_code: number | null;
  readonly stdout_sha256: string | null;
  readonly stderr_sha256: string | null;
  readonly output: unknown;
  readonly capability_tier: CapabilityTier;
  readonly unsupported_reason: string | null;
  readonly verified: false;
  readonly verification_authority: 'omcu-cli-only';
  readonly created_at: string;
  readonly receipt_sha256: string;
}

export interface WorkflowJournalEvent {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly sequence: number;
  readonly kind: 'run_started' | 'task_started' | 'task_receipt' | 'run_finished';
  readonly payload: unknown;
  readonly previous_event_sha256: string | null;
  readonly event_sha256: string;
}

export interface WorkflowRunStatus {
  readonly run_id: string;
  readonly status: 'active' | 'complete' | 'failed' | 'blocked' | 'unsupported' | 'ambiguous';
  readonly receipts: Readonly<Record<string, WorkflowReceipt>>;
  readonly verified: false;
  readonly verification_authority: 'omcu-cli-only';
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

export function digestObject(value: unknown): string { return sha256(canonicalJson(value)); }

export function validateWorkflowDefinition(raw: Omit<WorkflowDefinition, 'definition_sha256'> & { readonly definition_sha256?: string }): WorkflowDefinition {
  if (raw.schema_version !== 1 || !SAFE_ID.test(raw.name) || !SAFE_ID.test(raw.version)) throw new Error('E_WORKFLOW_DEFINITION_INVALID');
  if (!['cursor-backed', 'experimental-local', 'unsupported'].includes(raw.capability_tier)) throw new Error('E_WORKFLOW_CAPABILITY_TIER_INVALID');
  if (raw.capability_tier === 'unsupported' && !raw.unsupported_reason?.trim()) throw new Error('E_WORKFLOW_UNSUPPORTED_REASON_REQUIRED');
  if (raw.stages.length === 0 || raw.stages.length > 128) throw new Error('E_WORKFLOW_STAGES_INVALID');
  const seen = new Set<string>();
  for (const stage of raw.stages) {
    if (!SAFE_ID.test(stage.id) || stage.prompt.trim() === '' || stage.prompt.length > 32_768 || !['plan', 'ask'].includes(stage.mode)) throw new Error('E_WORKFLOW_STAGE_INVALID');
    if (!Number.isInteger(stage.max_attempts) || stage.max_attempts < 1 || stage.max_attempts > 10 || seen.has(stage.id)) throw new Error('E_WORKFLOW_STAGE_INVALID');
    for (const dependency of stage.depends_on) if (!seen.has(dependency)) throw new Error('E_WORKFLOW_DEPENDENCY_INVALID');
    seen.add(stage.id);
  }
  const { definition_sha256: claimedDigest, ...material } = raw;
  const digest = digestObject(material);
  if (claimedDigest !== undefined && claimedDigest !== digest) throw new Error('E_WORKFLOW_DIGEST_MISMATCH');
  return deepFreeze({ ...structuredClone(material), definition_sha256: digest } as WorkflowDefinition);
}

export function receiptDigest(receipt: Omit<WorkflowReceipt, 'receipt_sha256'>): string { return digestObject(receipt); }
export function eventDigest(event: Omit<WorkflowJournalEvent, 'event_sha256'>): string { return digestObject(event); }

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
