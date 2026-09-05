import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, HELP } from '../src/cli/application.js';
import { installExitCode, uninstallExitCode } from '../src/cli/lifecycle.js';
import { CursorAgentAdapter } from '../src/host/cursor-agent.js';
import { projectStateRoot } from '../src/runtime/state-root.js';
import { digestObject, WorkflowPersistenceStore } from '../src/workflows/index.js';

function harness(cwd: string) {
  const stdout: string[] = []; const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) }, dependencies: { cwd, homeDir: path.join(cwd, 'home'), packageRoot: path.resolve('.') } };
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

  it('reports workflow lease status without raw nonce and reconciles cross-process with a non-secret acknowledgement', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-workflow-lease-cli-')); const h = harness(cwd);
    const definition = path.join(cwd, 'definition.json');
    fs.writeFileSync(definition, JSON.stringify({ schema_version: 1, name: 'lease-cli', version: '1', capability_tier: 'cursor-backed', stages: [{ id: 'one', prompt: 'one', mode: 'ask', depends_on: [], max_attempts: 1 }] }));
    try {
      expect(await runCli(['workflow', 'install', '--file', definition], h.dependencies, h.io)).toBe(0);
      expect(await runCli(['workflow', 'plan', '--name', 'lease-cli', '--id', 'lease-cli-run', '--objective', 'inspect'], h.dependencies, h.io)).toBe(0);
      const store = new WorkflowPersistenceStore(projectStateRoot(cwd));
      let record = store.read('lease-cli-run');
      const rawNonce = 'cd'.repeat(32);
      const acquired = await store.acquireExecutionLease('lease-cli-run', record.revision, '1-one', 'operator', {
        pid: process.pid,
        start_identity: `unproven:${process.pid}`,
        start_identity_proven: false,
        nonce: rawNonce,
      });
      record = acquired.record;
      h.stdout.length = 0;
      expect(await runCli(['workflow', 'lease-status', '--id', 'lease-cli-run'], h.dependencies, h.io)).toBe(0);
      expect(h.stdout.join('')).toContain('"state": "ambiguous"');
      expect(h.stdout.join('')).toContain('"nonce_sha256"');
      expect(h.stdout.join('')).not.toContain(rawNonce);

      h.stdout.length = 0;
      const lease = record.execution_lease!;
      const acknowledgement = {
        run_id: lease.run_id,
        task_id: lease.task_id,
        owner_id: lease.owner_id,
        owner_pid: lease.owner_pid,
        owner_start_identity_sha256: digestObject(lease.owner_start_identity),
        owner_start_identity_proven: lease.owner_start_identity_proven,
        owner_nonce_sha256: lease.owner_nonce_sha256,
        generation: lease.generation,
        acquired_at: lease.acquired_at,
        expected_status: 'ambiguous',
        expected_reason: 'start_identity_unproven',
        operator_confirmation: 'owner-dead-side-effects-reviewed',
      };
      expect(await runCli([
        'workflow', 'lease-reconcile', '--id', 'lease-cli-run', '--revision', String(record.revision),
        '--credential-json', JSON.stringify(acknowledgement),
      ], h.dependencies, h.io)).toBe(0);
      expect(h.stdout.join('')).toContain('"reconciled": true');
      expect(h.stdout.join('')).not.toContain(rawNonce);
      expect(store.executionLeaseStatus('lease-cli-run').state).toBe('none');
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

  it('exits 0 for post-install doctor soft-warnings and fails only on hard doctor failure', () => {
    expect(installExitCode({ doctor: null })).toBe(0);
    expect(installExitCode({ doctor: { ok: true, exit_code: 2, checks: [] } })).toBe(0);
    expect(installExitCode({ doctor: { ok: true, exit_code: 0, checks: [] } })).toBe(0);
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

  it('integrates install lifecycle commands: status, list, verify, rollback, prune, repair, and update-source enforcement', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lifecycle-cli-'));
    fs.chmodSync(cwd, 0o700);
    const h = harness(cwd);
    const home = h.dependencies.homeDir;
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);

    const healthyAdapter = new CursorAgentAdapter('cursor-agent', async (_exe, invocation) => {
      if (invocation.argv[0] === '--version') return { code: 0, stdout: '2026.07.20-test\n', stderr: '' };
      if (invocation.argv[0] === 'status') return { code: 0, stdout: 'authenticated\n', stderr: '' };
      return { code: 0, stdout: '--version --help status --plugin-dir\n', stderr: '' };
    });

    function fixture(ver: string): string {
      const p = path.join(cwd, `pkg-${ver}`);
      fs.mkdirSync(path.join(p, 'dist', 'bin'), { recursive: true });
      fs.mkdirSync(path.join(p, '.cursor-plugin'), { recursive: true });
      fs.mkdirSync(path.join(p, '.cursor', 'rules'), { recursive: true });
      fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name: '@iml1s/oh-my-cursor', version: ver, files: ['dist', '.cursor-plugin', '.cursor/rules'] }));
      fs.writeFileSync(path.join(p, 'dist', 'bin', 'omcu.js'), `#!/usr/bin/env node\nconsole.log("${ver}");\n`);
      fs.writeFileSync(path.join(p, '.cursor', 'rules', 'oh-my-cursor.mdc'), '---\nalwaysApply: true\n---\n');
      fs.writeFileSync(path.join(p, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'oh-my-cursor', version: ver, rules: './.cursor/rules/' }));
      return p;
    }

    const pkg1 = fixture('1.0.0');
    const pkg2 = fixture('2.0.0');

    function makeWritable(dir: string): void {
      if (!fs.existsSync(dir)) return;
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory()) return;
      fs.chmodSync(dir, 0o700);
      for (const name of fs.readdirSync(dir)) makeWritable(path.join(dir, name));
    }

    try {
      // 1. bare update without source should fail with E_UPDATE_SOURCE_REQUIRED
      expect(await runCli(['update'], { ...h.dependencies, adapter: healthyAdapter }, h.io)).toBe(1);
      expect(h.stderr.join('')).toContain('E_UPDATE_SOURCE_REQUIRED');
      h.stderr.length = 0;
      h.stdout.length = 0;

      // 2. install status before install
      expect(await runCli(['install', 'status'], { ...h.dependencies, adapter: healthyAdapter }, h.io)).toBe(1);
      expect(h.stdout.join('')).toContain('"healthy": false');
      h.stdout.length = 0;

      // 3. install v1 via setup
      expect(await runCli(['setup', '--source', pkg1], { ...h.dependencies, adapter: healthyAdapter }, h.io)).toBe(0);
      expect(h.stdout.join('')).toContain('"status": "installed"');
      h.stdout.length = 0;

      // 4. install status after install
      expect(await runCli(['install', 'status'], { ...h.dependencies, adapter: healthyAdapter }, h.io)).toBe(0);
      expect(h.stdout.join('')).toContain('"healthy": true');
      h.stdout.length = 0;

      // 5. install list
      expect(await runCli(['install', 'list'], { ...h.dependencies, adapter: healthyAdapter }, h.io)).toBe(0);
      expect(h.stdout.join('')).toContain('"version": "1.0.0"');
      h.stdout.length = 0;

      // 6. install verify
      expect(await runCli(['install', 'verify'], { ...h.dependencies, adapter: healthyAdapter }, h.io)).toBe(0);
      expect(h.stdout.join('')).toContain('"ok": true');
      h.stdout.length = 0;

      // 7. update to v2
      expect(await runCli(['update', '--source', pkg2], { ...h.dependencies, adapter: healthyAdapter }, h.io)).toBe(0);
      expect(h.stdout.join('')).toContain('"status": "updated"');
      h.stdout.length = 0;

      // 8. rollback without --receipt automatically rolls back to v1
      const rollbackCode = await runCli(['rollback'], { ...h.dependencies, adapter: healthyAdapter }, h.io);
      if (rollbackCode !== 0) {
        console.error('ROLLBACK FAILED:', { rollbackCode, stdout: h.stdout.join(''), stderr: h.stderr.join('') });
      }
      expect(rollbackCode).toBe(0);
      expect(h.stdout.join('')).toContain('"status": "rolled_back"');
      expect(h.stdout.join('')).toContain('"version": "1.0.0"');
      h.stdout.length = 0;

      // 9. install prune --dry-run
      expect(await runCli(['install', 'prune', '--dry-run'], { ...h.dependencies, adapter: healthyAdapter }, h.io)).toBe(0);
      expect(h.stdout.join('')).toContain('"dry_run": true');
      h.stdout.length = 0;

      // 10. install repair
      expect(await runCli(['install', 'repair'], { ...h.dependencies, adapter: healthyAdapter }, h.io)).toBe(0);
      expect(h.stdout.join('')).toContain('"repaired": false');
      h.stdout.length = 0;
    } finally {
      makeWritable(cwd);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 20_000);
});
