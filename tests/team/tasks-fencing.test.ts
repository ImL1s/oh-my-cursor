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
  MAX_TASK_JOURNAL_RECORD_BYTES,
  MAX_TOTAL_LEASE_MS,
  readTask,
  rebuildTaskFromJournal,
  reclaimTask,
  releaseTaskClaim,
  renewTaskClaim,
  reopenTask,
  toWorkerProcessIdentityClaim,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-tasks-fencing-'));
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

describe('team tasks fencing & reconciliation', { timeout: 20_000 }, () => {
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
          expectedGeneration: 1,
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

    it('refuses forced reclaim while the prior worker remains active without termination', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Active Worker Protection',
        description: 'Supervisor cannot override if process still active',
      });

      const identity: WorkerProcessIdentityClaim = {
        pid: 7005,
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

      const alivePids = new Set([7005]);
      const runtime = makeMockProcessRuntime({ alivePids });

      // Reclaim with force but without killing or failing to kill the active worker
      const reclaim = await reclaimTask(
        root,
        teamName,
        task.id,
        'supervisor',
        {
          force: true,
          expectedGeneration: 1,
          processRuntime: runtime,
          reason: 'supervisor intervention without kill',
          now: () => now,
        },
      );

      expect(reclaim.ok).toBe(false);
      if (reclaim.ok) return;
      expect(reclaim.error).toBe('worker_alive');
      expect(reclaim.reason).toBe('prior worker process remains active and could not be terminated');
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
        { force: true, expectedGeneration: 1, now: () => fakeTime },
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

    it('restores assigned owner from request_owner when reopening a task', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Assigned Task',
        description: 'Will fail and reopen while retaining owner assignment',
        owner: 'worker-1',
        request_id: 'req-assigned-1',
      });

      expect(task.owner).toBe('worker-1');
      expect(task.request_owner).toBe('worker-1');

      // worker-1 claims and fails
      const claim = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      const fail = await transitionTaskStatus(
        root,
        teamName,
        task.id,
        'in_progress',
        'failed',
        claim.claimToken,
        { error: 'transient error' },
      );
      expect(fail.ok).toBe(true);

      // Reopen task
      const reopen = await reopenTask(root, teamName, task.id, { reason: 'retry assigned task' });
      expect(reopen.ok).toBe(true);
      if (!reopen.ok) return;
      expect(reopen.task.status).toBe('pending');
      expect(reopen.task.claim).toBeUndefined();
      expect(reopen.task.owner).toBe('worker-1');
      expect(reopen.task.request_owner).toBe('worker-1');

      // worker-2 cannot claim because it is assigned to worker-1
      const claimW2 = await claimTask(root, teamName, task.id, 'worker-2');
      expect(claimW2.ok).toBe(false);
      if (claimW2.ok) return;
      expect(claimW2.error).toBe('claim_conflict');

      // worker-1 can claim it
      const claimW1 = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claimW1.ok).toBe(true);
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

    it('preserves assigned owner when reblocking unclaimed pending tasks upon prerequisite reopen', async () => {
      const { root, teamName } = workspace();
      const task1 = await createTask(root, teamName, { subject: 'Step 1', description: 'Prereq' });

      const c1 = await claimTask(root, teamName, task1.id, 'worker-1');
      expect(c1.ok).toBe(true);
      if (!c1.ok) return;
      await transitionTaskStatus(root, teamName, task1.id, 'in_progress', 'completed', c1.claimToken);

      const task2 = await createTask(root, teamName, {
        subject: 'Step 2',
        description: 'Designated worker task',
        owner: 'worker-2',
        blocked_by: [task1.id],
      });
      expect(task2.status).toBe('pending');
      expect(task2.owner).toBe('worker-2');
      expect(task2.claim).toBeUndefined();

      const reopen = await reopenTask(root, teamName, task1.id, { reason: 'need rework on step 1' });
      expect(reopen.ok).toBe(true);

      const reblockedTask2 = await readTask(root, teamName, task2.id);
      expect(reblockedTask2?.status).toBe('blocked');
      expect(reblockedTask2?.owner).toBe('worker-2');
      expect(reblockedTask2?.claim).toBeUndefined();

      const c1Again = await claimTask(root, teamName, task1.id, 'worker-1');
      expect(c1Again.ok).toBe(true);
      if (!c1Again.ok) return;
      await transitionTaskStatus(root, teamName, task1.id, 'in_progress', 'completed', c1Again.claimToken);

      const unblockedTask2 = await readTask(root, teamName, task2.id);
      expect(unblockedTask2?.status).toBe('pending');
      expect(unblockedTask2?.owner).toBe('worker-2');

      const invalidClaim = await claimTask(root, teamName, task2.id, 'worker-1');
      expect(invalidClaim.ok).toBe(false);
      if (!invalidClaim.ok) {
        expect(invalidClaim.error).toBe('claim_conflict');
      }

      const validClaim = await claimTask(root, teamName, task2.id, 'worker-2');
      expect(validClaim.ok).toBe(true);
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

    it('invalidates completed and terminal dependents across multi-level cascade when a prerequisite is reopened', async () => {
      const { root, teamName } = workspace();
      // Setup DAG: Task 1 -> Task 2 -> Task 3
      const task1 = await createTask(root, teamName, { subject: 'Task 1', description: 'Root prerequisite' });
      const task2 = await createTask(root, teamName, { subject: 'Task 2', description: 'Intermediate dependent', blocked_by: [task1.id] });
      const task3 = await createTask(root, teamName, { subject: 'Task 3', description: 'Leaf dependent', blocked_by: [task2.id] });

      // Complete Task 1
      const c1 = await claimTask(root, teamName, task1.id, 'worker-1');
      expect(c1.ok).toBe(true);
      if (!c1.ok) return;
      await transitionTaskStatus(root, teamName, task1.id, 'in_progress', 'completed', c1.claimToken, { result: 'res-1' });

      // Complete Task 2
      const c2 = await claimTask(root, teamName, task2.id, 'worker-2');
      expect(c2.ok).toBe(true);
      if (!c2.ok) return;
      await transitionTaskStatus(root, teamName, task2.id, 'in_progress', 'completed', c2.claimToken, { result: 'res-2' });

      // Complete Task 3
      const c3 = await claimTask(root, teamName, task3.id, 'worker-1');
      expect(c3.ok).toBe(true);
      if (!c3.ok) return;
      await transitionTaskStatus(root, teamName, task3.id, 'in_progress', 'completed', c3.claimToken, { result: 'res-3' });

      // Verify all 3 tasks are initially completed
      let tasks = await listTasks(root, teamName);
      expect(tasks.map((t) => t.status)).toEqual(['completed', 'completed', 'completed']);

      // Now reopen Task 1
      const reopen = await reopenTask(root, teamName, task1.id, { reason: 'upstream input updated' });
      expect(reopen.ok).toBe(true);

      // Verify Task 1 is pending, and both Task 2 and Task 3 are invalidated and transitioned to blocked
      tasks = await listTasks(root, teamName);
      const t1 = tasks.find((t) => t.id === task1.id)!;
      const t2 = tasks.find((t) => t.id === task2.id)!;
      const t3 = tasks.find((t) => t.id === task3.id)!;

      expect(t1.status).toBe('pending');
      expect(t2.status).toBe('blocked');
      expect(t2.completed_at).toBeUndefined();
      expect(t2.result).toBeUndefined();
      expect(t2.claim).toBeUndefined();
      expect(t2.owner).toBeUndefined();

      expect(t3.status).toBe('blocked');
      expect(t3.completed_at).toBeUndefined();
      expect(t3.result).toBeUndefined();
      expect(t3.claim).toBeUndefined();
      expect(t3.owner).toBeUndefined();

      // Journal verification: check that reopened events were recorded for dependents
      const t2Rebuilt = rebuildTaskFromJournal(root, teamName, task2.id);
      expect(t2Rebuilt?.status).toBe('blocked');
      const t3Rebuilt = rebuildTaskFromJournal(root, teamName, task3.id);
      expect(t3Rebuilt?.status).toBe('blocked');
    });

    it('serializes task creation with prerequisite reopening under dependency coordination lock', async () => {
      const { root, teamName } = workspace();
      const task1 = await createTask(root, teamName, { subject: 'Prereq 1', description: 'Base task' });
      const c1 = await claimTask(root, teamName, task1.id, 'worker-1');
      expect(c1.ok).toBe(true);
      if (!c1.ok) return;
      await transitionTaskStatus(root, teamName, task1.id, 'in_progress', 'completed', c1.claimToken);

      // Concurrently create dependent task2 and reopen task1
      const [reopenRes, createdTask2] = await Promise.all([
        reopenTask(root, teamName, task1.id),
        createTask(root, teamName, { subject: 'Dep 2', description: 'Depends on 1', blocked_by: [task1.id] }),
      ]);

      expect(reopenRes.ok).toBe(true);
      // Because operations are serialized under dependencyCoordinationLock,
      // task2 MUST end up blocked.
      const finalTask2 = await readTask(root, teamName, createdTask2.id);
      expect(finalTask2?.status).toBe('blocked');
    });

    it('discovers and unblocks journal-only dependent tasks when prerequisite completes', async () => {
      const { root, teamName } = workspace();
      const task1 = await createTask(root, teamName, { subject: 'Prereq', description: 'Step 1' });
      const task2 = await createTask(root, teamName, { subject: 'Dependent', description: 'Step 2', blocked_by: [task1.id] });

      expect(task2.status).toBe('blocked');

      // Delete task2 snapshot JSON from disk, simulating crash/loss while journal remains
      const task2Path = path.join(teamTasksDir(root, teamName), `task-${task2.id}.json`);
      fs.unlinkSync(task2Path);
      expect(fs.existsSync(task2Path)).toBe(false);

      // Complete task1
      const c1 = await claimTask(root, teamName, task1.id, 'worker-1');
      expect(c1.ok).toBe(true);
      if (!c1.ok) return;
      const comp1 = await transitionTaskStatus(root, teamName, task1.id, 'in_progress', 'completed', c1.claimToken);
      expect(comp1.ok).toBe(true);

      // unblockDependentTasks should have discovered task2 via task-journals, unblocked it to pending, and restored snapshot
      expect(fs.existsSync(task2Path)).toBe(true);
      const readTask2 = await readTask(root, teamName, task2.id);
      expect(readTask2?.status).toBe('pending');
    });

    it('discovers and reblocks journal-only dependent tasks when prerequisite is reopened', async () => {
      const { root, teamName } = workspace();
      const task1 = await createTask(root, teamName, { subject: 'Prereq', description: 'Step 1' });
      const task2 = await createTask(root, teamName, { subject: 'Dependent', description: 'Step 2', blocked_by: [task1.id] });

      // Complete task1 -> task2 unblocks to pending
      const c1 = await claimTask(root, teamName, task1.id, 'worker-1');
      expect(c1.ok).toBe(true);
      if (!c1.ok) return;
      await transitionTaskStatus(root, teamName, task1.id, 'in_progress', 'completed', c1.claimToken);

      // Complete task2
      const c2 = await claimTask(root, teamName, task2.id, 'worker-2');
      expect(c2.ok).toBe(true);
      if (!c2.ok) return;
      await transitionTaskStatus(root, teamName, task2.id, 'in_progress', 'completed', c2.claimToken, { result: 'done2' });

      // Delete task2 snapshot JSON
      const task2Path = path.join(teamTasksDir(root, teamName), `task-${task2.id}.json`);
      fs.unlinkSync(task2Path);
      expect(fs.existsSync(task2Path)).toBe(false);

      // Now reopen task1
      const reopen = await reopenTask(root, teamName, task1.id);
      expect(reopen.ok).toBe(true);

      // reblockDependentTasks should have discovered task2 from journal, invalidated it to blocked, and restored snapshot
      expect(fs.existsSync(task2Path)).toBe(true);
      const readTask2 = await readTask(root, teamName, task2.id);
      expect(readTask2?.status).toBe('blocked');
      expect(readTask2?.completed_at).toBeUndefined();
      expect(readTask2?.result).toBeUndefined();
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
        expectedGeneration: 1,
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


  describe('Process Identity validation and Ownership preservation', () => {
    it('rejects invalid process identity in toWorkerProcessIdentityClaim', () => {
      expect(() => toWorkerProcessIdentityClaim(null as unknown as WorkerProcessIdentityClaim))
        .toThrow('E_TEAM_TASK_PROCESS_IDENTITY_INVALID: process identity must be an object');
      expect(() => toWorkerProcessIdentityClaim({ pid: -1, start_identity: 'id' }))
        .toThrow('E_TEAM_TASK_PROCESS_IDENTITY_INVALID: pid must be a positive integer');
      expect(() => toWorkerProcessIdentityClaim({ pid: 1, start_identity: '' }))
        .toThrow('E_TEAM_TASK_PROCESS_IDENTITY_INVALID: start_identity must be a non-empty string');
      expect(() => toWorkerProcessIdentityClaim({ pid: 1, start_identity: 'id', start_identity_proven: 'yes' as unknown as boolean }))
        .toThrow('E_TEAM_TASK_PROCESS_IDENTITY_INVALID: start_identity_proven must be a boolean');
      expect(() => toWorkerProcessIdentityClaim({ pid: 1, start_identity: 'id', nonce: '' }))
        .toThrow('E_TEAM_TASK_PROCESS_IDENTITY_INVALID: nonce must be a non-empty string');
      expect(() => toWorkerProcessIdentityClaim({ pid: 1, start_identity: 'id', nonce_sha256: 'bad' }))
        .toThrow('E_TEAM_TASK_PROCESS_IDENTITY_INVALID: nonce_sha256 must be a 64-character hex string');
    });

    it('preserves assigned owner when completed dependent is reblocked and then unblocked', async () => {
      const { root, teamName } = workspace();
      const task1 = await createTask(root, teamName, {
        subject: 'Prereq Task',
        description: 'First step',
      });
      const task2 = await createTask(root, teamName, {
        subject: 'Dependent Task',
        description: 'Second step',
        owner: 'worker-2',
        blocked_by: [task1.id],
      });

      expect(task2.status).toBe('blocked');
      expect(task2.owner).toBe('worker-2');
      expect(task2.request_owner).toBe('worker-2');

      // Complete task1 -> unblocks task2 to pending with owner intact
      const claim1 = await claimTask(root, teamName, task1.id, 'worker-1');
      expect(claim1.ok).toBe(true);
      if (!claim1.ok) return;
      await transitionTaskStatus(root, teamName, task1.id, 'in_progress', 'completed', claim1.claimToken);

      const unblocked2 = await readTask(root, teamName, task2.id);
      expect(unblocked2?.status).toBe('pending');
      expect(unblocked2?.owner).toBe('worker-2');

      // worker-2 claims and completes task2
      const claim2 = await claimTask(root, teamName, task2.id, 'worker-2');
      expect(claim2.ok).toBe(true);
      if (!claim2.ok) return;
      await transitionTaskStatus(root, teamName, task2.id, 'in_progress', 'completed', claim2.claimToken, { result: 'done' });

      const completed2 = await readTask(root, teamName, task2.id);
      expect(completed2?.status).toBe('completed');
      expect(completed2?.owner).toBe('worker-2');

      // Reopen task1 -> task2 should be reblocked, but preserve its owner worker-2!
      await reopenTask(root, teamName, task1.id, 'reopen for rework');
      const reblocked2 = await readTask(root, teamName, task2.id);
      expect(reblocked2?.status).toBe('blocked');
      expect(reblocked2?.owner).toBe('worker-2');

      // Re-complete task1 -> task2 unblocks to pending, still retaining worker-2!
      const reclaim1 = await claimTask(root, teamName, task1.id, 'worker-1');
      expect(reclaim1.ok).toBe(true);
      if (!reclaim1.ok) return;
      await transitionTaskStatus(root, teamName, task1.id, 'in_progress', 'completed', reclaim1.claimToken);

      const restored2 = await readTask(root, teamName, task2.id);
      expect(restored2?.status).toBe('pending');
      expect(restored2?.owner).toBe('worker-2');
    });

    it('preserves assigned owner on reopening non-idempotent task created without request_id', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Non-idempotent task',
        description: 'Created with owner but no request_id',
        owner: 'worker-1',
      });

      expect(task.request_id).toBeUndefined();
      expect(task.owner).toBe('worker-1');
      expect(task.request_owner).toBe('worker-1');

      // Claim and complete
      const claim = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;
      await transitionTaskStatus(root, teamName, task.id, 'in_progress', 'completed', claim.claimToken, { result: 'finished' });

      // Reopen task
      const reopen = await reopenTask(root, teamName, task.id, 'needs fixes');
      expect(reopen.ok).toBe(true);
      if (!reopen.ok) return;
      expect(reopen.task.status).toBe('pending');
      expect(reopen.task.owner).toBe('worker-1');
      expect(reopen.task.request_owner).toBe('worker-1');
    });

    it('fences claimTask against concurrent prerequisite reopen', async () => {
      const { root, teamName } = workspace();
      const task1 = await createTask(root, teamName, { subject: 'Prereq 1', description: 'Root' });
      const c1 = await claimTask(root, teamName, task1.id, 'worker-1');
      expect(c1.ok).toBe(true);
      if (!c1.ok) return;
      await transitionTaskStatus(root, teamName, task1.id, 'in_progress', 'completed', c1.claimToken);

      const task2 = await createTask(root, teamName, { subject: 'Dep 1', description: 'Leaf', blocked_by: [task1.id] });
      expect(task2.status).toBe('pending');

      // Concurrently claim Task 2 and reopen Task 1
      const [claimResult, reopenResult] = await Promise.all([
        claimTask(root, teamName, task2.id, 'worker-2'),
        reopenTask(root, teamName, task1.id, { reason: 'need revision' }),
      ]);

      expect(reopenResult.ok).toBe(true);
      const read1 = await readTask(root, teamName, task1.id);
      const read2 = await readTask(root, teamName, task2.id);
      expect(read1?.status).toBe('pending');

      // Due to dependency coordination fence, Task 2 can NEVER remain in_progress if Task 1 is reopened
      if (claimResult.ok) {
        // If claim succeeded first, reopenTask's cascade MUST have reblocked Task 2
        expect(read2?.status).toBe('blocked');
      } else {
        // If reopen ran first, claimTask MUST fail due to blocked_dependency
        expect(claimResult.error).toBe('blocked_dependency');
        expect(read2?.status).toBe('blocked');
      }
    });

    it('rejects task creation when lifecycle journal record would exceed max record limit without creating snapshot', async () => {
      const { root, teamName } = workspace();
      const oversizedDescription = 'x'.repeat(65 * 1024);

      await expect(createTask(root, teamName, {
        subject: 'Oversized Task',
        description: oversizedDescription,
      })).rejects.toThrow('E_TEAM_TASK_TOO_LARGE');

      // Verify no orphan snapshot file was created on disk
      const dir = teamTasksDir(root, teamName);
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('task-')) : [];
      expect(files.length).toBe(0);
    });

    it('permits creating, claiming, and transitioning tasks near 60 KiB limit when journal record fits within MAX_TASK_JOURNAL_RECORD_BYTES', async () => {
      const { root, teamName } = workspace();
      const description = 'x'.repeat(60 * 1024 - 500);
      const task = await createTask(root, teamName, {
        subject: 'Near Limit Task',
        description,
      });
      expect(task.status).toBe('pending');

      const claim = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      const comp = await transitionTaskStatus(
        root,
        teamName,
        task.id,
        'in_progress',
        'completed',
        claim.claimToken,
        { result: 'done' },
      );
      expect(comp.ok).toBe(true);
      if (!comp.ok) return;
      expect(comp.task.status).toBe('completed');
    });

    it('rejects transition when journal envelope causes total record to exceed MAX_TASK_JOURNAL_RECORD_BYTES', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Envelope Overflow Task',
        description: 'x'.repeat(60 * 1024 - 1000),
      });
      const claim = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      // Result sized such that payload alone is < 64 KiB, but with journal envelope exceeds 64 KiB
      const resultPayload = 'y'.repeat(4 * 1024 + 500);
      const rejected = await transitionTaskStatus(
        root,
        teamName,
        task.id,
        'in_progress',
        'completed',
        claim.claimToken,
        { result: resultPayload },
      );
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error).toBe('invalid_transition');
      }
    });
  });
});

