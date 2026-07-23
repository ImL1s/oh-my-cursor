export type RunStatus = 'active' | 'complete' | 'failed' | 'cancelled';
export interface MutationProof {
  readonly source: 'omcu-cli';
  readonly owner_token_sha256: string;
  readonly writer_pid: number;
  readonly mutated_at: string;
}
export interface VerificationRecord {
  readonly verified: boolean;
  readonly evidence_sha256: string | null;
  readonly verified_at: string | null;
}
export interface RunStateV1 {
  readonly store_kind: 'run_state';
  readonly schema_version: 1;
  readonly repository_id: 'OMCU';
  readonly run_id: string;
  readonly revision: number;
  readonly status: RunStatus;
  readonly objective: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly verification: VerificationRecord;
  readonly last_mutation: MutationProof;
}
export interface RunEventV1 {
  readonly store_kind: 'run_event';
  readonly schema_version: 1;
  readonly repository_id: 'OMCU';
  readonly run_id: string;
  readonly sequence: number;
  readonly type: string;
  readonly at: string;
  readonly payload: unknown;
  readonly mutation: MutationProof;
}
export interface LeaseV1 {
  readonly store_kind: 'run_lease';
  readonly schema_version: 1;
  readonly repository_id: 'OMCU';
  readonly run_id: string;
  readonly lease_name: string;
  readonly owner: string;
  readonly generation: number;
  readonly expires_at: string;
  readonly mutation: MutationProof;
}
