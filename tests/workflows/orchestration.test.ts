import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CursorAgentAdapter } from '../../src/host/cursor-agent.js';
import { projectStateRoot } from '../../src/runtime/state-root.js';
import { appendWorkflowEvent, planWorkflow, sha256, WorkflowPersistenceStore, WorkflowRegistry, WorkflowRunner } from '../../src/workflows/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function store(): WorkflowPersistenceStore {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-workflow-'));
  roots.push(workspace);
  return new WorkflowPersistenceStore(projectStateRoot(workspace), () => new Date('2026-07-23T00:00:00.000Z'));
}

function processIdentity(pid: number) {
  return {
    pid,
    start_identity: `test-start:${pid}`,
    start_identity_proven: true,
    nonce: 'ab'.repeat(32),
  } as const;
}

function definition() {
  return {
    schema_version: 1 as const,
    name: 'delivery',
    version: '1.0.0',
    capability_tier: 'cursor-backed' as const,
    stages: [
      { id: 'plan', prompt: 'plan safely', mode: 'plan' as const, depends_on: [], max_attempts: 1 },
      { id: 'execute', prompt: 'implement', mode: 'ask' as const, depends_on: ['plan'], max_attempts: 1 },
    ],
  };
}

describe('workflow orchestration', () => {
  it('keeps registered versions immutable and definitions frozen', () => {
    const registry = new WorkflowRegistry();
    const registered = registry.register(definition());
    expect(Object.isFrozen(registered)).toBe(true);
    expect(registry.register(definition())).toBe(registered);
    expect(() => registry.register({ ...definition(), stages: [{ ...definition().stages[0]!, prompt: 'changed' }] })).toThrow('E_WORKFLOW_VERSION_IMMUTABLE');
  });

  it('plans, runs, emits chained receipts, and never self-verifies', async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const adapter = new CursorAgentAdapter('cursor-agent', async (_executable, invocation) => {
      mutableCalls.push([...invocation.argv]);
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    });
    const registered = new WorkflowRegistry().register(definition());
    const plan = planWorkflow(registered, 'run-1', 'ship safely');
    const result = await new WorkflowRunner(adapter, '/repo', () => new Date('2026-07-23T00:00:00.000Z')).run(registered, plan);
    expect(result.status.status).toBe('complete');
    expect(result.status.verified).toBe(false);
    expect(Object.values(Object.fromEntries(Object.entries(result.status.tasks).map(([k, v]) => [k, v.attempts[v.attempts.length - 1]])))).toHaveLength(2);
    expect(calls[0]).toContain('plan');
    expect(calls[1]).toContain('ask');
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('marks unavailable workflows unsupported without invoking Cursor', async () => {
    let invoked = false;
    const adapter = new CursorAgentAdapter('cursor-agent', async () => { invoked = true; return { code: 0, stdout: '{}', stderr: '' }; });
    const unsupported = new WorkflowRegistry().register({ ...definition(), name: 'native-team', capability_tier: 'unsupported', unsupported_reason: 'Cursor exposes no native team API' });
    const result = await new WorkflowRunner(adapter, '/repo').run(unsupported, planWorkflow(unsupported, 'run-2', 'native team'));
    expect(result.status.status).toBe('unsupported');
    expect(invoked).toBe(false);
    expect(Object.values(Object.fromEntries(Object.entries(result.status.tasks).map(([k, v]) => [k, v.attempts[v.attempts.length - 1]])))[0]?.unsupported_reason).toContain('no native team');
  });

  it('atomically rejects duplicate and concurrent run creation', async () => {
    const persistence = store();
    const registered = new WorkflowRegistry().register(definition());
    const plan = planWorkflow(registered, 'same-run', 'one immutable run');
    const results = await Promise.allSettled([persistence.create(plan), persistence.create(plan)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(persistence.create(plan)).rejects.toThrow('E_WORKFLOW_RUN_EXISTS');
    expect(persistence.read('same-run').plan.plan_sha256).toBe(plan.plan_sha256);
  });

  it('uses revision and event-head fences for concurrent appends', async () => {
    const persistence = store();
    const plan = planWorkflow(new WorkflowRegistry().register(definition()), 'fenced-run', 'fenced');
    const created = await persistence.create(plan);
    const event = appendWorkflowEvent([], plan.run_id, 'run_started', { plan_sha256: plan.plan_sha256 });
    const results = await Promise.allSettled([
      persistence.append(plan.run_id, created.revision, event),
      persistence.append(plan.run_id, created.revision, event),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(persistence.read(plan.run_id).events).toHaveLength(1);
  });

  it('rejects tampered events before persistence', async () => {
    const persistence = store();
    const plan = planWorkflow(new WorkflowRegistry().register(definition()), 'tampered-run', 'tamper proof');
    const created = await persistence.create(plan);
    const event = appendWorkflowEvent([], plan.run_id, 'run_started', { plan_sha256: plan.plan_sha256 });
    await expect(persistence.append(plan.run_id, created.revision, { ...event, payload: { changed: true } })).rejects.toThrow('E_WORKFLOW_EVENT_DIGEST');
    expect(persistence.read(plan.run_id).events).toHaveLength(0);
  });

  it('persists each stage receipt before later workflow failure', async () => {
    const persistence = store();
    const registered = new WorkflowRegistry().register(definition());
    const plan = planWorkflow(registered, 'crash-run', 'preserve receipts');
    let record = await persistence.create(plan);
    let call = 0;
    const adapter = new CursorAgentAdapter('cursor-agent', async () => {
      call += 1;
      if (call === 2) throw new Error('simulated crash');
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    });
    const sink = async (event: Parameters<NonNullable<Parameters<WorkflowRunner['run']>[3]>>[0]) => { record = await persistence.append(plan.run_id, record.revision, event); };
    await expect(new WorkflowRunner(adapter, '/repo').run(registered, plan, [], sink)).rejects.toThrow('simulated crash');
    const persisted = persistence.read(plan.run_id);
    expect(persisted.events.map((event) => event.kind)).toEqual(['run_started', 'task_started', 'task_receipt', 'task_started']);
    let resumedCalls = 0;
    const resumedAdapter = new CursorAgentAdapter('cursor-agent', async () => { resumedCalls += 1; return { code: 0, stdout: '{}', stderr: '' }; });
    const resumed = await new WorkflowRunner(resumedAdapter, '/repo').run(registered, plan, persisted.events);
    expect(resumed.status.status).toBe('ambiguous');
    expect(resumedCalls).toBe(0);
  }, 15_000);

  it('recovers a persisted execution lease only from a dead owner', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-workflow-lease-'));
    roots.push(workspace);
    const alive = new Set<number>([7001]);
    let now = new Date('2026-07-23T00:00:00.000Z');
    const persistence = new WorkflowPersistenceStore(
      projectStateRoot(workspace),
      () => now,
      (pid) => alive.has(pid),
      (pid) => ({ value: `test-start:${pid}`, proven: true, source: 'linux-proc' }),
    );
    const plan = planWorkflow(new WorkflowRegistry().register(definition()), 'lease-run', 'exclusive');
    let record = await persistence.create(plan);
    record = (await persistence.acquireExecutionLease(plan.run_id, record.revision, '1-plan', 'owner-a', processIdentity(7001))).record;
    now = new Date('2026-07-23T01:00:00.000Z');
    await expect(persistence.acquireExecutionLease(plan.run_id, record.revision, '1-plan', 'owner-b', processIdentity(7002))).rejects.toThrow('E_WORKFLOW_LEASE_HELD');
    let duplicateCalls = 0;
    const duplicateAdapter = new CursorAgentAdapter('cursor-agent', async () => { duplicateCalls += 1; return { code: 0, stdout: '{}', stderr: '' }; });
    await expect(new WorkflowRunner(duplicateAdapter, '/repo').run(new WorkflowRegistry().register(definition()), plan, [], undefined, {
      acquire: async (taskId) => {
        const acquired = await persistence.acquireExecutionLease(plan.run_id, record.revision, taskId, 'owner-b', processIdentity(7002));
        record = acquired.record;
        return acquired.credential;
      },
      release: async () => undefined,
    })).rejects.toThrow('E_WORKFLOW_LEASE_HELD');
    expect(duplicateCalls).toBe(0);
    alive.delete(7001);
    record = (await persistence.acquireExecutionLease(plan.run_id, record.revision, '1-plan', 'owner-b', processIdentity(7002))).record;
    expect(record.execution_lease).toMatchObject({ owner_id: 'owner-b', generation: 2 });
  });

  it('redacts persisted output while hashing raw stdout and stderr bytes', async () => {
    const rawStdout = JSON.stringify({ token: 'super-secret', value: 'visible' });
    const rawStderr = 'authorization=raw-secret';
    const adapter = new CursorAgentAdapter('cursor-agent', async () => ({
      code: 0,
      stdout: rawStdout,
      stderr: 'authorization=<redacted>',
      raw_stdout_sha256: sha256(rawStdout),
      raw_stderr_sha256: sha256(rawStderr),
    }));
    const registered = new WorkflowRegistry().register({ ...definition(), stages: [definition().stages[0]!] });
    const result = await new WorkflowRunner(adapter, '/repo').run(registered, planWorkflow(registered, 'redact-run', 'redact'));
    const receipt = Object.values(Object.fromEntries(Object.entries(result.status.tasks).map(([k, v]) => [k, v.attempts[v.attempts.length - 1]])))[0]!;
    expect(receipt.output).toEqual({ token: '<redacted>', value: 'visible' });
    expect(receipt.stdout_sha256).toBe(sha256(rawStdout));
    expect(receipt.stderr_sha256).toBe(sha256(rawStderr));
  });

  it('recovers workflow effective revision when journal append wins before record rewrite', async () => {
    const persistence = store();
    const plan = planWorkflow(new WorkflowRegistry().register(definition()), 'recovery-run', 'recover');
    let record = await persistence.create(plan);
    expect(record.revision).toBe(1);

    const event = appendWorkflowEvent(record.events, plan.run_id, 'attempt_start', {
      task_id: '1-plan',
      attempt: 1,
      started_at: '2026-07-23T00:00:00.000Z',
    });

    // Append event normally
    record = await persistence.append(plan.run_id, record.revision, event);
    expect(record.revision).toBe(2);
    expect(record.events).toHaveLength(1);

    // Simulate crash after journal append where record.json retained old revision 1
    const recordFile = path.join(roots[roots.length - 1]!, '.omcu', 'workflows', 'runs', plan.run_id, 'record.json');
    const onDisk = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    onDisk.revision = 1;
    fs.writeFileSync(recordFile, JSON.stringify(onDisk));

    // Read should recover effectiveRevision from journal entry
    const recovered = persistence.read(plan.run_id);
    expect(recovered.revision).toBe(2);
    expect(recovered.events).toHaveLength(1);
  });

  it('recovers exact workflow revision after lease acquisition when record rewrite is lost', async () => {
    const persistence = store();
    const plan = planWorkflow(new WorkflowRegistry().register(definition()), 'recovery-lease-run', 'recover-lease');
    let record = await persistence.create(plan);
    expect(record.revision).toBe(1);

    // Acquire execution lease (increments revision to 2)
    const acquired = await persistence.acquireExecutionLease(plan.run_id, record.revision, '1-plan', 'owner-test', processIdentity(8001));
    record = acquired.record;
    expect(record.revision).toBe(2);

    const event = appendWorkflowEvent(record.events, plan.run_id, 'attempt_start', {
      task_id: '1-plan',
      attempt: 1,
      started_at: '2026-07-23T00:00:00.000Z',
    });

    // Appending event advances revision from 2 to 3
    record = await persistence.append(plan.run_id, record.revision, event);
    expect(record.revision).toBe(3);
    expect(record.events).toHaveLength(1);

    // Simulate crash where record.json is stuck at revision 2 (with 1 event in journal)
    const recordFile = path.join(roots[roots.length - 1]!, '.omcu', 'workflows', 'runs', plan.run_id, 'record.json');
    const onDisk = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    onDisk.revision = 2;
    fs.writeFileSync(recordFile, JSON.stringify(onDisk));

    // Recovery must recover revision 3 (not revision 2)
    const recovered = persistence.read(plan.run_id);
    expect(recovered.revision).toBe(3);
    expect(recovered.events).toHaveLength(1);
  });

  it('resumes partial legacy workflow migration without losing remaining events', async () => {
    const persistence = store();
    const plan = planWorkflow(new WorkflowRegistry().register(definition()), 'legacy-resume-run', 'legacy-resume');
    const record = await persistence.create(plan);

    // Create 2 legacy events in record.json
    const ev1 = appendWorkflowEvent([], plan.run_id, 'run_started', { started_at: '2026-07-23T00:00:00.000Z' });
    const ev2 = appendWorkflowEvent([ev1], plan.run_id, 'task_started', { task_id: '1-plan', started_at: '2026-07-23T00:00:01.000Z' });

    const recordFile = path.join(roots[roots.length - 1]!, '.omcu', 'workflows', 'runs', plan.run_id, 'record.json');
    const legacyRecord = {
      ...record,
      revision: 3,
      events: [ev1, ev2],
      event_head_sha256: ev2.event_sha256,
    };
    fs.writeFileSync(recordFile, JSON.stringify(legacyRecord));

    // Simulate partial migration: only event 1 was written to journal
    const journalDir = path.join(roots[roots.length - 1]!, '.omcu', 'workflows', 'runs', plan.run_id, 'events_journal');
    const journal = (persistence as any).eventJournal(plan.run_id);
    await journal.append({
      kind: ev1.kind,
      payload: { event: ev1, revision: 2 },
      at: '2026-07-23T00:00:00.000Z',
    });

    // Read should still return all 2 events from record.json (since journal has only 1 < 2)
    const midRead = persistence.read(plan.run_id);
    expect(midRead.events).toHaveLength(2);
    expect(midRead.events[1]?.event_sha256).toBe(ev2.event_sha256);

    // Now append a new event: migration should resume from event 2 and append event 3
    const ev3 = appendWorkflowEvent(midRead.events, plan.run_id, 'task_receipt', {
      task_id: '1-plan',
      attempt: 1,
      status: 'passed',
    });

    const finalRecord = await persistence.append(plan.run_id, midRead.revision, ev3);
    expect(finalRecord.events).toHaveLength(3);
    expect(finalRecord.revision).toBe(4);

    // Subsequent read should read all 3 events from journal
    const finalRead = persistence.read(plan.run_id);
    expect(finalRead.events).toHaveLength(3);
    expect(finalRead.revision).toBe(4);
  });
});
