import { buildPrintArgv } from '../host/cursor-agent.js';
import { sha256 } from '../workflows/schema.js';
import type { ModeContext } from './types.js';

export type RalplanRole = 'planner' | 'architect' | 'critic';
export interface RalplanLaneReceipt {
  readonly role: RalplanRole;
  readonly round: number;
  readonly argv: readonly string[];
  readonly exit_code: number;
  readonly output: unknown;
  readonly output_sha256: string;
  readonly read_only: true;
}
export interface RalplanResult {
  readonly status: 'accepted' | 'revision_required' | 'failed';
  readonly rounds: number;
  readonly receipts: readonly RalplanLaneReceipt[];
  readonly verified: false;
  readonly verification_authority: 'omcu-cli-only';
}

export async function runRalplan(context: ModeContext, objective: string, maxRounds = 3): Promise<RalplanResult> {
  if (objective.trim() === '' || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 10) throw new Error('E_RALPLAN_INPUT_INVALID');
  const receipts: RalplanLaneReceipt[] = [];
  let prior = '';
  for (let round = 1; round <= maxRounds; round += 1) {
    for (const role of ['planner', 'architect', 'critic'] as const) {
      const prompt = rolePrompt(role, objective, prior, round);
      const argv = buildPrintArgv(prompt, { format: 'json', mode: 'plan' });
      const result = await context.adapter.run({ argv, cwd: context.cwd, interactive: false });
      const output = result.json ?? result.stdout;
      receipts.push({ role, round, argv, exit_code: result.code, output, output_sha256: sha256(result.stdout), read_only: true });
      if (result.code !== 0) return terminal('failed', round, receipts);
      prior += `\n${role}: ${JSON.stringify(output)}`;
    }
    if (criticApproves(receipts.at(-1)?.output)) return terminal('accepted', round, receipts);
  }
  return terminal('revision_required', maxRounds, receipts);
}

function rolePrompt(role: RalplanRole, objective: string, prior: string, round: number): string {
  const instructions = role === 'planner'
    ? 'Produce a concrete implementation plan and acceptance criteria.'
    : role === 'architect'
      ? 'Review the plan architecture and synthesize necessary corrections.'
      : 'Adversarially review the complete proposal. Return JSON with verdict APPROVE or REQUEST_CHANGES.';
  return [`RALPLAN read-only lane. You MUST NOT edit files or implement code.`, `Role: ${role}. Round: ${round}.`, `Objective: ${objective}`, instructions, prior ? `Prior lane outputs:${prior}` : ''].filter(Boolean).join('\n\n');
}

function criticApproves(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.verdict === 'APPROVE' || (record.result !== null && typeof record.result === 'object' && (record.result as Record<string, unknown>).verdict === 'APPROVE');
}

function terminal(status: RalplanResult['status'], rounds: number, receipts: readonly RalplanLaneReceipt[]): RalplanResult {
  return { status, rounds, receipts, verified: false, verification_authority: 'omcu-cli-only' };
}
