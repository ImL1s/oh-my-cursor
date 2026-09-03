import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, withDirectoryLock } from '../runtime/atomic.js';
import { redact } from '../runtime/redaction.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';
import { assertCliMutationAuthority, authorityDigest, type CliMutationAuthority } from './authority.js';
import {
  ALLOWED_TRANSITIONS,
  TERMINAL_STATUSES,
  type LeaseV1,
  type MutationProof,
  type RunEventV1,
  type RunStateV1,
  type RunStatus,
} from './types.js';
export { ALLOWED_TRANSITIONS, TERMINAL_STATUSES };

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function safeKey(value: string, label: string): string {
  if (!SAFE_KEY.test(value)) throw new Error(`E_${label.toUpperCase()}_INVALID`);
  return value;
}
function proof(authority: CliMutationAuthority, now: Date): MutationProof {
  assertCliMutationAuthority(authority);
  return { source: 'omcu-cli', owner_token_sha256: authorityDigest(authority), writer_pid: process.pid, mutated_at: now.toISOString() };
}
function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function stateCorrupt(error: unknown): Error {
  return new Error('E_STATE_CORRUPT', { cause: error });
}
function validDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  try {
    return new Date(parsed).toISOString() === value;
  } catch {
    return false;
  }
}

export function validMutation(value: unknown): value is MutationProof {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const mutation = value as Partial<MutationProof> & Record<string, unknown>;
  const keys = Object.keys(mutation).sort().join(',');
  if (keys !== 'mutated_at,owner_token_sha256,source,writer_pid') return false;
  return mutation.source === 'omcu-cli'
    && typeof mutation.owner_token_sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(mutation.owner_token_sha256)
    && Number.isSafeInteger(mutation.writer_pid)
    && (mutation.writer_pid as number) > 0
    && validDate(mutation.mutated_at);
}

export function validRunState(state: unknown, runId: string): state is RunStateV1 {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return false;
  const s = state as Partial<RunStateV1> & Record<string, unknown>;
  const keys = Object.keys(s).sort().join(',');
  if (keys !== 'created_at,last_mutation,objective,repository_id,revision,run_id,schema_version,status,store_kind,updated_at,verification') {
    return false;
  }
  if (s.store_kind !== 'run_state' || s.schema_version !== 1 || s.repository_id !== 'OMCU') return false;
  if (s.run_id !== runId || typeof s.run_id !== 'string' || !SAFE_KEY.test(s.run_id)) return false;
  if (!Number.isSafeInteger(s.revision) || (s.revision as number) < 1) return false;
  if (s.status !== 'active' && s.status !== 'complete' && s.status !== 'failed' && s.status !== 'cancelled') return false;
  if (typeof s.objective !== 'string' || s.objective.trim() === '' || s.objective.length > 16_384) return false;
  if (!validDate(s.created_at) || !validDate(s.updated_at)) return false;
  if (Date.parse(s.created_at) > Date.parse(s.updated_at)) return false;

  const v = s.verification;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const vRec = v as unknown as Record<string, unknown>;
  const vKeys = Object.keys(vRec).sort().join(',');
  if (vKeys !== 'evidence_sha256,verified,verified_at') return false;
  if (typeof vRec.verified !== 'boolean') return false;

  if (vRec.verified) {
    if (s.status !== 'complete') return false;
    if (typeof vRec.evidence_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(vRec.evidence_sha256)) return false;
    if (!validDate(vRec.verified_at)) return false;
    if (Date.parse(s.created_at) > Date.parse(vRec.verified_at)) return false;
    if (Date.parse(vRec.verified_at) > Date.parse(s.updated_at)) return false;
  } else {
    if (vRec.evidence_sha256 !== null || vRec.verified_at !== null) return false;
  }

  if (!validMutation(s.last_mutation)) return false;
  if (Date.parse(s.created_at) > Date.parse(s.last_mutation.mutated_at)) return false;
  if (Date.parse(s.last_mutation.mutated_at) > Date.parse(s.updated_at)) return false;
  return true;
}

export function validLease(lease: unknown, runId: string, leaseName: string): lease is LeaseV1 {
  if (lease === null || typeof lease !== 'object' || Array.isArray(lease)) return false;
  const l = lease as Partial<LeaseV1> & Record<string, unknown>;
  const keys = Object.keys(l).sort().join(',');
  if (keys !== 'expires_at,generation,lease_name,mutation,owner,repository_id,run_id,schema_version,store_kind') {
    return false;
  }
  if (l.store_kind !== 'run_lease' || l.schema_version !== 1 || l.repository_id !== 'OMCU') return false;
  if (l.run_id !== runId || typeof l.run_id !== 'string' || !SAFE_KEY.test(l.run_id)) return false;
  if (l.lease_name !== leaseName || typeof l.lease_name !== 'string' || !SAFE_KEY.test(l.lease_name)) return false;
  if (typeof l.owner !== 'string' || !SAFE_KEY.test(l.owner)) return false;
  if (!Number.isSafeInteger(l.generation) || (l.generation as number) < 1) return false;
  if (!validDate(l.expires_at)) return false;
  return validMutation(l.mutation);
}


