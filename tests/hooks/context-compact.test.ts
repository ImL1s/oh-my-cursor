import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeContextCompact } from '../../src/hooks/context-compact.js';
import { dispatchHook } from '../../src/hooks/dispatcher.js';
import { CompactionStore } from '../../src/compaction/index.js';
import { openProjectStateRoot } from '../../src/runtime/state-root.js';

describe('Context Compaction Hook (omcu-hook-context-compact / omx_context_compact)', () => {
  it('returns null gracefully when .omcu state directory does not exist', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-compact-absent-'));
    try {
      const result = await executeContextCompact(tempDir, { session_id: 'session-123' });
      expect(result).toBeNull();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('persists active session state to compaction store before context compression', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-compact-test-'));
    try {
      const stateDir = path.join(tempDir, '.omcu');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'owner.json'), JSON.stringify({
        token: 'test-token',
        pid: process.pid,
      }));

      // Seed a persist state
      const persistDir = path.join(stateDir, 'persist');
      fs.mkdirSync(persistDir, { recursive: true });
      fs.writeFileSync(path.join(persistDir, 'state.json'), JSON.stringify({
        goal: 'test-compaction-goal',
        active: true,
        consumed_loops: 3,
        max_loops: 10,
      }));

      const compactResult = await executeContextCompact(tempDir, { session_id: 'sess-456' });
      expect(compactResult).not.toBeNull();
      expect(compactResult?.checkpointId).toBe('sess-456');
      expect(compactResult?.generation).toBe(1);
      expect(compactResult?.sha256).toMatch(/^[a-f0-9]{64}$/);

      // Verify the persisted checkpoint can be read back using CompactionStore
      const root = openProjectStateRoot(tempDir);
      const store = new CompactionStore(root);
      const checkpoint = store.read('sess-456');
      expect(checkpoint).not.toBeNull();
      expect(checkpoint?.generation).toBe(1);
      expect((checkpoint?.payload as any)?.persist_state?.goal).toBe('test-compaction-goal');

      // Second compaction advances generation
      const secondResult = await executeContextCompact(tempDir, { session_id: 'sess-456' });
      expect(secondResult?.generation).toBe(2);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('dispatches preCompact hook cleanly through dispatcher', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-compact-dispatch-'));
    try {
      const stateDir = path.join(tempDir, '.omcu');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'owner.json'), JSON.stringify({
        token: 'test-token',
        pid: process.pid,
      }));

      const dispatchResult = await dispatchHook('preCompact', {
        session_id: 'sess-dispatch-789',
      }, { cwd: tempDir });

      expect(dispatchResult.success).toBe(true);
      expect(dispatchResult.event).toBe('preCompact');
      expect(dispatchResult.response).toEqual({});
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
