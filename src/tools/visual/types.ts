export type VisualCaptureType =
  | 'screenshot'
  | 'dom_snapshot'
  | 'browser_log'
  | 'visual_diff';

export interface VisualCapture {
  readonly type: VisualCaptureType;
  readonly targetUrl?: string | undefined;
  readonly contentRef: string;
  readonly dimensions?: { readonly width: number; readonly height: number } | undefined;
  readonly timestamp: string;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface VisualComparisonResult {
  readonly baselineRef: string;
  readonly candidateRef: string;
  readonly diffScore: number;
  readonly isMatch: boolean;
  readonly diffArtifactPath?: string | undefined;
  readonly notes?: string | undefined;
}

export interface VisualReviewEvidence {
  readonly id: string;
  readonly verdict: 'pass' | 'fail' | 'inconclusive';
  readonly captures: readonly VisualCapture[];
  readonly comparison?: VisualComparisonResult | undefined;
  readonly notes: string;
  readonly timestamp: string;
}
