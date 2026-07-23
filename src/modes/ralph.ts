import { buildPrintArgv } from '../host/cursor-agent.js';
import { sha256 } from '../workflows/schema.js';
import type { ModeContext } from './types.js';

export interface RalphIterationReceipt { readonly iteration: number; readonly argv: readonly string[]; readonly exit_code: number; readonly output: unknown; readonly output_sha256: string }
export interface RalphResult { readonly status: 'complete' | 'exhausted' | 'failed'; readonly receipts: readonly RalphIterationReceipt[]; readonly verified: false; readonly verification_authority: 'omcu-cli-only' }
export type RalphCompletion = (output: unknown) => boolean;

export async function runRalph(context: ModeContext, objective: string, options: { readonly maxIterations?: number; readonly complete?: RalphCompletion } = {}): Promise<RalphResult> {
  const maxIterations = options.maxIterations ?? 5;
  if (objective.trim() === '' || !Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 100) throw new Error('E_RALPH_INPUT_INVALID');
  const complete = options.complete ?? defaultCompletion;
  const receipts: RalphIterationReceipt[] = [];
  let previous = '';
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const prompt = [`Persistent execution loop ${iteration}/${maxIterations}.`, `Objective: ${objective}`, 'Continue from current repository truth. Run targeted verification. Return JSON with complete boolean and evidence.', previous].filter(Boolean).join('\n\n');
    const argv = buildPrintArgv(prompt, { format: 'json', mode: 'ask' });
    const result = await context.adapter.run({ argv, cwd: context.cwd, interactive: false });
    const output = result.json ?? result.stdout;
    receipts.push({ iteration, argv, exit_code: result.code, output, output_sha256: sha256(result.stdout) });
    if (result.code !== 0) return terminal('failed', receipts);
    if (complete(output)) return terminal('complete', receipts);
    previous = `Previous iteration: ${JSON.stringify(output)}`;
  }
  return terminal('exhausted', receipts);
}

function defaultCompletion(output: unknown): boolean { return output !== null && typeof output === 'object' && (output as Record<string, unknown>).complete === true; }
function terminal(status: RalphResult['status'], receipts: readonly RalphIterationReceipt[]): RalphResult { return { status, receipts, verified: false, verification_authority: 'omcu-cli-only' }; }
