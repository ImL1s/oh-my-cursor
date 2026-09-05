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
  });

  describe('Lease Expiry, Duplicate Work Prevention & Safe Reclaim', () => {
    it('prevents new worker from claiming or reclaiming when prior worker is still alive', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Stop Duplicate Work',
        description: 'Worker still running',
      });

      const identity: WorkerProcessIdentityClaim = {
        pid: 7001,
        start_identity: 'darwin:Mon Sep  5 00:00:00 2026',
        start_identity_proven: true,
      };

      let fakeTime = new Date('2026-09-05T10:00:00.000Z');
      const claim = await claimTask(
        root,
        teamName,
        task.id,
        'worker-1',
        { processIdentity: identity, leaseMs: 60000, now: () => fakeTime },
      );
      expect(claim.ok).toBe(true);

      // Fast forward past lease expiry (2 minutes later)
      fakeTime = new Date('2026-09-05T10:02:00.000Z');

      // Worker 1 is STILL alive!
      const aliveRuntime = makeMockProcessRuntime({ alivePids: new Set([7001]) });

      // Worker 2 attempts normal claim -> rejected with worker_alive
      const claimAttempt = await claimTask(
        root,
        teamName,
        task.id,
        'worker-2',
        { processRuntime: aliveRuntime, now: () => fakeTime },
      );
      expect(claimAttempt.ok).toBe(false);
      if (claimAttempt.ok) return;
      expect(claimAttempt.error).toBe('worker_alive');

      // Worker 2 attempts reclaim without force -> rejected with worker_alive
      const reclaimAttempt = await reclaimTask(
        root,
        teamName,
        task.id,
        'worker-2',
        { processRuntime: aliveRuntime, now: () => fakeTime },
      );
      expect(reclaimAttempt.ok).toBe(false);
      if (reclaimAttempt.ok) return;
      expect(reclaimAttempt.error).toBe('worker_alive');
      expect(reclaimAttempt.priorGeneration).toBe(1);
      expect(reclaimAttempt.priorOwner).toBe('worker-1');
    });

    it('requires reconciliation when worker process status is ambiguous', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Ambiguous Worker',
        description: 'Cannot probe safely',
      });

      const identity: WorkerProcessIdentityClaim = {
        pid: 7002,
        start_identity: 'darwin:Mon Sep  5 00:00:00 2026',
        start_identity_proven: false, // Unproven identity
      };

      let fakeTime = new Date('2026-09-05T10:00:00.000Z');
      await claimTask(
        root,
        teamName,
        task.id,
        'worker-1',
        { processIdentity: identity, leaseMs: 60000, now: () => fakeTime },
      );

      // Past lease
      fakeTime = new Date('2026-09-05T10:02:00.000Z');
      const runtime = makeMockProcessRuntime({ alivePids: new Set([7002]) });

      const reclaimAttempt = await reclaimTask(
        root,
        teamName,
        task.id,
        'worker-2',
        { processRuntime: runtime, now: () => fakeTime },
      );
      expect(reclaimAttempt.ok).toBe(false);
      if (reclaimAttempt.ok) return;
      expect(reclaimAttempt.error).toBe('reconciliation_required');
    });

    it('reclaims expired task when worker process is confirmed dead, issuing generation 2', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Dead Worker Task',
        description: 'Worker crashed',
      });

      const identity: WorkerProcessIdentityClaim = {
        pid: 7003,
        start_identity: 'darwin:Mon Sep  5 00:00:00 2026',
        start_identity_proven: true,
      };

      let fakeTime = new Date('2026-09-05T10:00:00.000Z');
      await claimTask(
        root,
        teamName,
        task.id,
        'worker-1',
        { processIdentity: identity, leaseMs: 60000, now: () => fakeTime },
      );

      // Past lease, process confirmed dead
      fakeTime = new Date('2026-09-05T10:02:00.000Z');
      const deadRuntime = makeMockProcessRuntime({ alivePids: new Set() });

      const reclaim = await reclaimTask(
        root,
        teamName,
        task.id,
        'worker-2',
        { processRuntime: deadRuntime, reason: 'worker 1 dead', now: () => fakeTime },
      );
      expect(reclaim.ok).toBe(true);
      if (!reclaim.ok) return;
      expect(reclaim.previousGeneration).toBe(1);
      expect(reclaim.newGeneration).toBe(2);
      expect(reclaim.task.owner).toBe('worker-2');
      expect(reclaim.task.claim?.generation).toBe(2);
      expect(reclaim.task.last_claim_generation).toBe(2);
    });

    it('allows supervisor to force reclaim with killProcess hook', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Forced Handover',
        description: 'Supervisor override',
      });

      const identity: WorkerProcessIdentityClaim = {
        pid: 7004,
        start_identity: 'darwin:Mon Sep  5 00:00:00 2026',
        start_identity_proven: true,
      };

      const now = new Date('2026-09-05T10:00:00.000Z');
      await claimTask(
        root,
        teamName,
        task.id,
        'worker-1',
        { processIdentity: identity, leaseMs: 60000, now: () => now },
      );

      const killedPids: number[] = [];
      const alivePids = new Set([7004]);
      const runtime = makeMockProcessRuntime({ alivePids });

      // Reclaim with force & killProcess while lease is still active
      const reclaim = await reclaimTask(
        root,
        teamName,
        task.id,
        'supervisor',
        {
          force: true,
          killProcess: (pid) => {
            killedPids.push(pid);
            alivePids.delete(pid);
          },
          processRuntime: runtime,
          reason: 'supervisor intervention',
          now: () => now,
        },
      );

      expect(reclaim.ok).toBe(true);
      expect(killedPids).toEqual([7004]);
      if (!reclaim.ok) return;
      expect(reclaim.previousGeneration).toBe(1);
      expect(reclaim.newGeneration).toBe(2);
      expect(reclaim.task.owner).toBe('supervisor');
    });
  });

  describe('Generation Fencing (Stale Worker Protection)', () => {
    it('blocks zombie workers from older generations from mutating state', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Zombie Protection',
        description: 'Generation fencing',
      });

      let fakeTime = new Date('2026-09-05T10:00:00.000Z');
      const claim1 = await claimTask(
        root,
        teamName,
        task.id,
        'worker-1',
        { leaseMs: 60000, now: () => fakeTime },
      );
      expect(claim1.ok).toBe(true);
      if (!claim1.ok) return;

      // Force reclaim to worker-2 (generation 2)
      fakeTime = new Date('2026-09-05T10:00:30.000Z');
      const reclaim = await reclaimTask(
        root,
        teamName,
        task.id,
        'worker-2',
        { force: true, now: () => fakeTime },
      );
      expect(reclaim.ok).toBe(true);
      if (!reclaim.ok) return;

      // Worker 1 wakes up and tries to renew claim with generation 1
      const renewAttempt = await renewTaskClaim(
        root,
        teamName,
        task.id,
        'worker-1',
        claim1.claimToken,
        { generation: 1, now: () => fakeTime },
      );
      expect(renewAttempt.ok).toBe(false);
      if (renewAttempt.ok) return;
      expect(renewAttempt.error).toBe('claim_conflict');

      // Worker 1 tries to release claim with generation 1
      const releaseAttempt = await releaseTaskClaim(
        root,
        teamName,
        task.id,
        claim1.claimToken,
        'worker-1',
        () => fakeTime,
        { generation: 1 },
      );
      expect(releaseAttempt.ok).toBe(false);
      if (releaseAttempt.ok) return;
      expect(releaseAttempt.error).toBe('claim_conflict');

      // Worker 1 tries to submit completion with generation 1
      const transitionAttempt = await transitionTaskStatus(
        root,
        teamName,
        task.id,
        'in_progress',
        'completed',
        claim1.claimToken,
        { generation: 1, result: 'zombie result' },
        () => fakeTime,
      );
      expect(transitionAttempt.ok).toBe(false);
      if (transitionAttempt.ok) return;
      expect(transitionAttempt.error).toBe('claim_conflict');

      // Worker 2 completes successfully with generation 2
      const legitimateComplete = await transitionTaskStatus(
        root,
        teamName,
        task.id,
        'in_progress',
        'completed',
        reclaim.claimToken,
        { generation: 2, result: 'legitimate result' },
        () => fakeTime,
      );
      expect(legitimateComplete.ok).toBe(true);
    });
  });

  describe('Task Completion, Reopen & Summary', () => {
    it('completes task and clears active claim while preserving last_claim_generation', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Completion Test',
        description: 'Complete cleanly',
      });

      const claim = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      const finish = await transitionTaskStatus(
        root,
        teamName,
        task.id,
        'in_progress',
        'completed',
        claim.claimToken,
        { result: 'done with success' },
      );
      expect(finish.ok).toBe(true);
      if (!finish.ok) return;
      expect(finish.task.status).toBe('completed');
      expect(finish.task.claim).toBeUndefined();
      expect(finish.task.result).toBe('done with success');
      expect(finish.task.last_claim_generation).toBe(1);

      // Cannot transition already terminal task
      const retry = await transitionTaskStatus(
        root,
        teamName,
        task.id,
        'completed',
        'in_progress',
        claim.claimToken,
      );
      expect(retry.ok).toBe(false);
      if (retry.ok) return;
      expect(retry.error).toBe('invalid_transition');
    });

    it('rejects terminal payloads larger than 64 KiB', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Large Payload Task',
        description: 'Test payload bound',
      });

      const claim = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      const tooLarge = 'a'.repeat(64 * 1024 + 1);

      // Oversized result is rejected before commit
      const largeResult = await transitionTaskStatus(
        root,
        teamName,
        task.id,
        'in_progress',
        'completed',
        claim.claimToken,
        { result: tooLarge },
      );
      expect(largeResult.ok).toBe(false);
      if (largeResult.ok) return;
      expect(largeResult.error).toBe('invalid_transition');

      // Oversized error is rejected before commit
      const largeError = await transitionTaskStatus(
        root,
        teamName,
        task.id,
        'in_progress',
        'failed',
        claim.claimToken,
        { error: tooLarge },
      );
      expect(largeError.ok).toBe(false);
      if (largeError.ok) return;
      expect(largeError.error).toBe('invalid_transition');

      // Task remains in_progress and readable
      const tasks = await listTasks(root, teamName);
      expect(tasks[0]?.status).toBe('in_progress');
    });

    it('reopens completed or failed task preserving monotonic generation watermark', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Reopenable Task',
        description: 'Will fail then reopen',
      });

      const claim = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      // Fail task
      const fail = await transitionTaskStatus(
        root,
        teamName,
        task.id,
        'in_progress',
        'failed',
        claim.claimToken,
        { error: 'temporary network failure' },
      );
      expect(fail.ok).toBe(true);

      // Reopen
      const reopen = await reopenTask(root, teamName, task.id, { reason: 'retrying after network fix' });
      expect(reopen.ok).toBe(true);
      if (!reopen.ok) return;
      expect(reopen.task.status).toBe('pending');
      expect(reopen.task.claim).toBeUndefined();
      expect(reopen.task.last_claim_generation).toBe(1);

      // Re-claiming starts at generation 2
      const claimAgain = await claimTask(root, teamName, task.id, 'worker-2');
      expect(claimAgain.ok).toBe(true);
      if (!claimAgain.ok) return;
      expect(claimAgain.task.claim?.generation).toBe(2);
      expect(claimAgain.task.last_claim_generation).toBe(2);
    });

    it('reconciles and re-blocks active dependent tasks when a prerequisite is reopened', async () => {
      const { root, teamName } = workspace();
      const task1 = await createTask(root, teamName, { subject: 'Step 1', description: 'Prerequisite' });
      const task2 = await createTask(root, teamName, { subject: 'Step 2', description: 'Dependent', blocked_by: [task1.id] });

      // Worker 1 finishes task1 -> task2 unblocks to pending
      const c1 = await claimTask(root, teamName, task1.id, 'worker-1');
      expect(c1.ok).toBe(true);
      if (!c1.ok) return;
      const f1 = await transitionTaskStatus(root, teamName, task1.id, 'in_progress', 'completed', c1.claimToken);
      expect(f1.ok).toBe(true);

      const tasksAfter1 = await listTasks(root, teamName);
      const t2After1 = tasksAfter1.find((t) => t.id === task2.id);
      expect(t2After1?.status).toBe('pending');

      // Worker 2 claims task2 -> in_progress
      const c2 = await claimTask(root, teamName, task2.id, 'worker-2');
      expect(c2.ok).toBe(true);
      if (!c2.ok) return;
      expect(c2.task.status).toBe('in_progress');

      // Reopening task1 must reblock task2 and clear its claim
      const reopen = await reopenTask(root, teamName, task1.id, { reason: 'flaw found in step 1' });
      expect(reopen.ok).toBe(true);

      const tasksAfterReopen = await listTasks(root, teamName);
      const t2AfterReopen = tasksAfterReopen.find((t) => t.id === task2.id);
      expect(t2AfterReopen?.status).toBe('blocked');
      expect(t2AfterReopen?.owner).toBeUndefined();
      expect(t2AfterReopen?.claim).toBeUndefined();

      // Worker 2 can no longer transition task2 with old claim token
      const tryTransition = await transitionTaskStatus(
        root,
        teamName,
        task2.id,
        'in_progress',
        'completed',
        c2.claimToken,
      );
      expect(tryTransition.ok).toBe(false);
      if (tryTransition.ok) return;
      expect(tryTransition.error).toBe('invalid_transition');
    });

    it('prevents completing a task if any prerequisite is not completed', async () => {
      const { root, teamName } = workspace();
      const task1 = await createTask(root, teamName, { subject: 'Step 1', description: 'Prereq' });
      const task2 = await createTask(root, teamName, { subject: 'Step 2', description: 'Dep', blocked_by: [task1.id] });

      const c1 = await claimTask(root, teamName, task1.id, 'worker-1');
      expect(c1.ok).toBe(true);
      if (!c1.ok) return;
      await transitionTaskStatus(root, teamName, task1.id, 'in_progress', 'completed', c1.claimToken);

      const c2 = await claimTask(root, teamName, task2.id, 'worker-2');
      expect(c2.ok).toBe(true);
      if (!c2.ok) return;

      // Now reopen task1
      await reopenTask(root, teamName, task1.id);

      // Even if task2 status were somehow still checked, completing it is blocked
      const finish2 = await transitionTaskStatus(
        root,
        teamName,
        task2.id,
        'in_progress',
        'completed',
        c2.claimToken,
      );
      expect(finish2.ok).toBe(false);
      if (finish2.ok) return;
      expect(finish2.error).toBe('invalid_transition');
    });

    it('caps initial leaseMs to MAX_TOTAL_LEASE_MS on claimTask and reclaimTask', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, { subject: 'Lease Cap', description: 'Bound check' });

      const now = new Date('2026-09-05T12:00:00.000Z');
      const hugeLease = 100 * 24 * 60 * 60 * 1000; // 100 days

      // claimTask caps to 24h
      const claim = await claimTask(root, teamName, task.id, 'worker-1', {
        leaseMs: hugeLease,
        now: () => now,
      });
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;
      const expected24h = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      expect(claim.task.claim?.leased_until).toBe(expected24h);

      // reclaimTask caps to 24h
      const reclaim = await reclaimTask(root, teamName, task.id, 'worker-2', {
        force: true,
        leaseMs: hugeLease,
        now: () => now,
      });
      expect(reclaim.ok).toBe(true);
      if (!reclaim.ok) return;
      expect(reclaim.task.claim?.leased_until).toBe(expected24h);
    });

    it('computes accurate team summary counts', async () => {
      const { root, teamName } = workspace();
      const t1 = await createTask(root, teamName, { subject: 'P1', description: 'desc' });
      const t2 = await createTask(root, teamName, { subject: 'P2', description: 'desc', blocked_by: [t1.id] });
      const t3 = await createTask(root, teamName, { subject: 'P3', description: 'desc' });
      const t4 = await createTask(root, teamName, { subject: 'P4', description: 'desc' });

      // t3 claimed -> in_progress
      const c3 = await claimTask(root, teamName, t3.id, 'worker-1');
      expect(c3.ok).toBe(true);

      // t4 claimed and completed
      const c4 = await claimTask(root, teamName, t4.id, 'worker-2');
      expect(c4.ok).toBe(true);
      if (c4.ok) {
        await transitionTaskStatus(root, teamName, t4.id, 'in_progress', 'completed', c4.claimToken);
      }

      const summary = await getTeamSummary(root, teamName);
      expect(summary).not.toBeNull();
      expect(summary?.tasks.total).toBe(4);
      expect(summary?.tasks.pending).toBe(1); // t1
      expect(summary?.tasks.blocked).toBe(1); // t2
      expect(summary?.tasks.in_progress).toBe(1); // t3
      expect(summary?.tasks.completed).toBe(1); // t4
      expect(summary?.tasks.failed).toBe(0);
      expect(summary?.workers).toHaveLength(3);
    }, 20_000);
  });

  describe('Journal Recovery & Corruption Handling', () => {
    it('recovers corrupted task JSON file from authoritative task journal', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Resilient Task',
        description: 'Journal replay test',
      });

      const claim = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      const renew = await renewTaskClaim(root, teamName, task.id, 'worker-1', claim.claimToken);
      expect(renew.ok).toBe(true);

      // Directly corrupt the task JSON file on disk
      const filePath = path.join(teamTasksDir(root, teamName), `task-${task.id}.json`);
      fs.writeFileSync(filePath, '{"corrupted": true, broken');

      // rebuildTaskFromJournal recovers state
      const rebuilt = rebuildTaskFromJournal(root, teamName, task.id);
      expect(rebuilt).not.toBeNull();
      expect(rebuilt?.id).toBe(task.id);
      expect(rebuilt?.status).toBe('in_progress');
      expect(rebuilt?.claim?.heartbeat_sequence).toBe(1);
      expect(rebuilt?.claim?.generation).toBe(1);

      // Calling listTasks also transparently heals and returns the recovered task
      const tasks = await listTasks(root, teamName);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.id).toBe(task.id);
      expect(tasks[0]?.status).toBe('in_progress');
      expect(tasks[0]?.claim?.heartbeat_sequence).toBe(1);

      // Verify the file was restored on disk
      const healedJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(healedJson.id).toBe(task.id);
      expect(healedJson.status).toBe('in_progress');
    });

    it('rejects corrupt timestamps in task file as E_TEAM_TASK_CORRUPT', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Timestamp Test',
        description: 'Invalid date check',
      });

      const filePath = path.join(teamTasksDir(root, teamName), `task-${task.id}.json`);
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      raw.created_at = 'not-a-valid-iso-date';
      fs.writeFileSync(filePath, JSON.stringify(raw));

      // Remove journal so it cannot heal from journal
      const journalDir = teamTaskJournalDir(root, teamName, task.id);
      fs.rmSync(journalDir, { recursive: true, force: true });

      await expect(listTasks(root, teamName)).rejects.toThrow('E_TEAM_TASK_CORRUPT');
    });

    it('rejects schema invariant violations (e.g. pending with claim) as E_TEAM_TASK_CORRUPT', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Invariant Test',
        description: 'Schema check',
      });

      const filePath = path.join(teamTasksDir(root, teamName), `task-${task.id}.json`);
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      // Invariant violation: pending status cannot have a claim object
      raw.status = 'pending';
      raw.claim = {
        owner: 'worker-1',
        generation: 1,
        token_sha256: 'a'.repeat(64),
        leased_until: new Date().toISOString(),
      };
      fs.writeFileSync(filePath, JSON.stringify(raw));

      // Remove journal
      const journalDir = teamTaskJournalDir(root, teamName, task.id);
      fs.rmSync(journalDir, { recursive: true, force: true });

      await expect(listTasks(root, teamName)).rejects.toThrow('E_TEAM_TASK_CORRUPT');
    });
  });
});
