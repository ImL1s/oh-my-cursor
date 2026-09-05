import type { ModelParameterDefinition, ModelVariant } from '@cursor/sdk';
import type { ReasoningEffort, RoutingClass } from '../../agents/types.js';

export type ModelRuntimeTarget = 'local' | 'cloud' | 'both';

export interface ModelCapabilities {
  readonly reasoning: boolean;
  readonly vision: boolean;
  readonly tools: boolean;
  readonly supportsAutoRouter: boolean;
}

export interface DiscoveredModel {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string | undefined;
  readonly aliases?: readonly string[] | undefined;
  readonly parameters?: readonly ModelParameterDefinition[] | undefined;
  readonly variants?: readonly ModelVariant[] | undefined;
  readonly runtime: ModelRuntimeTarget;
  readonly routingTier: RoutingClass;
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly capabilities: ModelCapabilities;
  readonly isAccountVisible: boolean;
}

export interface ModelCatalogCache {
  readonly schema_version: 1;
  readonly sdkVersion: string;
  readonly cachedAt: string;
  readonly ttlMs: number;
  readonly accountVisible: boolean;
  readonly fallbackReason?: string | undefined;
  readonly models: readonly DiscoveredModel[];
}

export interface ModelDiscoveryOptions {
  readonly workspace?: string | undefined;
  readonly forceRefresh?: boolean | undefined;
  readonly ttlMs?: number | undefined;
  readonly sdkClient?: {
    readonly models: {
      readonly list: (options?: any) => Promise<readonly unknown[]>;
    };
  } | undefined;
}

export interface ModelListFilter {
  readonly runtime?: 'local' | 'cloud' | undefined;
  readonly tier?: RoutingClass | undefined;
  readonly requiresVision?: boolean | undefined;
  readonly requiresTools?: boolean | undefined;
  readonly requiresReasoning?: boolean | undefined;
}
