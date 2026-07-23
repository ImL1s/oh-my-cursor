import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, withDirectoryLock } from '../runtime/atomic.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';
import { digestObject, eventDigest, validateWorkflowDefinition, type WorkflowDefinition, type WorkflowJournalEvent, type WorkflowPlan } from './schema.js';

export interface WorkflowRunRecord {
  readonly schema_version: 1;
  readonly store_kind: 'workflow_run_record';
  readonly revision: number;
  readonly plan: WorkflowPlan;
  readonly events: readonly WorkflowJournalEvent[];
  readonly event_head_sha256: string | null;
  readonly execution_lease: WorkflowExecutionLease | null;
  readonly updated_at: string;
}

export interface WorkflowExecutionLease {
  readonly task_id: string;
  readonly owner_id: string;
  readonly owner_pid: number;
  readonly generation: number;
  readonly acquired_at: string;
  readonly expires_at: string;
}

export class WorkflowPersistenceStore {
  constructor(
    private readonly root: StateRoot,
    private readonly now: () => Date = () => new Date(),
    private readonly processAlive: (pid: number) => boolean = defaultProcessAlive,
  ) {}

  private recordFile(runId: string): string { return withinStateRoot(this.root, 'workflows', 'runs', safe(runId, 'run_id'), 'record.json'); }
  private definitionFile(name: string, version: string): string { return withinStateRoot(this.root, 'workflows', 'definitions', safe(name, 'workflow_name'), `${safe(version, 'workflow_version')}.json`); }

  async installDefinition(definition: WorkflowDefinition): Promise<WorkflowDefinition> {
    const validated = validateWorkflowDefinition(definition);
    const file = this.definitionFile(validated.name, validated.version);
    return withDirectoryLock(file, () => {
      if (fs.existsSync(file)) {
        const existing = validateWorkflowDefinition(readJson<WorkflowDefinition>(file));
        if (existing.definition_sha256 !== validated.definition_sha256) throw new Error('E_WORKFLOW_VERSION_IMMUTABLE');
        return existing;
      }
      atomicWriteJson(file, validated);
      return validated;
    });
  }

  readDefinition(name: string, version: string): WorkflowDefinition {
    return validateWorkflowDefinition(readJson<WorkflowDefinition>(this.definitionFile(name, version)));
  }

  listDefinitions(): readonly WorkflowDefinition[] {
    const base = withinStateRoot(this.root, 'workflows', 'definitions');
    if (!fs.existsSync(base)) return [];
    const definitions: WorkflowDefinition[] = [];
    for (const name of fs.readdirSync(base).sort()) {
      const directory = path.join(base, name);
      if (!fs.statSync(directory).isDirectory()) continue;
      for (const file of fs.readdirSync(directory).filter((entry) => entry.endsWith('.json')).sort()) {
        definitions.push(validateWorkflowDefinition(readJson<WorkflowDefinition>(path.join(directory, file))));
      }
    }
    return definitions.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
  }

  async create(plan: WorkflowPlan): Promise<WorkflowRunRecord> {
    validatePlan(plan);
    const file = this.recordFile(plan.run_id);
    return withDirectoryLock(file, () => {
      if (fs.existsSync(file)) throw new Error('E_WORKFLOW_RUN_EXISTS');
      const record: WorkflowRunRecord = { schema_version: 1, store_kind: 'workflow_run_record', revision: 1, plan, events: [], event_head_sha256: null, execution_lease: null, updated_at: this.now().toISOString() };
      atomicWriteJson(file, record);
      return record;
    });
  }

  read(runId: string): WorkflowRunRecord {
    const record = readJson<WorkflowRunRecord>(this.recordFile(runId));
    validateRecord(record, runId);
    return record;
  }

  async append(runId: string, expectedRevision: number, event: WorkflowJournalEvent): Promise<WorkflowRunRecord> {
    const file = this.recordFile(runId);
    return withDirectoryLock(file, () => {
      const current = this.read(runId);
      if (current.revision !== expectedRevision) throw new Error('E_WORKFLOW_REVISION_CONFLICT');
      if (event.run_id !== runId || event.sequence !== current.events.length + 1 || event.previous_event_sha256 !== current.event_head_sha256) throw new Error('E_WORKFLOW_EVENT_FENCE');
      const { event_sha256: claimedDigest, ...material } = event;
      if (eventDigest(material) !== claimedDigest) throw new Error('E_WORKFLOW_EVENT_DIGEST');
      const next: WorkflowRunRecord = {
        ...current,
        revision: current.revision + 1,
        events: [...current.events, event],
        event_head_sha256: event.event_sha256,
        updated_at: this.now().toISOString(),
      };
      atomicWriteJson(file, next);
      return next;
    });
  }

  async acquireExecutionLease(runId: string, expectedRevision: number, taskId: string, ownerId: string, ownerPid: number, ttlMs = 120_000): Promise<WorkflowRunRecord> {
    safe(taskId, 'task_id'); safe(ownerId, 'lease_owner');
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3_600_000) throw new Error('E_WORKFLOW_LEASE_INPUT');
    const file = this.recordFile(runId);
    return withDirectoryLock(file, () => {
      const current = this.read(runId);
      if (current.revision !== expectedRevision) throw new Error('E_WORKFLOW_REVISION_CONFLICT');
      const now = this.now();
      const prior = current.execution_lease;
      // TTL is diagnostic only while the recorded owner process is alive. Without
      // a renewable fencing token, wall-clock expiry cannot safely authorize a
      // second Cursor invocation.
      const stale = prior !== null && !this.processAlive(prior.owner_pid);
      if (prior !== null && !stale) throw new Error('E_WORKFLOW_LEASE_HELD');
      const lease: WorkflowExecutionLease = {
        task_id: taskId,
        owner_id: ownerId,
        owner_pid: ownerPid,
        generation: (prior?.generation ?? 0) + 1,
        acquired_at: now.toISOString(),
        expires_at: new Date(now.getTime() + ttlMs).toISOString(),
      };
      const next: WorkflowRunRecord = { ...current, revision: current.revision + 1, execution_lease: lease, updated_at: now.toISOString() };
      atomicWriteJson(file, next);
      return next;
    });
  }

  async releaseExecutionLease(runId: string, expectedRevision: number, taskId: string, ownerId: string, generation: number): Promise<WorkflowRunRecord> {
    const file = this.recordFile(runId);
    return withDirectoryLock(file, () => {
      const current = this.read(runId);
      if (current.revision !== expectedRevision) throw new Error('E_WORKFLOW_REVISION_CONFLICT');
      const lease = current.execution_lease;
      if (lease === null || lease.task_id !== taskId || lease.owner_id !== ownerId || lease.generation !== generation) throw new Error('E_WORKFLOW_LEASE_NOT_OWNER');
      const next: WorkflowRunRecord = { ...current, revision: current.revision + 1, execution_lease: null, updated_at: this.now().toISOString() };
      atomicWriteJson(file, next);
      return next;
    });
  }
}

function validateRecord(record: WorkflowRunRecord, runId: string): void {
  if (record.schema_version !== 1 || record.store_kind !== 'workflow_run_record' || record.plan.run_id !== runId || !Number.isSafeInteger(record.revision) || record.revision < record.events.length + 1) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
  const head = record.events.at(-1)?.event_sha256 ?? null;
  if (head !== record.event_head_sha256) throw new Error('E_WORKFLOW_RUN_RECORD_INVALID');
}

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
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
