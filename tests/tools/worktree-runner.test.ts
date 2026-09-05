import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGitTools,
  createToolRegistry,
  GitWorktreeRunner,
} from '../../src/tools/index.js';

describe('Git Worktree Runner and Git Tools', () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-git-test-repo-'));
    // Initialize temporary git repo
    execFileSync('git', ['init', '-b', 'main', tempRepo], { stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: tempRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: tempRepo, stdio: 'ignore' });
    fs.writeFileSync(path.join(tempRepo, 'README.md'), '# Initial', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: tempRepo, stdio: 'ignore' });
  });

  afterEach(() => {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  it('resolves git identity and clean/dirty status', async () => {
    const runner = new GitWorktreeRunner();
    const identity = await runner.getIdentity(tempRepo);

    expect(identity.repoRoot).toBe(fs.realpathSync(tempRepo));
    expect(identity.branch).toBe('main');
    expect(identity.headSha).toHaveLength(40);
    expect(identity.isClean).toBe(true);

    // Make repo dirty
    fs.writeFileSync(path.join(tempRepo, 'dirty.txt'), 'dirty', 'utf8');
    const dirtyIdentity = await runner.getIdentity(tempRepo);
    expect(dirtyIdentity.isClean).toBe(false);
  });

  it('creates, lists, and removes git worktrees', async () => {
    const runner = new GitWorktreeRunner();
    const worktreeTarget = path.join(tempRepo, '.worktrees', 'subagent-1');

    const created = await runner.createWorktree(tempRepo, worktreeTarget, 'feat-subagent');
    expect(fs.existsSync(worktreeTarget)).toBe(true);
    expect(created.branch).toContain('feat-subagent');

    const list = await runner.listWorktrees(tempRepo);
    expect(list.length).toBeGreaterThanOrEqual(2);

    await runner.removeWorktree(tempRepo, worktreeTarget, true);
    await runner.pruneWorktrees(tempRepo);

    const listAfter = await runner.listWorktrees(tempRepo);
    expect(listAfter.find((w) => w.path === worktreeTarget)).toBeUndefined();
  });

  it('dispatches git_worktree_runner tool through registry', async () => {
    const runner = new GitWorktreeRunner();
    const registry = createToolRegistry(createGitTools(runner));

    const worktreeTarget = path.join(tempRepo, '.worktrees', 'agent-task');

    // Create
    const createRes = await registry.execute(
      'git_worktree_runner',
      {
        action: 'create',
        path: worktreeTarget,
        branch: 'agent-branch',
      },
      { toolCallId: 'wt-1' },
      { projectRoot: tempRepo }
    );
    expect(JSON.parse(createRes as string).created).toBeDefined();

    // List via alias
    const listRes = await registry.execute(
      'worktree_runner',
      { action: 'list' },
      { toolCallId: 'wt-2' },
      { projectRoot: tempRepo }
    );
    expect(JSON.parse(listRes as string).worktrees.length).toBeGreaterThanOrEqual(2);

    // Remove
    const removeRes = await registry.execute(
      'git_worktree_runner',
      { action: 'remove', path: worktreeTarget, force: true },
      { toolCallId: 'wt-3' },
      { projectRoot: tempRepo }
    );
    expect(JSON.parse(removeRes as string).removed).toBe(worktreeTarget);
  });

  it('executes bounded commands and spills output exceeding maxOutputBytes', async () => {
    const runner = new GitWorktreeRunner();
    const registry = createToolRegistry(createGitTools(runner));

    // Command with small output
    const shortRes = await registry.execute(
      'git_bounded_exec',
      {
        command: 'echo',
        args: ['hello world'],
      },
      { toolCallId: 'exec-1' },
      { projectRoot: tempRepo }
    );
    const parsedShort = JSON.parse(shortRes as string);
    expect(parsedShort.exitCode).toBe(0);
    expect(parsedShort.stdout.trim()).toBe('hello world');
    expect(parsedShort.spilled).toBe(false);
  });
});
