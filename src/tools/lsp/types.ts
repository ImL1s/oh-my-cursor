export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspLocation {
  readonly uri: string;
  readonly range: LspRange;
}

export interface LspDiagnostic {
  readonly range: LspRange;
  readonly severity?: number | undefined;
  readonly code?: string | number | undefined;
  readonly source?: string | undefined;
  readonly message: string;
}

export interface LspHoverResult {
  readonly contents: string;
  readonly range?: LspRange | undefined;
}

export interface LspSymbol {
  readonly name: string;
  readonly kind: number;
  readonly range: LspRange;
  readonly containerName?: string | undefined;
}

export interface LspTextEdit {
  readonly range: LspRange;
  readonly newText: string;
}

export interface LspWorkspaceEdit {
  readonly changes?: Record<string, readonly LspTextEdit[]> | undefined;
}

export interface LspServerConfig {
  readonly languageId: string;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly rootDir?: string | undefined;
}

export interface ILspClient {
  readonly languageId: string;
  readonly rootDir: string;
  diagnostics(filePath: string): Promise<readonly LspDiagnostic[]>;
  hover(filePath: string, position: LspPosition): Promise<LspHoverResult | null>;
  definition(filePath: string, position: LspPosition): Promise<readonly LspLocation[]>;
  references(filePath: string, position: LspPosition, includeDeclaration?: boolean): Promise<readonly LspLocation[]>;
  symbols(filePath?: string, query?: string): Promise<readonly LspSymbol[]>;
  rename(filePath: string, position: LspPosition, newName: string): Promise<LspWorkspaceEdit>;
  implementation?(filePath: string, position: LspPosition): Promise<readonly LspLocation[]>;
  typeDefinition?(filePath: string, position: LspPosition): Promise<readonly LspLocation[]>;
  shutdown(): Promise<void>;
}
