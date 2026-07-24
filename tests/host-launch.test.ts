import { describe, expect, it } from 'vitest';
import {
  HostLaunchUsageError,
  buildHostLaunchPlan,
  hasMadmaxFlag,
  normalizeCursorArgs,
  resolveLaunchPolicy,
  shouldHostLaunch,
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
  });

  it('resolves launch policy flags without forwarding them to cursor-agent', () => {
    expect(resolveLaunchPolicy(['--direct', 'hello'])).toEqual({ policy: 'direct', rest: ['hello'] });
    expect(resolveLaunchPolicy(['--tmux', '--madmax'])).toEqual({ policy: 'tmux', rest: ['--madmax'] });
    expect(resolveLaunchPolicy(['hello'])).toEqual({ policy: 'auto', rest: ['hello'] });
  });

  it('injects plugin-dir for interactive and full-open flags for madmax', () => {
    expect(normalizeCursorArgs([], { packageRoot: '/pkg', madmax: false })).toEqual([
      '--plugin-dir', '/pkg',
    ]);
    expect(normalizeCursorArgs(['ship'], { packageRoot: '/pkg', madmax: false })).toEqual([
      '--plugin-dir', '/pkg', 'ship',
    ]);
    expect(normalizeCursorArgs(['--madmax', 'ship'], { packageRoot: '/pkg', madmax: true })).toEqual([
      '--plugin-dir', '/pkg',
      '--force',
      '--sandbox', 'disabled',
      'ship',
      '--approve-mcps',
      '--trust',
    ]);
  });

  it('refuses madmax with a conflicting sandbox and maps --yolo to --force', () => {
    expect(() => normalizeCursorArgs(['--madmax', '--sandbox', 'enabled'], { packageRoot: '/pkg', madmax: true }))
      .toThrow(/refusing --sandbox/);
    expect(normalizeCursorArgs(['--madmax', '--yolo'], { packageRoot: '/pkg', madmax: true })).toEqual([
      '--plugin-dir', '/pkg',
      '--force',
      '--sandbox', 'disabled',
      '--approve-mcps',
      '--trust',
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
      '--force',
      '--sandbox', 'disabled',
      '--approve-mcps',
      '--trust',
    ]);
  });
});
