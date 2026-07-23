import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureExternalStateRoot, projectStateRoot, withinStateRoot } from '../src/runtime/state-root.js';
import { createCliMutationAuthority } from '../src/state/authority.js';
import { LeaseStore, RunStateStore, sha256Evidence } from '../src/state/store.js';

const roots: string[] = [];
function workspace(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-test-')); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

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
    const leases = new LeaseStore(root, createCliMutationAuthority(root), () => new Date('2026-07-23T01:00:00.000Z'));
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
    const leases = new LeaseStore(root, authority);
    const lease = await leases.acquire('stale-owner', 'writer', 'owner-a', 10_000);
    const owner = JSON.parse(fs.readFileSync(root.ownerFile, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(root.ownerFile, JSON.stringify({ ...owner, owner_token: 'f'.repeat(64) }), { mode: 0o600 });
    await expect(store.create('stale-owner', 'must fail')).rejects.toThrow('E_CLI_MUTATION_AUTHORITY_STALE');
    await expect(leases.release('stale-owner', 'writer', 'owner-a', lease.generation)).rejects.toThrow('E_CLI_MUTATION_AUTHORITY_STALE');
  });
});
