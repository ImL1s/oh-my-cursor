import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_PERSIST_LOOPS,
  completePersist,
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

describe('CLI-owned persist state', () => {
  it('starts, reads back, and reports an active loop', () => {
    const root = projectStateRoot(workspace());
    const started = startPersist(root, { goal: 'reach the gate', maxLoops: 10, deadlineMinutes: 30, nowMs: 1000 });
    expect(started).toMatchObject({ active: true, goal: 'reach the gate', max_loops: 10, done: false, deadline_ms: 1000 + 30 * 60_000 });
    expect(readPersistState(root)).toEqual(started);
    expect(persistStatus(root)).toEqual({ present: true, state: started });
    const file = path.join(root.path, 'persist.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('applies safe defaults and validates bounds', () => {
    const root = projectStateRoot(workspace());
    const started = startPersist(root, { goal: 'default budgets', nowMs: 1 });
    expect(started.max_loops).toBe(25);
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
    expect(stopPersist(root)).toMatchObject({ active: false, done: false });
    startPersist(root, { goal: 'g2', nowMs: 6 });
    expect(completePersist(root)).toMatchObject({ active: false, done: true });
  });

  it('stop/done on an absent loop are null no-ops', () => {
    const root = projectStateRoot(workspace());
    expect(stopPersist(root)).toBeNull();
    expect(completePersist(root)).toBeNull();
    expect(persistStatus(root)).toEqual({ present: false, state: null });
  });

  it('reads back null for malformed, wrong-version, or symlinked state', () => {
    const root = projectStateRoot(workspace());
    const file = path.join(root.path, 'persist.json');
    fs.writeFileSync(file, 'not json', { mode: 0o600 });
    expect(readPersistState(root)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ schema_version: 2, active: true, goal: 'g', max_loops: 1, deadline_ms: 1, created_at_ms: 1, done: false }), { mode: 0o600 });
    expect(readPersistState(root)).toBeNull();
    fs.rmSync(file);
    const target = path.join(root.path, 'elsewhere.json');
    fs.writeFileSync(target, JSON.stringify({ schema_version: 1, active: true, goal: 'g', max_loops: 1, deadline_ms: 1, created_at_ms: 1, done: false }), { mode: 0o600 });
    fs.symlinkSync(target, file);
    expect(readPersistState(root)).toBeNull();
  });

  it('normalizes only complete, in-bounds objects', () => {
    expect(normalizePersistState({ schema_version: 1, active: true, goal: 'g', max_loops: 1, deadline_ms: 1, created_at_ms: 1, done: false })).not.toBeNull();
    expect(normalizePersistState({ schema_version: 1, active: true, goal: '', max_loops: 1, deadline_ms: 1, created_at_ms: 1, done: false })).toBeNull();
    expect(normalizePersistState({ schema_version: 1, active: 'yes', goal: 'g', max_loops: 1, deadline_ms: 1, created_at_ms: 1, done: false })).toBeNull();
    expect(normalizePersistState({ schema_version: 1, active: true, goal: 'g', max_loops: 1, deadline_ms: 1, created_at_ms: 1 })).toBeNull();
  });
});
