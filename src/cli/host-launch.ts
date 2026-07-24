/**
 * OMX/Sol-aligned host launch for Cursor Agent.
 *
 * Case IDs: GRAM-01..05, POL-01..05, LIFE-01, SAFE-01, OBS-01
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSafeArgv } from '../host/cursor-agent.js';

export const MADMAX_FLAG = '--madmax';
export const DIRECT_FLAG = '--direct';
export const TMUX_FLAG = '--tmux';
export const END_OF_OPTIONS = '--';
export const LAUNCHER_ONLY_FLAGS = Object.freeze(new Set([MADMAX_FLAG, DIRECT_FLAG, TMUX_FLAG]));

/** Sol mapping: madmax → --yolo --sandbox disabled (--force is accepted as alias). */
export const CURSOR_OPEN_FLAGS = Object.freeze(['--yolo', '--sandbox', 'disabled'] as const);

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
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'HostLaunchUsageError';
    this.exitCode = exitCode;
  }
}

export interface HostLaunchPlan {
  readonly mode: 'interactive' | 'madmax';
  readonly policy: LaunchPolicy;
  readonly argv: readonly string[];
  readonly executable: string;
}

export function splitAtEndOfOptions(argv: readonly string[]): {
  readonly head: readonly string[];
  readonly suffix: readonly string[];
} {
  const idx = argv.indexOf(END_OF_OPTIONS);
  if (idx < 0) return { head: [...argv], suffix: [] };
  return { head: argv.slice(0, idx), suffix: argv.slice(idx) }; // keeps leading `--`
}

export function hasMadmaxFlag(argv: readonly string[]): boolean {
  const { head } = splitAtEndOfOptions(argv);
  return head.includes(MADMAX_FLAG);
}

export function isPrintMode(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === END_OF_OPTIONS) break;
    if (arg === '-p' || arg === '--print' || arg === '-h' || arg === '--help' || arg === '-v' || arg === '--version') return true;
    if (arg.startsWith('--print=') || arg.startsWith('--output-format')) return true;
  }
  return false;
}

/** GRAM-05: launcher-only flags after a recognized first token → usage/2. */
export function rejectLauncherFlagsAfterSubcommand(argv: readonly string[]): void {
  const { head } = splitAtEndOfOptions(argv);
  if (head.length === 0) return;
  const first = head[0] ?? '';
  if (!KNOWN_OMCU_COMMANDS.has(first)) return;
  for (const tok of head.slice(1)) {
    if (LAUNCHER_ONLY_FLAGS.has(tok)) {
      throw new HostLaunchUsageError(
        `omcu: E_LAUNCH_USAGE — ${tok} is a host launcher flag and cannot follow command ${JSON.stringify(first)}`,
      );
    }
  }
}

/** True when argv should host-launch instead of the orchestration CLI. */
export function shouldHostLaunch(argv: readonly string[]): boolean {
  rejectLauncherFlagsAfterSubcommand(argv);
  if (argv.length === 0) return true;
  const { head } = splitAtEndOfOptions(argv);
  if (hasMadmaxFlag(argv)) {
    // GRAM-05: only a recognized *first* token owns the line.
    return true;
  }
  const first = head[0] ?? '';
  if (KNOWN_OMCU_COMMANDS.has(first)) return false;
  if (first === DIRECT_FLAG || first === TMUX_FLAG) return true;
  return true;
}

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): LaunchPolicy | undefined {
  const raw = env.OMCU_LAUNCH_POLICY?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === 'auto') return 'auto';
  if (raw === 'direct') return 'direct';
  if (raw === 'tmux' || raw === 'detached-tmux') return 'tmux';
  throw new HostLaunchUsageError(
    `omcu: invalid OMCU_LAUNCH_POLICY=${JSON.stringify(raw)} (expected auto|direct|tmux|detached-tmux)`,
  );
}

