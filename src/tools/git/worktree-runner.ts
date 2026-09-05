import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ToolError } from '../types.js';
import type {
  CommandExecutionOptions,
  CommandExecutionResult,
  GitIdentity,
  WorktreeEntry,
} from './types.js';

const execFileAsync = promisify(execFile);

export class GitWorktreeRunner {
  async getIdentity(cwd: string = process.cwd()): Promise<GitIdentity> {
    try {
      const { stdout: rootOut } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd });
      const repoRoot = rootOut.trim();

      const { stdout: prefixOut } = await execFileAsync('git', ['rev-parse', '--show-prefix'], { cwd });
      const worktreePath = prefixOut.trim() ? path.resolve(cwd) : repoRoot;

      const { stdout: branchOut } = await execFileAsync('git', ['branch', '--show-current'], { cwd });
      const branch = branchOut.trim() || 'HEAD';

      const { stdout: shaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
      const headSha = shaOut.trim();

      const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
      const isClean = statusOut.trim().length === 0;

      let upstream: string | undefined;
      try {
        const { stdout: upOut } = await execFileAsync(
          'git',
          ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
          { cwd }
        );
        upstream = upOut.trim() || undefined;
      } catch {
        // No upstream configured
      }

      return {
        repoRoot,
        worktreePath,
        branch,
        headSha,
        isClean,
        upstream,
      };
    } catch (err) {
      throw new ToolError(
        'E_TOOL_EXECUTION_FAILED',
        `Failed to resolve git identity at '${cwd}': ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  async listWorktrees(repoRoot: string): Promise<readonly WorktreeEntry[]> {
    try {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot });
      const entries: WorktreeEntry[] = [];
      const blocks = stdout.trim().split('\n\n');

      for (const block of blocks) {
        if (!block.trim()) continue;
        const lines = block.split('\n');
        let wtPath = '';
        let head = '';
        let branch = '';
        let isBare = false;
        let isDetached = false;

        for (const line of lines) {
          if (line.startsWith('worktree ')) {
            wtPath = line.slice(9).trim();
          } else if (line.startsWith('HEAD ')) {
            head = line.slice(5).trim();
          } else if (line.startsWith('branch ')) {
            branch = line.slice(7).trim();
          } else if (line === 'bare') {
            isBare = true;
          } else if (line === 'detached') {
            isDetached = true;
          }
        }

        if (wtPath) {
          entries.push({
            path: wtPath,
            head,
            branch,
            isBare,
            isDetached,
          });
        }
      }

      return entries;
    } catch (err) {
      throw new ToolError(
        'E_TOOL_EXECUTION_FAILED',
        `Failed to list git worktrees: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  async createWorktree(
    repoRoot: string,
    targetPath: string,
    branchName: string,
    startPoint?: string
  ): Promise<WorktreeEntry> {
    const resolvedPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(repoRoot, targetPath);

    if (fs.existsSync(resolvedPath)) {
      throw new ToolError(
        'E_WORKTREE_LOCK_FAILED',
        `Cannot create worktree at '${resolvedPath}': directory already exists`
      );
    }

    const args = ['worktree', 'add', '-b', branchName, resolvedPath];
    if (startPoint) {
      args.push(startPoint);
    }

    try {
      await execFileAsync('git', args, { cwd: repoRoot });
      const worktrees = await this.listWorktrees(repoRoot);
      const created = worktrees.find((w) => path.resolve(w.path) === resolvedPath);
      if (!created) {
        return {
          path: resolvedPath,
          head: 'unknown',
          branch: branchName,
          isBare: false,
          isDetached: false,
        };
      }
      return created;
    } catch (err) {
      throw new ToolError(
        'E_WORKTREE_LOCK_FAILED',
        `Failed to create worktree at '${resolvedPath}': ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  async removeWorktree(repoRoot: string, targetPath: string, force = false): Promise<void> {
    const resolvedPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(repoRoot, targetPath);
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(resolvedPath);

    try {
      await execFileAsync('git', args, { cwd: repoRoot });
    } catch (err) {
      throw new ToolError(
        'E_TOOL_EXECUTION_FAILED',
        `Failed to remove worktree '${resolvedPath}': ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  async pruneWorktrees(repoRoot: string): Promise<void> {
    try {
      await execFileAsync('git', ['worktree', 'prune'], { cwd: repoRoot });
    } catch (err) {
      throw new ToolError(
        'E_TOOL_EXECUTION_FAILED',
        `Failed to prune worktrees: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  async getStatusDiff(repoRoot: string): Promise<{ status: string; diffStat: string }> {
    try {
      const { stdout: status } = await execFileAsync('git', ['status', '--short'], { cwd: repoRoot });
      const { stdout: diffStat } = await execFileAsync('git', ['diff', '--stat'], { cwd: repoRoot });
      return { status, diffStat };
    } catch (err) {
      throw new ToolError(
        'E_TOOL_EXECUTION_FAILED',
        `Failed to get git status/diff: ${err instanceof Error ? err.message : String(err)}`,
        err
      );
    }
  }

  async executeBoundedCommand(
    options: CommandExecutionOptions,
    projectRoot?: string
  ): Promise<CommandExecutionResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 30000;
    const maxOutputBytes = options.maxOutputBytes ?? 32768;
    const cwd = options.cwd ?? projectRoot ?? process.cwd();

    try {
      const { stdout, stderr } = await execFileAsync(
        options.command,
        options.args ? [...options.args] : [],
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
        }
      );

      const durationMs = Date.now() - startTime;
      const totalBytes = Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8');

      if (totalBytes > maxOutputBytes) {
        // Spill output to artifact
        const root = projectRoot ?? cwd;
        const artifactsDir = path.join(root, '.omcu', 'artifacts', 'process');
        fs.mkdirSync(artifactsDir, { recursive: true });
        const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const artifactPath = path.join(artifactsDir, `exec-${id}.log`);

        fs.writeFileSync(
          artifactPath,
          `=== STDOUT ===\n${stdout}\n=== STDERR ===\n${stderr}`,
          'utf8'
        );

        return {
          exitCode: 0,
          stdout: stdout.slice(0, 1000) + (stdout.length > 1000 ? '\n...[spilled to artifact]' : ''),
          stderr: stderr.slice(0, 500) + (stderr.length > 500 ? '\n...[spilled to artifact]' : ''),
          durationMs,
          spilled: true,
          artifactPath: path.relative(root, artifactPath),
        };
      }

      return {
        exitCode: 0,
        stdout,
        stderr,
        durationMs,
        spilled: false,
      };
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const errorObj = err as { code?: string | number; stdout?: string; stderr?: string; message?: string };
      const exitCode = typeof errorObj.code === 'number' ? errorObj.code : 1;
      return {
        exitCode,
        stdout: errorObj.stdout ?? '',
        stderr: errorObj.stderr ?? errorObj.message ?? String(err),
        durationMs,
        spilled: false,
      };
    }
  }
}

export const defaultGitWorktreeRunner = new GitWorktreeRunner();
