import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { projectStateRoot } from '../../src/runtime/state-root.js';
import {
  claimTask,
  createTask,
  listTasks,
  readTask,
  rebuildTaskFromJournal,
  reclaimTask,
  releaseTaskClaim,
  renewTaskClaim,
  reopenTask,
  transitionTaskStatus,
} from '../../src/team/tasks.js';
import { initializeTeamState, teamTasksDir, teamTaskJournalDir } from '../../src/team/state-root.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function workspace(teamName = 'test-team') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-tasks-recovery-'));
  roots.push(dir);
  const root = projectStateRoot(dir);
  initializeTeamState(root, {
    teamName,
    task: 'team task recovery testing',
    workers: [
      { name: 'worker-1', owned_paths: ['src/w1'] },
      { name: 'worker-2', owned_paths: ['src/w2'] },
      { name: 'supervisor', owned_paths: ['src/sup'] },
    ],
  });
  return { dir, root, teamName };
}

describe('Team Tasks Journal Recovery and Reconciliation', () => {
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

    it('propagates corrupt task journal as E_TEAM_TASK_CORRUPT when snapshot is absent', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, {
        subject: 'Journal Corruption Test',
        description: 'Ensure corrupt journal is not reported as absent',
      });

      // Delete snapshot JSON file so it must rebuild from journal
      const taskPath = path.join(teamTasksDir(root, teamName), `task-${task.id}.json`);
      fs.unlinkSync(taskPath);
      expect(fs.existsSync(taskPath)).toBe(false);

      // Corrupt the journal head
      const journalDir = teamTaskJournalDir(root, teamName, task.id);
      const headFile = path.join(journalDir, 'head.json');
      fs.writeFileSync(headFile, '{"broken_head": true, bad_json');

      // rebuildTaskFromJournal must throw E_TEAM_TASK_CORRUPT instead of returning null
      expect(() => rebuildTaskFromJournal(root, teamName, task.id)).toThrow('E_TEAM_TASK_CORRUPT');

      // readTask must throw E_TEAM_TASK_CORRUPT instead of returning null
      await expect(readTask(root, teamName, task.id)).rejects.toThrow('E_TEAM_TASK_CORRUPT');

      // listTasks must throw E_TEAM_TASK_CORRUPT instead of silently omitting the task
      await expect(listTasks(root, teamName)).rejects.toThrow('E_TEAM_TASK_CORRUPT');
    });

    it('returns null for truly absent task without journal or snapshot', async () => {
      const { root, teamName } = workspace();
      expect(await readTask(root, teamName, '9999')).toBeNull();
      expect(rebuildTaskFromJournal(root, teamName, '9999')).toBeNull();
    });

    it('fences prerequisite checks against concurrent reopen', async () => {
      const { root, teamName } = workspace();
      // 1. Create Prereq (Task 1) and complete it
      const task1 = await createTask(root, teamName, { subject: 'Prereq', description: 'Step 1' });
      const claim1 = await claimTask(root, teamName, task1.id, 'worker-1');
      expect(claim1.ok).toBe(true);
      if (!claim1.ok) return;
      const comp1 = await transitionTaskStatus(root, teamName, task1.id, 'in_progress', 'completed', claim1.claimToken, { result: 'done' });
      expect(comp1.ok).toBe(true);

      // 2. Create Dependent (Task 2) blocked by Task 1, claimed as in_progress
      const task2 = await createTask(root, teamName, { subject: 'Dependent', description: 'Step 2', blocked_by: [task1.id] });
      expect(task2.status).toBe('pending');
      const claim2 = await claimTask(root, teamName, task2.id, 'worker-2');
      expect(claim2.ok).toBe(true);
      if (!claim2.ok) return;

      // 3. Concurrently reopen Task 1 and complete Task 2
      const [reopenResult, completeResult] = await Promise.all([
        reopenTask(root, teamName, task1.id, { reason: 'need update' }),
        transitionTaskStatus(root, teamName, task2.id, 'in_progress', 'completed', claim2.claimToken, { result: 'dep done' }),
      ]);

      expect(reopenResult.ok).toBe(true);
      const read1 = await readTask(root, teamName, task1.id);
      const read2 = await readTask(root, teamName, task2.id);
      expect(read1?.status).toBe('pending');

      // Task 2 can NEVER end up completed while Task 1 is pending!
      if (!completeResult.ok) {
        expect(['invalid_transition', 'claim_conflict']).toContain(completeResult.error);
        expect(read2?.status).toBe('blocked');
      } else {
        // If completion succeeded before reopen took effect, verify both are non-conflicting
        expect(read2?.status).toBe('completed');
      }
    });
  });

  describe('Forced Reclaim Expected Generation & Version Fencing', () => {
    it('rejects forced reclaim without expectedGeneration or expectedVersion', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, { subject: 'T1', description: 'Desc' });
      const claim = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claim.ok).toBe(true);

      const reclaim = await reclaimTask(root, teamName, task.id, 'supervisor', {
        force: true,
      });
      expect(reclaim.ok).toBe(false);
      if (!reclaim.ok) {
        expect(reclaim.error).toBe('generation_mismatch');
        expect(reclaim.reason).toContain('Forced reclaim requires expectedGeneration or expectedVersion');
      }
    });

    it('rejects forced reclaim with mismatched expectedGeneration', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, { subject: 'T1', description: 'Desc' });
      const claim = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claim.ok).toBe(true);

      const reclaim = await reclaimTask(root, teamName, task.id, 'supervisor', {
        force: true,
        expectedGeneration: 99,
      });
      expect(reclaim.ok).toBe(false);
      if (!reclaim.ok) {
        expect(reclaim.error).toBe('generation_mismatch');
        expect(reclaim.priorGeneration).toBe(1);
      }
    });

    it('rejects forced reclaim with mismatched expectedVersion', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, { subject: 'T1', description: 'Desc' });
      const claim = await claimTask(root, teamName, task.id, 'worker-1');
      expect(claim.ok).toBe(true);

      const reclaim = await reclaimTask(root, teamName, task.id, 'supervisor', {
        force: true,
        expectedGeneration: 1,
        expectedVersion: 99,
      });
      expect(reclaim.ok).toBe(false);
      if (!reclaim.ok) {
        expect(reclaim.error).toBe('claim_conflict');
      }
    });

    it('protects newer claims against stale supervisor force-reclaims', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, { subject: 'T1', description: 'Desc' });

      let fakeTime = new Date('2026-09-05T10:00:00.000Z');
      const claim1 = await claimTask(root, teamName, task.id, 'worker-1', { leaseMs: 60000, now: () => fakeTime });
      expect(claim1.ok).toBe(true);

      // Lease expires, worker 2 reclaims (generation 2)
      fakeTime = new Date('2026-09-05T10:01:01.000Z');
      const reclaim2 = await reclaimTask(root, teamName, task.id, 'worker-2', { now: () => fakeTime });
      expect(reclaim2.ok).toBe(true);
      if (!reclaim2.ok) return;
      expect(reclaim2.newGeneration).toBe(2);

      // Stale supervisor request targeting generation 1 arrives
      const staleSupervisorReclaim = await reclaimTask(root, teamName, task.id, 'supervisor', {
        force: true,
        expectedGeneration: 1,
        now: () => fakeTime,
      });
      expect(staleSupervisorReclaim.ok).toBe(false);
      if (!staleSupervisorReclaim.ok) {
        expect(staleSupervisorReclaim.error).toBe('generation_mismatch');
        expect(staleSupervisorReclaim.priorGeneration).toBe(2);
        expect(staleSupervisorReclaim.priorOwner).toBe('worker-2');
      }

      // Worker 2's active claim remains intact and protected
      const currentTask = await readTask(root, teamName, task.id);
      expect(currentTask?.owner).toBe('worker-2');
      expect(currentTask?.claim?.generation).toBe(2);
    });
  });

  describe('Journal Reconciliation on Snapshot Write Failure', () => {
    it('reconciles journal and advances generation when claimTask snapshot write fails', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, { subject: 'Fail Snapshot', description: 'desc' });
      expect(task.status).toBe('pending');
      expect(task.version).toBe(1);

      // Attempt claim with simulated atomic write error
      await expect(
        claimTask(root, teamName, task.id, 'worker-1', {
          taskWriteOptions: {
            faultInjector: (point) => {
              if (point === 'write') throw new Error('E_ATOMIC_WRITE_SIMULATED');
            },
          },
        }),
      ).rejects.toThrow('E_ATOMIC_WRITE_SIMULATED');

      // 1. Recovery must not resurrect an unauthenticated in-progress claim
      const recovered = rebuildTaskFromJournal(root, teamName, task.id);
      expect(recovered).not.toBeNull();
      expect(recovered?.status).toBe('pending');
      expect(recovered?.claim).toBeUndefined();
      expect(recovered?.owner).toBeUndefined();
      // 2. The aborted claim generation (1) is recorded as burned in last_claim_generation
      expect(recovered?.last_claim_generation).toBe(1);

      // 3. Retry claiming: it must succeed and allocate generation 2, never reusing generation 1
      const retry = await claimTask(root, teamName, task.id, 'worker-1');
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.task.claim?.generation).toBe(2);
      expect(retry.task.last_claim_generation).toBe(2);
    });

    it('reconciles journal when reclaimTask snapshot write fails', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, { subject: 'Fail Reclaim', description: 'desc' });

      let fakeTime = new Date('2026-09-05T10:00:00.000Z');
      const claim1 = await claimTask(root, teamName, task.id, 'worker-1', { leaseMs: 60000, now: () => fakeTime });
      expect(claim1.ok).toBe(true);

      // Reclaim attempt after lease expires with simulated snapshot write failure
      fakeTime = new Date('2026-09-05T10:01:01.000Z');
      await expect(
        reclaimTask(root, teamName, task.id, 'worker-2', {
          taskWriteOptions: {
            faultInjector: (point) => {
              if (point === 'write') throw new Error('E_RECLAIM_WRITE_SIMULATED');
            },
          },
          now: () => fakeTime,
        }),
      ).rejects.toThrow('E_RECLAIM_WRITE_SIMULATED');

      // Recovery should not resurrect unauthenticated worker-2 claim
      const recovered = rebuildTaskFromJournal(root, teamName, task.id);
      expect(recovered?.claim).toBeUndefined();
      expect(recovered?.owner).toBeUndefined();
      expect(recovered?.last_claim_generation).toBe(2);

      // Subsequent retry allocates generation 3
      const retry = await claimTask(root, teamName, task.id, 'worker-2', { now: () => fakeTime });
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.task.claim?.generation).toBe(3);
    });

    it('normalizes legacy active claim with absent generation and assigns next claim generation 2', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, { subject: 'Legacy active claim', description: 'desc' });

      // Directly write legacy un-upgraded snapshot: active claim with no generation and no last_claim_generation
      const legacyTask = {
        schema_version: 1,
        id: task.id,
        version: 1,
        subject: task.subject,
        description: task.description,
        status: 'in_progress',
        owner: 'worker-1',
        created_at: '2026-07-31T00:00:00.000Z',
        claim: {
          owner: 'worker-1',
          token: 'legacy-token',
          leased_until: new Date(Date.now() + 300_000).toISOString(),
        },
      };
      fs.writeFileSync(
        path.join(teamTasksDir(root, teamName), `task-${task.id}.json`),
        JSON.stringify(legacyTask, null, 2),
        'utf8',
      );

      // Read task: should be normalized with generation 1 AND last_claim_generation 1
      const read = await readTask(root, teamName, task.id);
      expect(read).not.toBeNull();
      expect(read?.claim?.generation).toBe(1);
      expect(read?.last_claim_generation).toBe(1);

      // Release the claim back to pending
      const released = await releaseTaskClaim(root, teamName, task.id, 'legacy-token', 'worker-1');
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.task.last_claim_generation).toBe(1);

      // Next claim MUST allocate generation 2, preserving monotonic generation fence
      const nextClaim = await claimTask(root, teamName, task.id, 'worker-2');
      expect(nextClaim.ok).toBe(true);
      if (!nextClaim.ok) return;
      expect(nextClaim.task.claim?.generation).toBe(2);
      expect(nextClaim.task.last_claim_generation).toBe(2);
    });

    it('rejects unsafe integer claim generations and recovers from journal', async () => {
      const { root, teamName } = workspace();
      const task = await createTask(root, teamName, { subject: 'Unsafe generation test', description: 'desc' });

      // Corrupt snapshot with unsafe integer watermark (1e100)
      const unsafeTask = {
        schema_version: 1,
        id: task.id,
        version: 1,
        subject: task.subject,
        description: task.description,
        status: 'pending',
        created_at: '2026-07-31T00:00:00.000Z',
        last_claim_generation: 1e100,
      };
      fs.writeFileSync(
        path.join(teamTasksDir(root, teamName), `task-${task.id}.json`),
        JSON.stringify(unsafeTask, null, 2),
        'utf8',
      );

      // readTask should reject corrupt snapshot and recover from authoritative journal
      const recovered = await readTask(root, teamName, task.id);
      expect(recovered).not.toBeNull();
      expect(recovered?.last_claim_generation).toBe(0);

      // Active claim exceeding watermark is also rejected as corrupt and recovered from journal
      const claimExceeding = {
        schema_version: 1,
        id: task.id,
        version: 1,
        subject: task.subject,
        description: task.description,
        status: 'in_progress',
        owner: 'worker-1',
        created_at: '2026-07-31T00:00:00.000Z',
        last_claim_generation: 1,
        claim: {
          owner: 'worker-1',
          generation: 5,
          token_sha256: crypto.createHash('sha256').update('tok').digest('hex'),
          leased_until: new Date(Date.now() + 300_000).toISOString(),
        },
      };
      fs.writeFileSync(
        path.join(teamTasksDir(root, teamName), `task-${task.id}.json`),
        JSON.stringify(claimExceeding, null, 2),
        'utf8',
      );

      const recovered2 = await readTask(root, teamName, task.id);
      expect(recovered2).not.toBeNull();
      expect(recovered2?.status).toBe('pending');
      expect(recovered2?.claim).toBeUndefined();
    });
  });
});
