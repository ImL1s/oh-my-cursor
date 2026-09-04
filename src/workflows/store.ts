import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, withDirectoryLock } from '../runtime/atomic.js';
import { Journal } from '../runtime/journal.js';
import {
  observeStartIdentity,
  processNonceSha256,
  probeProcess,
  type ProcessIdentity,
  type ProcessExistence,
  type ProcessLiveness,
  type ProcessStartIdentityObservation,
} from '../runtime/process-identity.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';
import { digestObject, eventDigest, validateWorkflowDefinition, type WorkflowDefinition, type WorkflowJournalEvent, type WorkflowPlan } from './schema.js';

export const WORKFLOW_JOURNAL_MAX_RECORD_BYTES = 4 * 1024 * 1024; // 4 MiB provides ample envelope headroom for 1 MiB stdout + 1 MiB stderr + receipt metadata
export const WORKFLOW_JOURNAL_MAX_SEGMENT_BYTES = 16 * 1024 * 1024; // 16 MiB per segment

/** Current durable workflow run schema. V1 is read-only migration input. */
export interface WorkflowRunRecord {
  readonly schema_version: 2;
  readonly store_kind: 'workflow_run_record';
  readonly revision: number;
  readonly plan: WorkflowPlan;
  readonly events: readonly WorkflowJournalEvent[];
  readonly event_head_sha256: string | null;
  /**
   * Durable monotonic fence for execution leases. Never resets on release.
   * Required in v2. A v1 reader may derive a conservative lower bound from
   * revision, active lease, and history; the first successful mutation writes v2.
   */
  readonly lease_generation: number;
  readonly execution_lease: WorkflowExecutionLease | null;
  readonly lease_journal_sequence: number;
  readonly lease_history: readonly WorkflowLeaseJournalEntry[];
  readonly updated_at: string;
}

export interface WorkflowLeaseToken {
  readonly run_id: string;
  readonly task_id: string;
  readonly owner_id: string;
  readonly owner_pid: number;
  readonly owner_start_identity: string;
  readonly owner_start_identity_proven: boolean;
  readonly owner_nonce_sha256: string | null;
  readonly credential_format: 'nonce-sha256-v1' | 'legacy-unproven';
  readonly generation: number;
}

export interface WorkflowLeaseCredential {
  readonly run_id: string;
  readonly task_id: string;
  readonly owner_id: string;
  readonly owner_pid: number;
  readonly owner_start_identity: string;
  readonly owner_start_identity_proven: boolean;
  readonly owner_nonce: string;
  readonly generation: number;
}

export interface WorkflowLeaseReconciliation {
  readonly run_id: string;
  readonly task_id: string;
  readonly owner_id: string;
  readonly owner_pid: number;
  readonly owner_start_identity_sha256: string;
  readonly owner_start_identity_proven: boolean;
  readonly owner_nonce_sha256: string | null;
  readonly generation: number;
  readonly acquired_at: string;
  readonly expected_status: 'ambiguous';
  readonly expected_reason: string;
  readonly operator_confirmation: 'owner-dead-side-effects-reviewed';
}

export interface WorkflowExecutionLease extends WorkflowLeaseToken {
  readonly acquired_at: string;
  readonly expires_at: string;
}

export interface WorkflowLeaseAcquisition {
  readonly record: WorkflowRunRecord;
  readonly credential: WorkflowLeaseCredential;
}

export interface WorkflowLeaseJournalEntry {
  readonly sequence: number;
  readonly action: 'acquire' | 'release' | 'reclaim' | 'reconcile';
  readonly generation: number;
  readonly task_id: string;
  readonly owner_id: string;
  readonly owner_pid: number;
  readonly owner_start_identity_sha256: string;
  readonly owner_start_identity_proven: boolean;
  readonly owner_nonce_sha256: string | null;
  readonly credential_format: WorkflowLeaseToken['credential_format'];
  readonly token_sha256: string;
  readonly liveness: ProcessLiveness['status'] | null;
  readonly at: string;
}

export interface WorkflowLeaseStatus {
  readonly state: 'none' | ProcessLiveness['status'];
  readonly generation: number;
  readonly owner: null | {
    readonly task_id: string;
    readonly owner_id: string;
    readonly owner_pid: number;
    readonly start_identity_sha256: string;
    readonly start_identity_proven: boolean;
    readonly nonce_sha256: string | null;
    readonly acquired_at: string;
    readonly age_ms: number;
  };
  readonly reason: string | null;
}

export interface WorkflowLockRunner {
  <T>(target: string, action: () => T | Promise<T>): Promise<T>;
}