/** Consume --direct/--tmux before `--`; last flag wins; env is the default. */
export function resolveLaunchPolicy(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { policy: LaunchPolicy; rest: string[]; suffix: readonly string[] } {
  const { head, suffix } = splitAtEndOfOptions(argv);
  let policy: LaunchPolicy = policyFromEnv(env) ?? 'auto';
  const rest: string[] = [];
  for (const arg of head) {
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
  return { policy, rest, suffix };
}

export function normalizeCursorArgs(argv: readonly string[], options: {
  readonly packageRoot: string;
  readonly madmax: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): string[] {
  const { rest, suffix } = resolveLaunchPolicy(argv, options.env);
  const notes: string[] = [];
  const out: string[] = [];
  let sawYoloOrForce = false;
  let sawSandbox = false;
  let sawPluginDir = false;

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === MADMAX_FLAG) continue;
    if (arg === '--yolo') {
      if (!sawYoloOrForce) {
        out.push('--yolo');
        sawYoloOrForce = true;
      } else {
        notes.push('omcu madmax: ignoring duplicate --yolo/--force');
      }
      continue;
    }
    if (arg === '--force' || arg === '-f') {
      // Accept as alias; canonicalize to --yolo for Sol mapping honesty.
      if (!sawYoloOrForce) {
        out.push('--yolo');
        sawYoloOrForce = true;
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
    if (arg === '--approve-mcps' || arg === '--trust') {
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
    if (!sawYoloOrForce) out.unshift('--yolo');
    if (!sawSandbox) {
      const yoloAt = out.indexOf('--yolo');
      out.splice(yoloAt + 1, 0, '--sandbox', 'disabled');
    }
  }

  if (!sawPluginDir) {
    out.unshift('--plugin-dir', options.packageRoot);
  }

  // Suffix after `--` is opaque and must not be re-scanned.
  out.push(...suffix);

  assertSafeArgv(out);
  for (const note of notes) process.stderr.write(`${note}\n`);
  return out;
}

export function resolveCursorExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.OMCU_CURSOR_BIN?.trim();
  if (fromEnv) {
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(fromEnv)) {
      throw new HostLaunchUsageError(
        'omcu: OMCU_CURSOR_BIN must point to a native .exe (not a .cmd/.bat shim)',
        127,
      );
    }
    return fromEnv;
  }
  const pathEnv = env.PATH ?? '';
  // Windows: only native .exe / extensionless — never .cmd/.bat (OBS-01 argv safety).
  const exts = process.platform === 'win32' ? ['.EXE', '.exe', ''] : [''];
  const seen = new Set<string>();
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `cursor-agent${ext}`);
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // continue
      }
    }
  }
  throw new HostLaunchUsageError(
    process.platform === 'win32'
      ? 'omcu: cursor-agent.exe not on PATH (set OMCU_CURSOR_BIN to a native .exe; .cmd shims are not supported).'
      : 'omcu: cursor-agent not on PATH. Install Cursor Agent CLI, then retry.',
    127,
  );
}

export function buildHostLaunchPlan(argv: readonly string[], options: {
  readonly packageRoot: string;
  readonly env?: NodeJS.ProcessEnv;
}): HostLaunchPlan {
  const env = options.env ?? process.env;
  const madmax = hasMadmaxFlag(argv);
  const { policy } = resolveLaunchPolicy(argv, env);
  const normalized = normalizeCursorArgs(argv, { packageRoot: options.packageRoot, madmax, env });
  return {
    mode: madmax ? 'madmax' : 'interactive',
    policy,
    argv: normalized,
    executable: resolveCursorExecutable(env),
  };
}

function insideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TMUX || env.TMUX_PANE);
}

function tmuxAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const pathEnv = env.PATH ?? '';
  const exts = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, `tmux${ext}`), fs.constants.X_OK);
        return true;
      } catch {
        // continue
      }
    }
  }
  return false;
}

function isInteractiveTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
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

function buildPaneCommand(executable: string, argv: readonly string[], exitFile: string): string {
  const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  const body = [
    [executable, ...argv].map(shellEscape).join(' '),
    'ec=$?',
    `printf '%s' "$ec" > ${shellEscape(exitFile)}`,
    'exit "$ec"',
  ].join('; ');
  const shell = process.env.SHELL || '/bin/zsh';
  return `exec ${shellEscape(shell)} -lc ${shellEscape(body)}`;
}

async function runDirect(plan: HostLaunchPlan, cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  assertSafeArgv(plan.argv);
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(plan.executable)) {
    throw new HostLaunchUsageError(
      'omcu: Windows host launch requires a native .exe (set OMCU_CURSOR_BIN); .cmd/.bat shims are not argv-safe',
      127,
    );
  }
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(plan.executable, [...plan.argv], {
      cwd,
      env,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') resolve(127);
      else reject(error);
    });
    child.once('close', (code) => resolve(code ?? 1));
  });
}

