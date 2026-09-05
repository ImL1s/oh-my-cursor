import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlLocalAgentStore } from '@cursor/sdk';
import {
  resolveLocalAgentStore,
  WorkflowProjectionStore,
  type WorkflowProjection,
} from '../src/runtime/cursor-sdk/index.js';

describe('Cursor SDK Native Store and Workflow Projection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-sdk-store-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('resolveLocalAgentStore', () => {
    it('creates a JsonlLocalAgentStore when storeType is jsonl', async () => {
      const storeDir = path.join(tempDir, 'jsonl-store');
      const store = await resolveLocalAgentStore({
        storeType: 'jsonl',
        rootDir: storeDir,
      });

      expect(store).toBeInstanceOf(JsonlLocalAgentStore);
      expect(fs.existsSync(storeDir)).toBe(true);
    });

    it('creates a SqliteLocalAgentStore when storeType is sqlite', async () => {
      const storeDir = path.join(tempDir, 'sqlite-store');
      const store = await resolveLocalAgentStore({
        storeType: 'sqlite',
        rootDir: storeDir,
      });

      expect(store).toBeDefined();
      expect(typeof (store as any).runs?.get).toBe('function');
      if (typeof (store as any).dispose === 'function') {
        await (store as any).dispose();
      }
    });
  });

  describe('WorkflowProjectionStore', () => {
    it('saves and loads workflow projection referencing Cursor native IDs without duplicating transcript', () => {
      const store = new WorkflowProjectionStore(tempDir);
      const projection: WorkflowProjection = {
        schema_version: 1,
        workflowId: 'wf-interview-001',
        cursorAgentId: 'cursor-agent-999',
        cursorRunId: 'cursor-run-111',
        target: 'local',
        goal: 'Implement feature X according to spec',
        phases: [
          { name: 'deep-interview', status: 'completed', summary: 'Requirements established' },
          { name: 'plan', status: 'in_progress' },
        ],
        acceptanceCriteria: [
          { description: 'Passes all tests', met: false },
          { description: 'Has no lint errors', met: true },
        ],
        evidenceReferences: ['file:///workspace/docs/plan.md'],
        sourceProfile: 'autopilot',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      store.save(projection);

      const loaded = store.load('wf-interview-001');
      expect(loaded).not.toBeNull();
      expect(loaded?.cursorAgentId).toBe('cursor-agent-999');
      expect(loaded?.cursorRunId).toBe('cursor-run-111');
      expect(loaded?.phases).toHaveLength(2);
      expect(loaded?.phases[0].status).toBe('completed');
      expect(loaded?.acceptanceCriteria).toHaveLength(2);

      // Verify no transcript field is persisted in the projection file
      const rawFile = path.join(tempDir, '.omcu', 'workflows', 'wf-interview-001.json');
      const rawContent = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
      expect(rawContent.transcript).toBeUndefined();
      expect(rawContent.messages).toBeUndefined();
      expect(rawContent.conversation).toBeUndefined();
    });

    it('updates phase status and summary', () => {
      const store = new WorkflowProjectionStore(tempDir);
      const projection: WorkflowProjection = {
        schema_version: 1,
        workflowId: 'wf-phases',
        cursorAgentId: 'agent-1',
        target: 'local',
        goal: 'Step-by-step pipeline',
        phases: [{ name: 'interview', status: 'pending' }],
        acceptanceCriteria: [],
        evidenceReferences: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.save(projection);

      const updated = store.updatePhase('wf-phases', 'interview', 'completed', 'Completed with 0 ambiguity');
      expect(updated.phases[0].status).toBe('completed');
      expect(updated.phases[0].summary).toBe('Completed with 0 ambiguity');

      const added = store.updatePhase('wf-phases', 'plan', 'in_progress');
      expect(added.phases).toHaveLength(2);
      expect(added.phases[1].name).toBe('plan');
      expect(added.phases[1].status).toBe('in_progress');
    });

    it('links new run IDs', () => {
      const store = new WorkflowProjectionStore(tempDir);
      const projection: WorkflowProjection = {
        schema_version: 1,
        workflowId: 'wf-link',
        cursorAgentId: 'agent-1',
        target: 'cloud',
        goal: 'Cloud dispatch',
        phases: [],
        acceptanceCriteria: [],
        evidenceReferences: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.save(projection);

      const updated = store.linkRun('wf-link', 'run-new-456');
      expect(updated.cursorRunId).toBe('run-new-456');

      const reloaded = store.load('wf-link');
      expect(reloaded?.cursorRunId).toBe('run-new-456');
    });

    it('lists all stored workflow projections', () => {
      const store = new WorkflowProjectionStore(tempDir);
      expect(store.list()).toHaveLength(0);

      const p1: WorkflowProjection = {
        schema_version: 1,
        workflowId: 'wf-1',
        cursorAgentId: 'a1',
        target: 'local',
        goal: 'Goal 1',
        phases: [],
        acceptanceCriteria: [],
        evidenceReferences: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const p2: WorkflowProjection = {
        schema_version: 1,
        workflowId: 'wf-2',
        cursorAgentId: 'a2',
        target: 'cloud',
        goal: 'Goal 2',
        phases: [],
        acceptanceCriteria: [],
        evidenceReferences: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      store.save(p1);
      store.save(p2);

      const list = store.list();
      expect(list).toHaveLength(2);
      expect(list.map((p) => p.workflowId).sort()).toEqual(['wf-1', 'wf-2']);
    });
  });
});
