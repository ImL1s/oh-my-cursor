import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/application.js';
import { ensureExternalStateRoot, projectStateRoot, withinStateRoot } from '../src/runtime/state-root.js';
import { createCliMutationAuthority } from '../src/state/authority.js';
import {
  ALLOWED_TRANSITIONS,
  LeaseStore,
  observeLease,
  observeRunState,
  RunStateStore,
  sha256Evidence,
  TERMINAL_STATUSES,
  validLease,
  validMutation,
  validRunState,
} from '../src/state/store.js';
import type { RunStatus } from '../src/state/types.js';

const roots: string[] = [];
function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-test-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createValidRunStateJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    store_kind: 'run_state',
    schema_version: 1,
    repository_id: 'OMCU',
    run_id: 'test-run',
    revision: 1,
    status: 'active',
    objective: 'test objective',
    created_at: '2026-07-23T01:00:00.000Z',
    updated_at: '2026-07-23T01:00:00.000Z',
    verification: {
      verified: false,
      evidence_sha256: null,
      verified_at: null,
    },
    last_mutation: {
      source: 'omcu-cli',
      owner_token_sha256: 'a'.repeat(64),
      writer_pid: 100,
      mutated_at: '2026-07-23T01:00:00.000Z',
    },
    ...overrides,
  };
}

function createValidLeaseJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    store_kind: 'run_lease',
    schema_version: 1,
    repository_id: 'OMCU',
    run_id: 'test-run',
    lease_name: 'main',
    owner: 'worker-1',
    generation: 1,
    expires_at: '2026-07-23T02:00:00.000Z',
    mutation: {
      source: 'omcu-cli',
      owner_token_sha256: 'a'.repeat(64),
      writer_pid: 100,
      mutated_at: '2026-07-23T01:00:00.000Z',
    },
    ...overrides,
  };
}

