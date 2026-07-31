import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessIdentity, ProcessStartIdentityObservation } from '../../src/runtime/process-identity.js';
import { projectStateRoot } from '../../src/runtime/state-root.js';
import { digestObject, eventDigest, type WorkflowJournalEvent } from '../../src/workflows/schema.js';
import { planWorkflow, WorkflowPersistenceStore, WorkflowRegistry, type WorkflowExecutionLease, type WorkflowLockRunner } from '../../src/workflows/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function definition() {
  return {
    schema_version: 1 as const,
    name: 'delivery',
    version: '1.0.0',
    capability_tier: 'cursor-backed' as const,
    stages: [{ id: 'plan', prompt: 'plan safely', mode: 'plan' as const, depends_on: [], max_attempts: 1 }],
  };
}

function identity(pid: number, start = `start-${pid}`, proven = true, nonce = pid.toString(16).padStart(64, '0')): ProcessIdentity {
  return { pid, start_identity: start, start_identity_proven: proven, nonce };
}

function observation(value: string, proven = true): ProcessStartIdentityObservation {
  return { value, proven, source: proven ? 'linux-proc' : 'unavailable' };
}

function fixture(runId: string, fastStressSeams = false) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lease-'));
  roots.push(workspace);
  const root = projectStateRoot(workspace);
  const alive = new Set<number>();
  const starts = new Map<number, ProcessStartIdentityObservation>();
  const directLock: WorkflowLockRunner = async <T>(_target: string, action: () => T | Promise<T>) => action();
  const createStore = () => fastStressSeams
    ? new WorkflowPersistenceStore(
      root,
      () => new Date('2026-07-23T00:00:00.000Z'),
      (pid) => alive.has(pid),
      (pid) => starts.get(pid) ?? observation(`unknown-${pid}`, false),
      (file, value) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
      },
      directLock,
    )
    : new WorkflowPersistenceStore(
      root,
      () => new Date('2026-07-23T00:00:00.000Z'),
      (pid) => alive.has(pid),
      (pid) => starts.get(pid) ?? observation(`unknown-${pid}`, false),
    );
  const plan = planWorkflow(new WorkflowRegistry().register(definition()), runId, 'exclusive');
  return { workspace, alive, starts, store: createStore(), createStore, plan };
}

function recordFile(workspace: string, runId: string): string {
  return path.join(workspace, '.omcu', 'workflows', 'runs', runId, 'record.json');
}

function acknowledgement(lease: WorkflowExecutionLease, reason: string) {
  return {
    run_id: lease.run_id,
    task_id: lease.task_id,
    owner_id: lease.owner_id,
    owner_pid: lease.owner_pid,
    owner_start_identity_sha256: digestObject(lease.owner_start_identity),
    owner_start_identity_proven: lease.owner_start_identity_proven,
    owner_nonce_sha256: lease.owner_nonce_sha256,
    generation: lease.generation,
    acquired_at: lease.acquired_at,
    expected_status: 'ambiguous' as const,
    expected_reason: reason,
    operator_confirmation: 'owner-dead-side-effects-reviewed' as const,
  };
}

