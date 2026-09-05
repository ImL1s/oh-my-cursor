import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessIdentityRuntime } from '../../src/runtime/process-identity.js';
import { projectStateRoot } from '../../src/runtime/state-root.js';
import {
  CLAIM_LEASE_MS,
  claimTask,
  createTask,
  getTeamSummary,
  listTasks,
  MAX_TOTAL_LEASE_MS,
  readTask,
  rebuildTaskFromJournal,
  reclaimTask,
  releaseTaskClaim,
  renewTaskClaim,
  reopenTask,
  transitionTaskStatus,
  type TeamTask,
  type WorkerProcessIdentityClaim,
} from '../../src/team/tasks.js';
import { initializeTeamState, teamTasksDir, teamTaskJournalDir } from '../../src/team/state-root.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function workspace(teamName = 'test-team') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-tasks-'));
  roots.push(dir);
  const root = projectStateRoot(dir);
  initializeTeamState(root, {
    teamName,
    task: 'team task testing',
    workers: [
      { name: 'worker-1', owned_paths: ['src/w1'] },
      { name: 'worker-2', owned_paths: ['src/w2'] },
      { name: 'supervisor', owned_paths: ['src/sup'] },
    ],
  });
  return { dir, root, teamName };
}

function makeMockProcessRuntime(options: {
  alivePids?: Set<number>;
  startTimes?: Map<number, string>;
  ambiguousPids?: Map<number, string>;
  platform?: NodeJS.Platform;
}): ProcessIdentityRuntime {
  const alive = options.alivePids ?? new Set<number>();
  const startTimes = options.startTimes ?? new Map<number, string>();
  const ambiguous = options.ambiguousPids ?? new Map<number, string>();
  const platform = options.platform ?? 'darwin';
  return {
    platform,
    readFile: () => '',
    execFile: (_file, args) => {
      const pidStr = args[args.indexOf('-p') + 1];
      const pid = Number(pidStr);
      const customTime = startTimes.get(pid);
      if (customTime !== undefined) {
        return `${customTime}\n`;
      }
      return 'Mon Sep  5 00:00:00 2026\n';
    },
    probePid: (pid) => {
      if (ambiguous.has(pid)) {
        return { status: 'ambiguous', reason: ambiguous.get(pid)! };
      }
      if (alive.has(pid)) {
        return { status: 'alive' };
      }
      return { status: 'dead' };
    },
  };
}

