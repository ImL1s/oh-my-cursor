export interface AuditEvaluation {
  readonly passed: boolean;
  readonly errors: readonly string[];
  readonly hints: readonly string[];
}

const SYNTAX_ERROR_PATTERNS: readonly RegExp[] = [
  /\bSyntaxError:\s+.+/i,
  /\bTS[0-9]{4,5}:\s+.+/i,
  /\bReferenceError:\s+.+/i,
  /\bTypeError:\s+.+/i,
  /Uncaught\s+[A-Z][a-zA-Z]*Error:\s+.+/i,
  /\bParseError:\s+.+/i,
];

const TEST_FAILURE_PATTERNS: readonly RegExp[] = [
  /\bFAIL\s+.+\.(test|spec)\.[a-z]+/i,
  /\bTests:\s+[0-9]+\s+failed/i,
  /\bTest Suites:\s+[0-9]+\s+failed/i,
  /\b[0-9]+\s+failed,\s+[0-9]+\s+passed/i,
];

const MAX_OUTPUT_RECOMMENDED_BYTES = 100 * 1024; // 100 KB

export function evaluatePostStepAudit(
  toolName: string,
  toolOutput: unknown
): AuditEvaluation {
  const errors: string[] = [];
  const hints: string[] = [];

  let textToAnalyze = '';
  let exitCode: number | undefined;

  if (typeof toolOutput === 'string') {
    textToAnalyze = toolOutput;
  } else if (typeof toolOutput === 'object' && toolOutput !== null) {
    const outObj = toolOutput as Record<string, unknown>;
    if (typeof outObj.stdout === 'string') textToAnalyze += outObj.stdout + '\n';
    if (typeof outObj.stderr === 'string') textToAnalyze += outObj.stderr + '\n';
    if (typeof outObj.output === 'string') textToAnalyze += outObj.output + '\n';
    if (typeof outObj.error === 'string') textToAnalyze += outObj.error + '\n';
    if (typeof outObj.exitCode === 'number') exitCode = outObj.exitCode;
    if (typeof outObj.status === 'number') exitCode = outObj.status;
  }

  // 1. Check for syntax / compilation errors
  for (const pattern of SYNTAX_ERROR_PATTERNS) {
    const match = pattern.exec(textToAnalyze);
    if (match) {
      errors.push(`Syntax or compilation failure detected: ${match[0].trim()}`);
      hints.push('Review recently modified files for syntax, typing, or import errors before proceeding.');
      break;
    }
  }

  // 2. Check for test runner failures
  for (const pattern of TEST_FAILURE_PATTERNS) {
    const match = pattern.exec(textToAnalyze);
    if (match) {
      errors.push(`Test suite failure detected: ${match[0].trim()}`);
      hints.push('Do not proceed with completion while tests fail. Run targeted tests and address root cause.');
      break;
    }
  }

  // 3. Check for nonzero exit code on test or build tools
  if (exitCode !== undefined && exitCode !== 0) {
    const isTestOrBuild = /test|build|check|lint|compile/i.test(toolName);
    if (isTestOrBuild && errors.length === 0) {
      errors.push(`Tool execution failed with exit code ${exitCode}`);
      hints.push('Inspect stderr and error trace to identify failing command.');
    }
  }

  // 4. Check for excessive output size that should spill to an artifact
  if (Buffer.byteLength(textToAnalyze, 'utf8') > MAX_OUTPUT_RECOMMENDED_BYTES) {
    hints.push(`Output size (${Math.round(textToAnalyze.length / 1024)}KB) exceeded recommended inline limit; consider spilling to an artifact.`);
  }

  return {
    passed: errors.length === 0,
    errors,
    hints,
  };
}