async function runInTmux(
  plan: HostLaunchPlan,
  cwd: string,
  env: NodeJS.ProcessEnv,
  required: boolean,
  stderr: (text: string) => void,
): Promise<number> {
  if (!tmuxAvailable(env)) {
    if (required) {
      throw new HostLaunchUsageError(
        'omcu: E_LAUNCH_TMUX_UNAVAILABLE — tmux requested but not installed (brew install tmux)',
        1,
      );
    }
    stderr('omcu: tmux unavailable; falling back to direct launch\n');
    return runDirect(plan, cwd, env);
  }
  if (required && !isInteractiveTty() && !insideTmux(env)) {
    throw new HostLaunchUsageError(
      'omcu: E_LAUNCH_TTY_REQUIRED — explicit --tmux needs a TTY outside an existing tmux session',
      1,
    );
  }
  const digest = cwdDigest(cwd);
  const prev = listPreviousSessions(digest);
  if (prev.length > 0) {
    stderr(
      `omcu: previous sessions for this directory (tmux attach -t <name>): ${prev.slice(0, 5).join(', ')}`
      + (prev.length > 5 ? ' …' : '')
      + '\n',
    );
  }
  const name = sessionNameForCwd(cwd);
  const exitFile = path.join(os.tmpdir(), `omcu-host-exit-${process.pid}-${name}.code`);
  try { fs.unlinkSync(exitFile); } catch { /* ignore */ }
  const pane = buildPaneCommand(plan.executable, plan.argv, exitFile);
  const create = spawnSync('tmux', ['new-session', '-d', '-s', name, '-c', cwd, pane], {
    encoding: 'utf8',
    env,
  });
  if (create.status !== 0) {
    throw new HostLaunchUsageError(
      `omcu: failed to create tmux session ${JSON.stringify(name)} (exit ${create.status ?? 'unknown'})`,
      1,
    );
  }
  spawnSync('tmux', ['set-option', '-t', name, 'mouse', 'on'], { encoding: 'utf8' });
  stderr(`omcu: created detached session ${name}; attaching (reattach: tmux attach -t ${name})\n`);
  const attach = spawnSync('tmux', ['attach-session', '-t', name], {
    stdio: 'inherit',
    env,
  });
  const attachRc = attach.status ?? 1;
  let hostRc: number | undefined;
  try {
    const raw = fs.readFileSync(exitFile, 'utf8').trim();
    const code = Number.parseInt(raw, 10);
    if (Number.isFinite(code)) hostRc = code;
  } catch { /* ignore */ }
  if (attachRc !== 0) {
    if (hostRc !== undefined && hostRc !== 0) return hostRc;
    return attachRc;
  }
  if (hostRc !== undefined) return hostRc;
  const stillAlive = spawnSync('tmux', ['has-session', '-t', name], { encoding: 'utf8' }).status === 0;
  if (stillAlive) return attachRc;
  return 1;
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
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(plan.executable)) {
    throw new HostLaunchUsageError(
      'omcu: Windows host launch requires a native .exe (set OMCU_CURSOR_BIN); .cmd/.bat shims are not argv-safe',
      127,
    );
  }
  const label = plan.mode === 'madmax'
    ? 'madmax (--yolo --sandbox disabled; deny rules + MCP/trust remain separate)'
    : 'interactive';
  stderr(`omcu ${label}: cursor-agent ${plan.argv.map(shellQuote).join(' ')}\n`);

  // POL-02: inside tmux always direct. POL-05: explicit tmux before print shortcuts.
  if (insideTmux(env) || plan.policy === 'direct') {
    return runDirect(plan, options.cwd, env);
  }
  if (plan.policy === 'auto' && process.platform === 'win32') {
    return runDirect(plan, options.cwd, env);
  }
  if (plan.policy === 'tmux') {
    return runInTmux(plan, options.cwd, env, true, stderr);
  }
  if (isPrintMode(plan.argv) || (plan.policy === 'auto' && !isInteractiveTty())) {
    return runDirect(plan, options.cwd, env);
  }
  return runInTmux(plan, options.cwd, env, false, stderr);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
