import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../runtime/atomic.js';
import { resolveProjectStatePath } from '../runtime/state-root.js';
import { getProviderAdapter } from './registry.js';
import type {
  ConsensusArtifact,
  ConsensusVerdict,
  CustomProcessRunner,
  ProviderComparisonItem,
  ProviderId,
} from './types.js';

export interface CompareOptions {
  readonly providers: readonly (ProviderId | string)[];
  readonly prompt: string;
  readonly modelMap?: Readonly<Record<string, string>> | undefined;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly runner?: CustomProcessRunner | undefined;
  readonly saveArtifact?: boolean | undefined;
  readonly workspace?: string | undefined;
}

function computeSimilarity(texts: readonly string[]): number {
  if (texts.length <= 1) return 1.0;
  const tokenSets = texts.map((t) => {
    const tokens = t.toLowerCase().split(/\W+/).filter((x) => x.length > 2);
    return new Set(tokens);
  });

  let totalSim = 0;
  let pairs = 0;

  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      const setA = tokenSets[i]!;
      const setB = tokenSets[j]!;
      if (setA.size === 0 && setB.size === 0) {
        totalSim += 1.0;
      } else {
        let intersection = 0;
        for (const token of setA) {
          if (setB.has(token)) intersection++;
        }
        const union = new Set([...setA, ...setB]).size;
        totalSim += union > 0 ? intersection / union : 0;
      }
      pairs++;
    }
  }

  return pairs > 0 ? Math.round((totalSim / pairs) * 100) / 100 : 0;
}

function synthesizeComparison(
  results: readonly ProviderComparisonItem[],
  score: number
): string {
  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  const parts: string[] = [];
  if (successful.length > 0) {
    parts.push(
      `${successful.length} of ${results.length} provider(s) succeeded (${successful.map((r) => r.provider).join(', ')}).`
    );
    if (score >= 0.7) {
      parts.push(`High consensus detected across successful responses (similarity score: ${score}).`);
    } else if (score >= 0.4) {
      parts.push(`Moderate consensus with minor divergence (similarity score: ${score}).`);
    } else {
      parts.push(`Outputs diverge substantially across providers (similarity score: ${score}).`);
    }
  } else {
    parts.push('All providers failed to produce a valid response.');
  }

  if (failed.length > 0) {
    parts.push(
      `Failures encountered on: ${failed.map((f) => `${f.provider} (${f.error ?? 'unknown error'})`).join('; ')}.`
    );
  }

  return parts.join(' ');
}

export async function compareProviders(options: CompareOptions): Promise<ConsensusArtifact> {
  const providerNames = options.providers;
  if (!providerNames || providerNames.length === 0) {
    throw new Error('E_COMPARE_EMPTY_PROVIDERS: at least one provider must be specified for comparison');
  }

  // Execute providers independently in parallel
  const executions = await Promise.all(
    providerNames.map(async (name) => {
      try {
        const adapter = getProviderAdapter(name);
        const model = options.modelMap?.[name] ?? options.modelMap?.[adapter.id];
        const res = await adapter.execute({
          prompt: options.prompt,
          model,
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
          runner: options.runner,
        });

        const success = res.exitCode === 0 && !res.error;
        const item: ProviderComparisonItem = {
          provider: adapter.id,
          model: res.model,
          runtime: res.runtime,
          success,
          exitCode: res.exitCode,
          durationMs: res.durationMs,
          text: res.text,
          error: res.error,
        };
        return item;
      } catch (err) {
        const item: ProviderComparisonItem = {
          provider: name.trim().toLowerCase() as ProviderId,
          model: 'unknown',
          runtime: 'external',
          success: false,
          exitCode: 1,
          durationMs: 0,
          error: err instanceof Error ? err.message : String(err),
        };
        return item;
      }
    })
  );

  const totalProviders = executions.length;
  const successCount = executions.filter((e) => e.success).length;
  const failureCount = totalProviders - successCount;

  const successfulTexts = executions.filter((e) => e.success && e.text).map((e) => e.text!);
  const agreementScore = computeSimilarity(successfulTexts);

  let verdict: ConsensusVerdict = 'failed';
  if (successCount === totalProviders) {
    verdict = agreementScore >= 0.15 ? 'full_consensus' : 'divergent';
  } else if (successCount > 0) {
    verdict = 'partial_consensus';
  }

  const synthesis = synthesizeComparison(executions, agreementScore);

  const artifact: ConsensusArtifact = {
    schema_version: 1,
    artifact_type: 'provider_consensus',
    id: `consensus-${crypto.randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    prompt: options.prompt,
    results: executions,
    totalProviders,
    successCount,
    failureCount,
    verdict,
    agreementScore,
    synthesis,
    advisoryNote: 'Provider agreement is advisory evidence, not test/command evidence.',
  };

  // Optionally persist artifact under .omcu/artifacts/ without touching code
  const workspace = options.workspace ?? options.cwd ?? process.cwd();
  const stateDir = resolveProjectStatePath(workspace);
  if (fs.existsSync(stateDir) || options.saveArtifact) {
    try {
      const artifactsDir = path.join(stateDir, 'artifacts');
      if (!fs.existsSync(artifactsDir)) {
        fs.mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
      }
      const artifactPath = path.join(artifactsDir, `${artifact.id}.json`);
      atomicWriteJson(artifactPath, artifact, { mode: 0o600 });
    } catch {
      // Artifact write failure does not fail the comparison result
    }
  }

  return artifact;
}
