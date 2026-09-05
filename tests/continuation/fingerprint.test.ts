import { describe, expect, it } from 'vitest';
import {
  deriveFailureFingerprint,
  evaluateFailureProgress,
} from '../../src/continuation/fingerprint.js';
import { getSourceProfile } from '../../src/workflows/profiles/catalog.js';

describe('Failure Fingerprint and Progress Intelligence', () => {
  it('normalizes non-deterministic elements (timestamps, memory addresses, temp paths)', () => {
    const fp1 = deriveFailureFingerprint({
      command: 'npm test --run /private/var/folders/33/xyz/t.ts',
      tool: 'Shell',
      error: 'Error: segmentation fault at 0x7ffee1234567 at 2026-09-06T04:00:00Z',
      exitCode: 1,
      output: 'Failed test in /tmp/test-workspace-1234 at 2026-09-06 04:00:00',
    });

    const fp2 = deriveFailureFingerprint({
      command: 'npm test --run /private/var/folders/99/abc/t.ts',
      tool: 'Shell',
      error: 'Error: segmentation fault at 0x7ffcc9876543 at 2026-09-06T04:05:00Z',
      exitCode: 1,
      output: 'Failed test in /tmp/test-workspace-5678 at 2026-09-06 04:05:00',
    });

    expect(fp1).toBe(fp2);
    expect(fp1.startsWith('fp-')).toBe(true);
  });

  it('differentiates distinct failure causes', () => {
    const fp1 = deriveFailureFingerprint({
      command: 'npm test',
      tool: 'Shell',
      error: 'SyntaxError: Unexpected token',
      exitCode: 1,
    });

    const fp2 = deriveFailureFingerprint({
      command: 'npm test',
      tool: 'Shell',
      error: 'TimeoutError: Test timed out after 5000ms',
      exitCode: 1,
    });

    expect(fp1).not.toBe(fp2);
  });

  it('evaluates progress and detects repeated failures exceeding threshold', () => {
    const profile = getSourceProfile('omc-autopilot')!;
    expect(profile).toBeDefined();

    // 1. Initial success or clear
    const p1 = evaluateFailureProgress(profile, null, null, 0);
    expect(p1.hasProgress).toBe(true);
    expect(p1.consecutiveFailures).toBe(0);
    expect(p1.repeatedFailure).toBe(false);

    // 2. First failure
    const fpA = 'fp-test-failure-aaa';
    const p2 = evaluateFailureProgress(profile, fpA, null, 0);
    expect(p2.hasProgress).toBe(false);
    expect(p2.consecutiveFailures).toBe(1);
    expect(p2.repeatedFailure).toBe(false);

    // 3. Second identical failure
    const p3 = evaluateFailureProgress(profile, fpA, fpA, 1);
    expect(p3.hasProgress).toBe(false);
    expect(p3.consecutiveFailures).toBe(2);
    expect(p3.repeatedFailure).toBe(false);

    // 4. Third identical failure reaches threshold (maxConsecutiveFailures = 3 for autopilot)
    const p4 = evaluateFailureProgress(profile, fpA, fpA, 2);
    expect(p4.hasProgress).toBe(false);
    expect(p4.consecutiveFailures).toBe(3);
    expect(p4.repeatedFailure).toBe(true);
    expect(p4.recommendedAction).toBe('replan');
  });

  it('routes to specialist for ultrawork profile', () => {
    const profile = getSourceProfile('omc-ultrawork')!;
    const fp = 'fp-worker-crash';
    const evalResult = evaluateFailureProgress(profile, fp, fp, 1); // threshold is 2
    expect(evalResult.repeatedFailure).toBe(true);
    expect(evalResult.recommendedAction).toBe('specialist');
  });
});
