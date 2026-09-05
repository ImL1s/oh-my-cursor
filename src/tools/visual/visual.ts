import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from '../types.js';
import type {
  VisualCapture,
  VisualComparisonResult,
  VisualReviewEvidence,
} from './types.js';

export function recordVisualCapture(
  capture: Omit<VisualCapture, 'timestamp'>,
  projectRoot: string = process.cwd()
): VisualCapture {
  const timestamp = new Date().toISOString();
  const fullCapture: VisualCapture = {
    ...capture,
    timestamp,
  };

  const artifactsDir = path.join(projectRoot, '.omcu', 'artifacts', 'visual');
  fs.mkdirSync(artifactsDir, { recursive: true });

  return fullCapture;
}

export function compareVisualCaptures(
  baselineRef: string,
  candidateRef: string,
  options?: { readonly maxDiffScore?: number | undefined; readonly notes?: string | undefined } | undefined,
  projectRoot: string = process.cwd()
): VisualComparisonResult {
  const maxDiff = options?.maxDiffScore ?? 0.05;

  const baselineResolved = path.isAbsolute(baselineRef)
    ? baselineRef
    : path.resolve(projectRoot, baselineRef);
  const candidateResolved = path.isAbsolute(candidateRef)
    ? candidateRef
    : path.resolve(projectRoot, candidateRef);

  let diffScore = 0.0;
  let diffArtifactPath: string | undefined;

  if (fs.existsSync(baselineResolved) && fs.existsSync(candidateResolved)) {
    const baseBuf = fs.readFileSync(baselineResolved);
    const candBuf = fs.readFileSync(candidateResolved);

    if (baseBuf.equals(candBuf)) {
      diffScore = 0.0;
    } else {
      // Simple binary / text difference metric
      const maxLen = Math.max(baseBuf.length, candBuf.length);
      let diffBytes = Math.abs(baseBuf.length - candBuf.length);
      const minLen = Math.min(baseBuf.length, candBuf.length);
      for (let i = 0; i < minLen; i++) {
        if (baseBuf[i] !== candBuf[i]) diffBytes++;
      }
      diffScore = maxLen > 0 ? Number((diffBytes / maxLen).toFixed(4)) : 0.0;

      // Save diff artifact reference
      const artifactsDir = path.join(projectRoot, '.omcu', 'artifacts', 'visual');
      fs.mkdirSync(artifactsDir, { recursive: true });
      const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const diffFile = path.join(artifactsDir, `diff-${id}.json`);
      fs.writeFileSync(
        diffFile,
        JSON.stringify(
          {
            baseline: path.relative(projectRoot, baselineResolved),
            candidate: path.relative(projectRoot, candidateResolved),
            diffScore,
            maxAllowedDiff: maxDiff,
          },
          null,
          2
        ),
        'utf8'
      );
      diffArtifactPath = path.relative(projectRoot, diffFile);
    }
  } else {
    // If refs don't point to files directly, check string equality
    if (baselineRef === candidateRef) {
      diffScore = 0.0;
    } else {
      diffScore = 1.0;
    }
  }

  const isMatch = diffScore <= maxDiff;

  return {
    baselineRef,
    candidateRef,
    diffScore,
    isMatch,
    diffArtifactPath,
    notes: options?.notes,
  };
}

export function packageVisualReviewEvidence(
  params: {
    readonly verdict: 'pass' | 'fail' | 'inconclusive';
    readonly captures: readonly VisualCapture[];
    readonly comparison?: VisualComparisonResult | undefined;
    readonly notes: string;
  },
  projectRoot: string = process.cwd()
): VisualReviewEvidence & { readonly artifactPath: string } {
  // Strict invariant: A source-code review cannot be reported as a visual pass
  if (params.verdict === 'pass' && (!params.captures || params.captures.length === 0)) {
    throw new ToolError(
      'E_VISUAL_EVIDENCE_MISSING',
      'Cannot report a visual pass without visual capture evidence. Source code review is not a visual pass.'
    );
  }

  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const timestamp = new Date().toISOString();

  const evidence: VisualReviewEvidence = {
    id,
    verdict: params.verdict,
    captures: params.captures,
    comparison: params.comparison,
    notes: params.notes,
    timestamp,
  };

  const artifactsDir = path.join(projectRoot, '.omcu', 'artifacts', 'visual');
  fs.mkdirSync(artifactsDir, { recursive: true });
  const filename = `visual-review-${id}.json`;
  const artifactPath = path.join(artifactsDir, filename);

  fs.writeFileSync(artifactPath, JSON.stringify(evidence, null, 2), 'utf8');

  return {
    ...evidence,
    artifactPath: path.relative(projectRoot, artifactPath),
  };
}
