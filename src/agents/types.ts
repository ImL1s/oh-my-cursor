export type AgentSource = 'omc' | 'omx' | 'omo' | 'omcu' | 'custom';

export type AgentMode = 'primary' | 'subagent' | 'either';

export type SemanticCategory =
  | 'architecture'
  | 'planning'
  | 'execution'
  | 'reconnaissance'
  | 'review'
  | 'verification'
  | 'testing'
  | 'debugging'
  | 'research'
  | 'documentation'
  | 'analysis'
  | 'refactoring'
  | 'operations'
  | 'coordination';

export type RoutingClass = 'reasoning' | 'smart' | 'fast';

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ModelRequirement {
  readonly preferredModel?: string | undefined;
  readonly routingTier: RoutingClass;
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly exactModelRequired?: boolean | undefined;
  readonly fallbackTiers: readonly RoutingClass[];
}

export type ToolClass = 'read' | 'write' | 'shell' | 'custom' | 'mcp';

export type WriteScope = 'none' | 'all' | 'markdown-only' | 'worktree-only' | 'path-scoped';

export interface ToolPolicy {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly toolClasses: readonly ToolClass[];
  readonly writeScope: WriteScope;
}

export interface DelegationPolicy {
  readonly canDelegate: boolean;
  readonly maxDepth: number;
  readonly allowedSubagentRoles?: readonly string[] | undefined;
}

export interface Eligibility {
  readonly local: boolean;
  readonly cloud: boolean;
  readonly background: boolean;
  readonly team: boolean;
  readonly teamIneligibilityReason?: string | undefined;
}

export interface WorkspacePolicy {
  readonly requiresWorktree: boolean;
  readonly isolationLevel: 'shared' | 'isolated-worktree' | 'read-only';
}

export interface ContextFragments {
  readonly requiredSkills: readonly string[];
  readonly requiredRules: readonly string[];
}

export interface ArtifactContract {
  readonly expectedInputs: readonly string[];
  readonly expectedOutputs: readonly string[];
  readonly artifactPathPattern?: string | undefined;
}

export interface SourceProfile {
  readonly profileId: string;
  readonly source: AgentSource;
  readonly sourceName: string;
  readonly description: string;
  readonly modelOverride?: Partial<ModelRequirement> | undefined;
  readonly toolPolicyOverride?: Partial<ToolPolicy> | undefined;
  readonly delegationOverride?: Partial<DelegationPolicy> | undefined;
  readonly intentionalDifferences: string;
}

export interface AgentRoleDefinition {
  readonly id: string;
  readonly canonicalName: string;
  readonly agentFile: string;
  readonly fallbackFile?: string | undefined;
  readonly aliases: readonly string[];
  readonly mode: AgentMode;
  readonly category: SemanticCategory;
  readonly model: ModelRequirement;
  readonly tools: ToolPolicy;
  readonly delegation: DelegationPolicy;
  readonly eligibility: Eligibility;
  readonly workspace: WorkspacePolicy;
  readonly context: ContextFragments;
  readonly artifacts: ArtifactContract;
  readonly profiles: readonly SourceProfile[];
  readonly defaultProfile: string;
  readonly intentionalDifferences: string;
  readonly custom?: boolean | undefined;
}

export interface PromptSections {
  readonly identity: string;
  readonly taskContract: string;
  readonly toolPolicy: string;
  readonly evidenceRules: string;
  readonly sourceProfile: string;
  readonly hostLimitations: string;
}

export interface ComposedPrompt {
  readonly roleId: string;
  readonly profileId: string;
  readonly systemPrompt: string;
  readonly sections: PromptSections;
  readonly promptHash: string;
  readonly effectiveTools: readonly string[];
  readonly deniedTools: readonly string[];
  readonly writeScope: WriteScope;
  readonly maxDepth: number;
  readonly canDelegate: boolean;
  readonly timestamp: string;
}

export interface AgentTaskContext {
  readonly objective: string;
  readonly handoffArtifact?: string | undefined;
  readonly workingDirectory?: string | undefined;
  readonly parentRunId?: string | undefined;
  readonly parentPolicy?: EffectiveAgentPolicy | undefined;
  readonly contextData?: Readonly<Record<string, unknown>> | undefined;
}

export interface EffectiveAgentPolicy {
  readonly allowedTools: readonly string[];
  readonly deniedTools: readonly string[];
  readonly writeScope: WriteScope;
  readonly maxDepth: number;
  readonly canDelegate: boolean;
  readonly workspaceIsolation: 'shared' | 'isolated-worktree' | 'read-only';
}

export interface EnforcementResult {
  readonly allowed: boolean;
  readonly reason?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly effectivePolicy?: EffectiveAgentPolicy | undefined;
}

export type RouteResolutionStep =
  | 'explicit_model'
  | 'profile_constraint'
  | 'user_override'
  | 'category_policy'
  | 'compatible_fallback'
  | 'external_provider'
  | 'unavailable';

export interface RouteExplanation {
  readonly agent: string;
  readonly profile: string;
  readonly selectedModel: string;
  readonly selectedRuntime: 'local' | 'cloud';
  readonly routingTier: RoutingClass;
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly resolutionStep: RouteResolutionStep;
  readonly reason: string;
  readonly history: readonly string[];
  readonly routerCompatibility: boolean;
  readonly availableModels: readonly string[];
}