const MAX_LEASE_HISTORY = 128;

interface WorkflowJournalEntry {
  readonly event: WorkflowJournalEvent;
  readonly revision: number;
}

export class WorkflowPersistenceStore {
  constructor(
    private readonly root: StateRoot,
    private readonly now: () => Date = () => new Date(),
    private readonly processProbe: (pid: number) => ProcessExistence | boolean = probeProcess,
    private readonly identityObserver: (pid: number) => ProcessStartIdentityObservation = observeStartIdentity,
    private readonly writeJson: (file: string, value: unknown) => unknown = atomicWriteJson,
    private readonly withLock: WorkflowLockRunner = withDirectoryLock,
  ) {}

  private recordFile(runId: string): string { return withinStateRoot(this.root, 'workflows', 'runs', safe(runId, 'run_id'), 'record.json'); }
  private definitionFile(name: string, version: string): string { return withinStateRoot(this.root, 'workflows', 'definitions', safe(name, 'workflow_name'), `${safe(version, 'workflow_version')}.json`); }
  private writeWorkflowRecord(file: string, record: WorkflowRunRecord): void { this.writeJson(file, { ...record, events: [] }); }

  async installDefinition(definition: WorkflowDefinition): Promise<WorkflowDefinition> {
    const validated = validateWorkflowDefinition(definition);
    const file = this.definitionFile(validated.name, validated.version);
    return this.withLock(file, () => {
      if (fs.existsSync(file)) {
        const existing = validateWorkflowDefinition(readJson<WorkflowDefinition>(file));
        if (existing.definition_sha256 !== validated.definition_sha256) throw new Error('E_WORKFLOW_VERSION_IMMUTABLE');
        return existing;
      }
      this.writeJson(file, validated);
      return validated;
    });
  }

