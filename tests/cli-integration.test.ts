import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, HELP } from '../src/cli/application.js';
import { installExitCode, uninstallExitCode } from '../src/cli/lifecycle.js';
import { CursorAgentAdapter } from '../src/host/cursor-agent.js';
import { projectStateRoot } from '../src/runtime/state-root.js';
import { WorkflowPersistenceStore } from '../src/workflows/index.js';

function harness(cwd: string) {
  const stdout: string[] = []; const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) }, dependencies: { cwd, packageRoot: path.resolve('.') } };
}

describe('integrated CLI surface', () => {
  it('truthfully labels experimental and non-authoritative surfaces', () => {
    expect(HELP).toContain('experimental local tmux; not native');
    expect(HELP).toContain('never self-assert verified state');
    expect(HELP).toContain('Notification dispatch is unsupported');
  });

  it('integrates state, cancellation, memory, compaction, tracker, and wiki services', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-integration-')); const h = harness(cwd);
    try {
      expect(await runCli(['state', 'create', '--id', 'run1', '--objective', 'ship'], h.dependencies, h.io)).toBe(0);
      expect(await runCli(['cancel', '--id', 'run1'], h.dependencies, h.io)).toBe(0);
      expect(await runCli(['memory', 'put', '--id', 'note1', '--text', 'integration truth'], h.dependencies, h.io)).toBe(0);
      expect(await runCli(['memory', 'search', '--query', 'truth'], h.dependencies, h.io)).toBe(0);
      expect(await runCli(['compact', 'checkpoint', '--id', 'cp1', '--generation', '0', '--payload-json', '{"done":true}'], h.dependencies, h.io)).toBe(0);
      expect(await runCli(['tracker', 'record', '--id', 'life1', '--phase', 'created'], h.dependencies, h.io)).toBe(0);
      expect(await runCli(['wiki', 'render', '--slug', 'life1', '--tracker', 'life1', '--generation', '0', '--title', 'Lifecycle'], h.dependencies, h.io)).toBe(0);
      expect(h.stderr).toEqual([]);
      expect(h.stdout.join('')).toContain('"status": "cancelled"');
      expect(h.stdout.join('')).toContain('integration truth');
      expect(h.stdout.join('')).toContain('"generation": 1');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it('persists and replays unsupported workflows without invoking Cursor', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-workflow-cli-')); const h = harness(cwd);
    const definition = path.join(cwd, 'unsupported.json');
    fs.writeFileSync(definition, JSON.stringify({ schema_version: 1, name: 'native-team', version: '1', capability_tier: 'unsupported', unsupported_reason: 'Cursor has no verified native team API', stages: [{ id: 'start', prompt: 'not invoked', mode: 'ask', depends_on: [], max_attempts: 1 }] }));
    try {
      expect(await runCli(['workflow', 'install', '--file', definition], h.dependencies, h.io)).toBe(0);
      expect(await runCli(['workflow', 'plan', '--name', 'native-team', '--version', '1', '--id', 'wf1', '--objective', 'test'], h.dependencies, h.io)).toBe(0);
      expect(await runCli(['workflow', 'run', '--id', 'wf1'], h.dependencies, h.io)).toBe(1);
      expect(await runCli(['workflow', 'replay', '--id', 'wf1'], h.dependencies, h.io)).toBe(1);
      expect(h.stderr).toEqual([]);
      expect(h.stdout.join('')).toContain('"status": "unsupported"');
      expect(h.stdout.join('')).toContain('"verified": false');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it('does not let a duplicate workflow run id overwrite the original plan', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-workflow-duplicate-')); const h = harness(cwd);
    const definition = path.join(cwd, 'definition.json');
    fs.writeFileSync(definition, JSON.stringify({ schema_version: 1, name: 'delivery', version: '1', capability_tier: 'cursor-backed', stages: [{ id: 'one', prompt: 'one', mode: 'ask', depends_on: [], max_attempts: 1 }] }));
    try {
      expect(await runCli(['workflow', 'install', '--file', definition], h.dependencies, h.io)).toBe(0);
      expect(await runCli(['workflow', 'plan', '--name', 'delivery', '--id', 'duplicate', '--objective', 'original'], h.dependencies, h.io)).toBe(0);
      expect(await runCli(['workflow', 'plan', '--name', 'delivery', '--id', 'duplicate', '--objective', 'replacement'], h.dependencies, h.io)).toBe(1);
      expect(new WorkflowPersistenceStore(projectStateRoot(cwd)).read('duplicate').plan.objective).toBe('original');
      expect(h.stderr.join('')).toContain('E_WORKFLOW_RUN_EXISTS');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it('persists completed stage evidence before a later Cursor invocation crashes', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-workflow-crash-')); const h = harness(cwd);
    const definition = path.join(cwd, 'definition.json');
    fs.writeFileSync(definition, JSON.stringify({
      schema_version: 1, name: 'two-stage', version: '1', capability_tier: 'cursor-backed',
      stages: [
        { id: 'one', prompt: 'one', mode: 'ask', depends_on: [], max_attempts: 1 },
        { id: 'two', prompt: 'two', mode: 'ask', depends_on: ['one'], max_attempts: 1 },
      ],
    }));
    let calls = 0;
    const adapter = new CursorAgentAdapter('cursor-agent', async () => {
      calls += 1;
      if (calls === 2) throw new Error('simulated cursor crash');
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    });
    try {
      expect(await runCli(['workflow', 'install', '--file', definition], h.dependencies, h.io)).toBe(0);
      expect(await runCli(['workflow', 'plan', '--name', 'two-stage', '--id', 'crash', '--objective', 'preserve'], h.dependencies, h.io)).toBe(0);
      expect(await runCli(['workflow', 'run', '--id', 'crash'], { ...h.dependencies, adapter }, h.io)).toBe(1);
      const record = new WorkflowPersistenceStore(projectStateRoot(cwd)).read('crash');
      expect(record.events.map((event) => event.kind)).toEqual(['run_started', 'task_started', 'task_receipt', 'task_started']);
      expect(h.stderr.join('')).toContain('simulated cursor crash');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it('maps uninstall collision completion to exit code 2', () => {
    expect(uninstallExitCode('uninstalled')).toBe(0);
    expect(uninstallExitCode('already_absent')).toBe(0);
    expect(uninstallExitCode('completed_with_collisions')).toBe(2);
  });

  it('propagates post-install doctor warning and failure exit codes', () => {
    expect(installExitCode({ doctor: null })).toBe(0);
    expect(installExitCode({ doctor: { ok: true, exit_code: 2, checks: [] } })).toBe(2);
    expect(installExitCode({ doctor: { ok: false, exit_code: 1, checks: [] } })).toBe(1);
  });

  it('validates MCP config shapes, preserves existing servers, and never truncates invalid input', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-mcp-config-'));
    const h = harness(cwd);
    const file = path.join(cwd, 'mcp.json');
    try {
      for (const invalid of ['[]', '{"mcpServers":null}', '{"mcpServers":[]}', '{"mcpServers":"bad"}']) {
        fs.writeFileSync(file, invalid);
        expect(await runCli(['mcp-install', '--file', file], h.dependencies, h.io)).toBe(1);
        expect(fs.readFileSync(file, 'utf8')).toBe(invalid);
      }
      fs.writeFileSync(file, JSON.stringify({
        title: 'preserved',
        mcpServers: { existing: { command: 'existing-command' } },
      }));
      expect(await runCli(['mcp-install', '--file', file], h.dependencies, h.io)).toBe(0);
      const result = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        title: string;
        mcpServers: Record<string, { command: string }>;
      };
      expect(result.title).toBe('preserved');
      expect(result.mcpServers.existing?.command).toBe('existing-command');
      expect(result.mcpServers['oh-my-cursor']?.command).toBe(process.execPath);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('allows only one concurrent workflow resume to invoke Cursor', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-workflow-concurrent-')); const h = harness(cwd);
    const definition = path.join(cwd, 'definition.json');
    fs.writeFileSync(definition, JSON.stringify({ schema_version: 1, name: 'exclusive', version: '1', capability_tier: 'cursor-backed', stages: [{ id: 'one', prompt: 'one', mode: 'ask', depends_on: [], max_attempts: 1 }] }));
    let calls = 0;
    let entered!: () => void; let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const adapter = new CursorAgentAdapter('cursor-agent', async () => {
      calls += 1; entered(); await releasePromise;
      return { code: 0, stdout: '{"ok":true}', stderr: '' };
    });
    try {
      expect(await runCli(['workflow', 'install', '--file', definition], h.dependencies, h.io)).toBe(0);
      expect(await runCli(['workflow', 'plan', '--name', 'exclusive', '--id', 'exclusive-run', '--objective', 'once'], h.dependencies, h.io)).toBe(0);
      const first = runCli(['workflow', 'run', '--id', 'exclusive-run'], { ...h.dependencies, adapter }, h.io);
      await enteredPromise;
      expect(await runCli(['workflow', 'run', '--id', 'exclusive-run'], { ...h.dependencies, adapter }, h.io)).toBe(1);
      expect(calls).toBe(1);
      release();
      expect(await first).toBe(0);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  it('rejects string false in gates-json and skips option values for positional objectives', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-objective-')); const h = harness(cwd);
    const invalidGate = JSON.stringify([{ gate: 'plan', passed: 'false', evidence_sha256: null, verified: false, verification_authority: 'omcu-cli-only' }]);
    const prompts: string[] = [];
    let calls = 0;
    const adapter = new CursorAgentAdapter('cursor-agent', async (_executable, invocation) => {
      prompts.push(invocation.argv.at(-1) ?? '');
      calls += 1;
      return { code: 0, stdout: JSON.stringify(calls % 3 === 0 ? { verdict: 'APPROVE' } : { verdict: 'READY' }), stderr: '' };
    });
    try {
      expect(await runCli(['pipeline', '--gates-json', invalidGate], h.dependencies, h.io)).toBe(1);
      expect(await runCli(['ralplan', '--rounds', '1', 'actual objective'], { ...h.dependencies, adapter }, h.io)).toBe(0);
      expect(prompts[0]).toContain('Objective: actual objective');
      expect(prompts[0]).not.toContain('Objective: 1');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
