import { describe, expect, it } from 'vitest';
import {
  classifyProcessLiveness,
  observeStartIdentity,
  probeProcess,
  processNonceSha256,
  type ProcessIdentityRuntime,
} from '../../src/runtime/process-identity.js';

function runtime(overrides: Partial<ProcessIdentityRuntime>): ProcessIdentityRuntime {
  return {
    platform: 'linux',
    readFile: () => { throw new Error('missing'); },
    execFile: () => { throw new Error('missing'); },
    probePid: () => ({ status: 'alive' }),
    ...overrides,
  };
}

describe('portable process identity', () => {
  it('parses Linux start time with boot identity', () => {
    const stat = `123 (name with spaces) ${['S', ...Array(18).fill('0'), '777'].join(' ')}`;
    const observed = observeStartIdentity(123, runtime({
      readFile: (file) => file.endsWith('/stat') ? stat : 'boot-abc\n',
    }));
    expect(observed).toEqual({ value: 'linux:boot-abc:777', proven: true, source: 'linux-proc' });
  });

  it('uses the macOS ps start marker without a shell', () => {
    const observed = observeStartIdentity(456, runtime({
      platform: 'darwin',
      execFile: (file, args) => {
        expect([file, ...args]).toEqual(['ps', '-p', '456', '-o', 'lstart=']);
        return 'Wed Jul 23 10:11:12 2026\n';
      },
    }));
    expect(observed).toEqual({ value: 'darwin:Wed Jul 23 10:11:12 2026', proven: true, source: 'darwin-ps' });
  });

  it('reports unsupported platforms explicitly and fails closed', () => {
    const source = runtime({ platform: 'win32' });
    expect(observeStartIdentity(789, source)).toEqual({ value: 'unsupported:win32:789', proven: false, source: 'unsupported' });
    expect(classifyProcessLiveness({ pid: 789, start_identity: 'anything', start_identity_proven: true }, source)).toEqual({ status: 'ambiguous', reason: 'platform_identity_unsupported' });
  });

  it('distinguishes dead, stale, active, and ambiguous owners', () => {
    expect(classifyProcessLiveness({ pid: 1, start_identity: 'x', start_identity_proven: true }, runtime({ probePid: () => ({ status: 'dead' }) }))).toEqual({ status: 'dead' });
    const linux = runtime({ readFile: (file) => file.endsWith('/stat') ? `2 (p) ${['S', ...Array(18).fill('0'), '88'].join(' ')}` : 'boot' });
    expect(classifyProcessLiveness({ pid: 2, start_identity: 'linux:boot:77', start_identity_proven: true }, linux)).toEqual({ status: 'stale' });
    expect(classifyProcessLiveness({ pid: 2, start_identity: 'linux:boot:88', start_identity_proven: true }, linux)).toEqual({ status: 'active' });
    expect(classifyProcessLiveness({ pid: 2, start_identity: 'local-only', start_identity_proven: false }, linux)).toEqual({ status: 'ambiguous', reason: 'start_identity_unproven' });
  });

  it('hashes only high-entropy nonce material', () => {
    expect(processNonceSha256('a'.repeat(64))).toMatch(/^[a-f0-9]{64}$/);
    expect(() => processNonceSha256('predictable')).toThrow('E_PROCESS_NONCE_INVALID');
  });

  it('classifies ESRCH as dead, EPERM as alive, and unexpected probe errors as ambiguous', () => {
    const throwing = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
    expect(probeProcess(123, throwing('ESRCH'))).toEqual({ status: 'dead' });
    expect(probeProcess(123, throwing('EPERM'))).toEqual({ status: 'alive' });
    expect(probeProcess(123, throwing('EIO'))).toEqual({ status: 'ambiguous', reason: 'process_probe_eio' });
  });

  it('does not prove Linux identity when boot identity is unavailable', () => {
    const observed = observeStartIdentity(123, runtime({
      readFile: (file) => {
        if (file.endsWith('/stat')) return `123 (p) ${['S', ...Array(18).fill('0'), '777'].join(' ')}`;
        throw new Error('boot id unavailable');
      },
    }));
    expect(observed).toEqual({ value: 'linux:unproven-boot:777', proven: false, source: 'unavailable' });
  });
});
