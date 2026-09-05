import type { ToolDefinition } from '../types.js';
import { GitWorktreeRunner, defaultGitWorktreeRunner } from './worktree-runner.js';

export function createGitTools(runner: GitWorktreeRunner = defaultGitWorktreeRunner): ToolDefinition[] {
  const identityTool: ToolDefinition = {
    name: 'git_identity',
    aliases: ['git_info', 'omcu_git_identity'],
    description: 'Get repository and current worktree identity, branch, HEAD SHA, clean/dirty state, and upstream tracking.',
    provider: 'sdk-custom',
    sideEffect: 'readOnly',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Directory to query' },
      },
    },
    execute: async (args, _context, env) => {
      const cwd = args.cwd ? String(args.cwd) : env?.projectRoot ?? process.cwd();
      const identity = await runner.getIdentity(cwd);
      return JSON.stringify(identity, null, 2);
    },
  };

  const worktreeTool: ToolDefinition = {
    name: 'git_worktree_runner',
    aliases: ['worktree_runner', 'omcu_worktree'],
    description: 'Safely creates, manages, and prunes git worktrees for isolated subagents.',
    provider: 'sdk-custom',
    sideEffect: 'idempotent',
    sourceAnalogs: {
      omo: 'omo_worktree_runner',
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'remove', 'prune'],
          description: 'Worktree action to perform',
        },
        path: { type: 'string', description: 'Path to target worktree' },
        branch: { type: 'string', description: 'Branch name for newly created worktree' },
        startPoint: { type: 'string', description: 'Starting commit or branch for new worktree' },
        force: { type: 'boolean', description: 'Force remove if active' },
      },
      required: ['action'],
    },
    execute: async (args, _context, env) => {
      const action = String(args.action);
      const cwd = env?.projectRoot ?? process.cwd();
      const identity = await runner.getIdentity(cwd);
      const repoRoot = identity.repoRoot;

      switch (action) {
        case 'list': {
          const list = await runner.listWorktrees(repoRoot);
          return JSON.stringify({ repoRoot, worktrees: list }, null, 2);
        }
        case 'create': {
          const targetPath = String(args.path);
          const branch = String(args.branch);
          const startPoint = args.startPoint ? String(args.startPoint) : undefined;
          const created = await runner.createWorktree(repoRoot, targetPath, branch, startPoint);
          return JSON.stringify({ created }, null, 2);
        }
        case 'remove': {
          const targetPath = String(args.path);
          const force = Boolean(args.force);
          await runner.removeWorktree(repoRoot, targetPath, force);
          return JSON.stringify({ removed: targetPath }, null, 2);
        }
        case 'prune': {
          await runner.pruneWorktrees(repoRoot);
          return JSON.stringify({ pruned: true }, null, 2);
        }
        default:
          throw new Error(`Unsupported worktree action: ${action}`);
      }
    },
  };

  const statusDiffTool: ToolDefinition = {
    name: 'git_status_diff',
    aliases: ['status_diff', 'omcu_git_status'],
    description: 'Inspect git working tree short status and diff stat without raw unconstrained shell commands.',
    provider: 'sdk-custom',
    sideEffect: 'readOnly',
    execute: async (_args, _context, env) => {
      const cwd = env?.projectRoot ?? process.cwd();
      const identity = await runner.getIdentity(cwd);
      const result = await runner.getStatusDiff(identity.repoRoot);
      return JSON.stringify(result, null, 2);
    },
  };

  const boundedExecTool: ToolDefinition = {
    name: 'git_bounded_exec',
    aliases: ['bounded_command', 'omcu_bounded_exec'],
    description: 'Execute a bounded background command with timeout and automatic artifact spill for large output.',
    provider: 'sdk-custom',
    sideEffect: 'destructive',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Executable command' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments list',
        },
        cwd: { type: 'string', description: 'Working directory' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds' },
      },
      required: ['command'],
    },
    execute: async (args, _context, env) => {
      const command = String(args.command);
      const cmdArgs = args.args !== undefined ? (args.args as string[]) : [];
      const cwd = args.cwd ? String(args.cwd) : env?.projectRoot ?? process.cwd();
      const timeoutMs = args.timeoutMs !== undefined ? Number(args.timeoutMs) : 30000;

      const result = await runner.executeBoundedCommand(
        {
          command,
          args: cmdArgs,
          cwd,
          timeoutMs,
        },
        env?.projectRoot
      );

      return JSON.stringify(result, null, 2);
    },
  };

  return [identityTool, worktreeTool, statusDiffTool, boundedExecTool];
}
