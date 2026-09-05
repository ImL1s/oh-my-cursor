import fs from 'node:fs';
import path from 'node:path';
import type { SDKModel } from '@cursor/sdk';
import { readModelCache, writeModelCache, DEFAULT_CACHE_TTL_MS } from './cache.js';
import type {
  DiscoveredModel,
  ModelCatalogCache,
  ModelDiscoveryOptions,
  ModelListFilter,
  ModelRuntimeTarget,
} from './types.js';
import type { ReasoningEffort, RoutingClass } from '../../agents/types.js';

let cachedSdkVersion: string | undefined;

export function getCursorSdkVersion(): string {
  if (cachedSdkVersion) return cachedSdkVersion;
  try {
    const importMetaUrl = new URL(import.meta.url);
    let dir = path.dirname(importMetaUrl.pathname);
    while (dir !== path.dirname(dir)) {
      const pkgPath = path.join(dir, 'node_modules', '@cursor', 'sdk', 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
        if (pkg.version) {
          cachedSdkVersion = pkg.version;
          return cachedSdkVersion;
        }
      }
      dir = path.dirname(dir);
    }
  } catch {
    // fallback below
  }
  cachedSdkVersion = '1.0.31';
  return cachedSdkVersion;
}

export const DEFAULT_CURSOR_MODELS_CATALOG: readonly DiscoveredModel[] = [
  {
    id: 'auto',
    displayName: 'Cursor Router (Auto)',
    description: 'Cursor Router dynamic multi-model optimization mode',
    aliases: ['cursor-router', 'cursor-auto', 'router'],
    runtime: 'both',
    routingTier: 'smart',
    capabilities: {
      reasoning: true,
      vision: true,
      tools: true,
      supportsAutoRouter: true,
    },
    isAccountVisible: true,
  },
  {
    id: 'claude-3-7-sonnet-thought',
    displayName: 'Claude 3.7 Sonnet (Thinking)',
    description: 'Anthropic hybrid reasoning model with dynamic thinking budget',
    aliases: ['sonnet-3.7-thought', 'claude-3.7-thinking'],
    runtime: 'cloud',
    routingTier: 'reasoning',
    reasoningEffort: 'high',
    capabilities: {
      reasoning: true,
      vision: true,
      tools: true,
      supportsAutoRouter: true,
    },
    isAccountVisible: false,
  },
  {
    id: 'claude-3-5-sonnet',
    displayName: 'Claude 3.5 Sonnet',
    description: 'Anthropic flagship coding and vision model',
    aliases: ['sonnet-3.5', 'claude-3.5'],
    runtime: 'cloud',
    routingTier: 'smart',
    capabilities: {
      reasoning: false,
      vision: true,
      tools: true,
      supportsAutoRouter: true,
    },
    isAccountVisible: false,
  },
  {
    id: 'claude-3-5-haiku',
    displayName: 'Claude 3.5 Haiku',
    description: 'Anthropic ultra-fast lightweight model',
    aliases: ['haiku-3.5', 'claude-haiku'],
    runtime: 'cloud',
    routingTier: 'fast',
    reasoningEffort: 'low',
    capabilities: {
      reasoning: false,
      vision: true,
      tools: true,
      supportsAutoRouter: true,
    },
    isAccountVisible: false,
  },
  {
    id: 'gpt-4o',
    displayName: 'GPT-4o',
    description: 'OpenAI versatile multimodal model',
    aliases: ['gpt4o', '4o'],
    runtime: 'cloud',
    routingTier: 'smart',
    capabilities: {
      reasoning: false,
      vision: true,
      tools: true,
      supportsAutoRouter: true,
    },
    isAccountVisible: false,
  },
  {
    id: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    description: 'OpenAI low-latency, cost-effective model',
    aliases: ['gpt4o-mini', '4o-mini'],
    runtime: 'cloud',
    routingTier: 'fast',
    reasoningEffort: 'low',
    capabilities: {
      reasoning: false,
      vision: true,
      tools: true,
      supportsAutoRouter: true,
    },
    isAccountVisible: false,
  },
  {
    id: 'o3-mini',
    displayName: 'o3-mini',
    description: 'OpenAI specialized reasoning model for code and math',
    aliases: ['o3'],
    runtime: 'cloud',
    routingTier: 'reasoning',
    reasoningEffort: 'high',
    capabilities: {
      reasoning: true,
      vision: false,
      tools: true,
      supportsAutoRouter: true,
    },
    isAccountVisible: false,
  },
  {
    id: 'o1',
    displayName: 'o1',
    description: 'OpenAI high-capability reasoning model with vision',
    aliases: ['o1-preview'],
    runtime: 'cloud',
    routingTier: 'reasoning',
    reasoningEffort: 'high',
    capabilities: {
      reasoning: true,
      vision: true,
      tools: true,
      supportsAutoRouter: true,
    },
    isAccountVisible: false,
  },
  {
    id: 'deepseek-r1',
    displayName: 'DeepSeek R1',
    description: 'Open-weights reasoning model',
    aliases: ['r1'],
    runtime: 'cloud',
    routingTier: 'reasoning',
    reasoningEffort: 'high',
    capabilities: {
      reasoning: true,
      vision: false,
      tools: false,
      supportsAutoRouter: false,
    },
    isAccountVisible: false,
  },
  {
    id: 'gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    description: 'Google high-speed multimodal model',
    aliases: ['gemini-flash'],
    runtime: 'cloud',
    routingTier: 'fast',
    reasoningEffort: 'low',
    capabilities: {
      reasoning: false,
      vision: true,
      tools: true,
      supportsAutoRouter: true,
    },
    isAccountVisible: false,
  },
  {
    id: 'gemini-2.0-pro',
    displayName: 'Gemini 2.0 Pro',
    description: 'Google advanced reasoning and coding multimodal model',
    aliases: ['gemini-pro'],
    runtime: 'cloud',
    routingTier: 'smart',
    capabilities: {
      reasoning: false,
      vision: true,
      tools: true,
      supportsAutoRouter: true,
    },
    isAccountVisible: false,
  },
  {
    id: 'cursor-small',
    displayName: 'Cursor Small',
    description: 'Cursor local fast low-latency model',
    aliases: ['local-small'],
    runtime: 'local',
    routingTier: 'fast',
    reasoningEffort: 'low',
    capabilities: {
      reasoning: false,
      vision: false,
      tools: true,
      supportsAutoRouter: true,
    },
    isAccountVisible: false,
  },
  {
    id: 'cursor-fast',
    displayName: 'Cursor Fast',
    description: 'Cursor optimized fast model for edits and navigation',
    aliases: ['cursor-quick'],
    runtime: 'both',
    routingTier: 'fast',
    reasoningEffort: 'low',
    capabilities: {
      reasoning: false,
      vision: false,
      tools: true,
      supportsAutoRouter: true,
    },
    isAccountVisible: false,
  },
];