describe('workflow lease generation fencing (#10)', () => {
  it('keeps raw nonce only in memory and requires it for release', async () => {
    const { workspace, alive, starts, store, plan } = fixture('credential-proof');
    alive.add(8001); starts.set(8001, observation('start-a'));
    let record = await store.create(plan);
    const acquired = await store.acquireExecutionLease(plan.run_id, record.revision, '1-plan', 'owner-a', identity(8001, 'start-a', true, 'a'.repeat(64)));
    record = acquired.record;
    expect(acquired.credential.owner_nonce).toBe('a'.repeat(64));
    const persisted = fs.readFileSync(recordFile(workspace, plan.run_id), 'utf8');
    expect(persisted).not.toContain('a'.repeat(64));
    expect(record.execution_lease).not.toHaveProperty('owner_nonce');
    const copied = record.execution_lease!;
    await expect(store.releaseExecutionLease(plan.run_id, record.revision, {
      ...acquired.credential,
      owner_nonce: copied.owner_nonce_sha256!,
    })).rejects.toThrow('E_WORKFLOW_LEASE_NOT_OWNER');
    record = await store.releaseExecutionLease(plan.run_id, record.revision, acquired.credential);
    expect(record.execution_lease).toBeNull();
  });

  it('provides exact same-argument idempotent release without accepting a newer revision', async () => {
    const { alive, starts, store, plan } = fixture('idempotent-release');
    alive.add(8100); starts.set(8100, observation('stable'));
    let record = await store.create(plan);
    const acquired = await store.acquireExecutionLease(plan.run_id, record.revision, '1-plan', 'owner', identity(8100, 'stable'));
    const expectedRevision = acquired.record.revision;
    const released = await store.releaseExecutionLease(plan.run_id, expectedRevision, acquired.credential);
    const retried = await store.releaseExecutionLease(plan.run_id, expectedRevision, acquired.credential);
    expect(retried).toEqual(released);
    await expect(store.releaseExecutionLease(plan.run_id, released.revision, acquired.credential)).rejects.toThrow('E_WORKFLOW_LEASE_NOT_OWNER');
  });

  it('advances generation after a normal release and rejects the prior release credential', async () => {
    const { alive, starts, store, plan } = fixture('normal-release-reacquire');
    alive.add(8201); starts.set(8201, observation('first-start'));
    alive.add(8202); starts.set(8202, observation('second-start'));
    const created = await store.create(plan);

    const first = await store.acquireExecutionLease(
      plan.run_id,
      created.revision,
      '1-plan',
      'owner-one',
      identity(8201, 'first-start', true, '1'.repeat(64)),
    );
    expect(first.record.execution_lease?.generation).toBe(1);

    const released = await store.releaseExecutionLease(plan.run_id, first.record.revision, first.credential);
    expect(released).toMatchObject({ lease_generation: 1, execution_lease: null });

    const second = await store.acquireExecutionLease(
      plan.run_id,
      released.revision,
      '1-plan',
      'owner-two',
      identity(8202, 'second-start', true, '2'.repeat(64)),
    );
    expect(second.record.execution_lease?.generation).toBe(2);
    await expect(
      store.releaseExecutionLease(plan.run_id, second.record.revision, first.credential),
    ).rejects.toThrow('E_WORKFLOW_LEASE_NOT_OWNER');
    expect(store.read(plan.run_id).execution_lease).toEqual(second.record.execution_lease);
  });

  it('advances strictly across 1,000 crash/reclaim cycles while retaining journal history', async () => {
    // This stress case isolates fence/history semantics from 1,000 fsyncs. The
    // credential test exercises production atomic persistence and the dedicated
    // cross-store test below exercises the real directory-lock serialization.
    const { alive, starts, store, plan } = fixture('many-cycles', true);
    let record = await store.create(plan);
    for (let generation = 1; generation <= 1_000; generation += 1) {
      const pid = 9_100 + generation;
      alive.clear();
      alive.add(pid);
      starts.set(pid, observation(`start-${generation}`));
      const acquired = await store.acquireExecutionLease(plan.run_id, record.revision, '1-plan', `owner-${generation}`, identity(pid, `start-${generation}`, true, generation.toString(16).padStart(64, '0')));
      expect(acquired.record.execution_lease?.generation).toBe(generation);
      record = acquired.record;
    }
    const persisted = store.read(plan.run_id);
    expect(persisted.lease_generation).toBe(1_000);
    expect(persisted.lease_journal_sequence).toBe(1_999);
    expect(persisted.lease_history).toHaveLength(128);
    expect(persisted.lease_history.at(-1)).toMatchObject({ sequence: 1_999, action: 'acquire', generation: 1_000 });
  }, 120_000);

  it('rejects tasks outside the immutable plan', async () => {
    const { store, plan } = fixture('task-membership');
    const record = await store.create(plan);
    await expect(store.acquireExecutionLease(plan.run_id, record.revision, '99-other', 'owner', identity(9200))).rejects.toThrow('E_WORKFLOW_LEASE_TASK_NOT_IN_PLAN');
  });

  it('fails closed for ambiguous liveness and reconciles from persisted metadata without the lost raw nonce', async () => {
    const { alive, starts, store, plan } = fixture('ambiguous-owner');
    alive.add(9300); starts.set(9300, observation('unavailable', false));
    const created = await store.create(plan);
    const acquired = await store.acquireExecutionLease(plan.run_id, created.revision, '1-plan', 'owner-a', identity(9300, 'self-only', false));
    const status = store.executionLeaseStatus(plan.run_id);
    expect(status).toMatchObject({ state: 'ambiguous', generation: 1, reason: 'start_identity_unproven' });
    expect(JSON.stringify(status)).not.toContain('self-only');
    await expect(store.reconcileAmbiguousExecutionLease(plan.run_id, acquired.record.revision, { ...acquired.credential, owner_nonce: 'f'.repeat(64) })).rejects.toThrow('E_WORKFLOW_LEASE_NOT_OWNER');
    const record = await store.reconcileAmbiguousExecutionLease(
      plan.run_id,
      acquired.record.revision,
      acknowledgement(acquired.record.execution_lease!, 'start_identity_unproven'),
    );
    expect(record.execution_lease).toBeNull();
  });

  it('detects PID reuse by start identity and records a redacted reclaim', async () => {
    const { alive, starts, store, plan } = fixture('pid-reuse');
    alive.add(9400); starts.set(9400, observation('original'));
    const created = await store.create(plan);
    const first = await store.acquireExecutionLease(plan.run_id, created.revision, '1-plan', 'owner-a', identity(9400, 'original'));
    starts.set(9400, observation('reused'));
    const second = await store.acquireExecutionLease(plan.run_id, first.record.revision, '1-plan', 'owner-b', identity(9400, 'reused', true, 'b'.repeat(64)));
    expect(second.record.execution_lease?.generation).toBe(2);
    expect(second.record.lease_history.slice(-2).map((entry) => [entry.action, entry.liveness])).toEqual([['reclaim', 'stale'], ['acquire', null]]);
    expect(JSON.stringify(second.record.lease_history)).not.toContain('original');
  });

  it('serializes cross-store concurrent acquisitions to one winner', async () => {
    const { alive, starts, store, createStore, plan } = fixture('concurrent');
    alive.add(9501); starts.set(9501, observation('one'));
    alive.add(9502); starts.set(9502, observation('two'));
    const record = await store.create(plan);
    const results = await Promise.allSettled([
      store.acquireExecutionLease(plan.run_id, record.revision, '1-plan', 'owner-one', identity(9501, 'one')),
      createStore().acquireExecutionLease(plan.run_id, record.revision, '1-plan', 'owner-two', identity(9502, 'two')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(store.read(plan.run_id)).toMatchObject({ revision: 2, lease_generation: 1 });
  });

  it('requires an explicit side-effect acknowledgement to reconcile a nonce-less legacy lease', async () => {
    const { workspace, alive, starts, store, plan } = fixture('legacy-reconcile');
    const created = await store.create(plan);
    const file = recordFile(workspace, plan.run_id);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({
      ...raw,
      schema_version: 1,
      lease_generation: 3,
      execution_lease: {
        task_id: '1-plan', owner_id: 'legacy-owner', owner_pid: 9550,
        owner_start_identity: 'legacy-start', owner_start_identity_proven: true,
        generation: 3, acquired_at: '2026-07-22T00:00:00.000Z', expires_at: '2026-07-22T00:02:00.000Z',
      },
    }));
    alive.add(9550); starts.set(9550, observation('legacy-start'));
    expect(store.executionLeaseStatus(plan.run_id)).toMatchObject({ state: 'ambiguous', reason: 'legacy_nonce_unproven' });
    const lease = store.read(plan.run_id).execution_lease!;
    const reconciled = await store.reconcileAmbiguousExecutionLease(plan.run_id, created.revision, acknowledgement(lease, 'legacy_nonce_unproven'));
    expect(reconciled.execution_lease).toBeNull();
    expect(reconciled.lease_history.at(-1)).toMatchObject({ action: 'reconcile', liveness: 'ambiguous', generation: 3 });
  });

  it('does not automatically reclaim a nonce-less legacy lease from a dead owner', async () => {
    const { workspace, store, plan } = fixture('legacy-dead-reconcile');
    const created = await store.create(plan);
    const file = recordFile(workspace, plan.run_id);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({
      ...raw,
      schema_version: 1,
      lease_generation: 4,
      execution_lease: {
        task_id: '1-plan', owner_id: 'dead-legacy-owner', owner_pid: 9551,
        owner_start_identity: 'legacy-dead-start', owner_start_identity_proven: true,
        generation: 4, acquired_at: '2026-07-22T00:00:00.000Z', expires_at: '2026-07-22T00:02:00.000Z',
      },
    }));

    expect(store.executionLeaseStatus(plan.run_id)).toMatchObject({
      state: 'ambiguous', reason: 'legacy_nonce_unproven', generation: 4,
    });
    await expect(store.acquireExecutionLease(
      plan.run_id,
      created.revision,
      '1-plan',
      'new-owner',
      identity(9552, 'new-start'),
    )).rejects.toThrow('E_WORKFLOW_LEASE_AMBIGUOUS');

    const reconciled = await store.reconcileAmbiguousExecutionLease(plan.run_id, created.revision, acknowledgement(store.read(plan.run_id).execution_lease!, 'legacy_nonce_unproven'));
    expect(reconciled.execution_lease).toBeNull();
  });

  it('rejects a present invalid nonce digest instead of downgrading it to legacy', async () => {
    const { workspace, alive, starts, store, plan } = fixture('nonce-normalization');
    alive.add(9560); starts.set(9560, observation('modern-start'));
    const created = await store.create(plan);
    await store.acquireExecutionLease(
      plan.run_id,
      created.revision,
      '1-plan',
      'modern-owner',
      identity(9560, 'modern-start', true, 'c'.repeat(64)),
    );
    const file = recordFile(workspace, plan.run_id);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

    for (const invalid of ['corrupt', null] as const) {
      const poisoned = structuredClone(persisted);
      (poisoned.execution_lease as Record<string, unknown>).owner_nonce_sha256 = invalid;
      fs.writeFileSync(file, JSON.stringify(poisoned));
      expect(() => store.read(plan.run_id)).toThrow('E_WORKFLOW_RUN_CORRUPT');
    }
  });

  it('ignores generations embedded in task output and rejects active/counter mismatch', async () => {
    const { workspace, alive, starts, store, plan } = fixture('migration-trust');
    let record = await store.create(plan);
    const eventMaterial = {
      schema_version: 1 as const, run_id: plan.run_id, sequence: 1,
      kind: 'task_receipt' as const, payload: { output: { lease_generation: 999_999 } },
      previous_event_sha256: null,
    };
    const event: WorkflowJournalEvent = { ...eventMaterial, event_sha256: eventDigest(eventMaterial) };
    const legacyLease: Omit<WorkflowExecutionLease, 'run_id' | 'owner_nonce_sha256' | 'credential_format'> = {
      task_id: '1-plan', owner_id: 'legacy-owner', owner_pid: 9600,
      owner_start_identity: 'legacy-start', owner_start_identity_proven: true, generation: 7,
      acquired_at: '2026-07-22T00:00:00.000Z', expires_at: '2026-07-22T00:02:00.000Z',
    };
    const file = recordFile(workspace, plan.run_id);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    raw.schema_version = 1;
    delete raw.lease_generation; delete raw.lease_history; delete raw.lease_journal_sequence;
    fs.writeFileSync(file, `${JSON.stringify({ ...raw, revision: 2, events: [event], event_head_sha256: event.event_sha256, execution_lease: legacyLease })}\n`);
    record = store.read(plan.run_id);
    expect(record.lease_generation).toBe(7);
    expect(record.execution_lease?.owner_nonce_sha256).toBeNull();
    alive.delete(9600); alive.add(9601); starts.set(9601, observation('new-start'));
    await expect(store.acquireExecutionLease(
      plan.run_id,
      record.revision,
      '1-plan',
      'new-owner',
      identity(9601, 'new-start'),
    )).rejects.toThrow('E_WORKFLOW_LEASE_AMBIGUOUS');
    const reconciled = await store.reconcileAmbiguousExecutionLease(plan.run_id, record.revision, acknowledgement(record.execution_lease!, 'legacy_nonce_unproven'));
    const migrated = await store.acquireExecutionLease(plan.run_id, reconciled.revision, '1-plan', 'new-owner', identity(9601, 'new-start'));
    expect(migrated.record.execution_lease?.generation).toBe(8);

    const corrupted = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    (corrupted.execution_lease as Record<string, unknown>).generation = 7;
    fs.writeFileSync(file, JSON.stringify(corrupted));
    expect(() => store.read(plan.run_id)).toThrow('E_WORKFLOW_RUN_CORRUPT');
  });

  it('keeps a normalized nonce-less legacy lease readable after append and rewrite', async () => {
    const { workspace, store, plan } = fixture('legacy-rewrite');
    const created = await store.create(plan);
    const file = recordFile(workspace, plan.run_id);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({
      ...raw,
      schema_version: 1,
      lease_generation: 5,
      execution_lease: {
        task_id: '1-plan', owner_id: 'legacy-owner', owner_pid: 9700,
        owner_start_identity: 'legacy-start', owner_start_identity_proven: true,
        generation: 5, acquired_at: '2026-07-22T00:00:00.000Z', expires_at: '2026-07-22T00:02:00.000Z',
      },
    }));
    const material = { schema_version: 1 as const, run_id: plan.run_id, sequence: 1, kind: 'task_receipt' as const, payload: { status: 'observed' }, previous_event_sha256: null };
    const rewritten = await store.append(plan.run_id, created.revision, { ...material, event_sha256: eventDigest(material) });
    expect(rewritten.execution_lease).toMatchObject({ owner_nonce_sha256: null, credential_format: 'legacy-unproven' });
    expect(store.read(plan.run_id).execution_lease).toEqual(rewritten.execution_lease);
  });

  it('uses legacy revision as a monotonic released-lease lower bound', async () => {
    const { workspace, store, plan } = fixture('legacy-released-generation');
    await store.create(plan);
    const file = recordFile(workspace, plan.run_id);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    raw.schema_version = 1;
    delete raw.lease_generation; delete raw.lease_history; delete raw.lease_journal_sequence;
    fs.writeFileSync(file, JSON.stringify({ ...raw, revision: 8, execution_lease: null }));
    const legacyDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(legacyDisk.schema_version).toBe(1);
    const migrated = store.read(plan.run_id);
    expect(migrated.schema_version).toBe(2);
    expect((JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>).schema_version).toBe(1);
    expect(migrated.lease_generation).toBe(8);
    const acquired = await store.acquireExecutionLease(plan.run_id, migrated.revision, '1-plan', 'new-owner', identity(9701));
    expect(acquired.record.execution_lease?.generation).toBe(9);
    expect(acquired.record.execution_lease!.generation).toBeGreaterThan(8);
    const modernDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(modernDisk.schema_version).toBe(2);
    expect(() => {
      if (modernDisk.schema_version !== 1) throw new Error('E_LEGACY_WORKFLOW_SCHEMA_UNSUPPORTED');
    }).toThrow('E_LEGACY_WORKFLOW_SCHEMA_UNSUPPORTED');
  });

  it('writes new records as v2 so obsolete v1 readers fail closed immediately', async () => {
    const { workspace, store, plan } = fixture('new-v2-record');
    const created = await store.create(plan);
    expect(created.schema_version).toBe(2);
    const raw = JSON.parse(fs.readFileSync(recordFile(workspace, plan.run_id), 'utf8')) as Record<string, unknown>;
    expect(raw).toMatchObject({ schema_version: 2, lease_generation: 0, lease_journal_sequence: 0, lease_history: [] });
    expect(() => {
      if (raw.schema_version !== 1) throw new Error('E_LEGACY_WORKFLOW_SCHEMA_UNSUPPORTED');
    }).toThrow('E_LEGACY_WORKFLOW_SCHEMA_UNSUPPORTED');
  });

  it('treats present-invalid v1 migration fields as corruption instead of absence', async () => {
    const { workspace, store, plan } = fixture('legacy-present-invalid');
    await store.create(plan);
    const file = recordFile(workspace, plan.run_id);
    const base = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    base.schema_version = 1;
    const invalidTopLevel: ReadonlyArray<readonly [string, unknown]> = [
      ['lease_generation', null],
      ['lease_journal_sequence', '0'],
      ['lease_history', null],
    ];
    for (const [field, value] of invalidTopLevel) {
      const poisoned = structuredClone(base);
      poisoned[field] = value;
      fs.writeFileSync(file, JSON.stringify(poisoned));
      expect(() => store.read(plan.run_id), field).toThrow('E_WORKFLOW_RUN_CORRUPT');
    }

    const legacyLease = {
      task_id: '1-plan', owner_id: 'legacy-owner', owner_pid: 9800,
      generation: 4, acquired_at: '2026-07-22T00:00:00.000Z', expires_at: '2026-07-22T00:02:00.000Z',
    };
    const invalidCredentialFields: ReadonlyArray<readonly [string, unknown]> = [
      ['owner_nonce_sha256', null],
      ['credential_format', null],
      ['owner_start_identity', null],
      ['owner_start_identity_proven', null],
    ];
    for (const [field, value] of invalidCredentialFields) {
      const poisoned = structuredClone(base);
      poisoned.lease_generation = 4;
      poisoned.execution_lease = { ...legacyLease, [field]: value };
      fs.writeFileSync(file, JSON.stringify(poisoned));
      expect(() => store.read(plan.run_id), field).toThrow('E_WORKFLOW_RUN_CORRUPT');
    }
  });

  it('requires every v2 lease fence and credential-format field', async () => {
    const { workspace, store, plan } = fixture('v2-required-fields');
    const created = await store.create(plan);
    const acquired = await store.acquireExecutionLease(plan.run_id, created.revision, '1-plan', 'owner', identity(9900));
    const file = recordFile(workspace, plan.run_id);
    const base = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const field of ['lease_generation', 'lease_journal_sequence', 'lease_history', 'execution_lease'] as const) {
      const poisoned = structuredClone(base);
      delete poisoned[field];
      fs.writeFileSync(file, JSON.stringify(poisoned));
      expect(() => store.read(plan.run_id), field).toThrow('E_WORKFLOW_RUN_CORRUPT');
    }
    for (const field of ['run_id', 'owner_start_identity', 'owner_start_identity_proven', 'owner_nonce_sha256', 'credential_format'] as const) {
      const poisoned = structuredClone(base);
      delete (poisoned.execution_lease as Record<string, unknown>)[field];
      fs.writeFileSync(file, JSON.stringify(poisoned));
      expect(() => store.read(plan.run_id), field).toThrow('E_WORKFLOW_RUN_CORRUPT');
    }
    expect(acquired.record.schema_version).toBe(2);
  });

  it('reports stable redacted errors for absent and corrupt workflow records', async () => {
    const { workspace, store, plan } = fixture('record-errors');
    expect(() => store.read(plan.run_id)).toThrow('E_WORKFLOW_RUN_ABSENT');
    const file = recordFile(workspace, plan.run_id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{secret-token');
    expect(() => store.read(plan.run_id)).toThrow(/^E_WORKFLOW_RUN_CORRUPT$/);
  });
});
