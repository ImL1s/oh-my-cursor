import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, type Run, type RunResult, type SDKAgent } from '@cursor/sdk';
import { runCli } from '../src/cli/application.js';

describe('CLI Native Agent Orchestration Commands', () => {
  let tempDir: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-cli-orch-'));
    stdout = [];
    stderr = [];
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const getIo = () => ({
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
  });

  it('runs omcu task start, list, status, output, and cancel', async () => {
    const fakeRun: Partial<Run> = {
      id: 'run-cli-101',
      agentId: 'agent-cli-101',
      status: 'running',
      supports: () => true,
      unsupportedReason: () => undefined,
      wait: async () => ({
        id: 'run-cli-101',
        status: 'completed',
        result: 'CLI Task Done',
      } as RunResult),
    };

    const fakeAgent: Partial<SDKAgent> = {
      agentId: 'agent-cli-101',
      send: vi.fn().mockResolvedValue(fakeRun as Run),
      close: vi.fn(),
    };

    vi.spyOn(Agent, 'create').mockResolvedValue(fakeAgent as SDKAgent);
    vi.spyOn(Agent, 'cancelRun').mockResolvedValue();

    // 1. omcu task start (background)
    const codeStartBg = await runCli(
      [
        'task',
        'start',
        '--agent',
        'omcu-worker',
        '--prompt',
        'Do background task',
        '--background',
        '--id',
        't-bg-1',
      ],
      { cwd: tempDir },
      getIo()
    );
    expect(codeStartBg).toBe(0);
    const startBgOutput = JSON.parse(stdout[stdout.length - 1]!);
    expect(startBgOutput.status).toBe('running');
    expect(startBgOutput.agentId).toBe('agent-cli-101');

    // 2. omcu task list
    const codeList = await runCli(['task', 'list'], { cwd: tempDir }, getIo());
    expect(codeList).toBe(0);
    const listOutput = JSON.parse(stdout[stdout.length - 1]!);
    expect(Array.isArray(listOutput)).toBe(true);
    expect(listOutput).toHaveLength(1);

    // 3. omcu task status
    const codeStatus = await runCli(['task', 'status', '--id', 't-bg-1'], { cwd: tempDir }, getIo());
    expect(codeStatus).toBe(0);
    const statusOutput = JSON.parse(stdout[stdout.length - 1]!);
    expect(statusOutput.taskId).toBe('t-bg-1');

    // 4. omcu task cancel
    const codeCancel = await runCli(['task', 'cancel', '--id', 't-bg-1'], { cwd: tempDir }, getIo());
    expect(codeCancel).toBe(0);
    const cancelOutput = JSON.parse(stdout[stdout.length - 1]!);
    expect(cancelOutput.status).toBe('cancelled');

    // 5. omcu task start (foreground)
    const codeStartFg = await runCli(
      [
        'task',
        'start',
        '--agent',
        'omcu-worker',
        '--prompt',
        'Do fg task',
        '--id',
        't-fg-1',
      ],
      { cwd: tempDir },
      getIo()
    );
    expect(codeStartFg).toBe(0);
    const startFgOutput = JSON.parse(stdout[stdout.length - 1]!);
    expect(startFgOutput.status).toBe('completed');

    // 6. omcu task output
    stdout = [];
    const codeOutput = await runCli(['task', 'output', '--id', 't-fg-1'], { cwd: tempDir }, getIo());
    expect(codeOutput).toBe(0);
    expect(stdout.join('')).toContain('CLI Task Done');
  });

  it('runs omcu dag run with canvas output', async () => {
    const fakeRun: Partial<Run> = {
      id: 'dag-run-1',
      agentId: 'dag-agent-1',
      status: 'running',
      supports: () => true,
      unsupportedReason: () => undefined,
      wait: async () => ({
        id: 'dag-run-1',
        status: 'completed',
        result: 'DAG node completed',
      } as RunResult),
    };

    const fakeAgent: Partial<SDKAgent> = {
      agentId: 'dag-agent-1',
      send: vi.fn().mockResolvedValue(fakeRun as Run),
      close: vi.fn(),
    };

    vi.spyOn(Agent, 'create').mockResolvedValue(fakeAgent as SDKAgent);

    const dagFilePath = path.join(tempDir, 'sample-dag.json');
    fs.writeFileSync(
      dagFilePath,
      JSON.stringify({
        dagId: 'cli-dag-1',
        description: 'Test DAG via CLI',
        tasks: [
          { id: 'node-1', role: 'omcu-worker', prompt: 'Step 1' },
          { id: 'node-2', role: 'omcu-worker', prompt: 'Step 2', dependencies: ['node-1'] },
        ],
      })
    );

    const exitCode = await runCli(
      ['dag', 'run', '--file', dagFilePath, '--canvas'],
      { cwd: tempDir },
      getIo()
    );

    expect(exitCode).toBe(0);
    const dagResult = JSON.parse(stdout[stdout.length - 1]!);
    expect(dagResult.status).toBe('completed');
    expect(dagResult.canvas).toBeDefined();
    expect(dagResult.canvas).toContain('DAG Canvas: cli-dag-1');
  });

  it('runs omcu automation plan, status, install, and remove', async () => {
    // Plan
    const planCode = await runCli(
      [
        'automation',
        'plan',
        '--name',
        'HourlySync',
        '--cron',
        '0 * * * *',
        '--prompt',
        'Sync state',
        '--id',
        'sync-auto-1',
      ],
      { cwd: tempDir },
      getIo()
    );
    expect(planCode).toBe(0);
    const planResult = JSON.parse(stdout[stdout.length - 1]!);
    expect(planResult.automationId).toBe('sync-auto-1');
    expect(planResult.status).toBe('planned');

    // Status
    const statusCode = await runCli(
      ['automation', 'status', '--id', 'sync-auto-1'],
      { cwd: tempDir },
      getIo()
    );
    expect(statusCode).toBe(0);
    const statusResult = JSON.parse(stdout[stdout.length - 1]!);
    expect(statusResult.automations).toHaveLength(1);

    // Remove
    const removeCode = await runCli(
      ['automation', 'remove', '--id', 'sync-auto-1'],
      { cwd: tempDir },
      getIo()
    );
    expect(removeCode).toBe(0);
    const removeResult = JSON.parse(stdout[stdout.length - 1]!);
    expect(removeResult.removed).toBe(true);
  });

  it('runs omcu automation install with --allow-fallback', async () => {
    // Plan
    await runCli(
      [
        'automation',
        'plan',
        '--name',
        'FallbackSync',
        '--cron',
        '*/5 * * * *',
        '--prompt',
        'Run fallback job',
        '--id',
        'auto-fb-1',
      ],
      { cwd: tempDir },
      getIo()
    );

    // Install with --allow-fallback
    stdout = [];
    const installCode = await runCli(
      ['automation', 'install', '--id', 'auto-fb-1', '--allow-fallback'],
      { cwd: tempDir },
      getIo()
    );
    expect(installCode).toBe(0);
    const installResult = JSON.parse(stdout[stdout.length - 1]!);
    expect(installResult.status).toBe('installed');
  });

  it('runs omcu team start, status, collect, and stop with --native dispatch', async () => {
    const fakeRun: Partial<Run> = {
      id: 'team-run-cli',
      agentId: 'team-agent-cli',
      status: 'completed',
      supports: () => true,
      unsupportedReason: () => undefined,
      wait: async () => ({ id: 'team-run-cli', status: 'completed', result: 'Team Worker CLI Output' } as RunResult),
    };

    const fakeAgent: Partial<SDKAgent> = {
      agentId: 'team-agent-cli',
      send: vi.fn().mockResolvedValue(fakeRun as Run),
      close: vi.fn(),
    };

    vi.spyOn(Agent, 'create').mockResolvedValue(fakeAgent as SDKAgent);
    vi.spyOn(Agent, 'getRun').mockResolvedValue({
      id: 'team-run-cli',
      status: 'completed',
      result: 'Team Worker CLI Output',
    } as Run);
    vi.spyOn(Agent, 'cancelRun').mockResolvedValue();

    const workers = [
      { id: 'w1', objective: 'Obj 1', cwd: tempDir, owned_paths: ['src/a.ts'] },
    ];

    // 1. omcu team start --native
    stdout = [];
    const startCode = await runCli(
      [
        'team',
        'start',
        '--id',
        'team-cli-1',
        '--native',
        '--workers-json',
        JSON.stringify(workers),
      ],
      { cwd: tempDir },
      getIo()
    );
    expect(startCode).toBe(0);
    const startResult = JSON.parse(stdout[stdout.length - 1]!);
    expect(startResult.native_cursor_team).toBe(true);

    // 2. omcu team status (auto-detects native team without requiring --native flag!)
    stdout = [];
    const statusCode = await runCli(
      ['team', 'status', '--id', 'team-cli-1'],
      { cwd: tempDir },
      getIo()
    );
    expect(statusCode).toBe(0);
    const statusResult = JSON.parse(stdout[stdout.length - 1]!);
    expect(statusResult.native_cursor_team).toBe(true);

    // 3. omcu team collect --native
    stdout = [];
    const collectCode = await runCli(
      ['team', 'collect', '--id', 'team-cli-1', '--native'],
      { cwd: tempDir },
      getIo()
    );
    expect(collectCode).toBe(0);
    const collectResult = JSON.parse(stdout[stdout.length - 1]!);
    expect(collectResult.team_id).toBe('team-cli-1');
    expect(collectResult.outputs['w1']).toBe('Team Worker CLI Output');

    // 4. omcu team stop (auto-detects native team and invokes shutdown)
    stdout = [];
    const stopCode = await runCli(
      ['team', 'stop', '--id', 'team-cli-1'],
      { cwd: tempDir },
      getIo()
    );
    expect(stopCode).toBe(0);
    const stopResult = JSON.parse(stdout[stdout.length - 1]!);
    expect(stopResult.stopped_at).not.toBeNull();
  });
});
