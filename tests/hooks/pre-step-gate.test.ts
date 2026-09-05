import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluatePreStepSafety } from '../../src/hooks/pre-step-gate.js';
import { dispatchHook } from '../../src/hooks/dispatcher.js';

describe('Pre-Step Safety Gate Hook (omcu-hook-pre-step-gate / omo_pre_step_gate)', () => {
  const cwd = path.resolve('/mock/workspace');

  it('allows benign developer shell commands', () => {
    const benignCommands = [
      'npm test',
      'git status',
      'git log -n 5',
      'node dist/bin/omcu.js --help',
      'vitest run tests/hooks',
      'mkdir -p src/components',
    ];

    for (const command of benignCommands) {
      const evaluation = evaluatePreStepSafety('Shell', { command }, cwd);
      expect(evaluation.safe).toBe(true);
      expect(evaluation.violations).toHaveLength(0);
    }
  });

  it('blocks destructive filesystem deletion commands', () => {
    const destructiveCommands = [
      'rm -rf /',
      'rm -rf /usr/local',
      'rm -rf ~',
      'rm -rf $HOME',
      'rm -rf /*',
      'rm -rf ..',
      'rm -rf .',
      'rm -rf ./',
      'rm -rf *',
      'rm -rf ./*',
      'rm -rf .*',
      'rm -rf $PWD',
      'rm -rf ${PWD}',
      'rm -rf .git',
      'rm -rf .git/',
    ];

    for (const command of destructiveCommands) {
      const evaluation = evaluatePreStepSafety('Shell', { command }, cwd);
      expect(evaluation.safe).toBe(false);
      expect(evaluation.errorCode).toBe('E_SAFETY_DENY');
      expect(evaluation.violations.length).toBeGreaterThan(0);
      expect(evaluation.reason).toContain('Destructive recursive deletion');
    }
  });

  it('blocks disk formatting and raw block device overwrites', () => {
    const formatCommands = [
      'mkfs.ext4 /dev/sda1',
      'fdisk /dev/nvme0n1',
      'dd if=/dev/zero of=/dev/sda bs=1M count=100',
    ];

    for (const command of formatCommands) {
      const evaluation = evaluatePreStepSafety('Shell', { command }, cwd);
      expect(evaluation.safe).toBe(false);
      expect(evaluation.errorCode).toBe('E_SAFETY_DENY');
    }
  });

  it('blocks dangerous git force-pushes and branch deletions', () => {
    const dangerousGit = [
      'git push origin main --force',
      'git push -f origin feature-branch',
      'git push origin --delete main',
      'git push origin --delete release',
    ];

    for (const command of dangerousGit) {
      const evaluation = evaluatePreStepSafety('Shell', { command }, cwd);
      expect(evaluation.safe).toBe(false);
      expect(evaluation.errorCode).toBe('E_SAFETY_DENY');
    }
  });

  it('blocks unauthorized access to secret keys', () => {
    const secretReads = [
      'cat ~/.ssh/id_rsa',
      'cat /home/user/.aws/credentials',
      'cat ~/.gnupg/secring.gpg',
    ];

    for (const command of secretReads) {
      const evaluation = evaluatePreStepSafety('Shell', { command }, cwd);
      expect(evaluation.safe).toBe(false);
      expect(evaluation.errorCode).toBe('E_SAFETY_DENY');
    }
  });

  it('blocks attempts to escape workspace root via tool input path', () => {
    const escapingPaths = [
      '../../etc/shadow',
      '/etc/passwd',
      '../../../root/.bashrc',
    ];

    for (const p of escapingPaths) {
      const evaluation = evaluatePreStepSafety('write_to_file', { targetFile: p }, cwd);
      expect(evaluation.safe).toBe(false);
      expect(evaluation.errorCode).toBe('E_SAFETY_DENY');
    }
  });

  it('blocks direct modification of .git directory and internal files', () => {
    const gitTargets = ['.git', '.git/config', '.git/HEAD'];
    for (const targetFile of gitTargets) {
      const evaluation = evaluatePreStepSafety('write_to_file', { targetFile }, cwd);
      expect(evaluation.safe).toBe(false);
      expect(evaluation.errorCode).toBe('E_SAFETY_DENY');
      expect(evaluation.reason).toContain('Direct modification of git internal directory is disallowed');
    }
  });

  it('dispatches preToolUse hook and halts on safety violation', async () => {
    const result = await dispatchHook('preToolUse', {
      tool_name: 'Shell',
      tool_input: { command: 'rm -rf /' },
    }, { cwd });

    expect(result.success).toBe(false);
    expect(result.denied).toBe(true);
    expect(result.errorCode).toBe('E_SAFETY_DENY');
    expect(result.response).toEqual({
      action: 'deny',
      message: expect.stringContaining('Destructive recursive deletion'),
      code: 'E_SAFETY_DENY',
    });
  });
});