function inferCapabilities(
  id: string,
  displayName: string
): {
  runtime: ModelRuntimeTarget;
  routingTier: RoutingClass;
  reasoningEffort?: ReasoningEffort;
  reasoning: boolean;
  vision: boolean;
  tools: boolean;
  supportsAutoRouter: boolean;
} {
  const lower = `${id} ${displayName}`.toLowerCase();

  // Tier & Reasoning
  let routingTier: RoutingClass = 'smart';
  let reasoningEffort: ReasoningEffort | undefined;
  let reasoning = false;

  if (
    lower.includes('thought') ||
    lower.includes('think') ||
    lower.includes('r1') ||
    lower.includes('o1') ||
    lower.includes('o3') ||
    lower.includes('reason')
  ) {
    routingTier = 'reasoning';
    reasoningEffort = 'high';
    reasoning = true;
  } else if (
    lower.includes('mini') ||
    lower.includes('haiku') ||
    lower.includes('flash') ||
    lower.includes('small') ||
    lower.includes('fast') ||
    lower.includes('lite')
  ) {
    routingTier = 'fast';
    reasoningEffort = 'low';
    reasoning = false;
  }

  // Vision
  let vision = true;
  if (lower.includes('deepseek-r1') || lower.includes('o3-mini') || lower.includes('cursor-small')) {
    vision = false;
  }

  // Tools
  let tools = true;
  if (lower.includes('deepseek-r1')) {
    tools = false;
  }

  // Runtime
  let runtime: ModelRuntimeTarget = 'cloud';
  if (lower.includes('local') || lower.includes('small') || lower.includes('on-device')) {
    runtime = 'local';
  } else if (id === 'auto' || lower.includes('cursor-fast')) {
    runtime = 'both';
  }

  return {
    runtime,
    routingTier,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    reasoning,
    vision,
    tools,
    supportsAutoRouter: true,
  };
}

export function toDiscoveredModel(item: SDKModel | { id: string; displayName?: string }): DiscoveredModel {
  const id = item.id;
  const displayName = item.displayName ?? id;
  const inferred = inferCapabilities(id, displayName);
  const sdkItem = item as SDKModel;

  return {
    id,
    displayName,
    ...(sdkItem.description !== undefined ? { description: sdkItem.description } : {}),
    ...(sdkItem.aliases !== undefined ? { aliases: sdkItem.aliases } : {}),
    ...(sdkItem.parameters !== undefined ? { parameters: sdkItem.parameters } : {}),
    ...(sdkItem.variants !== undefined ? { variants: sdkItem.variants } : {}),
    runtime: inferred.runtime,
    routingTier: inferred.routingTier,
    ...(inferred.reasoningEffort !== undefined ? { reasoningEffort: inferred.reasoningEffort } : {}),
    capabilities: {
      reasoning: inferred.reasoning,
      vision: inferred.vision,
      tools: inferred.tools,
      supportsAutoRouter: inferred.supportsAutoRouter,
    },
    isAccountVisible: true,
  };
}

