import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, type Run, type RunResult, type SDKAgent } from '@cursor/sdk';
import { CursorNativeTeamSupervisor } from '../../src/team/native-supervisor.js';
import type { TeamWorkerSpec } from '../../src/team/types.js';

describe('Native Cursor Team Supervisor (No Tmux Requirement)', () => {
  let tempDir: string;
  let supervisor: CursorNativeTeamSupervisor;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-native-team-'));
    supervisor = new CursorNativeTeamSupervisor(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('starts native Cursor team, records native IDs, and enforces path exclusivity', async () => {
    const fakeRun: Partial<Run> = {
      id: 'native-team-run-1',
      agentId: 'native-team-agent-1',
      status: 'running',
      supports: () => true,
      unsupportedReason: () => undefined,
      wait: async () => ({ id: 'native-team-run-1', status: 'completed' } as RunResult),
    };

    const fakeAgent: Partial<SDKAgent> = {
      agentId: 'native-team-agent-1',
      send: vi.fn().mockResolvedValue(fakeRun as Run),
      close: vi.fn(),
    };

    vi.spyOn(Agent, 'create').mockResolvedValue(fakeAgent as SDKAgent);

    // Conflict case: overlapping paths
    const conflictWorkers: TeamWorkerSpec[] = [
      { id: 'w1', objective: 'Obj 1', cwd: tempDir, owned_paths: ['src/a.ts'] },
      { id: 'w2', objective: 'Obj 2', cwd: tempDir, owned_paths: ['src/a.ts'] },
    ];
    await expect(supervisor.start('team-conflict', conflictWorkers)).rejects.toThrow(/E_TEAM_PATH_CONFLICT/);

    // Non-overlapping case
    const validWorkers: TeamWorkerSpec[] = [
      { id: 'w1', objective: 'Obj 1', cwd: tempDir, owned_paths: ['src/a.ts'] },
      { id: 'w2', objective: 'Obj 2', cwd: tempDir, owned_paths: ['src/b.ts'] },
    ];

    const manifest = await supervisor.start('team-valid', validWorkers);
    expect(manifest.native_cursor_team).toBe(true);
    expect(manifest.capability_tier).toBe('native-cursor-team');
    expect(manifest.workers).toHaveLength(2);
    expect(manifest.workers[0]?.agent_id).toBe('native-team-agent-1');
    expect(manifest.workers[0]?.run_id).toBe('native-team-run-1');
  });

  it('status queries native agent/run state without screen scraping', async () => {
    const fakeRun: Partial<Run> = {
      id: 'run-w1',
      agentId: 'agent-w1',
      status: 'in_progress',
    };

    vi.spyOn(Agent, 'getRun').mockResolvedValue(fakeRun as Run);

    const manifest = {
      schema_version: 2 as const,
      team_id: 'team-status-test',
      capability_tier: 'native-cursor-team' as const,
      native_cursor_team: true as const,
      workers: [
        {
          id: 'w1',
          cwd: tempDir,
          owned_paths: ['src/a.ts'],
          agent_id: 'agent-w1',
          run_id: 'run-w1',
          status: 'running',
          runtime: 'local' as const,
        },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      stopped_at: null,
    };
    supervisor.saveManifest(manifest);

    const status = await supervisor.status('team-status-test');
    expect(status.native_cursor_team).toBe(true);
    expect(status.active).toBe(true);
    expect(status.workers[0]?.status).toBe('in_progress');

    const monitorText = await supervisor.monitor('team-status-test');
    expect(monitorText).toContain('team-status-test');
    expect(monitorText).toContain('native_cursor_team: true');
    expect(monitorText).toContain('agent=agent-w1');
  });

  it('shutdown cancels native worker runs via Agent.cancelRun', async () => {
    const cancelledRunIds: string[] = [];
    vi.spyOn(Agent, 'cancelRun').mockImplementation(async (runId) => {
      cancelledRunIds.push(runId);
    });

    const manifest = {
      schema_version: 2 as const,
      team_id: 'team-shutdown-test',
      capability_tier: 'native-cursor-team' as const,
      native_cursor_team: true as const,
      workers: [
        {
          id: 'w1',
          cwd: tempDir,
          owned_paths: ['src/a.ts'],
          agent_id: 'agent-w1',
          run_id: 'run-w1-active',
          status: 'running',
          runtime: 'local' as const,
        },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      stopped_at: null,
    };
    supervisor.saveManifest(manifest);

    const updated = await supervisor.shutdown('team-shutdown-test');
    expect(updated.stopped_at).not.toBeNull();
    expect(updated.workers[0]?.status).toBe('cancelled');
    expect(cancelledRunIds).toContain('run-w1-active');
  });

  it('resume re-attaches to native agents across boundaries', async () => {
    const resumeSpy = vi.spyOn(Agent, 'resume').mockImplementation(async (agentId) => {
      return {
        agentId,
        send: vi.fn().mockResolvedValue({
          id: `new-run-for-${agentId}`,
          status: 'running',
        } as Partial<Run> as Run),
      } as Partial<SDKAgent> as SDKAgent;
    });

    const manifest = {
      schema_version: 2 as const,
      team_id: 'team-resume-test',
      capability_tier: 'native-cursor-team' as const,
      native_cursor_team: true as const,
      workers: [
        {
          id: 'w1',
          cwd: tempDir,
          owned_paths: ['src/a.ts'],
          agent_id: 'agent-w1-resumable',
          run_id: 'old-run',
          status: 'paused',
          runtime: 'local' as const,
        },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      stopped_at: null,
    };
    supervisor.saveManifest(manifest);

    const resumed = await supervisor.resume('team-resume-test');
    expect(resumeSpy).toHaveBeenCalledWith('agent-w1-resumable', expect.any(Object));
    expect(resumed.workers[0]?.run_id).toBe('new-run-for-agent-w1-resumable');
  });

  it('collect gathers outputs from native worker runs without tmux', async () => {
    vi.spyOn(Agent, 'getRun').mockImplementation(async (runId) => {
      return {
        id: runId,
        status: 'completed',
        result: `Output for ${runId}`,
      } as Partial<Run> as Run;
    });

    const manifest = {
      schema_version: 2 as const,
      team_id: 'team-collect-test',
      capability_tier: 'native-cursor-team' as const,
      native_cursor_team: true as const,
      workers: [
        {
          id: 'worker-1',
          cwd: tempDir,
          owned_paths: ['src/a.ts'],
          agent_id: 'agent-1',
          run_id: 'run-w1-done',
          status: 'completed',
          runtime: 'local' as const,
        },
      ],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      stopped_at: null,
    };
    supervisor.saveManifest(manifest);

    const collection = await supervisor.collect('team-collect-test');
    expect(collection.team_id).toBe('team-collect-test');
    expect(collection.outputs['worker-1']).toBe('Output for run-w1-done');
    expect(collection.verified).toBe(false);
  });
});