  readDefinition(name: string, version: string): WorkflowDefinition {
    const file = this.definitionFile(name, version);
    try {
      return validateWorkflowDefinition(readJson<WorkflowDefinition>(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('E_WORKFLOW_DEFINITION_ABSENT');
      throw new Error('E_WORKFLOW_DEFINITION_CORRUPT');
    }
  }

  listDefinitions(): readonly WorkflowDefinition[] {
    const base = withinStateRoot(this.root, 'workflows', 'definitions');
    if (!fs.existsSync(base)) return [];
    const results: WorkflowDefinition[] = [];
    for (const name of fs.readdirSync(base).sort()) {
      const dir = path.join(base, name);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const file of fs.readdirSync(dir).sort()) {
        if (!file.endsWith('.json')) continue;
        results.push(this.readDefinition(name, file.slice(0, -'.json'.length)));
      }
    }
    return results;
  }

  async create(plan: WorkflowPlan): Promise<WorkflowRunRecord> {
    validatePlan(plan);
    const file = this.recordFile(plan.run_id);
    return this.withLock(file, () => {
      if (fs.existsSync(file)) throw new Error('E_WORKFLOW_RUN_EXISTS');
      const now = this.now().toISOString();
      const record: WorkflowRunRecord = {
        schema_version: 2,
        store_kind: 'workflow_run_record',
        plan,
        revision: 1,
        events: [],
        event_head_sha256: null,
        lease_generation: 0,
        execution_lease: null,
        lease_journal_sequence: 0,
        lease_history: [],
        updated_at: now,
      };
      this.writeWorkflowRecord(file, record);
      return record;
    });
  }

  private journalDir(runId: string): string {
    return withinStateRoot(this.root, 'workflows', 'runs', safe(runId, 'run_id'), 'events_journal');
  }

  private eventJournal(runId: string): Journal<WorkflowJournalEntry> {
    return new Journal<WorkflowJournalEntry>(this.journalDir(runId), `workflows/${safe(runId, 'run_id')}`, {
      now: this.now,
      maxRecordBytes: WORKFLOW_JOURNAL_MAX_RECORD_BYTES,
      maxSegmentBytes: WORKFLOW_JOURNAL_MAX_SEGMENT_BYTES,
    });
  }

  private async migrateLegacyEvents(current: WorkflowRunRecord, journal: Journal<WorkflowJournalEntry>): Promise<void> {
    if (current.events.length > 0) {
      const head = journal.readHead();
      const startIndex = head !== null ? head.head_sequence : 0;
      if (startIndex < current.events.length) {
        for (let i = startIndex; i < current.events.length; i++) {
          const event = current.events[i]!;
          await journal.append({
            kind: event.kind,
            payload: { event, revision: i + 2 },
            at: this.now().toISOString(),
          });
        }
      }
    }
  }

  read(runId: string): WorkflowRunRecord {
    const file = this.recordFile(runId);
    try {
      const journal = this.eventJournal(runId);
      let record = normalizeRecord(readJson<unknown>(file), runId);
      const journalHead = journal.readHead();

      const shouldLoadJournal =
        journalHead !== null &&
        journalHead.head_sequence > 0 &&
        (record.events.length === 0 || journalHead.head_sequence >= record.events.length);

      if (shouldLoadJournal) {
        const entries = journal.readRange();
        const events = entries.map((r) => ('event' in (r.payload as any) ? (r.payload as any).event : (r.payload as any)) as WorkflowJournalEvent);
        const lastEntry = entries.at(-1);
        const committedRevision = lastEntry && typeof (lastEntry.payload as any)?.revision === 'number'
          ? (lastEntry.payload as any).revision as number
          : events.length + 1;
        const effectiveRevision = Math.max(record.revision, committedRevision);
        record = { ...record, revision: effectiveRevision, events, event_head_sha256: events.at(-1)?.event_sha256 ?? null };
      }
      validateRecord(record, runId);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('E_WORKFLOW_RUN_ABSENT');
      throw new Error('E_WORKFLOW_RUN_CORRUPT');
    }
  }

  async append(runId: string, expectedRevision: number, event: WorkflowJournalEvent): Promise<WorkflowRunRecord> {
    const file = this.recordFile(runId);
    const journal = this.eventJournal(runId);
    return this.withLock(file, async () => {
      const current = this.read(runId);
      if (current.revision !== expectedRevision) throw new Error('E_WORKFLOW_REVISION_CONFLICT');
      await this.migrateLegacyEvents(current, journal);

      if (event.run_id !== runId || event.sequence !== current.events.length + 1 || event.previous_event_sha256 !== current.event_head_sha256) throw new Error('E_WORKFLOW_EVENT_FENCE');
      const { event_sha256: claimedDigest, ...material } = event;
      if (eventDigest(material) !== claimedDigest) throw new Error('E_WORKFLOW_EVENT_DIGEST');

      const nextRevision = current.revision + 1;
      await journal.append({
        kind: event.kind,
        payload: { event, revision: nextRevision },
        at: this.now().toISOString(),
      });

      const updatedEvents = [...current.events, event];
      const next: WorkflowRunRecord = {
        ...current,
        revision: nextRevision,
        events: updatedEvents,
        event_head_sha256: event.event_sha256,
        updated_at: this.now().toISOString(),
      };
      this.writeWorkflowRecord(file, next);
      return next;
    });
  }

  readEvents(runId: string): readonly WorkflowJournalEvent[] {
    const journal = this.eventJournal(runId);
    const head = journal.readHead();
    const current = this.read(runId);
    if (head !== null && head.head_sequence > 0 && (current.events.length === 0 || head.head_sequence >= current.events.length)) {
      return journal.readRange().map((r) => ('event' in (r.payload as any) ? (r.payload as any).event : (r.payload as any)) as WorkflowJournalEvent);
    }
    return current.events;
  }

  async acquireExecutionLease(
    runId: string,
    expectedRevision: number,
    taskId: string,
    ownerId: string,
    ownerIdentity: ProcessIdentity,
    ttlMs = 120_000,
  ): Promise<WorkflowLeaseAcquisition> {
    safe(taskId, 'task_id'); safe(ownerId, 'lease_owner');
    validateProcessIdentity(ownerIdentity);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3_600_000) throw new Error('E_WORKFLOW_LEASE_INPUT');
    const file = this.recordFile(runId);
    const journal = this.eventJournal(runId);
    return this.withLock(file, async () => {
      const current = this.read(runId);
      await this.migrateLegacyEvents(current, journal);
      if (current.revision !== expectedRevision) throw new Error('E_WORKFLOW_REVISION_CONFLICT');
      if (!current.plan.tasks.some((task) => task.task_id === taskId)) throw new Error('E_WORKFLOW_LEASE_TASK_NOT_IN_PLAN');
      const now = this.now();
      const prior = current.execution_lease;
      // TTL is diagnostic only while the recorded owner process is alive. Without
      // a renewable fencing token, wall-clock expiry cannot safely authorize a
      // second Cursor invocation.
      let liveness: ProcessLiveness | null = null;
      if (prior !== null) {
        liveness = prior.generation < current.lease_generation
          ? { status: 'stale' }
          : this.classifyLease(prior);
      }
      if (liveness?.status === 'active') throw new Error('E_WORKFLOW_LEASE_HELD');
      if (liveness?.status === 'ambiguous') throw new Error('E_WORKFLOW_LEASE_AMBIGUOUS');
      if (current.lease_generation >= Number.MAX_SAFE_INTEGER) throw new Error('E_WORKFLOW_LEASE_GENERATION_EXHAUSTED');
      const generation = current.lease_generation + 1;
      const credential: WorkflowLeaseCredential = {
        run_id: runId,
        task_id: taskId,
        owner_id: ownerId,
        owner_pid: ownerIdentity.pid,
        owner_start_identity: ownerIdentity.start_identity,
        owner_start_identity_proven: ownerIdentity.start_identity_proven,
        owner_nonce: ownerIdentity.nonce,
        generation,
      };
      const lease: WorkflowExecutionLease = {
        run_id: runId,
        task_id: taskId,
        owner_id: ownerId,
        owner_pid: ownerIdentity.pid,
        owner_start_identity: ownerIdentity.start_identity,
        owner_start_identity_proven: ownerIdentity.start_identity_proven,
        owner_nonce_sha256: processNonceSha256(ownerIdentity.nonce),
        credential_format: 'nonce-sha256-v1',
        generation,
        acquired_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttlMs).toISOString(),
      };
      const next: WorkflowRunRecord = {
        ...current,
        revision: current.revision + 1,
        lease_generation: generation,
        execution_lease: lease,
        lease_journal_sequence: current.lease_journal_sequence + (prior === null ? 1 : 2),
        lease_history: appendLeaseHistory(current.lease_history, [
          ...(prior === null || liveness === null ? [] : [leaseJournal(current.lease_journal_sequence + 1, 'reclaim', prior, now, liveness.status)]),
          leaseJournal(current.lease_journal_sequence + (prior === null ? 1 : 2), 'acquire', lease, now, null),
        ]),
        updated_at: now.toISOString(),
      };
      this.writeWorkflowRecord(file, next);
      return { record: next, credential };
    });
  }

  async releaseExecutionLease(runId: string, expectedRevision: number, credential: WorkflowLeaseCredential): Promise<WorkflowRunRecord> {
    const token = persistedTokenFromCredential(credential, runId);
    const file = this.recordFile(runId);
    const journal = this.eventJournal(runId);
    return this.withLock(file, async () => {
      const current = this.read(runId);
      await this.migrateLegacyEvents(current, journal);
      const lease = current.execution_lease;
      if (lease === null) {
        const last = current.lease_history.at(-1);
        if (current.revision === expectedRevision + 1 && token.generation === current.lease_generation && last?.action === 'release' && last.token_sha256 === tokenDigest(token)) return current;
      }
      if (current.revision !== expectedRevision) throw new Error('E_WORKFLOW_REVISION_CONFLICT');
      if (lease === null) throw new Error('E_WORKFLOW_LEASE_NOT_OWNER');
      if (lease.generation !== current.lease_generation || !sameLeaseToken(lease, token)) {
        throw new Error('E_WORKFLOW_LEASE_NOT_OWNER');
      }
      // Keep lease_generation so the next acquire is strictly greater (#10).
      const next: WorkflowRunRecord = {
        ...current,
        revision: current.revision + 1,
        execution_lease: null,
        lease_journal_sequence: current.lease_journal_sequence + 1,
        lease_history: appendLeaseHistory(current.lease_history, [leaseJournal(current.lease_journal_sequence + 1, 'release', lease, this.now(), null)]),
        updated_at: this.now().toISOString(),
      };
      this.writeWorkflowRecord(file, next);
      return next;
    });
  }

  executionLeaseStatus(runId: string): WorkflowLeaseStatus {
    const record = this.read(runId);
    const lease = record.execution_lease;
    if (lease === null) return { state: 'none', generation: record.lease_generation, owner: null, reason: null };
    const liveness = lease.generation < record.lease_generation ? { status: 'stale' as const } : this.classifyLease(lease);
    return {
      state: liveness.status,
      generation: lease.generation,
      owner: {
        task_id: lease.task_id,
        owner_id: lease.owner_id,
        owner_pid: lease.owner_pid,
        start_identity_sha256: digestObject(lease.owner_start_identity),
        start_identity_proven: lease.owner_start_identity_proven,
        nonce_sha256: lease.owner_nonce_sha256,
        acquired_at: lease.acquired_at,
        age_ms: Math.max(0, this.now().getTime() - Date.parse(lease.acquired_at)),
      },
      reason: liveness.status === 'ambiguous' ? liveness.reason : null,
    };
  }

  async reconcileAmbiguousExecutionLease(
    runId: string,
    expectedRevision: number,
    proof: WorkflowLeaseCredential | WorkflowLeaseReconciliation,
  ): Promise<WorkflowRunRecord> {
    const acknowledgement = isLeaseReconciliation(proof);
    const token = acknowledgement ? null : persistedTokenFromCredential(proof, runId);
    if (acknowledgement) validateLeaseReconciliation(proof, runId);
    const file = this.recordFile(runId);
    const journal = this.eventJournal(runId);
    return this.withLock(file, async () => {
      const current = this.read(runId);
      await this.migrateLegacyEvents(current, journal);
      if (current.revision !== expectedRevision) throw new Error('E_WORKFLOW_REVISION_CONFLICT');
      const lease = current.execution_lease;
      if (lease === null) throw new Error('E_WORKFLOW_LEASE_NOT_OWNER');
      if (acknowledgement) {
        if (!sameLeaseReconciliation(lease, proof)) throw new Error('E_WORKFLOW_LEASE_NOT_OWNER');
      } else if (token === null || !sameLeaseToken(lease, token)) throw new Error('E_WORKFLOW_LEASE_NOT_OWNER');
      const liveness = this.classifyLease(lease);
      if (liveness.status !== 'ambiguous') throw new Error('E_WORKFLOW_LEASE_RECONCILE_NOT_AMBIGUOUS');
      if (acknowledgement && liveness.reason !== proof.expected_reason) throw new Error('E_WORKFLOW_LEASE_RECONCILE_STATUS_CHANGED');
      const now = this.now();
      const next: WorkflowRunRecord = {
        ...current,
        revision: current.revision + 1,
        execution_lease: null,
        lease_journal_sequence: current.lease_journal_sequence + 1,
        lease_history: appendLeaseHistory(current.lease_history, [leaseJournal(current.lease_journal_sequence + 1, 'reconcile', lease, now, liveness.status)]),
        updated_at: now.toISOString(),
      };
      this.writeWorkflowRecord(file, next);
      return next;
    });
  }

  private classifyLease(lease: WorkflowExecutionLease): ProcessLiveness {
    // A nonce-less lease cannot prove possession of the acquisition
    // credential. Even a proven-dead PID is insufficient because the operator
    // must explicitly acknowledge that possible external side effects were
    // reviewed before the fence is cleared.
    if (lease.owner_nonce_sha256 === null) return { status: 'ambiguous', reason: 'legacy_nonce_unproven' };
    const probe = this.processProbe(lease.owner_pid);
    const existence: ProcessExistence = typeof probe === 'boolean'
      ? { status: probe ? 'alive' : 'dead' }
      : probe;
    if (existence.status === 'dead') return { status: 'dead' };
    if (existence.status === 'ambiguous') return existence;
    const observed = this.identityObserver(lease.owner_pid);
    if (!lease.owner_start_identity_proven || !observed.proven) {
      return { status: 'ambiguous', reason: observed.source === 'unsupported' ? 'platform_identity_unsupported' : 'start_identity_unproven' };
    }
    return observed.value === lease.owner_start_identity ? { status: 'active' } : { status: 'stale' };
  }
}

