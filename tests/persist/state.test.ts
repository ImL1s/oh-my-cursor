import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PERSIST_LOOPS,
  MAX_PERSIST_LOOPS,
  PERSIST_SCHEMA_VERSION,
  completePersist,
  executePersistDecision,
  normalizePersistState,
  persistStatus,
  readPersistState,
  startPersist,
  stopPersist,
} from '../../src/persist/state.js';
import { projectStateRoot } from '../../src/runtime/state-root.js';

const workspaces: string[] = [];
function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-persist-'));
  workspaces.push(dir);
  return dir;
}
afterEach(() => { for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const omcuBin = path.join(process.cwd(), 'dist', 'bin', 'omcu.js');

function cliChild(cwd: string, argv: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [omcuBin, ...argv], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += String(chunk); });
    proc.stderr.on('data', (chunk) => { stderr += String(chunk); });
    proc.once('error', reject);
    proc.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('CLI-owned persist state', () => {
  it('starts, reads back, and reports an active loop', () => {
    const root = projectStateRoot(workspace());
    const started = startPersist(root, { goal: 'reach the gate', maxLoops: 10, deadlineMinutes: 30, nowMs: 1000 });
    expect(started).toMatchObject({
      schema_version: PERSIST_SCHEMA_VERSION,
      active: true,
      goal: 'reach the gate',
      max_loops: 10,
      consumed_loops: 0,
      last_host_loop_count: null,
      revision: 1,
      done: false,
      deadline_ms: 1000 + 30 * 60_000,
    });
    expect(readPersistState(root)).toEqual(started);
    expect(persistStatus(root)).toEqual({
      present: true,
      state: started,
      consumed_loops: 0,
      remaining_loops: 10,
      deadline_ms: started.deadline_ms,
      revision: 1,
      last_decision_reason: null,
    });
    const file = path.join(root.path, 'persist.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('applies safe defaults and validates bounds', () => {
    const root = projectStateRoot(workspace());
    const started = startPersist(root, { goal: 'default budgets', nowMs: 1 });
    expect(started.max_loops).toBe(DEFAULT_PERSIST_LOOPS);
    expect(started.deadline_ms).toBe(1 + 120 * 60_000);
    expect(() => startPersist(root, { goal: 'bad clock', nowMs: 0 })).toThrow('E_PERSIST_CLOCK_INVALID');
    expect(() => startPersist(root, { goal: '   ' })).toThrow('E_PERSIST_GOAL_INVALID');
    expect(() => startPersist(root, { goal: 'x', maxLoops: 0 })).toThrow('E_PERSIST_MAX_LOOPS_INVALID');
    expect(() => startPersist(root, { goal: 'x', maxLoops: MAX_PERSIST_LOOPS + 1 })).toThrow('E_PERSIST_MAX_LOOPS_INVALID');
    expect(() => startPersist(root, { goal: 'x', deadlineMinutes: 0 })).toThrow('E_PERSIST_DEADLINE_INVALID');
    expect(() => startPersist(root, { goal: 'x', deadlineMinutes: 24 * 60 + 1 })).toThrow('E_PERSIST_DEADLINE_INVALID');
  });

  it('stop deactivates and done marks the goal satisfied', () => {
    const root = projectStateRoot(workspace());
    startPersist(root, { goal: 'g', nowMs: 5 });
    expect(stopPersist(root)).toMatchObject({ active: false, done: false, last_decision_reason: 'stopped_by_operator' });
    startPersist(root, { goal: 'g2', nowMs: 6 });
    expect(completePersist(root)).toMatchObject({ active: false, done: true, last_decision_reason: 'completed_by_operator' });
  });

  it('stop/done on an absent loop are null no-ops', () => {
    const root = projectStateRoot(workspace());
    expect(stopPersist(root)).toBeNull();
    expect(completePersist(root)).toBeNull();
    expect(persistStatus(root)).toEqual({
      present: false,
      state: null,
      consumed_loops: null,
      remaining_loops: null,
      deadline_ms: null,
      revision: null,
      last_decision_reason: null,
    });
  });

  it('distinguishes absent state from malformed, wrong-version, or symlinked corruption', () => {
    const root = projectStateRoot(workspace());
    const file = path.join(root.path, 'persist.json');
    expect(readPersistState(root)).toBeNull();
    fs.writeFileSync(file, 'not json', { mode: 0o600 });
    expect(() => readPersistState(root)).toThrow('E_STATE_CORRUPT');
    // Schema version 2 without required consumed_loops / revision is invalid
    fs.writeFileSync(file, JSON.stringify({ schema_version: 2, active: true, goal: 'g', max_loops: 1, deadline_ms: 1, created_at_ms: 1, done: false }), { mode: 0o600 });
    expect(() => readPersistState(root)).toThrow('E_STATE_CORRUPT');
    // Unsupported schema version
    fs.writeFileSync(file, JSON.stringify({ schema_version: 99, active: true, goal: 'g', max_loops: 1, deadline_ms: 1, created_at_ms: 1, done: false }), { mode: 0o600 });
    expect(() => readPersistState(root)).toThrow('E_STATE_CORRUPT');
    fs.rmSync(file);
    const target = path.join(root.path, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({
      schema_version: 2, active: true, goal: 'g', max_loops: 1, consumed_loops: 0, last_host_loop_count: null, revision: 1, deadline_ms: 1, created_at_ms: 1, done: false, last_event_id: null, last_decision_at_ms: null, last_decision_reason: null,
    }), { mode: 0o600 });
    fs.symlinkSync(target, file);
    expect(() => readPersistState(root)).toThrow('E_STATE_CORRUPT');
  });

  it('normalizes legacy v1 and v2 objects safely', () => {
    // v1 migration into v2 shape with legacy_v1 flag
    const v1 = normalizePersistState({ schema_version: 1, active: true, goal: 'g', max_loops: 1, deadline_ms: 1, created_at_ms: 1, done: false });
    expect(v1).not.toBeNull();
    expect(v1?.schema_version).toBe(2);
    expect(v1?.legacy_v1).toBe(true);

    // v2 complete object
    const v2 = normalizePersistState({
      schema_version: 2, active: true, goal: 'g', max_loops: 5, consumed_loops: 1, last_host_loop_count: 0, revision: 2, deadline_ms: 100, created_at_ms: 1, done: false, last_event_id: 'e1', last_decision_at_ms: 50, last_decision_reason: 'persist_active',
    });
    expect(v2).not.toBeNull();
    expect(v2?.consumed_loops).toBe(1);
    expect(v2?.revision).toBe(2);

    // v1 with overlong last_event_id is bounded
    const v1LongId = normalizePersistState({
      schema_version: 1, active: true, goal: 'g', max_loops: 1, deadline_ms: 1, created_at_ms: 1, done: false, last_event_id: 'x'.repeat(500),
    });
    expect(v1LongId?.last_event_id?.length).toBeLessThanOrEqual(256);

    expect(normalizePersistState({ schema_version: 2, active: true, goal: '', max_loops: 1, consumed_loops: 0, last_host_loop_count: null, revision: 1, deadline_ms: 1, created_at_ms: 1, done: false, last_event_id: null, last_decision_at_ms: null, last_decision_reason: null })).toBeNull();
    expect(normalizePersistState({ schema_version: 2, active: 'yes', goal: 'g', max_loops: 1, consumed_loops: 0, last_host_loop_count: null, revision: 1, deadline_ms: 1, created_at_ms: 1, done: false, last_event_id: null, last_decision_at_ms: null, last_decision_reason: null })).toBeNull();
  });

  it('stopping or completing a legacy v1 state writes clean schema v2 without legacy_v1 flag', () => {
    const root = projectStateRoot(workspace());
    const file = path.join(root.path, 'persist.json');
    fs.writeFileSync(file, JSON.stringify({
      schema_version: 1, active: true, goal: 'v1 goal', max_loops: 5, deadline_ms: Date.now() + 10_000, created_at_ms: Date.now() - 1000, done: false,
    }), { mode: 0o600 });
    const stopped = stopPersist(root);
    expect(stopped?.schema_version).toBe(2);
    expect(stopped?.legacy_v1).toBeUndefined();
    const rawDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(rawDisk.schema_version).toBe(2);
    expect(rawDisk.legacy_v1).toBeUndefined();
  });

  it('executePersistDecision increments consumed_loops and persists monotonically', () => {
    const root = projectStateRoot(workspace());
    startPersist(root, { goal: 'monotonic loop', maxLoops: 3, deadlineMinutes: 10 });
    const d1 = executePersistDecision(root, { status: 'completed', loop_count: 0 });
    expect(d1.continue).toBe(true);
    expect(d1.reason).toBe('persist_active');
    expect(readPersistState(root)?.consumed_loops).toBe(1);

    const d2 = executePersistDecision(root, { status: 'completed', loop_count: 1 });
    expect(d2.continue).toBe(true);
    expect(readPersistState(root)?.consumed_loops).toBe(2);

    const d3 = executePersistDecision(root, { status: 'completed', loop_count: 2 });
    expect(d3.continue).toBe(true);
    expect(readPersistState(root)?.consumed_loops).toBe(3);

    // Budget exhausted on 4th decision
    const d4 = executePersistDecision(root, { status: 'completed', loop_count: 3 });
    expect(d4.continue).toBe(false);
    expect(d4.reason).toBe('loop_budget_exhausted');
    expect(readPersistState(root)?.consumed_loops).toBe(3);

    // Status reflects loop_budget_exhausted when remaining_loops is 0
    expect(persistStatus(root)).toMatchObject({
      remaining_loops: 0,
      last_decision_reason: 'loop_budget_exhausted',
    });
  });

  it('20 concurrent decisions with one slot remaining produce exactly one continuation', async () => {
    const ws = workspace();
    const root = projectStateRoot(ws);
    // Start with max_loops: 5 and simulate 4 loops already consumed
    startPersist(root, { goal: 'race test', maxLoops: 5, deadlineMinutes: 10 });
    // Execute 4 decisions to leave exactly 1 slot remaining
    for (let i = 0; i < 4; i++) {
      executePersistDecision(root, { status: 'completed', loop_count: i });
    }
    expect(readPersistState(root)?.consumed_loops).toBe(4);

    // Spawn 20 child processes simultaneously competing for the last slot via real CLI
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        cliChild(ws, ['persist', 'decide', '--input', JSON.stringify({ status: 'completed', loop_count: 4, event_id: `race-event-${i}` })]),
      ),
    );

    expect(results.every((r) => r.code === 0)).toBe(true);
    const parsedDecisions = results.map((r) => JSON.parse(r.stdout.trim()) as { continue: boolean; reason: string });
    const continued = parsedDecisions.filter((d) => d.continue);
    const stopped = parsedDecisions.filter((d) => !d.continue);

    expect(continued).toHaveLength(1);
    expect(stopped).toHaveLength(19);
    expect(stopped.every((d) => d.reason === 'loop_budget_exhausted')).toBe(true);
    expect(readPersistState(root)?.consumed_loops).toBe(5);
  }, 30_000);

  it('done and stop win races against decide', async () => {
    const ws = workspace();
    const root = projectStateRoot(ws);
    startPersist(root, { goal: 'done race', maxLoops: 10, deadlineMinutes: 10 });

    // Race stop with decide via real CLI
    const [stopResult, decideResult] = await Promise.all([
      cliChild(ws, ['persist', 'stop']),
      cliChild(ws, ['persist', 'decide', '--input', JSON.stringify({ status: 'completed', loop_count: 0 })]),
    ]);

    expect(stopResult.code).toBe(0);
    expect(decideResult.code).toBe(0);
    // Persist must end up inactive
    const finalState = readPersistState(root);
    expect(finalState?.active).toBe(false);
  }, 15_000);

  it('restart/resume preserves consumed budget across executions', () => {
    const root = projectStateRoot(workspace());
    startPersist(root, { goal: 'resume test', maxLoops: 10, deadlineMinutes: 10 });
    executePersistDecision(root, { status: 'completed', loop_count: 0 });
    executePersistDecision(root, { status: 'completed', loop_count: 1 });

    // Simulate process restart by reading state fresh from disk
    const freshRoot = projectStateRoot(root.path.replace(/\/\.omcu$/, ''));
    const state = readPersistState(freshRoot);
    expect(state?.consumed_loops).toBe(2);
    expect(state?.last_host_loop_count).toBe(1);

    // Resume execution
    const decision = executePersistDecision(freshRoot, { status: 'completed', loop_count: 2 });
    expect(decision.continue).toBe(true);
    expect(readPersistState(freshRoot)?.consumed_loops).toBe(3);
  });
});
