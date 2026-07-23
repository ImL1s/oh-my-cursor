import fs from 'node:fs';
import path from 'node:path';
import { buildPrintArgv, type CursorAgentAdapter } from '../host/cursor-agent.js';
import { sha256 } from '../workflows/schema.js';
import { assertExclusivePathClaims } from './path-claims.js';
import type { CommandRunner } from './types.js';

export interface UlwWorkerSpec { readonly id: string; readonly objective: string; readonly owned_paths: readonly string[] }
export interface UlwWorkerReceipt {
  readonly worker_id: string;
  readonly worktree: string;
  readonly owned_paths: readonly string[];
  readonly argv: readonly string[];
  readonly exit_code: number;
  readonly output_sha256: string;
  readonly worktree_disposition: 'retained' | 'removed-before-invocation' | 'cleanup-failed';
  readonly head_oid: string | null;
  readonly dirty: boolean | null;
  readonly status_sha256: string | null;
  readonly cleanup_instruction: string | null;
  readonly disposition_error: string | null;
  readonly verified: false;
}
export interface UlwResult { readonly status: 'complete' | 'failed'; readonly workers: readonly UlwWorkerReceipt[]; readonly worktree_policy: 'retain-after-worker-invocation'; readonly capability_tier: 'cursor-backed-worktrees'; readonly native_cursor_team: false; readonly verified: false; readonly verification_authority: 'omcu-cli-only' }

export class CursorWorktreeUlw {
  constructor(private readonly adapter: CursorAgentAdapter, private readonly commandRunner: CommandRunner) {}

  async run(repository: string, runId: string, workers: readonly UlwWorkerSpec[]): Promise<UlwResult> {
    validateWorkers(workers);
    const base = path.join(repository, '.omcu-worktrees', safe(runId));
    fs.mkdirSync(base, { recursive: true });
    const receipts = await Promise.all(workers.map(async (worker) => this.runWorker(repository, base, worker)));
    if (receipts.every((receipt) => receipt.worktree_disposition === 'removed-before-invocation')) removeEmptyBase(base);
    return {
      status: receipts.every((receipt) => receipt.exit_code === 0 && receipt.worktree_disposition === 'retained') ? 'complete' : 'failed',
      workers: receipts,
      worktree_policy: 'retain-after-worker-invocation',
      capability_tier: 'cursor-backed-worktrees',
      native_cursor_team: false,
      verified: false,
      verification_authority: 'omcu-cli-only',
    };
  }

