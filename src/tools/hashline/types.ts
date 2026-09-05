export interface Hashline {
  readonly line: number;
  readonly hash: string;
  readonly text: string;
}

export interface HashlineEditChunk {
  readonly startLine: number;
  readonly endLine: number;
  readonly expectedHashes?: readonly string[] | undefined;
  readonly newText: string;
}

export interface HashlineEditResult {
  readonly success: boolean;
  readonly modifiedContent: string;
  readonly diffPreview: string;
  readonly modifiedLines: number;
}
