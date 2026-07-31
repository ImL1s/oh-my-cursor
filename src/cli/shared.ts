import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CursorAgentAdapter } from '../host/cursor-agent.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';
import type { ParsedCommand } from './parser.js';

export interface CliIo { stdout(text: string): void; stderr(text: string): void }
export interface CliContext {
  /** Single schema-validated command value consumed by all typed handlers. */
  readonly parsed: ParsedCommand;
  readonly cwd: string;
  readonly packageRoot: string;
  readonly adapter: CursorAgentAdapter;
  /** Invocation-scoped project state root using the parsed action's read/write policy. */
  readonly root: StateRoot;
  readonly io: CliIo;
  readonly homeDir: string;
}

export function optionValue<T>(context: CliContext, name: string): T | undefined {
  return context.parsed.options[name] as T | undefined;
}

export function requiredOptionValue<T>(context: CliContext, name: string): T {
  const value = optionValue<T>(context, name);
  if (value === undefined) throw new Error(`E_CANONICAL_OPTION_ABSENT: ${name}`);
  return value;
}

export function flagValue(context: CliContext, name: string): boolean {
  return optionValue<boolean>(context, name) === true;
}

export function positionalValue(context: CliContext, index: number): string | undefined {
  return context.parsed.positionals[index];
}

export function printJson(io: CliIo, value: unknown): void { io.stdout(`${JSON.stringify(value, null, 2)}\n`); }
export function readJsonFile(file: string): unknown { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as unknown; }
export function externalStateRoot(homeDir = os.homedir()): string { return path.join(homeDir, '.local', 'state', 'oh-my-cursor'); }
export function workflowDir(root: StateRoot): string { return withinStateRoot(root, 'workflows'); }
export function commandRunner(executable: string, argv: readonly string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...argv], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
