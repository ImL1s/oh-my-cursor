import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

/** Stable-enough process identity material for local lock and lease fencing. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly start_identity: string;
  readonly start_identity_proven: boolean;
  /** Per-acquisition proof material. Persist only its SHA-256 digest. */
  readonly nonce: string;
}

export interface ProcessStartIdentityObservation {
  readonly value: string;
  readonly proven: boolean;
  readonly source: 'linux-proc' | 'darwin-ps' | 'unsupported' | 'unavailable';
}

export type ProcessLiveness =
  | { readonly status: 'active' }
  | { readonly status: 'dead' }
  | { readonly status: 'stale' }
  | { readonly status: 'ambiguous'; readonly reason: string };

export type ProcessExistence =
  | { readonly status: 'alive' }
  | { readonly status: 'dead' }
  | { readonly status: 'ambiguous'; readonly reason: string };

export interface ProcessIdentityRuntime {
  readonly platform: NodeJS.Platform;
  readonly readFile: (file: string) => string;
  readonly execFile: (file: string, args: readonly string[]) => string;
  readonly probePid: (pid: number) => ProcessExistence;
}

const runtime: ProcessIdentityRuntime = {
  platform: process.platform,
  readFile: (file) => fs.readFileSync(file, 'utf8'),
  execFile: (file, args) => execFileSync(file, args, {
    encoding: 'utf8',
    timeout: 500,
    stdio: ['ignore', 'pipe', 'ignore'],
  }),
  probePid: probeProcess,
};

let cachedStartIdentity: ProcessStartIdentityObservation | null = null;

export function processNonceSha256(nonce: string): string {
  if (!/^[A-Fa-f0-9]{32,256}$/.test(nonce)) throw new Error('E_PROCESS_NONCE_INVALID');
  return crypto.createHash('sha256').update(nonce).digest('hex');
}

export function observeStartIdentity(
  pid: number,
  source: ProcessIdentityRuntime = runtime,
): ProcessStartIdentityObservation {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { value: `unavailable:${pid}`, proven: false, source: 'unavailable' };
  }
  if (source.platform === 'linux') {
    try {
      const stat = source.readFile(`/proc/${pid}/stat`);
      const close = stat.lastIndexOf(')');
      if (close < 0) throw new Error('invalid stat');
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      // /proc/<pid>/stat field 22; fields starts at field 3 after stripping comm.
      const startTime = fields[19];
      if (startTime === undefined || !/^\d+$/.test(startTime)) throw new Error('invalid starttime');
      let bootId: string;
      try {
        bootId = source.readFile('/proc/sys/kernel/random/boot_id').trim();
        if (!bootId) throw new Error('empty boot id');
      } catch {
        return { value: `linux:unproven-boot:${startTime}`, proven: false, source: 'unavailable' };
      }
      return { value: `linux:${bootId}:${startTime}`, proven: true, source: 'linux-proc' };
    } catch {
      return { value: `unavailable:${pid}`, proven: false, source: 'unavailable' };
    }
  }
  if (source.platform === 'darwin') {
    try {
      const started = source.execFile('ps', ['-p', String(pid), '-o', 'lstart=']).trim();
      if (!started) throw new Error('empty start time');
      return { value: `darwin:${started}`, proven: true, source: 'darwin-ps' };
    } catch {
      return { value: `unavailable:${pid}`, proven: false, source: 'unavailable' };
    }
  }
  return { value: `unsupported:${source.platform}:${pid}`, proven: false, source: 'unsupported' };
}

export function currentProcessIdentity(source: ProcessIdentityRuntime = runtime): ProcessIdentity {
  if (source === runtime && cachedStartIdentity !== null) {
    return identityFromObservation(process.pid, cachedStartIdentity);
  }
  const observation = observeStartIdentity(process.pid, source);
  if (source === runtime) cachedStartIdentity = observation;
  return identityFromObservation(process.pid, observation);
}

function identityFromObservation(pid: number, observation: ProcessStartIdentityObservation): ProcessIdentity {
  return {
    pid,
    start_identity: observation.value,
    start_identity_proven: observation.proven,
    nonce: crypto.randomBytes(32).toString('hex'),
  };
}

export function processAlive(pid: number): boolean {
  // Boolean compatibility is deliberately fail-closed: only proven ESRCH is
  // false; callers needing the distinction must use probeProcess().
  return probeProcess(pid).status !== 'dead';
}

export function probeProcess(pid: number, signal: (pid: number) => void = (target) => process.kill(target, 0)): ProcessExistence {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'dead' };
  try {
    signal(pid);
    return { status: 'alive' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { status: 'dead' };
    if (code === 'EPERM') return { status: 'alive' };
    return { status: 'ambiguous', reason: code === undefined ? 'process_probe_failed' : `process_probe_${code.toLowerCase()}` };
  }
}

/**
 * PID-only success never proves ownership. A live PID is active only when the
 * recorded and observed stable start identities are both proven and equal.
 */
export function classifyProcessLiveness(
  recorded: Pick<ProcessIdentity, 'pid' | 'start_identity' | 'start_identity_proven'>,
  source: ProcessIdentityRuntime = runtime,
): ProcessLiveness {
  const existence = source.probePid(recorded.pid);
  if (existence.status === 'dead') return { status: 'dead' };
  if (existence.status === 'ambiguous') return existence;
  const observed = observeStartIdentity(recorded.pid, source);
  if (!recorded.start_identity_proven || !observed.proven) {
    return {
      status: 'ambiguous',
      reason: observed.source === 'unsupported' ? 'platform_identity_unsupported' : 'start_identity_unproven',
    };
  }
  if (recorded.start_identity !== observed.value) return { status: 'stale' };
  return { status: 'active' };
}