describe('team tasks lifecycle & generation fencing', { timeout: 20_000 }, () => {
  describe('Task Creation & Idempotency', () => {
    it('creates a task with pending status and monotonic last_claim_generation 0', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'First Task',
        description: 'Do something important',
      });

      expect(task.id).toBe('1');
      expect(task.subject).toBe('First Task');
      expect(task.description).toBe('Do something important');
      expect(task.status).toBe('pending');
      expect(task.version).toBe(1);
      expect(task.last_claim_generation).toBe(0);
      expect(task.claim).toBeUndefined();

      const tasks = await listTasks(root, teamName);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.id).toBe('1');
    });

    it('supports idempotent creation with identical request_id and payload', async () => {
      const { root, teamName } = workspace();
      const first = await createTask(root, teamName, {
        subject: 'Idempotent Task',
        description: 'Payload A',
        request_id: 'req-123',
      });

      const second = await createTask(root, teamName, {
        subject: 'Idempotent Task',
        description: 'Payload A',
        request_id: 'req-123',
      });

      expect(second.id).toBe(first.id);
      expect(second.version).toBe(first.version);

      const tasks = await listTasks(root, teamName);
      expect(tasks).toHaveLength(1);
    });

    it('rejects conflicting payload for the same request_id', async () => {
      const { root, teamName } = workspace();
      await createTask(root, teamName, {
        subject: 'Original Task',
        description: 'Payload A',
        request_id: 'req-conflict',
      });

      await expect(
        createTask(root, teamName, {
          subject: 'Changed Task',
          description: 'Payload B',
          request_id: 'req-conflict',
        }),
      ).rejects.toThrow('E_TEAM_TASK_IDEMPOTENCY_CONFLICT');
    });

    it('rejects invalid inputs on creation', async () => {
      const { root, teamName } = workspace();
      await expect(
        createTask(root, teamName, {
          subject: '',
          description: 'no subject',
        }),
      ).rejects.toThrow('E_TEAM_TASK_FIELDS_REQUIRED');

      await expect(
        createTask(root, teamName, {
          subject: 'Valid Subject',
          description: 'invalid worker',
          owner: 'non_existent_worker',
        }),
      ).rejects.toThrow('E_TEAM_WORKER_NOT_FOUND');
    });

    it('does not append created journal event if task creation write fails', async () => {
      const { root, teamName } = workspace();
      await expect(
        createTask(
          root,
          teamName,
          { subject: 'Failing Task', description: 'Write will fail' },
          {
            taskWriteOptions: {
              faultInjector: (point) => {
                if (point === 'write') throw new Error('injected_write_error');
              },
            },
          },
        ),
      ).rejects.toThrow('injected_write_error');

      // Assert journal does not have phantom event
      const journalTask = rebuildTaskFromJournal(root, teamName, '1');
      expect(journalTask).toBeNull();

      // Next task creation succeeds and receives task-1 cleanly
      const created = await createTask(root, teamName, {
        subject: 'Real Task',
        description: 'Now succeeds',
      });
      expect(created.id).toBe('1');
    });
  });

  describe('Dependencies, Cycle Detection & Auto-Unblocking', () => {
    it('creates task with status blocked when dependencies are not complete', async () => {
      const { root, teamName } = workspace();
      const task1 = await createTask(root, teamName, {
        subject: 'Prerequisite',
        description: 'Step 1',
      });
      const task2 = await createTask(root, teamName, {
        subject: 'Dependent',
        description: 'Step 2',
        blocked_by: [task1.id],
      });

      expect(task1.status).toBe('pending');
      expect(task2.status).toBe('blocked');
      expect(task2.blocked_by).toEqual([task1.id]);
    });

    it('fails to claim a blocked task', async () => {
      const { root, teamName } = workspace();
      const task1 = await createTask(root, teamName, {
        subject: 'Prerequisite',
        description: 'Step 1',
      });
      const task2 = await createTask(root, teamName, {
        subject: 'Dependent',
        description: 'Step 2',
        blocked_by: [task1.id],
      });

      const claimResult = await claimTask(root, teamName, task2.id, 'worker-1');
      expect(claimResult.ok).toBe(false);
      if (claimResult.ok) return;
      expect(claimResult.error).toBe('blocked_dependency');
      expect(claimResult.dependencies).toEqual([task1.id]);
    });

    it('rejects non-existent dependencies', async () => {
      const { root, teamName } = workspace();
      await expect(
        createTask(root, teamName, {
          subject: 'Orphaned Task',
          description: 'Depends on non-existent',
          blocked_by: ['9999'],
        }),
      ).rejects.toThrow('E_TEAM_BLOCKED_BY_NOT_FOUND');
    });

    it('detects dependency cycles and rejects creation', async () => {
      const { root, teamName } = workspace();
      const task1 = await createTask(root, teamName, {
        subject: 'Task 1',
        description: 'Part 1',
      });
      const task2 = await createTask(root, teamName, {
        subject: 'Task 2',
        description: 'Part 2',
        blocked_by: [task1.id],
      });

      // Self-dependency
      await expect(
        createTask(root, teamName, {
          subject: 'Self Cycle',
          description: 'Self',
          blocked_by: ['3'], // Next ID is 3
        }),
      ).rejects.toThrow('E_TEAM_TASK_DEPENDENCY_CYCLE');

      const task3 = await createTask(root, teamName, {
        subject: 'Task 3',
        description: 'Part 3',
        blocked_by: [task2.id],
      });
      expect(task3.status).toBe('blocked');
    });

    it('automatically unblocks dependent tasks when prerequisite completes', async () => {
      const { root, teamName } = workspace();
      const task1 = await createTask(root, teamName, {
        subject: 'Build Foundation',
        description: 'Must do first',
      });
      const task2 = await createTask(root, teamName, {
        subject: 'Build Walls',
        description: 'Must do second',
        blocked_by: [task1.id],
      });

      expect(task2.status).toBe('blocked');

      // Worker 1 claims and completes task1
      const claim1 = await claimTask(root, teamName, task1.id, 'worker-1');
      expect(claim1.ok).toBe(true);
      if (!claim1.ok) return;

      const finish1 = await transitionTaskStatus(
        root,
        teamName,
        task1.id,
        'in_progress',
        'completed',
        claim1.claimToken,
        { result: 'foundation poured' },
      );
      expect(finish1.ok).toBe(true);

      // Verify task2 is now automatically 'pending'
      const tasks = await listTasks(root, teamName);
      const updatedTask2 = tasks.find((t) => t.id === task2.id);
      expect(updatedTask2?.status).toBe('pending');

      // Now worker 2 can claim task2!
      const claim2 = await claimTask(root, teamName, task2.id, 'worker-2');
      expect(claim2.ok).toBe(true);
    });
  });

  describe('Claiming, Token Protection & Monotonic Generations', () => {
    it('claims pending task with token hash on disk and unguessable token returned', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Claimable Task',
        description: 'Claims test',
      });

      const claimResult = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claimResult.ok).toBe(true);
      if (!claimResult.ok) return;

      const { task: claimedTask, claimToken } = claimResult;
      expect(claimedTask.status).toBe('in_progress');
      expect(claimedTask.owner).toBe('worker-1');
      expect(claimedTask.claim?.generation).toBe(1);
      expect(claimedTask.last_claim_generation).toBe(1);
      expect(claimedTask.claim?.heartbeat_sequence).toBe(0);

      // Verify token hash
      const expectedHash = crypto.createHash('sha256').update(claimToken).digest('hex');
      expect(claimedTask.claim?.token_sha256).toBe(expectedHash);
      // Raw token is NEVER stored on disk
      expect(claimedTask.claim?.token).toBeUndefined();

      // Read directly from file to verify secret is not persisted
      const fileContent = JSON.parse(
        fs.readFileSync(path.join(teamTasksDir(root, teamName), `task-${task.id}.json`), 'utf8'),
      );
      expect(fileContent.claim.token_sha256).toBe(expectedHash);
      expect(fileContent.claim.token).toBeUndefined();
    });

    it('rejects duplicate claim on in_progress task while lease is active', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Contested Task',
        description: 'Contested',
      });

      const claim1 = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claim1.ok).toBe(true);

      const claim2 = await claimTask(root, teamName, task.id, 'worker-2');
      expect(claim2.ok).toBe(false);
      if (claim2.ok) return;
      expect(claim2.error).toBe('claim_conflict');
    });

    it('releases task claim and increments generation upon next claim', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Release Task',
        description: 'Release test',
      });

      const claim1 = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claim1.ok).toBe(true);
      if (!claim1.ok) return;

      const release = await releaseTaskClaim(
        root,
        teamName,
        task.id,
        claim1.claimToken,
        'worker-1',
        undefined,
        { generation: 1 },
      );
      expect(release.ok).toBe(true);
      if (!release.ok) return;
      expect(release.task.status).toBe('pending');
      expect(release.task.claim).toBeUndefined();
      expect(release.task.owner).toBeUndefined();
      // Generation watermark is preserved across release
      expect(release.task.last_claim_generation).toBe(1);

      // Worker 2 claims released task -> generation monotonically advances to 2!
      const claim2 = await claimTask(root, teamName, task.id, 'worker-2');
      expect(claim2.ok).toBe(true);
      if (!claim2.ok) return;
      expect(claim2.task.claim?.generation).toBe(2);
      expect(claim2.task.last_claim_generation).toBe(2);
    });
  });

  describe('Claim Renewal (renewTaskClaim)', () => {
    it('renews claim with valid token, extending leased_until and incrementing heartbeat_sequence', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Long Running Task',
        description: 'Needs renewals',
      });

      let fakeTime = new Date('2026-09-05T10:00:00.000Z');
      const claim = await claimTask(
        root,
        teamName,
        task.id,
        'worker-1',
        { leaseMs: 60000, now: () => fakeTime },
      );
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      // 30 seconds later, renew
      fakeTime = new Date('2026-09-05T10:00:30.000Z');
      const renew1 = await renewTaskClaim(
        root,
        teamName,
        task.id,
        'worker-1',
        claim.claimToken,
        { leaseMs: 60000, generation: 1, now: () => fakeTime },
      );
      expect(renew1.ok).toBe(true);
      if (!renew1.ok) return;
      expect(renew1.task.claim?.heartbeat_sequence).toBe(1);
      expect(renew1.task.claim?.renewed_at).toBe('2026-09-05T10:00:30.000Z');
      expect(renew1.task.claim?.leased_until).toBe('2026-09-05T10:01:30.000Z');

      // Renew again 30 seconds later (sequence 2)
      fakeTime = new Date('2026-09-05T10:01:00.000Z');
      const renew2 = await renewTaskClaim(
        root,
        teamName,
        task.id,
        'worker-1',
        claim.claimToken,
        { leaseMs: 60000, generation: 1, now: () => fakeTime },
      );
      expect(renew2.ok).toBe(true);
      if (!renew2.ok) return;
      expect(renew2.task.claim?.heartbeat_sequence).toBe(2);
    });

    it('rejects unsafe or non-monotonic heartbeat sequence options during renewal', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, { subject: 'HB test', description: 'desc' });
      const claim = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      // Reject unsafe heartbeatSequence (1e100)
      const unsafeRenew = await renewTaskClaim(root, teamName, task.id, 'worker-1', claim.claimToken, {
        heartbeatSequence: 1e100,
      });
      expect(unsafeRenew.ok).toBe(false);

      // Normal renew advances to 1
      const renew1 = await renewTaskClaim(root, teamName, task.id, 'worker-1', claim.claimToken, {
        heartbeatSequence: 1,
      });
      expect(renew1.ok).toBe(true);

      // Reject non-monotonic sequence (<= 1)
      const nonMonotonic = await renewTaskClaim(root, teamName, task.id, 'worker-1', claim.claimToken, {
        heartbeatSequence: 1,
      });
      expect(nonMonotonic.ok).toBe(false);
    });

    it('sustains tasks past default 15m lease without eviction', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: '20 Minute Task',
        description: 'Long job',
      });

      let fakeTime = new Date('2026-09-05T10:00:00.000Z');
      const claim = await claimTask(
        root,
        teamName,
        task.id,
        'worker-1',
        { leaseMs: CLAIM_LEASE_MS, now: () => fakeTime },
      );
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      // Renew at 10m
      fakeTime = new Date('2026-09-05T10:10:00.000Z');
      const renew = await renewTaskClaim(
        root,
        teamName,
        task.id,
        'worker-1',
        claim.claimToken,
        { leaseMs: CLAIM_LEASE_MS, generation: 1, now: () => fakeTime },
      );
      expect(renew.ok).toBe(true);

      // Check at 18m (past original 15m)
      fakeTime = new Date('2026-09-05T10:18:00.000Z');
      const reclaim = await reclaimTask(
        root,
        teamName,
        task.id,
        'worker-2',
        { now: () => fakeTime },
      );
      expect(reclaim.ok).toBe(false);
      if (reclaim.ok) return;
      expect(reclaim.error).toBe('lease_active');
    });

    it('rejects renewal with invalid token, wrong generation, or expired lease', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Faulty Renewals',
        description: 'Testing errors',
      });

      let fakeTime = new Date('2026-09-05T10:00:00.000Z');
      const claim = await claimTask(
        root,
        teamName,
        task.id,
        'worker-1',
        { leaseMs: 60000, now: () => fakeTime },
      );
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      // Wrong token
      const wrongToken = await renewTaskClaim(
        root,
        teamName,
        task.id,
        'worker-1',
        'wrong-token',
        { now: () => fakeTime },
      );
      expect(wrongToken.ok).toBe(false);
      if (wrongToken.ok) return;
      expect(wrongToken.error).toBe('claim_conflict');

      // Wrong generation
      const wrongGen = await renewTaskClaim(
        root,
        teamName,
        task.id,
        'worker-1',
        claim.claimToken,
        { generation: 99, now: () => fakeTime },
      );
      expect(wrongGen.ok).toBe(false);
      if (wrongGen.ok) return;
      expect(wrongGen.error).toBe('claim_conflict');

      // Expired lease
      fakeTime = new Date('2026-09-05T10:02:00.000Z'); // 2 minutes later
      const expired = await renewTaskClaim(
        root,
        teamName,
        task.id,
        'worker-1',
        claim.claimToken,
        { now: () => fakeTime },
      );
      expect(expired.ok).toBe(false);
      if (expired.ok) return;
      expect(expired.error).toBe('lease_expired');
    });

    it('rejects renewal exceeding MAX_TOTAL_LEASE_MS (24 hours)', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Eternal Task',
        description: 'Attempts to run forever',
      });

      const startTime = new Date('2026-09-05T00:00:00.000Z');
      const claim = await claimTask(
        root,
        teamName,
        task.id,
        'worker-1',
        { leaseMs: 20 * 60 * 1000, now: () => startTime },
      );
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      // Renew at 10m with total limit of 20m, requesting another 15m (10m + 15m = 25m > 20m)
      const renewTime = new Date(startTime.getTime() + 10 * 60 * 1000);
      const renew = await renewTaskClaim(
        root,
        teamName,
        task.id,
        'worker-1',
        claim.claimToken,
        { leaseMs: 15 * 60 * 1000, maxTotalLeaseMs: 20 * 60 * 1000, now: () => renewTime },
      );
      expect(renew.ok).toBe(false);
      if (renew.ok) return;
      expect(renew.error).toBe('lease_limit_exceeded');
    });

    it('does not shorten an existing lease during renewal when renewal request has earlier deadline', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Long Lease Task',
        description: 'Initial lease is long',
      });

      const startTime = new Date('2026-09-05T00:00:00.000Z');
      const claim = await claimTask(
        root,
        teamName,
        task.id,
        'worker-1',
        { leaseMs: 60 * 60 * 1000, now: () => startTime },
      );
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      const initialLeasedUntil = claim.task.claim?.leased_until;
      expect(initialLeasedUntil).toBe(new Date(startTime.getTime() + 60 * 60 * 1000).toISOString());

      // At 10m, send renewal with default 15m (10m + 15m = 25m < 60m)
      const renewTime = new Date(startTime.getTime() + 10 * 60 * 1000);
      const renew = await renewTaskClaim(
        root,
        teamName,
        task.id,
        'worker-1',
        claim.claimToken,
        { leaseMs: 15 * 60 * 1000, now: () => renewTime },
      );
      expect(renew.ok).toBe(true);
      if (!renew.ok) return;

      // The lease must NOT be shortened to 25m; it must preserve the 60m deadline
      expect(renew.task.claim?.leased_until).toBe(initialLeasedUntil);
    });

    it('verifies worker process liveness during renewal', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Liveness Task',
        description: 'Process bound',
      });

      const identity: WorkerProcessIdentityClaim = {
        pid: 5001,
        start_identity: 'darwin:Mon Sep  5 00:00:00 2026',
        start_identity_proven: true,
      };

      const now = new Date('2026-09-05T10:00:00.000Z');
      const claim = await claimTask(
        root,
        teamName,
        task.id,
        'worker-1',
        { processIdentity: identity, leaseMs: 60000, now: () => now },
      );
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      // Case 1: Process died
      const deadRuntime = makeMockProcessRuntime({ alivePids: new Set() });
      const renewDead = await renewTaskClaim(
        root,
        teamName,
        task.id,
        'worker-1',
        claim.claimToken,
        { processRuntime: deadRuntime, now: () => new Date('2026-09-05T10:00:10.000Z') },
      );
      expect(renewDead.ok).toBe(false);
      if (renewDead.ok) return;
      expect(renewDead.error).toBe('process_dead');

      // Case 2: Process PID was recycled (stale start identity)
      const staleRuntime = makeMockProcessRuntime({
        alivePids: new Set([5001]),
        startTimes: new Map([[5001, 'Tue Sep  6 12:00:00 2026']]),
      });
      const renewStale = await renewTaskClaim(
        root,
        teamName,
        task.id,
        'worker-1',
        claim.claimToken,
        { processRuntime: staleRuntime, now: () => new Date('2026-09-05T10:00:10.000Z') },
      );
      expect(renewStale.ok).toBe(false);
      if (renewStale.ok) return;
      expect(renewStale.error).toBe('process_stale');

      // Case 3: Process probe ambiguous
      const ambigRuntime = makeMockProcessRuntime({
        alivePids: new Set([5001]),
        ambiguousPids: new Map([[5001, 'permission_denied']]),
      });
      const renewAmbig = await renewTaskClaim(
        root,
        teamName,
        task.id,
        'worker-1',
        claim.claimToken,
        { processRuntime: ambigRuntime, now: () => new Date('2026-09-05T10:00:10.000Z') },
      );
      expect(renewAmbig.ok).toBe(false);
      if (renewAmbig.ok) return;
      expect(renewAmbig.error).toBe('process_ambiguous');
    });

    it('derives acquired_at from leased_until for legacy claims so tasks older than 24 hours can be renewed', async () => {
      const { root, teamName } = workspace();
      // Task created 48 hours ago
      const createdAt = '2026-09-03T10:00:00.000Z';
      const task = await createTask(root, teamName, {
        subject: 'Old Task Legacy Claim',
        description: 'Created 2 days ago',
      }, () => new Date(createdAt));

      // Simulate a legacy claim from 5 minutes ago without acquired_at or generation
      const now = new Date('2026-09-05T10:05:00.000Z');
      const leasedUntil = new Date('2026-09-05T10:15:00.000Z').toISOString();
      const filePath = path.join(teamTasksDir(root, teamName), `task-${task.id}.json`);
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      raw.status = 'in_progress';
      raw.owner = 'worker-1';
      raw.claim = {
        owner: 'worker-1',
        token: 'legacy-token-123',
        leased_until: leasedUntil,
      };
      fs.writeFileSync(filePath, JSON.stringify(raw));

      // Try renewing the legacy claim now (2 days after creation, but only 5 min into the lease)
      const renew = await renewTaskClaim(
        root,
        teamName,
        task.id,
        'worker-1',
        'legacy-token-123',
        { now: () => now },
      );
      expect(renew.ok).toBe(true);
      if (!renew.ok) return;
      expect(renew.task.claim?.acquired_at).toBe('2026-09-05T10:00:00.000Z');
      expect(renew.task.claim?.generation).toBe(1);
    });
  });
});