function normalizeRecord(raw: unknown, runId: string): WorkflowRunRecord {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  const input = raw as Record<string, unknown>;
  if (input.schema_version !== 1 && input.schema_version !== 2) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  const modern = input.schema_version === 2;
  let history: readonly WorkflowLeaseJournalEntry[];
  if (hasOwn(input, 'lease_history')) {
    history = normalizeLeaseHistory(input.lease_history, modern);
  } else {
    history = modern ? invalidRecord() : [];
  }
  let persistedGeneration: number;
  if (hasOwn(input, 'lease_generation')) {
    persistedGeneration = validCounter(input.lease_generation);
  } else {
    persistedGeneration = modern
      ? invalidRecord()
      : Math.max(0, Number.isSafeInteger(input.revision) ? input.revision as number : 0);
  }
  const leaseGen = modern
    ? persistedGeneration
    : Math.max(persistedGeneration, leaseGeneration(input.execution_lease), ...history.map((entry) => entry.generation));
  let lease: WorkflowExecutionLease | null;
  if (hasOwn(input, 'execution_lease')) {
    lease = input.execution_lease === null
      ? null
      : normalizeLease(input.execution_lease, runId, modern);
  } else {
    lease = modern ? invalidRecord() : null;
  }
  let journalSequence: number;
  if (hasOwn(input, 'lease_journal_sequence')) {
    journalSequence = validCounter(input.lease_journal_sequence);
  } else {
    journalSequence = modern ? invalidRecord() : history.at(-1)?.sequence ?? 0;
  }
  return {
    ...input,
    schema_version: 2,
    lease_generation: leaseGen,
    execution_lease: lease,
    lease_journal_sequence: journalSequence,
    lease_history: history,
    plan: input.plan,
  } as WorkflowRunRecord;
}