describe('owner-only state and CLI mutation contract', () => {
  it('creates an absolute owner-only state root and rejects escapes', () => {
    const root = projectStateRoot(workspace());
    expect(fs.statSync(root.path).mode & 0o777).toBe(0o700);
    expect(() => ensureExternalStateRoot('relative')).toThrow('E_STATE_ROOT_NOT_ABSOLUTE');
    expect(() => withinStateRoot(root, '..', 'escape')).toThrow('E_PATH_OUTSIDE_STATE_ROOT');
  });

  it('uses revision fences and explicit evidence for verified state', async () => {
    const root = projectStateRoot(workspace());
    const store = new RunStateStore(root, createCliMutationAuthority(root), () => new Date('2026-07-23T01:00:00.000Z'));
    const created = await store.create('run-1', 'build foundation');
    expect(created.verification.verified).toBe(false);
    await expect(store.transition('run-1', 99, 'complete')).rejects.toThrow('E_REVISION_CONFLICT');
    const complete = await store.transition('run-1', 1, 'complete');
    const verified = await store.verify('run-1', complete.revision, sha256Evidence('test evidence'));
    expect(verified.verification.verified).toBe(true);
    expect(verified.last_mutation.source).toBe('omcu-cli');
    const event = await store.appendEvent('run-1', 'diagnostic', { token: 'secret', message: 'ok' });
    expect(event.payload).toEqual({ token: '<redacted>', message: 'ok' });
  });

  it('fences leases by owner and generation', async () => {
    const root = projectStateRoot(workspace());
    const authority = createCliMutationAuthority(root);
    const store = new RunStateStore(root, authority);
    await store.create('run-1', 'build foundation');
    const leases = new LeaseStore(root, authority, () => new Date('2026-07-23T01:00:00.000Z'));
    const lease = await leases.acquire('run-1', 'writer', 'owner-a', 10_000);
    await expect(leases.acquire('run-1', 'writer', 'owner-b', 10_000)).rejects.toThrow('E_LEASE_HELD');
    await expect(leases.release('run-1', 'writer', 'owner-a', lease.generation + 1)).rejects.toThrow('E_LEASE_NOT_OWNER');
    await leases.release('run-1', 'writer', 'owner-a', lease.generation);
    expect(leases.read('run-1', 'writer')).toBeNull();
  });

  it('revalidates persisted owner identity before every mutation', async () => {
    const root = projectStateRoot(workspace());
    const authority = createCliMutationAuthority(root);
    const store = new RunStateStore(root, authority);
    await store.create('stale-owner', 'test run');
    const leases = new LeaseStore(root, authority);
    const lease = await leases.acquire('stale-owner', 'writer', 'owner-a', 10_000);
    const owner = JSON.parse(fs.readFileSync(root.ownerFile, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(root.ownerFile, JSON.stringify({ ...owner, owner_token: 'f'.repeat(64) }), { mode: 0o600 });
    await expect(store.create('stale-owner', 'must fail')).rejects.toThrow('E_CLI_MUTATION_AUTHORITY_STALE');
    await expect(leases.release('stale-owner', 'writer', 'owner-a', lease.generation)).rejects.toThrow('E_CLI_MUTATION_AUTHORITY_STALE');
  });

  it.each([
    { status: 'active', verification: { verified: true, evidence_sha256: 'a'.repeat(64), verified_at: '2026-07-23T01:00:00.000Z' } },
    { status: 'failed', verification: { verified: true, evidence_sha256: 'a'.repeat(64), verified_at: '2026-07-23T01:00:00.000Z' } },
    { status: 'cancelled', verification: { verified: true, evidence_sha256: 'a'.repeat(64), verified_at: '2026-07-23T01:00:00.000Z' } },
    { status: 'complete', verification: { verified: true, evidence_sha256: null, verified_at: '2026-07-23T01:00:00.000Z' } },
    { status: 'complete', verification: { verified: true, evidence_sha256: 'a'.repeat(64), verified_at: '2026-07-23 01:00:00Z' } },
    { status: 'complete', verification: { verified: false, evidence_sha256: 'a'.repeat(64), verified_at: null } },
    { status: 'complete', verification: { verified: false, evidence_sha256: null, verified_at: '2026-07-23T01:00:00.000Z' } },
  ] as const)('rejects inconsistent persisted verification state: %#', ({ status, verification }) => {
    const root = projectStateRoot(workspace());
    const runDir = path.join(root.path, 'runs', 'bad-verification');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(createValidRunStateJson({
      run_id: 'bad-verification',
      status,
      verification,
    })));
    expect(() => observeRunState(root, 'bad-verification')).toThrow('E_STATE_CORRUPT');
  });
});

describe('run-state transition graph and invariants', () => {
  it('exposes defined transition graph and terminal status set', () => {
    expect(TERMINAL_STATUSES).toEqual(new Set(['complete', 'failed', 'cancelled']));
    expect(ALLOWED_TRANSITIONS).toEqual({
      active: ['complete', 'failed', 'cancelled'],
      complete: [],
      failed: [],
      cancelled: [],
    });
  });

  // Test full 4x4 matrix of transitions
  describe.each([
    { from: 'active', to: 'active', expected: 'noop' },
    { from: 'active', to: 'complete', expected: 'ok' },
    { from: 'active', to: 'failed', expected: 'ok' },
    { from: 'active', to: 'cancelled', expected: 'ok' },
    { from: 'complete', to: 'complete', expected: 'illegal' },
    { from: 'complete', to: 'active', expected: 'illegal' },
    { from: 'complete', to: 'failed', expected: 'illegal' },
    { from: 'complete', to: 'cancelled', expected: 'illegal' },
    { from: 'failed', to: 'failed', expected: 'illegal' },
    { from: 'failed', to: 'active', expected: 'illegal' },
    { from: 'failed', to: 'complete', expected: 'illegal' },
    { from: 'failed', to: 'cancelled', expected: 'illegal' },
    { from: 'cancelled', to: 'cancelled', expected: 'illegal' },
    { from: 'cancelled', to: 'active', expected: 'illegal' },
    { from: 'cancelled', to: 'complete', expected: 'illegal' },
    { from: 'cancelled', to: 'failed', expected: 'illegal' },
  ] as const)('transition matrix: %s -> %s', ({ from, to, expected }) => {
    it(`evaluates transition from ${from} to ${to} as ${expected}`, async () => {
      const root = projectStateRoot(workspace());
      const store = new RunStateStore(root, createCliMutationAuthority(root));
      await store.create('matrix-run', 'matrix test objective');

      // Move to 'from' state if needed
      let currentRev = 1;
      if (from !== 'active') {
        const moved = await store.transition('matrix-run', currentRev, from as RunStatus);
        currentRev = moved.revision;
      }

      if (expected === 'ok') {
        const result = await store.transition('matrix-run', currentRev, to as RunStatus);
        expect(result.status).toBe(to);
        expect(result.revision).toBe(currentRev + 1);
        expect(result.verification).toEqual({ verified: false, evidence_sha256: null, verified_at: null });
      } else if (expected === 'noop') {
        await expect(store.transition('matrix-run', currentRev, to as RunStatus)).rejects.toThrow('E_TRANSITION_NOOP');
      } else {
        await expect(store.transition('matrix-run', currentRev, to as RunStatus)).rejects.toThrow('E_TRANSITION_ILLEGAL');
      }
    });
  });

  it('rejects invalid target status with E_RUN_STATUS_INVALID', async () => {
    const root = projectStateRoot(workspace());
    const store = new RunStateStore(root, createCliMutationAuthority(root));
    await store.create('run-status-invalid', 'test');
    await expect(store.transition('run-status-invalid', 1, 'not-a-status' as RunStatus)).rejects.toThrow('E_RUN_STATUS_INVALID');
  });

  it('rejects transition on revision conflict before checking transition validity', async () => {
    const root = projectStateRoot(workspace());
    const store = new RunStateStore(root, createCliMutationAuthority(root));
    await store.create('rev-conflict', 'test');
    await expect(store.transition('rev-conflict', 42, 'complete')).rejects.toThrow('E_REVISION_CONFLICT');
  });

  it('clamps mutation timestamps when clock steps backwards to preserve monotonic created_at <= updated_at', async () => {
    const root = projectStateRoot(workspace());
    let mockTime = new Date('2026-07-23T12:00:00.000Z');
    const store = new RunStateStore(root, createCliMutationAuthority(root), () => mockTime);
    await store.create('clock-rollback-run', 'objective');

    // Simulate clock moving backward 1 hour
    mockTime = new Date('2026-07-23T11:00:00.000Z');
    const next = await store.transition('clock-rollback-run', 1, 'complete');
    expect(next.updated_at).toBe('2026-07-23T12:00:00.000Z');
    expect(Date.parse(next.created_at)).toBeLessThanOrEqual(Date.parse(next.updated_at));
    // Verify that subsequent observeRunState succeeds without E_STATE_CORRUPT
    expect(observeRunState(root, 'clock-rollback-run').status).toBe('complete');
  });

  it('clamps event timestamps when clock steps backwards across multiple events', async () => {
    const root = projectStateRoot(workspace());
    let mockTime = new Date('2026-07-23T12:00:00.000Z');
    const store = new RunStateStore(root, createCliMutationAuthority(root), () => mockTime);
    await store.create('clock-rollback-events', 'objective');

    mockTime = new Date('2026-07-23T12:05:00.000Z');
    const ev1 = await store.appendEvent('clock-rollback-events', 'ev1', { count: 1 });
    expect(ev1.at).toBe('2026-07-23T12:05:00.000Z');

    // Clock steps backward
    mockTime = new Date('2026-07-23T12:02:00.000Z');
    const ev2 = await store.appendEvent('clock-rollback-events', 'ev2', { count: 2 });
    expect(ev2.at).toBe('2026-07-23T12:05:00.000Z');
    expect(Date.parse(ev1.at)).toBeLessThanOrEqual(Date.parse(ev2.at));
  });
});

describe('verification invariants (Option A - acceptance verification)', () => {
  it('allows verification only when status is complete', async () => {
    const root = projectStateRoot(workspace());
    const store = new RunStateStore(root, createCliMutationAuthority(root));
    await store.create('run-verify-complete', 'verify objective');
    const complete = await store.transition('run-verify-complete', 1, 'complete');

    const digest = sha256Evidence('acceptance-evidence');
    const verified = await store.verify('run-verify-complete', complete.revision, digest);
    expect(verified.status).toBe('complete');
    expect(verified.verification.verified).toBe(true);
    expect(verified.verification.evidence_sha256).toBe(digest);
    expect(verified.verification.verified_at).not.toBeNull();
    expect(verified.revision).toBe(complete.revision + 1);
  });

  it('rejects verification on active status with E_RUN_NOT_COMPLETE_FOR_VERIFICATION', async () => {
    const root = projectStateRoot(workspace());
    const store = new RunStateStore(root, createCliMutationAuthority(root));
    await store.create('run-verify-active', 'active run');
    const digest = sha256Evidence('evidence');
    await expect(store.verify('run-verify-active', 1, digest)).rejects.toThrow('E_RUN_NOT_COMPLETE_FOR_VERIFICATION');
  });

  it('rejects verification on failed status with E_RUN_NOT_COMPLETE_FOR_VERIFICATION', async () => {
    const root = projectStateRoot(workspace());
    const store = new RunStateStore(root, createCliMutationAuthority(root));
    await store.create('run-verify-failed', 'failed run');
    const failed = await store.transition('run-verify-failed', 1, 'failed');
    const digest = sha256Evidence('evidence');
    await expect(store.verify('run-verify-failed', failed.revision, digest)).rejects.toThrow('E_RUN_NOT_COMPLETE_FOR_VERIFICATION');
  });

  it('rejects verification on cancelled status with E_RUN_NOT_COMPLETE_FOR_VERIFICATION', async () => {
    const root = projectStateRoot(workspace());
    const store = new RunStateStore(root, createCliMutationAuthority(root));
    await store.create('run-verify-cancelled', 'cancelled run');
    const cancelled = await store.transition('run-verify-cancelled', 1, 'cancelled');
    const digest = sha256Evidence('evidence');
    await expect(store.verify('run-verify-cancelled', cancelled.revision, digest)).rejects.toThrow('E_RUN_NOT_COMPLETE_FOR_VERIFICATION');
  });

  it('rejects invalid evidence SHA-256 digests', async () => {
    const root = projectStateRoot(workspace());
    const store = new RunStateStore(root, createCliMutationAuthority(root));
    await store.create('run-bad-digest', 'test');
    await store.transition('run-bad-digest', 1, 'complete');

    await expect(store.verify('run-bad-digest', 2, 'short')).rejects.toThrow('E_EVIDENCE_DIGEST_INVALID');
    await expect(store.verify('run-bad-digest', 2, 'A'.repeat(64))).rejects.toThrow('E_EVIDENCE_DIGEST_INVALID');
    await expect(store.verify('run-bad-digest', 2, 'z'.repeat(64))).rejects.toThrow('E_EVIDENCE_DIGEST_INVALID');
  });
});

describe('LeaseStore relationship with RunState', () => {
  it('rejects lease acquisition for nonexistent run with E_RUN_ABSENT', async () => {
    const root = projectStateRoot(workspace());
    const leases = new LeaseStore(root, createCliMutationAuthority(root));
    await expect(leases.acquire('run-missing', 'writer', 'owner-a', 10_000)).rejects.toThrow('E_RUN_ABSENT');
  });

  it('allows lease acquisition for active run', async () => {
    const root = projectStateRoot(workspace());
    const authority = createCliMutationAuthority(root);
    const runs = new RunStateStore(root, authority);
    await runs.create('run-active-lease', 'active lease test');

    const leases = new LeaseStore(root, authority);
    const lease = await leases.acquire('run-active-lease', 'worker', 'owner-a', 5_000);
    expect(lease.run_id).toBe('run-active-lease');
    expect(lease.owner).toBe('owner-a');
    expect(lease.generation).toBe(1);
  });

  it.each(['complete', 'failed', 'cancelled'] as const)(
    'rejects lease acquisition when run is in terminal status: %s',
    async (terminalStatus) => {
      const root = projectStateRoot(workspace());
      const authority = createCliMutationAuthority(root);
      const runs = new RunStateStore(root, authority);
      await runs.create(`run-${terminalStatus}`, 'terminal lease test');
      await runs.transition(`run-${terminalStatus}`, 1, terminalStatus);

      const leases = new LeaseStore(root, authority);
      await expect(leases.acquire(`run-${terminalStatus}`, 'worker', 'owner-a', 5_000)).rejects.toThrow('E_RUN_TERMINAL');
    },
  );

  it('validates lease TTL bounds', async () => {
    const root = projectStateRoot(workspace());
    const authority = createCliMutationAuthority(root);
    const runs = new RunStateStore(root, authority);
    await runs.create('run-ttl-bounds', 'test');
    const leases = new LeaseStore(root, authority);

    await expect(leases.acquire('run-ttl-bounds', 'worker', 'owner', 999)).rejects.toThrow('E_LEASE_TTL_INVALID');
    await expect(leases.acquire('run-ttl-bounds', 'worker', 'owner', 86_400_001)).rejects.toThrow('E_LEASE_TTL_INVALID');
    await expect(leases.acquire('run-ttl-bounds', 'worker', 'owner', 5000.5)).rejects.toThrow('E_LEASE_TTL_INVALID');
    await expect(leases.acquire('run-ttl-bounds', 'worker', 'owner', NaN)).rejects.toThrow('E_LEASE_TTL_INVALID');
  });

  it('clamps lease mutation timestamp when clock steps backward during renewal', async () => {
    const root = projectStateRoot(workspace());
    const authority = createCliMutationAuthority(root);
    const runs = new RunStateStore(root, authority);
    await runs.create('run-lease-rollback', 'test');

    let mockTime = new Date('2026-07-23T12:00:00.000Z');
    const leases = new LeaseStore(root, authority, () => mockTime);
    const lease1 = await leases.acquire('run-lease-rollback', 'worker', 'owner-1', 5_000);
    expect(lease1.mutation.mutated_at).toBe('2026-07-23T12:00:00.000Z');

    // Clock steps backward
    mockTime = new Date('2026-07-23T11:59:00.000Z');
    const lease2 = await leases.acquire('run-lease-rollback', 'worker', 'owner-1', 5_000);
    expect(lease2.generation).toBe(2);
    expect(lease2.mutation.mutated_at).toBe('2026-07-23T12:00:00.000Z');
    expect(Date.parse(lease2.expires_at)).toBeGreaterThan(Date.parse(lease2.mutation.mutated_at));
    expect(observeLease(root, 'run-lease-rollback', 'worker').generation).toBe(2);
  });

  it('rejects lease renewal when run transitions to terminal state concurrently', async () => {
    const root = projectStateRoot(workspace());
    const authority = createCliMutationAuthority(root);
    const runs = new RunStateStore(root, authority);
    await runs.create('run-race-terminal', 'race test');
    const leases = new LeaseStore(root, authority);
    await leases.acquire('run-race-terminal', 'worker', 'owner-1', 5_000);

    // Transition run to complete
    await runs.transition('run-race-terminal', 1, 'complete');

    // Attempt to re-acquire / renew lease must fail with E_RUN_TERMINAL
    await expect(leases.acquire('run-race-terminal', 'worker', 'owner-1', 5_000)).rejects.toThrow('E_RUN_TERMINAL');
  });
});

describe('runtime schema validation: validRunState and validLease', () => {
  it('validates correct run state and lease records', () => {
    const runState = createValidRunStateJson();
    expect(validRunState(runState, 'test-run')).toBe(true);

    const lease = createValidLeaseJson();
    expect(validLease(lease, 'test-run', 'main')).toBe(true);
  });

  it.each([
    ['null input', null],
    ['primitive input', 'string'],
    ['array input', []],
    ['wrong store_kind', createValidRunStateJson({ store_kind: 'wrong' })],
    ['wrong schema_version', createValidRunStateJson({ schema_version: 2 })],
    ['wrong repository_id', createValidRunStateJson({ repository_id: 'OTHER' })],
    ['run_id mismatch', createValidRunStateJson({ run_id: 'mismatch' })],
    ['run_id unsafe key', createValidRunStateJson({ run_id: '../escape' })],
    ['non-integer revision', createValidRunStateJson({ revision: 1.5 })],
    ['zero revision', createValidRunStateJson({ revision: 0 })],
    ['negative revision', createValidRunStateJson({ revision: -1 })],
    ['unsafe integer revision', createValidRunStateJson({ revision: Number.MAX_SAFE_INTEGER + 1 })],
    ['invalid status', createValidRunStateJson({ status: 'pending' })],
    ['empty objective', createValidRunStateJson({ objective: '' })],
    ['whitespace-only objective', createValidRunStateJson({ objective: '   ' })],
    ['oversized objective', createValidRunStateJson({ objective: 'x'.repeat(16_385) })],
    ['invalid created_at timestamp', createValidRunStateJson({ created_at: 'invalid-date' })],
    ['non-ISO created_at', createValidRunStateJson({ created_at: '2026-07-23 01:00:00Z' })],
    ['invalid updated_at timestamp', createValidRunStateJson({ updated_at: 'not-a-date' })],
    ['created_at after updated_at', createValidRunStateJson({ created_at: '2026-07-24T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z' })],
    ['extra field on run state', createValidRunStateJson({ extra_field: true })],
    ['missing verification', (() => { const s = createValidRunStateJson(); delete (s as any).verification; return s; })()],
    ['extra field in verification', createValidRunStateJson({ verification: { verified: false, evidence_sha256: null, verified_at: null, extra: 1 } })],
    ['verified true with non-complete status', createValidRunStateJson({ status: 'active', verification: { verified: true, evidence_sha256: 'a'.repeat(64), verified_at: '2026-07-23T01:00:00.000Z' } })],
    ['verified true with failed status', createValidRunStateJson({ status: 'failed', verification: { verified: true, evidence_sha256: 'a'.repeat(64), verified_at: '2026-07-23T01:00:00.000Z' } })],
    ['verified true with non-hex evidence', createValidRunStateJson({ status: 'complete', verification: { verified: true, evidence_sha256: 'zzz', verified_at: '2026-07-23T01:00:00.000Z' } })],
    ['verified true with uppercase evidence hex', createValidRunStateJson({ status: 'complete', verification: { verified: true, evidence_sha256: 'A'.repeat(64), verified_at: '2026-07-23T01:00:00.000Z' } })],
    ['verified false with non-null evidence_sha256', createValidRunStateJson({ verification: { verified: false, evidence_sha256: 'a'.repeat(64), verified_at: null } })],
    ['verified false with non-null verified_at', createValidRunStateJson({ verification: { verified: false, evidence_sha256: null, verified_at: '2026-07-23T01:00:00.000Z' } })],
    ['verified true with verified_at before created_at', createValidRunStateJson({ status: 'complete', created_at: '2026-07-23T01:00:00.000Z', verification: { verified: true, evidence_sha256: 'a'.repeat(64), verified_at: '2026-07-23T00:59:59.000Z' } })],
    ['verified true with verified_at after updated_at', createValidRunStateJson({ status: 'complete', updated_at: '2026-07-23T01:00:00.000Z', verification: { verified: true, evidence_sha256: 'a'.repeat(64), verified_at: '2026-07-23T01:00:01.000Z' } })],
    ['last_mutation mutated_at before created_at', createValidRunStateJson({ created_at: '2026-07-23T01:00:00.000Z', last_mutation: { source: 'omcu-cli', owner_token_sha256: 'a'.repeat(64), writer_pid: 1, mutated_at: '2026-07-23T00:59:59.000Z' } })],
    ['last_mutation mutated_at after updated_at', createValidRunStateJson({ updated_at: '2026-07-23T01:00:00.000Z', last_mutation: { source: 'omcu-cli', owner_token_sha256: 'a'.repeat(64), writer_pid: 1, mutated_at: '2026-07-23T01:00:01.000Z' } })],
    ['missing last_mutation', (() => { const s = createValidRunStateJson(); delete (s as any).last_mutation; return s; })()],
    ['bad last_mutation source', createValidRunStateJson({ last_mutation: { source: 'other', owner_token_sha256: 'a'.repeat(64), writer_pid: 1, mutated_at: '2026-07-23T01:00:00.000Z' } })],
    ['bad last_mutation pid <= 0', createValidRunStateJson({ last_mutation: { source: 'omcu-cli', owner_token_sha256: 'a'.repeat(64), writer_pid: 0, mutated_at: '2026-07-23T01:00:00.000Z' } })],
    ['bad last_mutation non-integer pid', createValidRunStateJson({ last_mutation: { source: 'omcu-cli', owner_token_sha256: 'a'.repeat(64), writer_pid: 1.5, mutated_at: '2026-07-23T01:00:00.000Z' } })],
    ['bad last_mutation mutated_at', createValidRunStateJson({ last_mutation: { source: 'omcu-cli', owner_token_sha256: 'a'.repeat(64), writer_pid: 1, mutated_at: 'bad-date' } })],
    ['extra field in last_mutation', createValidRunStateJson({ last_mutation: { source: 'omcu-cli', owner_token_sha256: 'a'.repeat(64), writer_pid: 1, mutated_at: '2026-07-23T01:00:00.000Z', extra: true } })],
  ])('rejects invalid run state schema: %s', (_, state) => {
    expect(validRunState(state, 'test-run')).toBe(false);
  });

  it.each([
    ['null lease', null],
    ['wrong store_kind', createValidLeaseJson({ store_kind: 'wrong' })],
    ['wrong schema_version', createValidLeaseJson({ schema_version: 2 })],
    ['wrong repository_id', createValidLeaseJson({ repository_id: 'OTHER' })],
    ['run_id mismatch', createValidLeaseJson({ run_id: 'mismatch' })],
    ['lease_name mismatch', createValidLeaseJson({ lease_name: 'mismatch' })],
    ['lease_name unsafe key', createValidLeaseJson({ lease_name: '../escape' })],
    ['unsafe owner key', createValidLeaseJson({ owner: '../bad' })],
    ['generation 0', createValidLeaseJson({ generation: 0 })],
    ['negative generation', createValidLeaseJson({ generation: -1 })],
    ['non-integer generation', createValidLeaseJson({ generation: 1.5 })],
    ['unsafe integer generation', createValidLeaseJson({ generation: Number.MAX_SAFE_INTEGER + 1 })],
    ['invalid expires_at', createValidLeaseJson({ expires_at: 'invalid' })],
    ['extra lease field', createValidLeaseJson({ extra: 1 })],
    ['invalid lease mutation', createValidLeaseJson({ mutation: { bad: 1 } })],
  ])('rejects invalid lease schema: %s', (_, lease) => {
    expect(validLease(lease, 'test-run', 'main')).toBe(false);
  });

  it('validMutation validates exact shape', () => {
    expect(validMutation(null)).toBe(false);
    expect(validMutation({})).toBe(false);
    expect(validMutation({
      source: 'omcu-cli',
      owner_token_sha256: 'a'.repeat(64),
      writer_pid: 1,
      mutated_at: '2026-07-23T01:00:00.000Z',
    })).toBe(true);
    expect(validMutation({
      source: 'omcu-cli',
      owner_token_sha256: 'a'.repeat(64),
      writer_pid: 1,
      mutated_at: '2026-07-23T01:00:00.000Z',
      extra: true,
    })).toBe(false);
  });

  it('observeLease throws E_STATE_CORRUPT on malformed persisted lease', () => {
    const root = projectStateRoot(workspace());
    const leaseDir = path.join(root.path, 'leases', 'test-run');
    fs.mkdirSync(leaseDir, { recursive: true });
    fs.writeFileSync(path.join(leaseDir, 'main.json'), JSON.stringify(createValidLeaseJson({ generation: 0 })));
    expect(() => observeLease(root, 'test-run', 'main')).toThrow('E_STATE_CORRUPT');
  });
});

describe('CLI integration for cancellation and state transition invariants', () => {
  function harness(cwd: string) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      cwd,
      dependencies: { cwd },
      io: {
        stdout: (t: string) => stdout.push(t),
        stderr: (t: string) => stderr.push(t),
      },
      stdout,
      stderr,
    };
  }

  it('makes omcu cancel idempotent for active and already-cancelled runs', async () => {
    const cwd = workspace();
    const h = harness(cwd);

    // Create run
    expect(await runCli(['state', 'create', '--id', 'run-cancel', '--objective', 'cancel test'], h.dependencies, h.io)).toBe(0);

    // First cancel: transitions from active to cancelled
    expect(await runCli(['cancel', '--id', 'run-cancel'], h.dependencies, h.io)).toBe(0);
    const output1 = JSON.parse(h.stdout[1]) as Record<string, unknown>;
    expect(output1.status).toBe('cancelled');
    expect(output1.revision).toBe(2);

    // Second cancel: idempotent, returns 0 and outputs current state without mutation
    expect(await runCli(['cancel', '--id', 'run-cancel'], h.dependencies, h.io)).toBe(0);
    const output2 = JSON.parse(h.stdout[2]) as Record<string, unknown>;
    expect(output2.status).toBe('cancelled');
    expect(output2.revision).toBe(2);
  });

  it('rejects cancelling a complete run with E_TRANSITION_ILLEGAL', async () => {
    const cwd = workspace();
    const h = harness(cwd);

    expect(await runCli(['state', 'create', '--id', 'run-complete', '--objective', 'complete test'], h.dependencies, h.io)).toBe(0);
    expect(await runCli(['state', 'transition', '--id', 'run-complete', '--revision', '1', '--status', 'complete'], h.dependencies, h.io)).toBe(0);

    // Cancel must fail because run is already complete
    expect(await runCli(['cancel', '--id', 'run-complete'], h.dependencies, h.io)).toBe(1);
    expect(h.stderr.join('')).toContain('E_TRANSITION_ILLEGAL');
  });

  it('rejects no-op transition in CLI with E_TRANSITION_NOOP', async () => {
    const cwd = workspace();
    const h = harness(cwd);

    expect(await runCli(['state', 'create', '--id', 'run-noop', '--objective', 'noop test'], h.dependencies, h.io)).toBe(0);
    expect(await runCli(['state', 'transition', '--id', 'run-noop', '--revision', '1', '--status', 'active'], h.dependencies, h.io)).toBe(1);
    expect(h.stderr.join('')).toContain('E_TRANSITION_NOOP');
  });

  it('rejects transitioning a complete terminal run to complete in CLI with E_TRANSITION_ILLEGAL', async () => {
    const cwd = workspace();
    const h = harness(cwd);

    expect(await runCli(['state', 'create', '--id', 'run-complete-noop', '--objective', 'test'], h.dependencies, h.io)).toBe(0);
    expect(await runCli(['state', 'transition', '--id', 'run-complete-noop', '--revision', '1', '--status', 'complete'], h.dependencies, h.io)).toBe(0);

    // Transitioning from complete to complete must fail with E_TRANSITION_ILLEGAL, not E_TRANSITION_NOOP
    expect(await runCli(['state', 'transition', '--id', 'run-complete-noop', '--revision', '2', '--status', 'complete'], h.dependencies, h.io)).toBe(1);
    expect(h.stderr.join('')).toContain('E_TRANSITION_ILLEGAL');
  });

  it('rejects acquiring lease via CLI when run is absent or terminal', async () => {
    const cwd = workspace();
    const h = harness(cwd);

    // Absent run
    expect(await runCli(['lease', 'acquire', '--run', 'absent-run', '--name', 'test', '--owner', 'me'], h.dependencies, h.io)).toBe(1);
    expect(h.stderr.join('')).toContain('E_RUN_ABSENT');

    // Complete run
    expect(await runCli(['state', 'create', '--id', 'completed-run', '--objective', 'test'], h.dependencies, h.io)).toBe(0);
    expect(await runCli(['state', 'transition', '--id', 'completed-run', '--revision', '1', '--status', 'complete'], h.dependencies, h.io)).toBe(0);
    expect(await runCli(['lease', 'acquire', '--run', 'completed-run', '--name', 'test', '--owner', 'me'], h.dependencies, h.io)).toBe(1);
    expect(h.stderr.join('')).toContain('E_RUN_TERMINAL');
  });

  it('handles concurrent cancellation races idempotently on revision conflict', async () => {
    const cwd = workspace();
    const h1 = harness(cwd);
    const h2 = harness(cwd);

    expect(await runCli(['state', 'create', '--id', 'run-concurrent-cancel', '--objective', 'race test'], h1.dependencies, h1.io)).toBe(0);

    const [code1, code2] = await Promise.all([
      runCli(['cancel', '--id', 'run-concurrent-cancel'], h1.dependencies, h1.io),
      runCli(['cancel', '--id', 'run-concurrent-cancel'], h2.dependencies, h2.io),
    ]);
    expect(code1).toBe(0);
    expect(code2).toBe(0);
    expect(h1.stderr).toEqual([]);
    expect(h2.stderr).toEqual([]);
  });

  it('migrates legacy events.jsonl into journal and supports readEvents', async () => {
    const root = projectStateRoot(workspace());
    const authority = createCliMutationAuthority(root);
    const store = new RunStateStore(root, authority);
    await store.create('run-migrate', 'test migration');

    // Manually create legacy events.jsonl
    const runDir = path.join(root.path, 'runs', 'run-migrate');
    const legacyEvent = {
      store_kind: 'run_event',
      schema_version: 1,
      repository_id: 'OMCU',
      run_id: 'run-migrate',
      sequence: 1,
      type: 'legacy_init',
      at: '2026-07-23T01:00:00.000Z',
      payload: { old: true },
      mutation: {
        source: 'omcu-cli',
        owner_token_sha256: 'a'.repeat(64),
        writer_pid: process.pid,
        mutated_at: '2026-07-23T01:00:00.000Z',
      },
    };
    fs.writeFileSync(path.join(runDir, 'events.jsonl'), `${JSON.stringify(legacyEvent)}\n`);

    // Appending a new event should migrate legacy event and append new event at seq 2
    const ev2 = await store.appendEvent('run-migrate', 'step2', { count: 2 });
    expect(ev2.sequence).toBe(2);

    const allEvents = store.readEvents('run-migrate');
    expect(allEvents).toHaveLength(2);
    expect(allEvents[0]?.type).toBe('legacy_init');
    expect(allEvents[1]?.type).toBe('step2');
  });
});
