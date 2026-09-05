export interface ResearchSourceCitation {
  readonly url: string;
  readonly domain: string;
  readonly retrievedAt: string;
  readonly primarySource: boolean;
  readonly title?: string | undefined;
  readonly snippet?: string | undefined;
}

export interface ResearchEvidenceArtifact {
  readonly id: string;
  readonly topic: string;
  readonly citations: readonly ResearchSourceCitation[];
  readonly summary: string;
  readonly rawContent?: string | undefined;
  readonly timestamp: string;
}
