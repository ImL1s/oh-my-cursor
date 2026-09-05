import { describe, expect, it } from 'vitest';
import { evaluatePostStepAudit } from '../../src/hooks/post-step-audit.js';
import { dispatchHook } from '../../src/hooks/dispatcher.js';

describe('Post-Step Audit Hook (omcu-hook-post-step-audit / omo_post_step_audit)', () => {
  it('passes on clean successful tool executions', () => {
    const cleanOutput = 'Build completed successfully. All 42 tests passed.';
    const evaluation = evaluatePostStepAudit('run_command', {
      stdout: cleanOutput,
      exitCode: 0,
    });

    expect(evaluation.passed).toBe(true);
    expect(evaluation.errors).toHaveLength(0);
    expect(evaluation.hints).toHaveLength(0);
  });

  it('detects syntax and TypeScript compilation errors', () => {
    const errorOutputs = [
      'SyntaxError: Unexpected token "{" in file src/index.ts at line 14',
      'src/agents/types.ts(45,7): error TS2345: Argument of type "string" is not assignable to parameter of type "number".',
      'ReferenceError: undefinedVariable is not defined',
      'TypeError: Cannot read properties of undefined (reading "map")',
    ];

    for (const text of errorOutputs) {
      const evaluation = evaluatePostStepAudit('run_command', { stdout: text, exitCode: 1 });
      expect(evaluation.passed).toBe(false);
      expect(evaluation.errors.length).toBeGreaterThan(0);
      expect(evaluation.hints).toContain(
        'Review recently modified files for syntax, typing, or import errors before proceeding.'
      );
    }
  });

  it('detects Vitest / Jest test runner failures', () => {
    const testFailOutput = `
 FAIL  tests/workflows/lease.test.ts > lease fencing > advances generation
AssertionError: expected 1 to be 2
Tests: 1 failed, 15 passed, 16 total
`;
    const evaluation = evaluatePostStepAudit('test_runner', { stdout: testFailOutput, exitCode: 1 });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.errors.some((e) => e.includes('Test suite failure detected'))).toBe(true);
    expect(evaluation.hints).toContain(
      'Do not proceed with completion while tests fail. Run targeted tests and address root cause.'
    );
  });

  it('warns about large tool output exceeding inline threshold', () => {
    const largeOutput = 'x'.repeat(120 * 1024); // 120 KB
    const evaluation = evaluatePostStepAudit('read_file', { stdout: largeOutput });
    expect(evaluation.hints.some((h) => h.includes('consider spilling to an artifact'))).toBe(true);
  });

  it('dispatches postToolUse hook and reports audit findings', async () => {
    const result = await dispatchHook('postToolUse', {
      tool_name: 'test_runner',
      tool_output: {
        stdout: 'FAIL tests/demo.test.ts\nTests: 1 failed',
        exitCode: 1,
      },
    });

    expect(result.success).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    const auditResult = result.results.find((r) => r.auditPassed === false);
    expect(auditResult).toBeDefined();
    expect(auditResult?.auditErrors?.length).toBeGreaterThan(0);
  });
});