/**
 * Discovers available models via Cursor SDK with local caching and offline fallback.
 */
export async function discoverCursorModels(
  options?: ModelDiscoveryOptions
): Promise<ModelCatalogCache> {
  const workspace = options?.workspace ?? process.cwd();

  // 1. Check cache first unless forced
  if (!options?.forceRefresh) {
    const cached = readModelCache(workspace);
    if (cached) {
      return cached;
    }
  }

  const sdkVersion = getCursorSdkVersion();
  const ttlMs = options?.ttlMs ?? DEFAULT_CACHE_TTL_MS;

  // 2. Query live SDK
  try {
    let client = options?.sdkClient;
    if (!client) {
      try {
        const sdk = await import('@cursor/sdk');
        client = sdk.Cursor;
      } catch {
        client = undefined;
      }
    }
    if (!client) {
      throw new Error('Cursor SDK (@cursor/sdk) is not available in runtime environment');
    }
    const sdkModels = await client.models.list();
    if (Array.isArray(sdkModels) && sdkModels.length > 0) {
      const modelsMap = new Map<string, DiscoveredModel>();

      // Ensure Cursor Router auto mode is always present
      modelsMap.set('auto', DEFAULT_CURSOR_MODELS_CATALOG[0]!);

      for (const raw of sdkModels) {
        if (typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string') {
          const discovered = toDiscoveredModel(raw as SDKModel);
          modelsMap.set(discovered.id, discovered);
        }
      }

      const cache: ModelCatalogCache = {
        schema_version: 1,
        sdkVersion,
        cachedAt: new Date().toISOString(),
        ttlMs,
        accountVisible: true,
        models: Array.from(modelsMap.values()),
      };

      writeModelCache(cache, workspace);
      return cache;
    }
  } catch (error) {
    // 3. Live discovery failed; check expired cache or fallback
    const expiredCache = readModelCache(workspace, { ignoreExpiry: true });
    if (expiredCache && expiredCache.accountVisible) {
      return expiredCache;
    }

    const fallbackReason = error instanceof Error ? error.message : String(error);
    const fallbackCache: ModelCatalogCache = {
      schema_version: 1,
      sdkVersion,
      cachedAt: new Date().toISOString(),
      ttlMs,
      accountVisible: false,
      fallbackReason: `SDK_DISCOVERY_FALLBACK: ${fallbackReason}`,
      models: [...DEFAULT_CURSOR_MODELS_CATALOG],
    };

    writeModelCache(fallbackCache, workspace);
    return fallbackCache;
  }

  // Default fallback if empty list returned
  const defaultCache: ModelCatalogCache = {
    schema_version: 1,
    sdkVersion,
    cachedAt: new Date().toISOString(),
    ttlMs,
    accountVisible: false,
    fallbackReason: 'SDK_EMPTY_LIST',
    models: [...DEFAULT_CURSOR_MODELS_CATALOG],
  };
  writeModelCache(defaultCache, workspace);
  return defaultCache;
}

/**
 * Returns filtered list of Cursor models based on options and runtime.
 */
export async function listCursorModels(
  options?: ModelListFilter & ModelDiscoveryOptions
): Promise<readonly DiscoveredModel[]> {
  const cache = await discoverCursorModels(options);
  let models = cache.models;

  if (options?.runtime) {
    models = models.filter((m) => m.runtime === options.runtime || m.runtime === 'both');
  }
  if (options?.tier) {
    models = models.filter((m) => m.routingTier === options.tier);
  }
  if (options?.requiresVision) {
    models = models.filter((m) => m.capabilities.vision);
  }
  if (options?.requiresTools) {
    models = models.filter((m) => m.capabilities.tools);
  }
  if (options?.requiresReasoning) {
    models = models.filter((m) => m.capabilities.reasoning);
  }

  return models;
}

/**
 * Checks whether a specific model is available in the catalog.
 */
export async function isCursorModelAvailable(
  modelId: string,
  options?: ModelDiscoveryOptions
): Promise<boolean> {
  const trimmed = modelId.trim().toLowerCase();
  const cache = await discoverCursorModels(options);
  return cache.models.some(
    (m) =>
      m.id.toLowerCase() === trimmed ||
      m.aliases?.some((a) => a.toLowerCase() === trimmed)
  );
}
