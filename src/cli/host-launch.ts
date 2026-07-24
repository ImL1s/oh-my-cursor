/**
 * OMX/OMG-style host launch for Cursor Agent.
 *
 * - bare `omcu` / `omcu <prompt…>` → interactive cursor-agent (+ --plugin-dir)
 * - `omcu --madmax [args…]` → full-open break-glass (not a mode FSM; never stamps verified)
 * - known orchestration subcommands are never intercepted
 *
 * Launch policy (OMX-aligned):
 * - auto (default): detached tmux then attach when outside tmux; fall back direct if tmux missing
 * - `--tmux`: fail closed if tmux unavailable
 * - `--direct`: never wrap tmux
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertSafeArgv } from '../host/cursor-agent.js';

export const MADMAX_FLAG = '--madmax';
export const DIRECT_FLAG = '--direct';
export const TMUX_FLAG = '--tmux';

/** Closest Cursor surface to OMG/OMX full-open. */
export const CURSOR_OPEN_FLAGS = Object.freeze([
  '--force',
  '--sandbox',
  'disabled',
  '--approve-mcps',
  '--trust',
] as const);

export const KNOWN_OMCU_COMMANDS = Object.freeze(new Set([
  'help', '--help', '-h',
  'version', '--version', '-v',
  'setup', 'update', 'doctor', 'uninstall',
  'capabilities', 'native-status',
  'state', 'run', 'lease', 'cancel', 'session', 'resume', 'recover',
  'compact', 'memory', 'notify', 'tracker', 'wiki',
  'mcp-server', 'mcp-install',
  'workflow', 'ralplan', 'ralph', 'ulw',
  'autopilot', 'pipeline', 'persist', 'team',
  'review', 'qa', 'accept', 'integrate', 'ask',
]));

export type LaunchPolicy = 'auto' | 'tmux' | 'direct';

export class HostLaunchUsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'HostLaunchUsageError';
  }
}

export interface HostLaunchPlan {
  readonly mode: 'interactive' | 'madmax';
  readonly policy: LaunchPolicy;
  readonly argv: readonly string[];
  readonly executable: string;
}

export function hasMadmaxFlag(argv: readonly string[]): boolean {
  return argv.includes(MADMAX_FLAG);
}

export function isPrintMode(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === '-p' || arg === '--print' || arg === '-h' || arg === '--help' || arg === '-v' || arg === '--version') return true;
    if (arg.startsWith('--print=') || arg.startsWith('--output-format')) return true;
  }
  return argv.includes('--output-format');
}

/** True when argv should host-launch instead of the orchestration CLI. */
export function shouldHostLaunch(argv: readonly string[]): boolean {
  if (argv.length === 0) return true;
  if (hasMadmaxFlag(argv)) {
    const idx = argv.indexOf(MADMAX_FLAG);
    const prior = argv.slice(0, idx);
    if (prior.some((token) => KNOWN_OMCU_COMMANDS.has(token))) {
      throw new HostLaunchUsageError(
        `omcu: ${MADMAX_FLAG} is a host launcher and cannot follow a known subcommand `
        + `(got ${prior.find((token) => KNOWN_OMCU_COMMANDS.has(token))})`,
      );
    }
    return true;
  }
  const head = argv[0] ?? '';
  if (KNOWN_OMCU_COMMANDS.has(head)) return false;
  // Unknown first token / prompt → interactive passthrough (OMA/OMX style).
  return true;
}

export function resolveLaunchPolicy(argv: readonly string[]): { policy: LaunchPolicy; rest: string[] } {
  let policy: LaunchPolicy = 'auto';
  const rest: string[] = [];
  for (const arg of argv) {
    if (arg === DIRECT_FLAG) {
      policy = 'direct';
      continue;
    }
    if (arg === TMUX_FLAG) {
      policy = 'tmux';
      continue;
    }
    rest.push(arg);
  }
  return { policy, rest };
}

export function normalizeCursorArgs(argv: readonly string[], options: {
  readonly packageRoot: string;
  readonly madmax: boolean;
}): string[] {
  const { policy: _policy, rest } = resolveLaunchPolicy(argv);
  void _policy;
  const notes: string[] = [];
  const out: string[] = [];
  let sawForce = false;
  let sawSandbox = false;
  let sawApproveMcps = false;
  let sawTrust = false;
  let sawPluginDir = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === MADMAX_FLAG) continue;
    if (arg === '--yolo') {
      // Host-native alias for --force; keep one force token.
      if (!sawForce) {
        out.push('--force');
        sawForce = true;
      } else {
        notes.push('omcu madmax: ignoring duplicate --yolo/--force');
      }
      continue;
    }
    if (arg === '--force' || arg === '-f') {
      if (!sawForce) {
        out.push('--force');
        sawForce = true;
      }
      continue;
    }
    if (arg === '--sandbox') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new HostLaunchUsageError('omcu madmax: --sandbox requires enabled|disabled');
      }
      if (options.madmax && value !== 'disabled') {
        throw new HostLaunchUsageError(
          `omcu madmax: refusing --sandbox ${value} (madmax requires disabled; omit the flag to use the default)`,
        );
      }
      out.push('--sandbox', value);
      sawSandbox = true;
      i += 1;
      continue;
    }
    if (arg.startsWith('--sandbox=')) {
      const value = arg.slice('--sandbox='.length);
      if (options.madmax && value !== 'disabled') {
        throw new HostLaunchUsageError(
          `omcu madmax: refusing --sandbox=${value} (madmax requires disabled)`,
        );
      }
      out.push('--sandbox', value);
      sawSandbox = true;
      continue;
    }
    if (arg === '--approve-mcps') {
      sawApproveMcps = true;
      out.push(arg);
      continue;
    }
    if (arg === '--trust') {
      sawTrust = true;
      out.push(arg);
      continue;
    }
    if (arg === '--plugin-dir') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new HostLaunchUsageError('omcu: --plugin-dir requires a path');
      }
      out.push('--plugin-dir', value);
      sawPluginDir = true;
      i += 1;
      continue;
    }
    if (arg.startsWith('--plugin-dir=')) {
      out.push('--plugin-dir', arg.slice('--plugin-dir='.length));
      sawPluginDir = true;
      continue;
    }
    out.push(arg);
  }

  if (options.madmax) {
    if (!sawForce) out.unshift('--force');
    if (!sawSandbox) {
      // Insert after force so help/banner stay readable.
      const forceAt = out.indexOf('--force');
      out.splice(forceAt + 1, 0, '--sandbox', 'disabled');
    }
    if (!sawApproveMcps) out.push('--approve-mcps');
    if (!sawTrust) out.push('--trust');
  }

  if (!sawPluginDir) {
    out.unshift('--plugin-dir', options.packageRoot);
  }

  assertSafeArgv(out);
  for (const note of notes) process.stderr.write(`${note}\n`);
  return out;
}

