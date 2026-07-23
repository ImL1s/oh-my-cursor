import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { parseCursorJsonOutput } from './json-output.js';
import { redactText } from '../runtime/redaction.js';

export type CursorOutputFormat = 'text' | 'json' | 'stream-json';
export interface CursorInvocation { readonly argv: readonly string[]; readonly cwd: string; readonly interactive: boolean }
export interface CursorResult { readonly code: number; readonly stdout: string; readonly stderr: string; readonly raw_stdout_sha256?: string; readonly raw_stderr_sha256?: string; readonly json?: unknown }
export interface RunOptions { readonly timeoutMs?: number; readonly maxOutputBytes?: number; readonly env?: NodeJS.ProcessEnv }
export type CursorRunner = (executable: string, invocation: CursorInvocation, options?: RunOptions) => Promise<CursorResult>;

const MAX_ARG_COUNT = 256;
const MAX_ARG_BYTES = 32 * 1024;
const TERMINATION_GRACE_MS = 1_000;
const TERMINATION_POLL_MS = 20;

export function assertSafeArgv(argv: readonly string[]): void {
  if (argv.length > MAX_ARG_COUNT) throw new Error('E_ARGV_TOO_MANY');
  let bytes = 0;
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.includes('\0')) throw new Error('E_ARGV_INVALID');
    bytes += Buffer.byteLength(arg, 'utf8');
  }
  if (bytes > MAX_ARG_BYTES) throw new Error('E_ARGV_TOO_LARGE');
}

export function buildPrintArgv(prompt: string, options: { readonly format?: CursorOutputFormat; readonly mode?: 'plan' | 'ask'; readonly model?: string; readonly resume?: string; readonly continue?: boolean } = {}): string[] {
  if (options.resume !== undefined && options.continue === true) throw new Error('E_SESSION_ROUTE_CONFLICT');
  const argv = ['--print', '--output-format', options.format ?? 'json'];
  if (options.mode !== undefined) argv.push('--mode', options.mode);
  if (options.model !== undefined) argv.push('--model', options.model);
  if (options.resume !== undefined) argv.push('--resume', validateSessionId(options.resume));
  if (options.continue === true) argv.push('--continue');
  argv.push(prompt);
  assertSafeArgv(argv);
  return argv;
}

export function validateSessionId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) throw new Error('E_SESSION_ID_INVALID');
  return value;
}

function processGroupAlive(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForProcessGroupExit(processGroupId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupAlive(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, TERMINATION_POLL_MS));
  }
  return true;
}

async function terminateProcessGroup(processGroupId: number): Promise<void> {
  signalProcessGroup(processGroupId, 'SIGTERM');
  if (await waitForProcessGroupExit(processGroupId, TERMINATION_GRACE_MS)) return;
  signalProcessGroup(processGroupId, 'SIGKILL');
  if (!await waitForProcessGroupExit(processGroupId, TERMINATION_GRACE_MS)) {
    throw new Error('E_CURSOR_PROCESS_GROUP_STUCK');
  }
}

export const defaultCursorRunner: CursorRunner = (executable, invocation, options = {}) => new Promise((resolve, reject) => {
  assertSafeArgv(invocation.argv);
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  const ownsProcessGroup = !invocation.interactive && process.platform !== 'win32';
  const child = spawn(executable, [...invocation.argv], {
    cwd: invocation.cwd,
    env: options.env ?? process.env,
    shell: false,
    stdio: invocation.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    detached: ownsProcessGroup,
  });
  let terminalFailure: Error | null = null;
  let forceTimer: NodeJS.Timeout | undefined;
  let groupTermination: Promise<void> | null = null;
  const terminate = (failure: Error): void => {
    if (terminalFailure !== null) return;
    terminalFailure = failure;
    if (ownsProcessGroup && child.pid !== undefined) {
      groupTermination = terminateProcessGroup(child.pid);
      void groupTermination.catch(() => undefined);
    } else {
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => child.kill('SIGKILL'), TERMINATION_GRACE_MS);
    }
  };
  const timeoutMs = options.timeoutMs ?? (invocation.interactive ? undefined : 120_000);
  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => terminate(new Error('E_CURSOR_TIMEOUT')), timeoutMs);
  if (invocation.interactive) {
    child.once('error', (error) => {
      if (timer !== undefined) clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      reject(terminalFailure ?? error);
    });
    child.once('close', (code) => {
      if (timer !== undefined) clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (terminalFailure !== null) reject(terminalFailure);
      else resolve({ code: code ?? 1, stdout: '', stderr: '' });
    });
    return;
  }
  let stdout: Buffer = Buffer.alloc(0);
  let stderr: Buffer = Buffer.alloc(0);
  let overflow = false;
  const append = (current: Buffer, chunk: Buffer): Buffer => {
    if (overflow) return current;
    if (current.length + chunk.length > maxOutputBytes) {
      overflow = true;
      terminate(new Error('E_OUTPUT_TOO_LARGE'));
      return Buffer.concat([current, chunk]).subarray(0, maxOutputBytes);
    }
    return Buffer.concat([current, chunk]);
  };
  child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
  child.once('error', async (error) => {
    if (timer !== undefined) clearTimeout(timer);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    try {
      if (groupTermination !== null) await groupTermination;
      reject(terminalFailure ?? error);
    } catch (terminationError) {
      reject(terminationError);
    }
  });
  child.once('close', async (code) => {
    if (timer !== undefined) clearTimeout(timer);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
    if (terminalFailure !== null) {
      try {
        if (groupTermination !== null) await groupTermination;
        return reject(terminalFailure);
      } catch (terminationError) {
        return reject(terminationError);
      }
    }
    if (overflow) return reject(new Error('E_OUTPUT_TOO_LARGE'));
    resolve({
      code: code ?? 1,
      stdout: stdout.toString('utf8'),
      stderr: redactText(stderr.toString('utf8')),
      raw_stdout_sha256: crypto.createHash('sha256').update(stdout).digest('hex'),
      raw_stderr_sha256: crypto.createHash('sha256').update(stderr).digest('hex'),
    });
  });
});

export class CursorAgentAdapter {
  constructor(readonly executable = 'cursor-agent', private readonly runner: CursorRunner = defaultCursorRunner) {}

  async run(invocation: CursorInvocation, options?: RunOptions): Promise<CursorResult> {
    const result = await this.runner(this.executable, invocation, options);
    const formatIndex = invocation.argv.indexOf('--output-format');
    const format = formatIndex >= 0 ? invocation.argv[formatIndex + 1] : undefined;
    if (result.code === 0 && (format === 'json' || format === 'stream-json')) {
      return { ...result, json: parseCursorJsonOutput(result.stdout) };
    }
    return result;
  }
}