  private async runWorker(repository: string, base: string, worker: UlwWorkerSpec): Promise<UlwWorkerReceipt> {
    const worktree = path.join(base, safe(worker.id));
    let added;
    try {
      added = await this.commandRunner('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], repository);
    } catch (error) {
      const cleanup = await cleanupBeforeInvocation(this.commandRunner, repository, worktree);
      return receipt(worker, worktree, [], 1, errorText(error), cleanup, null);
    }
    if (added.code !== 0) {
      const cleanup = await cleanupBeforeInvocation(this.commandRunner, repository, worktree);
      return receipt(worker, worktree, [], added.code, added.stderr, cleanup, null);
    }

    const prompt = [`ULW worker ${worker.id}.`, `Objective: ${worker.objective}`, `Exclusive path ownership: ${worker.owned_paths.join(', ')}`, 'Do not edit outside the declared owned paths. You are one independent Cursor worker; Cursor has no native team authority here.'].join('\n\n');
    const argv = buildPrintArgv(prompt, { format: 'json', mode: 'ask' });
    let exitCode = 1;
    let output = '';
    try {
      const result = await this.adapter.run({ argv, cwd: worktree, interactive: false });
      exitCode = result.code;
      output = result.stdout;
    } catch (error) {
      output = errorText(error);
    }
    const evidence = await inspectRetainedWorktree(this.commandRunner, worktree);
    return receipt(worker, worktree, argv, exitCode, output, {
      disposition: 'retained',
      error: evidence.error,
      cleanupInstruction: `After integrating or preserving the worker commit, run: git worktree remove --force ${JSON.stringify(worktree)}`,
    }, evidence);
  }
}

function validateWorkers(workers: readonly UlwWorkerSpec[]): void {
  if (workers.length === 0 || workers.length > 16) throw new Error('E_ULW_WORKER_COUNT_INVALID');
  const ids = new Set<string>();
  for (const worker of workers) {
    safe(worker.id);
    if (ids.has(worker.id)) throw new Error(`E_ULW_WORKER_ID_CONFLICT:${worker.id}`);
    ids.add(worker.id);
    if (worker.objective.trim() === '' || worker.owned_paths.length === 0) throw new Error('E_ULW_WORKER_INVALID');
  }
  assertExclusivePathClaims(
    workers.map((worker) => ({ ownerId: worker.id, paths: worker.owned_paths })),
    {
      invalid: 'E_ULW_PATH_INVALID',
      conflict: (owner, claimant) => `E_ULW_PATH_CONFLICT:${owner}:${claimant}`,
    },
  );
}

async function inspectRetainedWorktree(runner: CommandRunner, worktree: string): Promise<{ headOid: string | null; dirty: boolean | null; statusSha256: string | null; error: string | null }> {
  try {
    const [head, status] = await Promise.all([
      runner('git', ['rev-parse', 'HEAD'], worktree),
      runner('git', ['status', '--porcelain=v1', '--untracked-files=all'], worktree),
    ]);
    const headOid = head.code === 0 && /^[a-f0-9]{40,64}$/.test(head.stdout.trim()) ? head.stdout.trim() : null;
    const statusText = status.code === 0 ? status.stdout : null;
    const errors = [head.code === 0 ? '' : head.stderr, status.code === 0 ? '' : status.stderr].filter(Boolean).join('; ');
    return { headOid, dirty: statusText === null ? null : statusText.trim() !== '', statusSha256: statusText === null ? null : sha256(statusText), error: errors || null };
  } catch (error) {
    return { headOid: null, dirty: null, statusSha256: null, error: errorText(error) };
  }
}

async function cleanupBeforeInvocation(runner: CommandRunner, repository: string, worktree: string): Promise<{ disposition: 'removed-before-invocation' | 'cleanup-failed'; error: string | null; cleanupInstruction: null }> {
  try {
    const removed = await runner('git', ['worktree', 'remove', '--force', worktree], repository);
    if (removed.code === 0) {
      fs.rmSync(worktree, { recursive: true, force: true });
      return { disposition: 'removed-before-invocation', error: null, cleanupInstruction: null };
    }
    const pruned = await runner('git', ['worktree', 'prune'], repository);
    if (!fs.existsSync(worktree) && pruned.code === 0) return { disposition: 'removed-before-invocation', error: null, cleanupInstruction: null };
    return { disposition: 'cleanup-failed', error: removed.stderr || pruned.stderr || 'pre-invocation cleanup failed', cleanupInstruction: null };
  } catch (error) {
    return { disposition: 'cleanup-failed', error: errorText(error), cleanupInstruction: null };
  }
}

function receipt(worker: UlwWorkerSpec, worktree: string, argv: readonly string[], exitCode: number, output: string, disposition: { disposition: UlwWorkerReceipt['worktree_disposition']; error: string | null; cleanupInstruction: string | null }, evidence: { headOid: string | null; dirty: boolean | null; statusSha256: string | null } | null): UlwWorkerReceipt {
  return { worker_id: worker.id, worktree, owned_paths: worker.owned_paths, argv, exit_code: exitCode, output_sha256: sha256(output), worktree_disposition: disposition.disposition, head_oid: evidence?.headOid ?? null, dirty: evidence?.dirty ?? null, status_sha256: evidence?.statusSha256 ?? null, cleanup_instruction: disposition.cleanupInstruction, disposition_error: disposition.error, verified: false };
}

function removeEmptyBase(base: string): void {
  if (fs.existsSync(base) && fs.readdirSync(base).length === 0) fs.rmdirSync(base);
  const parent = path.dirname(base);
  if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
}
function safe(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error('E_ULW_ID_INVALID'); return value; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
