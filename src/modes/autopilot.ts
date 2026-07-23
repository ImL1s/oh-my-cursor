import type { AdvisoryGate } from './types.js';
import type { PipelinePhase } from './gates.js';

const ORDER: readonly PipelinePhase[] = ['plan', 'execute', 'review', 'qa', 'acceptance'];
export interface AutopilotSnapshot { readonly phase: PipelinePhase | 'complete' | 'failed'; readonly accepted_gates: readonly AdvisoryGate[]; readonly verified: false; readonly verification_authority: 'omcu-cli-only' }

export class AutopilotPipeline {
  private snapshot: AutopilotSnapshot = { phase: 'plan', accepted_gates: [], verified: false, verification_authority: 'omcu-cli-only' };
  status(): AutopilotSnapshot { return structuredClone(this.snapshot); }
  accept(gate: AdvisoryGate): AutopilotSnapshot {
    if (gate === null || typeof gate !== 'object'
      || Object.keys(gate).sort().join(',') !== 'evidence_sha256,gate,passed,verification_authority,verified'
      || !ORDER.includes(gate.gate as PipelinePhase)
      || typeof gate.passed !== 'boolean'
      || gate.verified !== false
      || gate.verification_authority !== 'omcu-cli-only'
      || (gate.evidence_sha256 !== null && !/^[a-f0-9]{64}$/.test(gate.evidence_sha256))
      || (gate.passed && gate.evidence_sha256 === null)) throw new Error('E_AUTOPILOT_GATE_INVALID');
    if (this.snapshot.phase === 'complete' || this.snapshot.phase === 'failed') throw new Error('E_AUTOPILOT_TERMINAL');
    if (gate.gate !== this.snapshot.phase) throw new Error('E_AUTOPILOT_GATE_ORDER');
    if (!gate.passed) { this.snapshot = { ...this.snapshot, phase: 'failed' }; return this.status(); }
    const index = ORDER.indexOf(this.snapshot.phase);
    this.snapshot = { phase: ORDER[index + 1] ?? 'complete', accepted_gates: [...this.snapshot.accepted_gates, gate], verified: false, verification_authority: 'omcu-cli-only' };
    return this.status();
  }
}
