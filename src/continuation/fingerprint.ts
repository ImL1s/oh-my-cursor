import crypto from 'node:crypto';
import type { FailureFingerprintInput, FailureRoutingAction } from './types.js';
import type { WorkflowProfileDefinition } from '../workflows/profiles/types.js';

const TIMESTAMP_REGEX = /\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/gi;
const HEX_ADDRESS_REGEX = /0x[a-f0-9]{4,16}/gi;
const TEMP_PATH_REGEX = /(?:\/private)?\/var\/folders\/[^\s:]+|\/tmp\/[^\s:]+/gi;

/**
 * Normalizes command, tool, error, and output data into a stable fingerprint.
 * Strips non-deterministic elements (timestamps, hex memory addresses, temp paths).
 */
export function deriveFailureFingerprint(input: FailureFingerprintInput): string {
  const normCommand = input.command
    ? input.command.replace(TEMP_PATH_REGEX, '<tmp>').trim()
    : '';

  const normTool = input.tool ? input.tool.trim() : '';

  let errorText = '';
  if (input.error instanceof Error) {
    errorText = `${input.error.name}: ${input.error.message}`;
  } else if (typeof input.error === 'string') {
    errorText = input.error;
  }
  const normError = errorText
    .replace(TIMESTAMP_REGEX, '<time>')
    .replace(HEX_ADDRESS_REGEX, '<addr>')
    .replace(TEMP_PATH_REGEX, '<tmp>')
    .trim();

  const normExitCode = input.exitCode !== undefined && input.exitCode !== null
    ? String(input.exitCode)
    : '';

  const normOutput = (input.output ?? '')
    .slice(0, 1024)
    .replace(TIMESTAMP_REGEX, '<time>')
    .replace(HEX_ADDRESS_REGEX, '<addr>')
    .replace(TEMP_PATH_REGEX, '<tmp>')
    .trim();

  const canonicalPayload = JSON.stringify({
    cmd: normCommand,
    tool: normTool,
    err: normError,
    code: normExitCode,
    out: normOutput,
  });

  const hash = crypto.createHash('sha256').update(canonicalPayload).digest('hex').slice(0, 24);
  return `fp-${hash}`;
}

export interface ProgressEvaluation {
  readonly hasProgress: boolean;
  readonly consecutiveFailures: number;
  readonly repeatedFailure: boolean;
  readonly recommendedAction: FailureRoutingAction;
  readonly reason: string;
}

/**
 * Evaluates progress given the current and previous failure fingerprints and profile policy.
 */
export function evaluateFailureProgress(
  profile: WorkflowProfileDefinition,
  currentFingerprint: string | null,
  previousFingerprint: string | null,
  consecutiveFailures: number
): ProgressEvaluation {
  if (!currentFingerprint) {
    return {
      hasProgress: true,
      consecutiveFailures: 0,
      repeatedFailure: false,
      recommendedAction: 'rework',
      reason: 'no_failure_detected',
    };
  }

  const isIdentical = currentFingerprint === previousFingerprint;
  const newConsecutive = isIdentical ? consecutiveFailures + 1 : 1;
  const maxConsecutive = profile.failureRouting.maxConsecutiveFailures;

  if (newConsecutive >= maxConsecutive) {
    return {
      hasProgress: false,
      consecutiveFailures: newConsecutive,
      repeatedFailure: true,
      recommendedAction: profile.failureRouting.onRepeatedFailure,
      reason: `repeated_failure_threshold_reached: ${newConsecutive} >= ${maxConsecutive} with fingerprint ${currentFingerprint}`,
    };
  }

  return {
    hasProgress: false,
    consecutiveFailures: newConsecutive,
    repeatedFailure: false,
    recommendedAction: 'rework',
    reason: `failure_detected: count ${newConsecutive}/${maxConsecutive}`,
  };
}
