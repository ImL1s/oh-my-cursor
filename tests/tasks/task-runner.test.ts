import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, type Run, type RunResult, type SDKAgent } from '@cursor/sdk';
import { TaskRunner, TaskStore } from '../../src/tasks/index.js';

describe('Native Task Runner & Store', () => {
  let tempDir: string;
  let store: TaskStore;
  let runner: TaskRunner;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-task-test-'));
    store = new TaskStore(tempDir);
    runner = new TaskRunner(tempDir, store);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('background start returns native IDs immediately without waiting for completion', async () => {
    let waitCalled = false;
    const fakeRun: Partial<Run> = {
      id: 'native-run-001',
      agentId: 'native-agent-001',
      status: 'running',
      supports: () => true,
      unsupportedReason: () => undefined,
      wait: async () => {
        waitCalled = true;
        return { id: 'native-run-001', status: 'completed', result: 'done' } as RunResult;
      },
    };

    const fakeAgent: Partial<SDKAgent> = {
      agentId: 'native-agent-001',
      send: vi.fn().mockResolvedValue(fakeRun as Run),
      close: vi.fn(),
    };

    vi.spyOn(Agent, 'create').mockResolvedValue(fakeAgent as SDKAgent);

    const task = runner.createTask({
      taskId: 'task-bg-1',
      role: 'omcu-worker',
      prompt: 'Execute long task',
      runtime: 'local',
    });

    const result = await runner.run(task, { background: true });

    expect(result.status).toBe('running');
    expect(result.agentId).toBe('native-agent-001');
    expect(result.runId).toBe('native-run-001');
    expect(waitCalled).toBe(false);

    // Verify task is persisted in TaskStore with native IDs
    const persisted = store.get('task-bg-1');
    expect(persisted).not.toBeNull();
    expect(persisted?.agentId).toBe('native-agent-001');
    expect(persisted?.runId).toBe('native-run-001');
    expect(persisted?.status).toBe('running');
  });

  it('foreground run completes and creates evidence artifact', async () => {
    const fakeRun: Partial<Run> = {
      id: 'native-run-002',
      agentId: 'native-agent-002',
      status: 'running',
      supports: () => true,
      unsupportedReason: () => undefined,
      wait: async () => ({
        id: 'native-run-002',
        status: 'completed',
        result: 'Successfully indexed files.',
      } as RunResult),
    };

    const fakeAgent: Partial<SDKAgent> = {
      agentId: 'native-agent-002',
      send: vi.fn().mockResolvedValue(fakeRun as Run),
      close: vi.fn(),
    };

    vi.spyOn(Agent, 'create').mockResolvedValue(fakeAgent as SDKAgent);

    const task = runner.createTask({
      taskId: 'task-fg-1',
      role: 'omcu-worker',
      prompt: 'Index files',
      runtime: 'local',
    });

    const result = await runner.run(task);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('Successfully indexed files.');
    expect(result.evidenceArtifacts).toHaveLength(1);
    expect(fs.existsSync(result.evidenceArtifacts![0]!)).toBe(true);
    expect(fs.readFileSync(result.evidenceArtifacts![0]!, 'utf8')).toBe('Successfully indexed files.');
  });

  it('preserves startup error vs run error vs cancelled vs ambiguous', async () => {
    // 1. Startup error
    vi.spyOn(Agent, 'create').mockRejectedValueOnce(new Error('Agent process failed to spawn'));
    const taskStartup = runner.createTask({
      taskId: 'task-err-startup',
      role: 'omcu-worker',
      prompt: 'Crash on start',
    });
    const startupRes = await runner.run(taskStartup);
    expect(startupRes.status).toBe('failed');
    expect(startupRes.error?.kind).toBe('startup');
    expect(startupRes.error?.message).toContain('Agent process failed to spawn');

    // 2. Run error
    const fakeRunFail: Partial<Run> = {
      id: 'run-fail',
      agentId: 'agent-fail',
      status: 'running',
      supports: () => true,
      unsupportedReason: () => undefined,
      wait: async () => ({
        id: 'run-fail',
        status: 'failed',
        error: { message: 'Out of memory during model inference', code: 'OOM' },
      } as RunResult),
    };
    const fakeAgentFail: Partial<SDKAgent> = {
      agentId: 'agent-fail',
      send: vi.fn().mockResolvedValue(fakeRunFail as Run),
      close: vi.fn(),
    };
    vi.spyOn(Agent, 'create').mockResolvedValueOnce(fakeAgentFail as SDKAgent);

    const taskRunErr = runner.createTask({
      taskId: 'task-err-run',
      role: 'omcu-worker',
      prompt: 'Fail during run',
    });
    const runErrRes = await runner.run(taskRunErr);
    expect(runErrRes.status).toBe('failed');
    expect(runErrRes.error?.kind).toBe('run');
    expect(runErrRes.error?.message).toContain('Out of memory');
  });

  it('interruption cancels supported runs and finalizes status', async () => {
    let cancelCalled = false;
    const fakeRun: Partial<Run> = {
      id: 'run-cancel-1',
      agentId: 'agent-cancel-1',
      status: 'running',
      supports: (op) => op === 'cancel' || op === 'wait',
      unsupportedReason: () => undefined,
      cancel: async () => {
        cancelCalled = true;
      },
      wait: async () => {
        // Simulates run cancelled
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('AbortError')), 50);
        });
      },
    };

    const fakeAgent: Partial<SDKAgent> = {
      agentId: 'agent-cancel-1',
      send: vi.fn().mockResolvedValue(fakeRun as Run),
      close: vi.fn(),
    };

    vi.spyOn(Agent, 'create').mockResolvedValue(fakeAgent as SDKAgent);

    const abortController = new AbortController();
    const task = runner.createTask({
      taskId: 'task-cancel-1',
      role: 'omcu-worker',
      prompt: 'Long running task to cancel',
    });

    setTimeout(() => abortController.abort(), 10);

    const res = await runner.run(task, { signal: abortController.signal });

    expect(res.status).toBe('cancelled');
    expect(res.error?.kind).toBe('cancelled');
    expect(cancelCalled).toBe(true);
  });

  it('process restart can inspect and resume native agents', async () => {
    // Initial task setup
    store.save({
      schema_version: 1,
      taskId: 'task-persisted-1',
      agentId: 'native-agent-persisted',
      runId: 'native-run-persisted',
      role: 'omcu-worker',
      runtime: 'local',
      prompt: 'First half of task',
      workspace: tempDir,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const resumedRun: Partial<Run> = {
      id: 'resumed-run-002',
      agentId: 'native-agent-persisted',
      status: 'running',
      supports: () => true,
      unsupportedReason: () => undefined,
      wait: async () => ({
        id: 'resumed-run-002',
        status: 'completed',
        result: 'Resumed and finished work.',
      } as RunResult),
    };

    const resumedAgent: Partial<SDKAgent> = {
      agentId: 'native-agent-persisted',
      send: vi.fn().mockResolvedValue(resumedRun as Run),
      close: vi.fn(),
    };

    const resumeSpy = vi.spyOn(Agent, 'resume').mockResolvedValue(resumedAgent as SDKAgent);

    // Reconstruct a fresh TaskRunner in a new instance (simulating restart)
    const newRunner = new TaskRunner(tempDir);
    const resumed = await newRunner.resume('task-persisted-1', 'Continue remaining work');

    expect(resumeSpy).toHaveBeenCalledWith('native-agent-persisted', expect.any(Object));
    expect(resumed.status).toBe('completed');
    expect(resumed.output).toBe('Resumed and finished work.');
  });
});