function normalizeLease(raw: unknown, runId: string, modern: boolean): WorkflowExecutionLease {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  const lease = raw as Record<string, unknown>;
  const required = ['run_id', 'task_id', 'owner_id', 'owner_pid', 'owner_start_identity', 'owner_start_identity_proven', 'owner_nonce_sha256', 'credential_format', 'generation', 'acquired_at', 'expires_at'] as const;
  if (modern && required.some((field) => !hasOwn(lease, field))) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  const hasNonceDigest = hasOwn(lease, 'owner_nonce_sha256');
  const hasCredentialFormat = hasOwn(lease, 'credential_format');
  const rawNonceDigest = lease.owner_nonce_sha256;
  const rawCredentialFormat = lease.credential_format;
  if (hasNonceDigest && rawNonceDigest === undefined) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  if (rawNonceDigest === null && rawCredentialFormat !== 'legacy-unproven') {
    throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  }
  if (rawNonceDigest !== undefined && rawNonceDigest !== null
    && (typeof rawNonceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(rawNonceDigest))) {
    throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  }
  if (rawCredentialFormat !== undefined
    && rawCredentialFormat !== 'nonce-sha256-v1'
    && rawCredentialFormat !== 'legacy-unproven') {
    throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  }
  if (rawCredentialFormat === 'nonce-sha256-v1' && rawNonceDigest === undefined) {
    throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  }
  if (!hasNonceDigest && hasCredentialFormat && rawCredentialFormat !== 'legacy-unproven') throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  return {
    run_id: hasOwn(lease, 'run_id') ? lease.run_id as string : runId,
    task_id: lease.task_id as string,
    owner_id: lease.owner_id as string,
    owner_pid: lease.owner_pid as number,
    owner_start_identity: hasOwn(lease, 'owner_start_identity') ? lease.owner_start_identity as string : `legacy:${String(lease.owner_pid)}`,
    owner_start_identity_proven: hasOwn(lease, 'owner_start_identity_proven') ? lease.owner_start_identity_proven as boolean : false,
    // Only a truly absent field identifies the original legacy on-disk format.
    // Once normalized, an explicit legacy marker makes its null digest durable.
    owner_nonce_sha256: rawNonceDigest ?? null,
    credential_format: !hasNonceDigest ? 'legacy-unproven' : rawCredentialFormat as WorkflowLeaseToken['credential_format'] ?? 'nonce-sha256-v1',
    generation: lease.generation as number,
    acquired_at: lease.acquired_at as string,
    expires_at: lease.expires_at as string,
  };
}

