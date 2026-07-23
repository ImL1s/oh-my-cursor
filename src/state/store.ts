import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, withDirectoryLock } from '../runtime/atomic.js';
import { redact } from '../runtime/redaction.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';
import { assertCliMutationAuthority, authorityDigest, type CliMutationAuthority } from './authority.js';
import type { LeaseV1, MutationProof, RunEventV1, RunStateV1, RunStatus } from './types.js';

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

export class RunStateStore {
  constructor(private readonly root: StateRoot, private readonly authority: CliMutationAuthority, private readonly now: () => Date = () => new Date()) {
    assertCliMutationAuthority(authority);
  }

  private runDir(runId: string): string { return withinStateRoot(this.root, 'runs', safeKey(runId, 'run_id')); }
  private runFile(runId: string): string { return path.join(this.runDir(runId), 'state.json'); }

  read(runId: string): RunStateV1 {
    const state = readJson<RunStateV1>(this.runFile(runId));
    if (state.store_kind !== 'run_state' || state.schema_version !== 1 || state.run_id !== runId) throw new Error('E_RUN_STATE_INVALID');
    return state;
  }

  async create(runId: string, objective: string): Promise<RunStateV1> {
    safeKey(runId, 'run_id');
    if (objective.trim() === '' || objective.length > 16_384) throw new Error('E_OBJECTIVE_INVALID');
    const file = this.runFile(runId);
    return withDirectoryLock(file, () => {
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
      const current = this.read(runId);
      if (current.revision !== expectedRevision) throw new Error('E_REVISION_CONFLICT');
      const now = this.now();
      const next: RunStateV1 = { ...current, revision: current.revision + 1, status, updated_at: now.toISOString(), verification: { verified: false, evidence_sha256: null, verified_at: null }, last_mutation: proof(this.authority, now) };
      atomicWriteJson(file, next);
      return next;
    });
  }

  async verify(runId: string, expectedRevision: number, evidenceSha256: string): Promise<RunStateV1> {
    if (!/^[a-f0-9]{64}$/.test(evidenceSha256)) throw new Error('E_EVIDENCE_DIGEST_INVALID');
    const file = this.runFile(runId);
    return withDirectoryLock(file, () => {
      const current = this.read(runId);
      if (current.revision !== expectedRevision) throw new Error('E_REVISION_CONFLICT');
      if (current.status === 'active') throw new Error('E_ACTIVE_RUN_NOT_VERIFIABLE');
      const now = this.now();
      const next: RunStateV1 = { ...current, revision: current.revision + 1, updated_at: now.toISOString(), verification: { verified: true, evidence_sha256: evidenceSha256, verified_at: now.toISOString() }, last_mutation: proof(this.authority, now) };
      atomicWriteJson(file, next);
      return next;
    });
  }

  async appendEvent(runId: string, type: string, payload: unknown): Promise<RunEventV1> {
    safeKey(type, 'event_type');
    this.read(runId);
    const file = path.join(this.runDir(runId), 'events.jsonl');
    return withDirectoryLock(file, () => {
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
      if (existing.length >= 10_000) throw new Error('E_EVENT_LIMIT');
      const now = this.now();
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
    const file = this.file(runId, leaseName);
    if (!fs.existsSync(file)) return null;
    const lease = readJson<LeaseV1>(file);
    if (lease.run_id !== runId || lease.lease_name !== leaseName) throw new Error('E_LEASE_INVALID');
    return lease;
  }
  async acquire(runId: string, leaseName: string, owner: string, ttlMs: number): Promise<LeaseV1> {
    safeKey(owner, 'lease_owner');
    if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 86_400_000) throw new Error('E_LEASE_TTL_INVALID');
    const file = this.file(runId, leaseName);
    return withDirectoryLock(file, () => {
      const now = this.now();
      const current = this.read(runId, leaseName);
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
