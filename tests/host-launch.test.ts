import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HostLaunchUsageError,
  buildHostLaunchPlan,
  hasMadmaxFlag,
  normalizeCursorArgs,
  resolveLaunchPolicy,
  runHostLaunch,
  shouldHostLaunch,
  splitAtEndOfOptions,
} from '../src/cli/host-launch.js';

describe('OMCU host launch contract', () => {
  it('routes bare argv and prompts to host launch; keeps known commands', () => {
    expect(shouldHostLaunch([])).toBe(true);
    expect(shouldHostLaunch(['fix the tests'])).toBe(true);
    expect(shouldHostLaunch(['--madmax'])).toBe(true);
    expect(shouldHostLaunch(['--madmax', 'ship it'])).toBe(true);
    expect(shouldHostLaunch(['doctor'])).toBe(false);
    expect(shouldHostLaunch(['session', 'list'])).toBe(false);
    expect(shouldHostLaunch(['--help'])).toBe(false);
    expect(() => shouldHostLaunch(['ralph', '--madmax'])).toThrow(HostLaunchUsageError);
    expect(() => shouldHostLaunch(['doctor', '--direct'])).toThrow(/E_LAUNCH_USAGE/);
  });

  it('keeps suffix after -- opaque (GRAM-04)', () => {
    expect(splitAtEndOfOptions(['--madmax', '--', '--sandbox', 'enabled'])).toEqual({
      head: ['--madmax'],
      suffix: ['--', '--sandbox', 'enabled'],
    });
    expect(normalizeCursorArgs(['--madmax', '--', '--sandbox', 'enabled'], { packageRoot: '/pkg', madmax: true }))
      .toEqual([
        '--plugin-dir', '/pkg',
        '--yolo',
        '--sandbox', 'disabled',
        '--', '--sandbox', 'enabled',
      ]);
  });

  it('resolves launch policy flags and env; last CLI flag wins', () => {
    expect(resolveLaunchPolicy(['--direct', 'hello'])).toEqual({
      policy: 'direct', rest: ['hello'], suffix: [],
    });
    expect(resolveLaunchPolicy(['--tmux', '--madmax'])).toEqual({
      policy: 'tmux', rest: ['--madmax'], suffix: [],
    });
    expect(resolveLaunchPolicy(['--tmux', '--direct', 'x'])).toEqual({
      policy: 'direct', rest: ['x'], suffix: [],
    });
    expect(resolveLaunchPolicy(['hello'], { OMCU_LAUNCH_POLICY: 'tmux' })).toEqual({
      policy: 'tmux', rest: ['hello'], suffix: [],
    });
    expect(resolveLaunchPolicy(['--direct'], { OMCU_LAUNCH_POLICY: 'tmux' })).toEqual({
      policy: 'direct', rest: [], suffix: [],
    });
  });

  it('injects plugin-dir for interactive and yolo+sandbox for madmax', () => {
    expect(normalizeCursorArgs([], { packageRoot: '/pkg', madmax: false })).toEqual([
      '--plugin-dir', '/pkg',
    ]);
    expect(normalizeCursorArgs(['ship'], { packageRoot: '/pkg', madmax: false })).toEqual([
      '--plugin-dir', '/pkg', 'ship',
    ]);
    expect(normalizeCursorArgs(['--madmax', 'ship'], { packageRoot: '/pkg', madmax: true })).toEqual([
      '--plugin-dir', '/pkg',
      '--yolo',
      '--sandbox', 'disabled',
      'ship',
    ]);
  });

  it('refuses madmax with a conflicting sandbox and maps --force to --yolo', () => {
    expect(() => normalizeCursorArgs(['--madmax', '--sandbox', 'enabled'], { packageRoot: '/pkg', madmax: true }))
      .toThrow(/refusing --sandbox/);
    expect(normalizeCursorArgs(['--madmax', '--force'], { packageRoot: '/pkg', madmax: true })).toEqual([
      '--plugin-dir', '/pkg',
      '--yolo',
      '--sandbox', 'disabled',
    ]);
  });

  it('builds a madmax plan with executable override', () => {
    const plan = buildHostLaunchPlan(['--madmax', '--direct'], {
      packageRoot: '/pkg',
      env: { ...process.env, OMCU_CURSOR_BIN: '/bin/cursor-agent-fake' },
    });
    expect(hasMadmaxFlag(['--madmax'])).toBe(true);
    expect(plan).toMatchObject({
      mode: 'madmax',
      policy: 'direct',
      executable: '/bin/cursor-agent-fake',
    });
    expect(plan.argv).toEqual([
      '--plugin-dir', '/pkg',
      '--yolo',
      '--sandbox', 'disabled',
    ]);
  });

  it('rejects Windows cmd/bat shims before transport', async () => {
    const prev = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-pkg-'));
    try {
      await expect(runHostLaunch(['--direct'], {
        cwd: pkg,
        packageRoot: pkg,
        env: { ...process.env, OMCU_CURSOR_BIN: '/tmp/cursor-agent.cmd' },
        stderr: () => {},
      })).rejects.toThrow(/native \.exe/);
    } finally {
      Object.defineProperty(process, 'platform', { value: prev });
      fs.rmSync(pkg, { recursive: true, force: true });
    }
  });
});