function validateRecord(record: WorkflowRunRecord, runId: string): void {
  if (record.schema_version !== 2 || record.store_kind !== 'workflow_run_record' || !Array.isArray(record.events) || record.plan.run_id !== runId || !Number.isSafeInteger(record.revision) || record.revision < record.events.length + 1 || !isTimestamp(record.updated_at)) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  validatePlan(record.plan);
  for (const [index, event] of record.events.entries()) {
    const previous = index === 0 ? null : record.events[index - 1]!.event_sha256;
    const { event_sha256: claimedDigest, ...material } = event;
    if (event.schema_version !== 1 || event.run_id !== runId || event.sequence !== index + 1 || event.previous_event_sha256 !== previous || eventDigest(material) !== claimedDigest) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  }
  if (!Number.isSafeInteger(record.lease_generation) || record.lease_generation < 0) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  if (record.execution_lease !== null && record.execution_lease.generation !== record.lease_generation) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  if (record.execution_lease !== null) {
    validateLeaseToken(record.execution_lease, runId);
    if (!isTimestamp(record.execution_lease.acquired_at) || !isTimestamp(record.execution_lease.expires_at) || Date.parse(record.execution_lease.expires_at) < Date.parse(record.execution_lease.acquired_at)) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  }
  if (!Number.isSafeInteger(record.lease_journal_sequence) || record.lease_journal_sequence < 0 || record.lease_history.at(-1)?.sequence !== record.lease_journal_sequence && record.lease_history.length > 0 || record.lease_history.some((entry) => entry.generation > record.lease_generation)) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  const head = record.events.at(-1)?.event_sha256 ?? null;
  if (head !== record.event_head_sha256) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
}

