export interface AstGrepMatch {
  readonly file: string;
  readonly text: string;
  readonly range: {
    readonly start: { readonly line: number; readonly column: number };
    readonly end: { readonly line: number; readonly column: number };
  };
  readonly lines?: string | undefined;
}

export interface AstGrepSearchOptions {
  readonly pattern: string;
  readonly language?: string | undefined;
  readonly paths?: readonly string[] | undefined;
  readonly rootDir?: string | undefined;
}

export interface AstGrepRewriteOptions {
  readonly pattern: string;
  readonly rewrite: string;
  readonly language?: string | undefined;
  readonly paths?: readonly string[] | undefined;
  readonly rootDir?: string | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface AstGrepRewriteResult {
  readonly matches: readonly AstGrepMatch[];
  readonly diff: string;
  readonly applied: boolean;
}

export interface IAstGrepRunner {
  isAvailable(language?: string): Promise<boolean> | boolean;
  search(options: AstGrepSearchOptions): Promise<readonly AstGrepMatch[]>;
  rewrite(options: AstGrepRewriteOptions): Promise<AstGrepRewriteResult>;
}
