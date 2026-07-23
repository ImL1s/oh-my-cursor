import { sha256 } from '../workflows/schema.js';
import type { AdvisoryGate } from './types.js';

export type PipelinePhase = 'plan' | 'execute' | 'review' | 'qa' | 'acceptance';
export interface GateEvidence { readonly phase: PipelinePhase; readonly passed: boolean; readonly evidence: string }

export function evaluateGate(input: GateEvidence): AdvisoryGate {
  if (input.evidence.trim() === '') return { gate: input.phase, passed: false, evidence_sha256: null, verified: false, verification_authority: 'omcu-cli-only' };
  return { gate: input.phase, passed: input.passed, evidence_sha256: sha256(input.evidence), verified: false, verification_authority: 'omcu-cli-only' };
}

export function reviewGate(evidence: string, clean: boolean): AdvisoryGate { return evaluateGate({ phase: 'review', passed: clean, evidence }); }
export function qaGate(evidence: string, passed: boolean): AdvisoryGate { return evaluateGate({ phase: 'qa', passed, evidence }); }
export function acceptanceGate(evidence: string, accepted: boolean): AdvisoryGate { return evaluateGate({ phase: 'acceptance', passed: accepted, evidence }); }