function validateProcessIdentity(identity: ProcessIdentity): void {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 1 || typeof identity.start_identity !== 'string' || identity.start_identity.length < 1 || identity.start_identity.length > 512 || typeof identity.start_identity_proven !== 'boolean') throw new Error('E_WORKFLOW_LEASE_INPUT');
  processNonceSha256(identity.nonce);
}

function validateLeaseToken(token: WorkflowLeaseToken, runId: string): void {
  if (token.run_id !== runId || !Number.isSafeInteger(token.owner_pid) || token.owner_pid <= 1 || !Number.isSafeInteger(token.generation) || token.generation < 1) throw new Error('E_WORKFLOW_LEASE_TOKEN_INVALID');
  safe(token.task_id, 'task_id'); safe(token.owner_id, 'lease_owner');
  if (typeof token.owner_start_identity !== 'string' || token.owner_start_identity.length < 1 || token.owner_start_identity.length > 512 || typeof token.owner_start_identity_proven !== 'boolean' || (token.owner_nonce_sha256 !== null && !/^[a-f0-9]{64}$/.test(token.owner_nonce_sha256)) || ((token.credential_format === 'nonce-sha256-v1') !== (token.owner_nonce_sha256 !== null))) throw new Error('E_WORKFLOW_LEASE_TOKEN_INVALID');
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function persistedTokenFromCredential(credential: WorkflowLeaseCredential, runId: string): WorkflowLeaseToken {
  if (credential.run_id !== runId) throw new Error('E_WORKFLOW_LEASE_TOKEN_INVALID');
  const token: WorkflowLeaseToken = {
    run_id: credential.run_id,
    task_id: credential.task_id,
    owner_id: credential.owner_id,
    owner_pid: credential.owner_pid,
    owner_start_identity: credential.owner_start_identity,
    owner_start_identity_proven: credential.owner_start_identity_proven,
    owner_nonce_sha256: processNonceSha256(credential.owner_nonce),
    credential_format: 'nonce-sha256-v1',
    generation: credential.generation,
  };
  validateLeaseToken(token, runId);
  return token;
}

function isLeaseReconciliation(
  proof: WorkflowLeaseCredential | WorkflowLeaseReconciliation,
): proof is WorkflowLeaseReconciliation {
  return 'operator_confirmation' in proof;
}

function validateLeaseReconciliation(proof: WorkflowLeaseReconciliation, runId: string): void {
  if (proof.run_id !== runId || proof.operator_confirmation !== 'owner-dead-side-effects-reviewed' || proof.expected_status !== 'ambiguous' || !Number.isSafeInteger(proof.owner_pid) || proof.owner_pid <= 1 || !Number.isSafeInteger(proof.generation) || proof.generation < 1 || !/^[a-f0-9]{64}$/.test(proof.owner_start_identity_sha256) || (proof.owner_nonce_sha256 !== null && !/^[a-f0-9]{64}$/.test(proof.owner_nonce_sha256)) || typeof proof.owner_start_identity_proven !== 'boolean' || typeof proof.acquired_at !== 'string' || !Number.isFinite(Date.parse(proof.acquired_at)) || typeof proof.expected_reason !== 'string' || proof.expected_reason.length < 1) throw new Error('E_WORKFLOW_LEASE_TOKEN_INVALID');
  safe(proof.task_id, 'task_id'); safe(proof.owner_id, 'lease_owner');
}

function sameLeaseReconciliation(lease: WorkflowExecutionLease, proof: WorkflowLeaseReconciliation): boolean {
  return lease.run_id === proof.run_id
    && lease.task_id === proof.task_id
    && lease.owner_id === proof.owner_id
    && lease.owner_pid === proof.owner_pid
    && digestObject(lease.owner_start_identity) === proof.owner_start_identity_sha256
    && lease.owner_start_identity_proven === proof.owner_start_identity_proven
    && lease.owner_nonce_sha256 === proof.owner_nonce_sha256
    && lease.generation === proof.generation
    && lease.acquired_at === proof.acquired_at;
}

function sameLeaseToken(lease: WorkflowLeaseToken, token: WorkflowLeaseToken): boolean {
  return tokenDigest(lease) === tokenDigest(token);
}

function tokenDigest(token: WorkflowLeaseToken): string {
  return digestObject({
    run_id: token.run_id,
    task_id: token.task_id,
    owner_id: token.owner_id,
    owner_pid: token.owner_pid,
    owner_start_identity: token.owner_start_identity,
    owner_start_identity_proven: token.owner_start_identity_proven,
    owner_nonce_sha256: token.owner_nonce_sha256,
    credential_format: token.credential_format,
    generation: token.generation,
  });
}

function leaseJournal(
  sequence: number,
  action: WorkflowLeaseJournalEntry['action'],
  token: WorkflowLeaseToken,
  at: Date,
  liveness: WorkflowLeaseJournalEntry['liveness'],
): WorkflowLeaseJournalEntry {
  return {
    sequence,
    action,
    generation: token.generation,
    task_id: token.task_id,
    owner_id: token.owner_id,
    owner_pid: token.owner_pid,
    owner_start_identity_sha256: digestObject(token.owner_start_identity),
    owner_start_identity_proven: token.owner_start_identity_proven,
    owner_nonce_sha256: token.owner_nonce_sha256,
    credential_format: token.credential_format,
    token_sha256: tokenDigest(token),
    liveness,
    at: at.toISOString(),
  };
}

function appendLeaseHistory(
  history: readonly WorkflowLeaseJournalEntry[],
  entries: readonly WorkflowLeaseJournalEntry[],
): readonly WorkflowLeaseJournalEntry[] {
  return [...history, ...entries].slice(-MAX_LEASE_HISTORY);
}

function normalizeLeaseHistory(raw: unknown, modern: boolean): readonly WorkflowLeaseJournalEntry[] {
  if (!Array.isArray(raw)) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  const normalized: WorkflowLeaseJournalEntry[] = [];
  for (const [index, entry] of raw.entries()) {
    if (entry === null || typeof entry !== 'object') throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
    const item = entry as Record<string, unknown>;
    const previous = normalized.at(-1) ?? null;
    const hasNonceDigest = hasOwn(item, 'owner_nonce_sha256');
    const hasCredentialFormat = hasOwn(item, 'credential_format');
    if (modern && (!hasNonceDigest || !hasCredentialFormat)) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
    if (hasNonceDigest && item.owner_nonce_sha256 === undefined) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
    if (hasNonceDigest && item.owner_nonce_sha256 === null && item.credential_format !== 'legacy-unproven') throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
    let credentialFormat = item.credential_format;
    if (!hasCredentialFormat) {
      credentialFormat = item.owner_nonce_sha256 === null || !hasNonceDigest
        ? 'legacy-unproven'
        : 'nonce-sha256-v1';
    }
    if ((credentialFormat !== 'nonce-sha256-v1' && credentialFormat !== 'legacy-unproven') || ((credentialFormat === 'nonce-sha256-v1') !== (typeof item.owner_nonce_sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.owner_nonce_sha256)))) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
    if (!Number.isSafeInteger(item.sequence) || (previous !== null && item.sequence !== previous.sequence + 1) || !['acquire', 'release', 'reclaim', 'reconcile'].includes(item.action as string) || !Number.isSafeInteger(item.generation) || (item.generation as number) < 1 || typeof item.task_id !== 'string' || typeof item.owner_id !== 'string' || !Number.isSafeInteger(item.owner_pid) || !/^[a-f0-9]{64}$/.test(item.owner_start_identity_sha256 as string) || typeof item.owner_start_identity_proven !== 'boolean' || !/^[a-f0-9]{64}$/.test(item.token_sha256 as string) || (item.liveness !== null && !['active', 'dead', 'stale', 'ambiguous'].includes(item.liveness as string)) || !isTimestamp(item.at)) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
    normalized.push({ ...item, owner_nonce_sha256: hasNonceDigest ? item.owner_nonce_sha256 as string | null : null, credential_format: credentialFormat } as WorkflowLeaseJournalEntry);
  }
  return normalized;
}

function hasOwn(value: object, property: string): boolean { return Object.prototype.hasOwnProperty.call(value, property); }
function invalidRecord(): never { throw new Error('E_WORKFLOW_RUN_RECORD_INVALID'); }
function validCounter(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalidRecord();
  return value as number;
}
function leaseGeneration(value: unknown): number {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return 0;
  const generation = (value as Record<string, unknown>).generation;
  return Number.isSafeInteger(generation) && (generation as number) >= 1 ? generation as number : 0;
}

function validatePlan(plan: WorkflowPlan): void {
  const { plan_sha256: claimedDigest, ...material } = plan;
  if (plan.schema_version !== 1 || digestObject(material) !== claimedDigest) throw new Error('E_WORKFLOW_PLAN_INVALID');
}

function readJson<T>(file: string): T { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
function safe(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || path.basename(value) !== value) throw new Error(`E_${label.toUpperCase()}_INVALID`);
  return value;
}