/** Read a run without creating CLI authority or acquiring a mutation lock. */
export function observeRunState(root: StateRoot, runId: string): RunStateV1 {
  const safeRunId = safeKey(runId, 'run_id');
  const file = withinStateRoot(root, 'runs', safeRunId, 'state.json');
  try {
    const state = readJson<RunStateV1>(file);
    if (!validRunState(state, runId)) {
      throw new Error('E_RUN_STATE_INVALID');
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('E_STATE_ABSENT', { cause: error });
    throw stateCorrupt(error);
  }
}

/** Read a lease without creating CLI authority or acquiring a mutation lock. */
export function observeLease(root: StateRoot, runId: string, leaseName: string): LeaseV1 {
  const lease = readLease(root, runId, leaseName, false);
  if (lease === null) throw new Error('E_STATE_ABSENT');
  return lease;
}

function readLease(root: StateRoot, runId: string, leaseName: string, absentAsNull: boolean): LeaseV1 | null {
  const file = withinStateRoot(
    root,
    'leases',
    safeKey(runId, 'run_id'),
    `${safeKey(leaseName, 'lease_name')}.json`,
  );
  try {
    const lease = readJson<LeaseV1>(file);
    if (!validLease(lease, runId, leaseName)) {
      throw new Error('E_LEASE_INVALID');
    }
    return lease;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (absentAsNull) return null;
      throw new Error('E_STATE_ABSENT', { cause: error });
    }
    throw stateCorrupt(error);
  }
}

export class RunStateStore {
  constructor(private readonly root: StateRoot, private readonly authority: CliMutationAuthority, private readonly now: () => Date = () => new Date()) {
    assertCliMutationAuthority(authority);
  }

  private runDir(runId: string): string { return withinStateRoot(this.root, 'runs', safeKey(runId, 'run_id')); }
  private runFile(runId: string): string { return path.join(this.runDir(runId), 'state.json'); }

  read(runId: string): RunStateV1 {
    return observeRunState(this.root, runId);
  }

  async create(runId: string, objective: string): Promise<RunStateV1> {
    safeKey(runId, 'run_id');
    if (objective.trim() === '' || objective.length > 16_384) throw new Error('E_OBJECTIVE_INVALID');
    const file = this.runFile(runId);
    return withDirectoryLock(file, () => {
      assertCliMutationAuthority(this.authority);
      if (fs.existsSync(file)) throw new Error('E_RUN_EXISTS');
      const now = this.now();
      const state: RunStateV1 = {
        store_kind: 'run_state', schema_version: 1, repository_id: 'OMCU', run_id: runId,
        revision: 1, status: 'active', objective, created_at: now.toISOString(), updated_at: now.toISOString(),
        verification: { verified: false, evidence_sha256: null, verified_at: null }, last_mutation: proof(this.authority, now),
      };
      atomicWriteJson(file, state);
      return state;
    });
  }

  async transition(runId: string, expectedRevision: number, status: RunStatus): Promise<RunStateV1> {
    if (!['active', 'complete', 'failed', 'cancelled'].includes(status)) {
      throw new Error('E_RUN_STATUS_INVALID');
    }
    const file = this.runFile(runId);
    return withDirectoryLock(file, () => {
      assertCliMutationAuthority(this.authority);
      const current = this.read(runId);
      if (current.revision !== expectedRevision) throw new Error('E_REVISION_CONFLICT');
      if (TERMINAL_STATUSES.has(current.status)) {
        throw new Error('E_TRANSITION_ILLEGAL');
      }
      if (current.status === status) {
        throw new Error('E_TRANSITION_NOOP');
      }
      const rawNow = this.now();
      const updatedMs = Math.max(rawNow.getTime(), Date.parse(current.updated_at));
      const now = new Date(updatedMs);
      const next: RunStateV1 = { ...current, revision: current.revision + 1, status, updated_at: now.toISOString(), verification: { verified: false, evidence_sha256: null, verified_at: null }, last_mutation: proof(this.authority, now) };
      atomicWriteJson(file, next);
      return next;
    });
  }

