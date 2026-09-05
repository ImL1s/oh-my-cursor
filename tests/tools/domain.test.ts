import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDefaultToolRegistry,
  createDomainTools,
  createToolRegistry,
} from '../../src/tools/index.js';

describe('Runtime Domain Tools and Default Registry', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-domain-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('manages workflow goal state (get/set)', async () => {
    const registry = createToolRegistry(createDomainTools());

    // 1. Initial get (no goal set)
    const initRes = await registry.execute(
      'domain_workflow_goal',
      { action: 'get' },
      { toolCallId: 'g1' },
      { projectRoot: tempDir }
    );
    expect(JSON.parse(initRes as string).active).toBe(false);

    // 2. Set goal
    const setRes = await registry.execute(
      'domain_workflow_goal',
      {
        action: 'set',
        goal: 'Implement Issue 28',
        phase: 'implementation',
        tags: ['tools', 'mcp'],
      },
      { toolCallId: 'g2' },
      { projectRoot: tempDir }
    );
    const parsedSet = JSON.parse(setRes as string);
    expect(parsedSet.active).toBe(true);
    expect(parsedSet.goal).toBe('Implement Issue 28');

    // 3. Verify on disk
    const goalFile = path.join(tempDir, '.omcu', 'state', 'goal.json');
    expect(fs.existsSync(goalFile)).toBe(true);

    // 4. Read back
    const getRes = await registry.execute(
      'domain_workflow_goal',
      { action: 'get' },
      { toolCallId: 'g3' },
      { projectRoot: tempDir }
    );
    expect(JSON.parse(getRes as string).goal).toBe('Implement Issue 28');
  });

  it('updates workflow phase and records artifacts', async () => {
    const registry = createToolRegistry(createDomainTools());

    // Phase update
    const phaseRes = await registry.execute(
      'domain_phase_update',
      { phase: 'review', notes: 'Completed implementation pass' },
      { toolCallId: 'p1' },
      { projectRoot: tempDir }
    );
    expect(JSON.parse(phaseRes as string).phase).toBe('review');
    expect(fs.existsSync(path.join(tempDir, '.omcu', 'state', 'phase.json'))).toBe(true);

    // Artifact record
    const artRes = await registry.execute(
      'domain_artifact_record',
      {
        category: 'telemetry',
        name: 'run-1.json',
        content: JSON.stringify({ status: 'ok' }),
      },
      { toolCallId: 'a1' },
      { projectRoot: tempDir }
    );
    const parsedArt = JSON.parse(artRes as string);
    expect(parsedArt.recorded).toBe(true);
    expect(fs.existsSync(path.join(tempDir, parsedArt.artifactPath))).toBe(true);
  });

  it('inspects profiles and catalog entries', async () => {
    const registry = createToolRegistry(createDomainTools());
    const inspectRes = await registry.execute(
      'domain_profile_inspect',
      { query: 'autopilot' },
      { toolCallId: 'prof-1' },
      { projectRoot: tempDir }
    );
    const parsed = JSON.parse(inspectRes as string);
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.components[0].canonicalName).toContain('autopilot');
  });

  it('initializes complete default tool registry with all families registered', () => {
    const defaultRegistry = createDefaultToolRegistry();
    const tools = defaultRegistry.list();

    // Check representatives of all families
    expect(defaultRegistry.has('lsp_diagnostics')).toBe(true);
    expect(defaultRegistry.has('hashline_read')).toBe(true);
    expect(defaultRegistry.has('hashline_edit')).toBe(true);
    expect(defaultRegistry.has('ast_grep_search')).toBe(true);
    expect(defaultRegistry.has('ast_grep_rewrite')).toBe(true);
    expect(defaultRegistry.has('git_identity')).toBe(true);
    expect(defaultRegistry.has('git_worktree_runner')).toBe(true);
    expect(defaultRegistry.has('research_fetch')).toBe(true);
    expect(defaultRegistry.has('visual_capture')).toBe(true);
    expect(defaultRegistry.has('domain_workflow_goal')).toBe(true);

    expect(tools.length).toBeGreaterThanOrEqual(18);
  });
});
