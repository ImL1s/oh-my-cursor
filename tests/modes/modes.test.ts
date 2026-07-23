import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CursorAgentAdapter } from '../../src/host/cursor-agent.js';
import { acceptanceGate, AutopilotPipeline, CursorWorktreeUlw, qaGate, reviewGate, runRalplan, runRalph } from '../../src/modes/index.js';

describe('Cursor-backed modes', () => {
  it('runs all ralplan roles through cursor-agent plan mode', async () => {
    let call = 0;
    const adapter = new CursorAgentAdapter('cursor-agent', async (_executable, invocation) => {
      call += 1;
      const output = call === 3 ? { verdict: 'APPROVE' } : { verdict: 'READY' };
      return { code: 0, stdout: JSON.stringify(output), stderr: '' };
    });
    const result = await runRalplan({ adapter, cwd: '/repo' }, 'design feature');
    expect(result.status).toBe('accepted');
    expect(result.receipts).toHaveLength(3);
    expect(result.receipts.every((receipt) => receipt.read_only && receipt.argv.includes('plan'))).toBe(true);
    expect(result.verified).toBe(false);
  });

  it('persists ralph until explicit structured completion', async () => {
    let call = 0;
    const adapter = new CursorAgentAdapter('cursor-agent', async () => ({ code: 0, stdout: JSON.stringify({ complete: ++call === 2 }), stderr: '' }));
    const result = await runRalph({ adapter, cwd: '/repo' }, 'finish task', { maxIterations: 4 });
    expect(result.status).toBe('complete');
    expect(result.receipts).toHaveLength(2);
  });

  it('creates isolated ULW worktrees and rejects ownership overlap', async () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-ulw-'));
    const adapter = new CursorAgentAdapter('cursor-agent', async () => ({ code: 0, stdout: '{}', stderr: '' }));
    const commands: string[][] = [];
    const ulw = new CursorWorktreeUlw(adapter, async (_executable, argv) => {
      commands.push([...argv]);
      if (argv[0] === 'worktree' && argv[1] === 'add') fs.mkdirSync(argv[3]!, { recursive: true });
      if (argv[0] === 'rev-parse') return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const result = await ulw.run(repository, 'run-1', [
      { id: 'a', objective: 'A', owned_paths: ['src/a'] },
      { id: 'b', objective: 'B', owned_paths: ['src/b'] },
    ]);
    expect(result.status).toBe('complete');
    expect(result.native_cursor_team).toBe(false);
    expect(result.worktree_policy).toBe('retain-after-worker-invocation');
    expect(result.workers.every((worker) => worker.worktree_disposition === 'retained')).toBe(true);
    expect(commands).toHaveLength(6);
    expect(fs.existsSync(path.join(repository, '.omcu-worktrees', 'run-1', 'a'))).toBe(true);
    await expect(ulw.run(repository, 'run-2', [
      { id: 'a', objective: 'A', owned_paths: ['src'] },
      { id: 'b', objective: 'B', owned_paths: ['src/b'] },
    ])).rejects.toThrow('E_ULW_PATH_CONFLICT');
    fs.rmSync(repository, { recursive: true, force: true });
  });

  it('rejects non-canonical ULW owned paths and preserves prefix conflict detection', async () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-ulw-canonical-'));
    const adapter = new CursorAgentAdapter('cursor-agent', async () => ({ code: 0, stdout: '{}', stderr: '' }));
    const ulw = new CursorWorktreeUlw(adapter, async (_executable, argv) => {
      if (argv[0] === 'worktree' && argv[1] === 'add') fs.mkdirSync(argv[3]!, { recursive: true });
      if (argv[0] === 'rev-parse') return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    for (const owned of ['src/./a', 'src//a', 'a/../b', 'src/a/', './src', '.', 'a\\b', '']) {
      await expect(ulw.run(repository, 'invalid-path', [
        { id: 'a', objective: 'A', owned_paths: [owned] },
      ])).rejects.toThrow('E_ULW_PATH_INVALID');
    }
    const ok = await ulw.run(repository, 'canonical-ok', [
      { id: 'a', objective: 'A', owned_paths: ['src/a'] },
      { id: 'b', objective: 'B', owned_paths: ['src/b'] },
    ]);
    expect(ok.status).toBe('complete');
    await expect(ulw.run(repository, 'prefix-conflict', [
      { id: 'a', objective: 'A', owned_paths: ['src/a'] },
      { id: 'b', objective: 'B', owned_paths: ['src/a/sub'] },
    ])).rejects.toThrow('E_ULW_PATH_CONFLICT');
    await expect(ulw.run(repository, 'casefold-conflict', [
      { id: 'a', objective: 'A', owned_paths: ['src/Foo'] },
      { id: 'b', objective: 'B', owned_paths: ['src/foo'] },
    ])).rejects.toThrow('E_ULW_PATH_CONFLICT');
    fs.rmSync(repository, { recursive: true, force: true });
  });

  it('rejects duplicate ULW worker ids before filesystem, worktree, or adapter effects', async () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-ulw-duplicate-'));
    let runnerCalls = 0;
    let adapterCalls = 0;
    const adapter = new CursorAgentAdapter('cursor-agent', async () => { adapterCalls += 1; return { code: 0, stdout: '{}', stderr: '' }; });
    const ulw = new CursorWorktreeUlw(adapter, async () => { runnerCalls += 1; return { code: 0, stdout: '', stderr: '' }; });
    await expect(ulw.run(repository, 'duplicate-run', [
      { id: 'same', objective: 'A', owned_paths: ['src/a'] },
      { id: 'same', objective: 'B', owned_paths: ['src/b'] },
    ])).rejects.toThrow('E_ULW_WORKER_ID_CONFLICT');
    expect(runnerCalls).toBe(0);
    expect(adapterCalls).toBe(0);
    expect(fs.existsSync(path.join(repository, '.omcu-worktrees'))).toBe(false);
    fs.rmSync(repository, { recursive: true, force: true });
  });

  it('retains worktrees after worker invocation, including worker failure', async () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-ulw-cleanup-'));
    const failingAdapter = new CursorAgentAdapter('cursor-agent', async (_executable, invocation) => {
      fs.writeFileSync(path.join(invocation.cwd, 'draft.txt'), 'do not destroy');
      throw new Error('worker crashed');
    });
    const commands: string[][] = [];
    const ulw = new CursorWorktreeUlw(failingAdapter, async (_executable, argv) => {
      commands.push([...argv]);
      if (argv[0] === 'worktree' && argv[1] === 'add') fs.mkdirSync(argv[3]!, { recursive: true });
      if (argv[0] === 'rev-parse') return { code: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' };
      if (argv[0] === 'status') return { code: 0, stdout: '?? draft.txt\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const failed = await ulw.run(repository, 'worker-fails', [{ id: 'one', objective: 'fail', owned_paths: ['src/one'] }]);
    expect(failed.status).toBe('failed');
    expect(failed.workers[0]).toMatchObject({ worktree_disposition: 'retained', dirty: true });
    expect(fs.readFileSync(path.join(failed.workers[0]!.worktree, 'draft.txt'), 'utf8')).toBe('do not destroy');
    expect(commands.some((argv) => argv[0] === 'worktree' && argv[1] === 'remove')).toBe(false);
    fs.rmSync(repository, { recursive: true, force: true });
  });

  it('retains a successful real git worktree and keeps its detached commit reachable', async () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-ulw-real-git-'));
    const git = (args: readonly string[], cwd = repository) => {
      const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repository, 'base.txt'), 'base');
    git(['add', 'base.txt']); git(['commit', '-qm', 'base']);
    const runner = async (executable: string, argv: readonly string[], cwd: string) => {
      const result = spawnSync(executable, [...argv], { cwd, encoding: 'utf8' });
      return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    };
    const adapter = new CursorAgentAdapter('cursor-agent', async (_executable, invocation) => {
      fs.writeFileSync(path.join(invocation.cwd, 'worker.txt'), 'preserved');
      const result = spawnSync('git', ['add', 'worker.txt'], { cwd: invocation.cwd, encoding: 'utf8' });
      expect(result.status).toBe(0);
      const committed = spawnSync('git', ['commit', '-qm', 'worker result'], { cwd: invocation.cwd, encoding: 'utf8' });
      expect(committed.status).toBe(0);
      return { code: 0, stdout: '{}', stderr: '' };
    });
    const result = await new CursorWorktreeUlw(adapter, runner).run(repository, 'real', [{ id: 'worker', objective: 'commit', owned_paths: ['worker.txt'] }]);
    const receipt = result.workers[0]!;
    expect(result.status).toBe('complete');
    expect(receipt.worktree_disposition).toBe('retained');
    expect(fs.readFileSync(path.join(receipt.worktree, 'worker.txt'), 'utf8')).toBe('preserved');
    expect(receipt.head_oid).toMatch(/^[a-f0-9]{40}$/);
    expect(git(['cat-file', '-t', `${receipt.head_oid}^{commit}`])).toBe('commit');
    spawnSync('git', ['worktree', 'remove', '--force', receipt.worktree], { cwd: repository });
    fs.rmSync(repository, { recursive: true, force: true });
  });

  it('enforces autopilot gate order without claiming verification', () => {
    const pipeline = new AutopilotPipeline();
    pipeline.accept({ gate: 'plan', passed: true, evidence_sha256: 'a'.repeat(64), verified: false, verification_authority: 'omcu-cli-only' });
    pipeline.accept({ gate: 'execute', passed: true, evidence_sha256: 'b'.repeat(64), verified: false, verification_authority: 'omcu-cli-only' });
    pipeline.accept(reviewGate('clean review', true));
    pipeline.accept(qaGate('tests pass', true));
    const complete = pipeline.accept(acceptanceGate('criteria met', true));
    expect(complete.phase).toBe('complete');
    expect(complete.verified).toBe(false);
  });

  it('rejects caller-forged verified gates', () => {
    const pipeline = new AutopilotPipeline();
    expect(() => pipeline.accept({ gate: 'plan', passed: true, evidence_sha256: 'a'.repeat(64), verified: true, verification_authority: 'omcu-cli-only' } as never)).toThrow('E_AUTOPILOT_GATE_INVALID');
  });

  it('strictly validates gate booleans, evidence, fields, and order', () => {
    const base = { gate: 'plan', passed: true, evidence_sha256: 'a'.repeat(64), verified: false, verification_authority: 'omcu-cli-only' };
    expect(() => new AutopilotPipeline().accept({ ...base, passed: 'false' } as never)).toThrow('E_AUTOPILOT_GATE_INVALID');
    expect(() => new AutopilotPipeline().accept({ ...base, evidence_sha256: null } as never)).toThrow('E_AUTOPILOT_GATE_INVALID');
    expect(() => new AutopilotPipeline().accept({ ...base, extra: true } as never)).toThrow('E_AUTOPILOT_GATE_INVALID');
    expect(() => new AutopilotPipeline().accept({ ...base, gate: 'review' } as never)).toThrow('E_AUTOPILOT_GATE_ORDER');
  });
});
