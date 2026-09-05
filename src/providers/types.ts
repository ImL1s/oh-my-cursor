export type ProviderId =
  | 'cursor'
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'grok'
  | 'opencode'
  | 'custom';

export interface ProviderReadiness {
  readonly provider: ProviderId;
  readonly available: boolean;
  readonly binaryPath?: string | undefined;
  readonly version?: string | undefined;
  readonly authStatus?: 'authenticated' | 'unauthenticated' | 'unknown' | undefined;
  readonly reason?: string | undefined;
  readonly supportedModels?: readonly string[] | undefined;
  readonly error?: string | undefined;
}

export type CustomProcessRunner = (
  executable: string,
  args: readonly string[],
  options: {
    readonly cwd?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  }
) => Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

export interface ProviderExecutionOptions {
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly customBinary?: string | undefined;
  readonly customArgs?: readonly string[] | undefined;
  readonly runner?: CustomProcessRunner | undefined;
}

export interface ProviderExecutionResult {
  readonly provider: ProviderId;
  readonly model: string;
  readonly runtime: 'local' | 'cloud' | 'external';
  readonly exitCode: number;
  readonly text: string;
  readonly durationMs: number;
  readonly error?: string | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly isCanonical: boolean;
  readonly defaultBinary: string;
  readonly envAllowlist: readonly string[];
  readonly dangerousFlags: readonly string[];
  readonly supportedModels: readonly string[];

  probe(cwd?: string, runner?: CustomProcessRunner): Promise<ProviderReadiness>;
  execute(options: ProviderExecutionOptions): Promise<ProviderExecutionResult>;
}

export interface ProviderComparisonItem {
  readonly provider: ProviderId;
  readonly model: string;
  readonly runtime: 'local' | 'cloud' | 'external';
  readonly success: boolean;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly text?: string | undefined;
  readonly error?: string | undefined;
}

export type ConsensusVerdict =
  | 'full_consensus'
  | 'partial_consensus'
  | 'divergent'
  | 'failed';

export interface ConsensusArtifact {
  readonly schema_version: 1;
  readonly artifact_type: 'provider_consensus';
  readonly id: string;
  readonly createdAt: string;
  readonly prompt: string;
  readonly results: readonly ProviderComparisonItem[];
  readonly totalProviders: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly verdict: ConsensusVerdict;
  readonly agreementScore: number;
  readonly synthesis: string;
  readonly advisoryNote: string;
}