export function resolveCursorExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.OMCU_CURSOR_BIN?.trim();
  if (fromEnv) return fromEnv;
  const which = spawnSync('which', ['cursor-agent'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  throw new HostLaunchUsageError(
    'omcu: cursor-agent not on PATH. Install Cursor Agent CLI, then retry.',
  );
}

export function buildHostLaunchPlan(argv: readonly string[], options: {
  readonly packageRoot: string;
  readonly env?: NodeJS.ProcessEnv;
}): HostLaunchPlan {
  const madmax = hasMadmaxFlag(argv);
  const { policy } = resolveLaunchPolicy(argv);
  const normalized = normalizeCursorArgs(argv, { packageRoot: options.packageRoot, madmax });
  return {
    mode: madmax ? 'madmax' : 'interactive',
    policy,
    argv: normalized,
    executable: resolveCursorExecutable(options.env),
  };
}

function insideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TMUX || env.TMUX_PANE);
}

function tmuxAvailable(): boolean {
  return spawnSync('which', ['tmux'], { encoding: 'utf8' }).status === 0;
}

function cwdDigest(cwd: string): string {
  return crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 8);
}

function sessionNameForCwd(cwd: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const nonce = crypto.randomBytes(3).toString('hex');
  return `omcu-${cwdDigest(cwd)}-${stamp}-${nonce}`;
}

function listPreviousSessions(digest: string): string[] {
  if (!tmuxAvailable()) return [];
  const listed = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
  if (listed.status !== 0) return [];
  return listed.stdout.split('\n').map((line) => line.trim()).filter((name) => name.includes(`omcu-${digest}-`));
}

function buildPaneCommand(executable: string, argv: readonly string[]): string {
  const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  return [executable, ...argv].map(shellEscape).join(' ');
}

async function runDirect(plan: HostLaunchPlan, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  assertSafeArgv(plan.argv);
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(plan.executable, [...plan.argv], {
      cwd,
      env,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
}

async function runInTmux(plan: HostLaunchPlan, cwd: string, env: NodeJS.ProcessEnv, required: boolean): Promise<number> {
  if (!tmuxAvailable()) {
    if (required) {
      throw new HostLaunchUsageError(
        'omcu: --tmux requested but tmux is not installed (brew install tmux)',
      );
    }
    process.stderr.write('omcu: tmux unavailable; falling back to direct launch\n');
    return runDirect(plan, cwd, env);
  }
  const digest = cwdDigest(cwd);
  const prev = listPreviousSessions(digest);
  if (prev.length > 0) {
    process.stderr.write(
      `omcu: previous sessions for this directory (tmux attach -t <name>): ${prev.slice(0, 5).join(', ')}`
      + (prev.length > 5 ? ' …' : '')
      + '\n',
    );
  }
  const name = sessionNameForCwd(cwd);
  const pane = buildPaneCommand(plan.executable, plan.argv);
  const create = spawnSync('tmux', ['new-session', '-d', '-s', name, '-c', cwd, pane], {
    encoding: 'utf8',
    env,
  });
  if (create.status !== 0) {
    throw new HostLaunchUsageError(
      `omcu: failed to create tmux session ${JSON.stringify(name)} (exit ${create.status ?? 'unknown'})`,
    );
  }
  spawnSync('tmux', ['set-option', '-t', name, 'mouse', 'on'], { encoding: 'utf8' });
  process.stderr.write(`omcu: attaching tmux session ${name}\n`);
  const attach = spawnSync('tmux', ['attach-session', '-t', name], {
    stdio: 'inherit',
    env,
  });
  return attach.status ?? 1;
}

export async function runHostLaunch(argv: readonly string[], options: {
  readonly cwd: string;
  readonly packageRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stderr?: (text: string) => void;
}): Promise<number> {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? ((text) => process.stderr.write(text));
  if (!fs.existsSync(options.packageRoot)) {
    throw new HostLaunchUsageError(`omcu: package root missing: ${options.packageRoot}`);
  }
  const plan = buildHostLaunchPlan(argv, { packageRoot: options.packageRoot, env });
  const label = plan.mode === 'madmax' ? 'madmax full-open' : 'interactive';
  stderr(`omcu ${label}: cursor-agent ${plan.argv.map(shellQuote).join(' ')}\n`);

  if (isPrintMode(plan.argv) || insideTmux(env) || plan.policy === 'direct') {
    return runDirect(plan, options.cwd, env);
  }
  if (plan.policy === 'tmux') {
    return runInTmux(plan, options.cwd, env, true);
  }
  return runInTmux(plan, options.cwd, env, false);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