  async verify(runId: string, expectedRevision: number, evidenceSha256: string): Promise<RunStateV1> {
    if (!/^[a-f0-9]{64}$/.test(evidenceSha256)) throw new Error('E_EVIDENCE_DIGEST_INVALID');
    const file = this.runFile(runId);
    return withDirectoryLock(file, () => {
      assertCliMutationAuthority(this.authority);
      const current = this.read(runId);
      if (current.revision !== expectedRevision) throw new Error('E_REVISION_CONFLICT');
      if (current.status !== 'complete') throw new Error('E_RUN_NOT_COMPLETE_FOR_VERIFICATION');
      const rawNow = this.now();
      const updatedMs = Math.max(rawNow.getTime(), Date.parse(current.updated_at));
      const now = new Date(updatedMs);
      const next: RunStateV1 = { ...current, revision: current.revision + 1, updated_at: now.toISOString(), verification: { verified: true, evidence_sha256: evidenceSha256, verified_at: now.toISOString() }, last_mutation: proof(this.authority, now) };
      atomicWriteJson(file, next);
      return next;
    });
  }

  async appendEvent(runId: string, type: string, payload: unknown): Promise<RunEventV1> {
    safeKey(type, 'event_type');
    const runState = this.read(runId);
    const file = path.join(this.runDir(runId), 'events.jsonl');
    return withDirectoryLock(file, () => {
      assertCliMutationAuthority(this.authority);
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
      if (existing.length >= 10_000) throw new Error('E_EVENT_LIMIT');
      const rawNow = this.now();
      let lastAtMs = Date.parse(runState.created_at);
      if (existing.length > 0) {
        try {
          const lastEvent = JSON.parse(existing[existing.length - 1]!) as RunEventV1;
          if (validDate(lastEvent.at)) {
            lastAtMs = Math.max(lastAtMs, Date.parse(lastEvent.at));
          }
        } catch {
          // ignore corrupted trailing event when computing clock clamp
        }
      }
      const atMs = Math.max(rawNow.getTime(), lastAtMs);
      const now = new Date(atMs);
      const event: RunEventV1 = { store_kind: 'run_event', schema_version: 1, repository_id: 'OMCU', run_id: runId, sequence: existing.length + 1, type, at: now.toISOString(), payload: redact(payload), mutation: proof(this.authority, now) };
      const line = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(line) > 64 * 1024) throw new Error('E_EVENT_TOO_LARGE');
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, line, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      return event;
    });
  }
}

export class LeaseStore {
  constructor(private readonly root: StateRoot, private readonly authority: CliMutationAuthority, private readonly now: () => Date = () => new Date()) {
    assertCliMutationAuthority(authority);
  }
  private file(runId: string, leaseName: string): string {
    return withinStateRoot(this.root, 'leases', safeKey(runId, 'run_id'), `${safeKey(leaseName, 'lease_name')}.json`);
  }
  read(runId: string, leaseName: string): LeaseV1 | null {
    return readLease(this.root, runId, leaseName, true);
  }
  async acquire(runId: string, leaseName: string, owner: string, ttlMs: number): Promise<LeaseV1> {
    safeKey(owner, 'lease_owner');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 86_400_000) throw new Error('E_LEASE_TTL_INVALID');
    const checkRun = (): RunStateV1 => {
      try {
        const runState = observeRunState(this.root, runId);
        if (runState.status !== 'active') {
          throw new Error('E_RUN_TERMINAL');
        }
        return runState;
      } catch (error) {
        if ((error as Error).message === 'E_STATE_ABSENT') {
          throw new Error('E_RUN_ABSENT', { cause: error });
        }
        throw error;
      }
    };
    checkRun();
    const file = this.file(runId, leaseName);
    return withDirectoryLock(file, () => {
      assertCliMutationAuthority(this.authority);
      checkRun();
      const current = this.read(runId, leaseName);
      const rawNow = this.now();
      const mutatedMs = current !== null ? Math.max(rawNow.getTime(), Date.parse(current.mutation.mutated_at)) : rawNow.getTime();
      const now = new Date(mutatedMs);
      if (current !== null && Date.parse(current.expires_at) > now.getTime() && current.owner !== owner) throw new Error('E_LEASE_HELD');
      const lease: LeaseV1 = { store_kind: 'run_lease', schema_version: 1, repository_id: 'OMCU', run_id: runId, lease_name: leaseName, owner, generation: (current?.generation ?? 0) + 1, expires_at: new Date(now.getTime() + ttlMs).toISOString(), mutation: proof(this.authority, now) };
      atomicWriteJson(file, lease);
      return lease;
    });
  }
  async release(runId: string, leaseName: string, owner: string, generation: number): Promise<void> {
    const file = this.file(runId, leaseName);
    await withDirectoryLock(file, () => {
      assertCliMutationAuthority(this.authority);
      const current = this.read(runId, leaseName);
      if (current === null || current.owner !== owner || current.generation !== generation) throw new Error('E_LEASE_NOT_OWNER');
      fs.unlinkSync(file);
    });
  }
}

export function sha256Evidence(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
