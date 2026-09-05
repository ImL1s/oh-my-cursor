import { getAgentRole, resolveRoleAndProfile } from './catalog.js';
import { resolveCategoryPolicy, type CategoryPolicy } from '../routing/categories.js';
import type {
  AgentRoleDefinition,
  ReasoningEffort,
  RouteExplanation,
  RouteResolutionStep,
  RoutingClass,
  SourceProfile,
} from './types.js';

export const DEFAULT_CURSOR_MODELS: Record<RoutingClass, readonly string[]> = {
  reasoning: ['claude-3-7-sonnet-thought', 'o3-mini', 'o1', 'deepseek-r1'],
  smart: ['claude-3-5-sonnet', 'gpt-4o', 'gemini-2.0-pro'],
  fast: ['claude-3-5-haiku', 'gpt-4o-mini', 'gemini-2.0-flash', 'cursor-small'],
};

export interface RouteOptions {
  readonly profile?: string | undefined;
  readonly model?: string | undefined;
  readonly runtime?: 'local' | 'cloud' | 'external' | undefined;
  readonly category?: string | undefined;
  readonly provider?: string | undefined;
  readonly externalProvider?: string | undefined;
  readonly externalModel?: string | undefined;
  readonly userOverrides?: Readonly<Record<string, string>> | undefined;
  readonly availableModels?: readonly string[] | undefined;
  readonly strictModelCheck?: boolean | undefined;
  readonly requiresVision?: boolean | undefined;
  readonly requiresTools?: boolean | undefined;
}

export function defaultModelForProvider(provider: string): string {
  const p = provider.trim().toLowerCase();
  switch (p) {
    case 'claude':
      return 'claude-3-7-sonnet';
    case 'codex':
      return 'o3-mini';
    case 'gemini':
      return 'gemini-2.0-pro';
    case 'antigravity':
    case 'agy':
      return 'gemini-2.0-pro';
    case 'grok':
      return 'grok-3';
    case 'opencode':
    case 'omo':
      return 'opencode-default';
    case 'cursor':
      return 'claude-3-5-sonnet';
    default:
      return 'default';
  }
}

function modelSupportsCapabilities(
  modelId: string,
  requirements: {
    readonly requiresVision?: boolean | undefined;
    readonly requiresTools?: boolean | undefined;
    readonly runtime?: 'local' | 'cloud' | 'external' | undefined;
  }
): boolean {
  const lower = modelId.toLowerCase();
  if (requirements.requiresVision) {
    if (lower.includes('deepseek-r1') || lower.includes('o3-mini') || lower.includes('cursor-small')) {
      return false;
    }
  }
  if (requirements.requiresTools) {
    if (lower.includes('deepseek-r1')) {
      return false;
    }
  }
  if (requirements.runtime === 'local') {
    if (!lower.includes('local') && !lower.includes('cursor-small') && lower !== 'auto') {
      return false;
    }
  }
  return true;
}

/**
 * Resolves the model routing for an agent persona following the strict 7-step precedence ladder.
 *
 * 1. explicit Cursor model/runtime override
 * 2. exact OMCU role/profile requirement
 * 3. project/user OMCU agent override
 * 4. Cursor category/router policy
 * 5. ordered compatible Cursor fallback
 * 6. explicit external provider only when invocation/profile requested it
 * 7. unavailable result
 *
 * Enforces invariant: No fallback may change provider/runtime identity silently.
 */
export function resolveAgentRoute(
  role: AgentRoleDefinition,
  profile: SourceProfile,
  options?: RouteOptions
): RouteExplanation {
  const history: string[] = [];
  const runtime = options?.runtime ?? (role.eligibility.cloud ? 'cloud' : 'local');
  const available = options?.availableModels ?? [
    ...DEFAULT_CURSOR_MODELS.reasoning,
    ...DEFAULT_CURSOR_MODELS.smart,
    ...DEFAULT_CURSOR_MODELS.fast,
  ];

  // Resolve category preset if specified or from role
  const categoryPreset: CategoryPolicy | undefined = options?.category
    ? resolveCategoryPolicy(options.category)
    : resolveCategoryPolicy(role.category);

  // 1. Explicit Cursor model request
  const isExplicitExternal = Boolean(
    (options?.provider && options.provider.trim().toLowerCase() !== 'cursor') ||
    options?.externalProvider
  );

  if (options?.model && !isExplicitExternal) {
    const requested = options.model.trim();
    history.push(`Step 1 (explicit_model): User requested explicit model '${requested}'`);

    // Strict availability check if requested
    if (options.strictModelCheck && options.availableModels && !options.availableModels.includes(requested)) {
      history.push(`Step 1 (explicit_model): Requested model '${requested}' unavailable under strict check`);
      return {
        agent: role.canonicalName,
        profile: profile.profileId,
        selectedModel: 'none',
        selectedRuntime: runtime,
        selectedProvider: 'cursor',
        routingTier: role.model.routingTier,
        reasoningEffort: role.model.reasoningEffort,
        resolutionStep: 'unavailable',
        reason: `E_MODEL_UNAVAILABLE: Explicit model '${requested}' is not available.`,
        history,
        routerCompatibility: false,
        availableModels: available,
        category: categoryPreset?.id,
      };
    }

    return {
      agent: role.canonicalName,
      profile: profile.profileId,
      selectedModel: requested,
      selectedRuntime: runtime,
      selectedProvider: 'cursor',
      routingTier: role.model.routingTier,
      reasoningEffort: role.model.reasoningEffort,
      resolutionStep: 'explicit_model',
      reason: `User explicitly specified model '${requested}'.`,
      history,
      routerCompatibility: true,
      availableModels: available,
      category: categoryPreset?.id,
    };
  }

  // 2. Exact role/profile constraint
  const profileModel = profile.modelOverride?.preferredModel;
  const roleExact = role.model.exactModelRequired ? role.model.preferredModel : undefined;
  const constraintModel = roleExact ?? (!isExplicitExternal ? profileModel : undefined);

  if (constraintModel) {
    history.push(`Step 2 (profile_constraint): Found constraint model '${constraintModel}' on profile '${profile.profileId}'`);
    if (available.includes(constraintModel)) {
      return {
        agent: role.canonicalName,
        profile: profile.profileId,
        selectedModel: constraintModel,
        selectedRuntime: runtime,
        selectedProvider: 'cursor',
        routingTier: profile.modelOverride?.routingTier ?? role.model.routingTier,
        reasoningEffort: profile.modelOverride?.reasoningEffort ?? role.model.reasoningEffort,
        resolutionStep: 'profile_constraint',
        reason: `Selected model '${constraintModel}' from role/profile constraint.`,
        history,
        routerCompatibility: true,
        availableModels: available,
        category: categoryPreset?.id,
      };
    }

    history.push(`Step 2 (profile_constraint): Constraint model '${constraintModel}' not present in available models`);
    // If exact model is strictly required, do NOT fall back silently to other models
    if (role.model.exactModelRequired) {
      history.push(`Step 2 (profile_constraint): Exact model requirement cannot be relaxed`);
      return {
        agent: role.canonicalName,
        profile: profile.profileId,
        selectedModel: 'none',
        selectedRuntime: runtime,
        selectedProvider: 'cursor',
        routingTier: role.model.routingTier,
        reasoningEffort: role.model.reasoningEffort,
        resolutionStep: 'unavailable',
        reason: `E_MODEL_UNAVAILABLE: Exact model '${constraintModel}' required by role '${role.canonicalName}' is unavailable.`,
        history,
        routerCompatibility: false,
        availableModels: available,
        category: categoryPreset?.id,
      };
    }
  }

  // 3. User / Project role override
  const overrideKey = Object.keys(options?.userOverrides ?? {}).find(
    (k) =>
      k.toLowerCase() === role.canonicalName.toLowerCase() ||
      k.toLowerCase() === role.id.toLowerCase()
  );
  if (overrideKey && options?.userOverrides?.[overrideKey]) {
    const overrideModel = options.userOverrides[overrideKey]!;
    history.push(`Step 3 (user_override): Found user configuration override '${overrideModel}' for role '${role.canonicalName}'`);
    return {
      agent: role.canonicalName,
      profile: profile.profileId,
      selectedModel: overrideModel,
      selectedRuntime: runtime,
      selectedProvider: 'cursor',
      routingTier: role.model.routingTier,
      reasoningEffort: role.model.reasoningEffort,
      resolutionStep: 'user_override',
      reason: `Selected model '${overrideModel}' from user role override.`,
      history,
      routerCompatibility: true,
      availableModels: available,
      category: categoryPreset?.id,
    };
  }

  // 4. Category / Router policy
  const effectiveTier: RoutingClass =
    options?.category && categoryPreset
      ? categoryPreset.routingTier
      : (profile.modelOverride?.routingTier ?? categoryPreset?.routingTier ?? role.model.routingTier);
  const preferredModel =
    options?.category && categoryPreset?.preferredModel
      ? categoryPreset.preferredModel
      : (profile.modelOverride?.preferredModel ?? categoryPreset?.preferredModel ?? role.model.preferredModel);
  const reasoningEffort =
    options?.category && categoryPreset?.reasoningEffort
      ? categoryPreset.reasoningEffort
      : (profile.modelOverride?.reasoningEffort ?? categoryPreset?.reasoningEffort ?? role.model.reasoningEffort);

  if (!isExplicitExternal) {
    history.push(
      `Step 4 (category_policy): Checking tier '${effectiveTier}' with preferred model '${preferredModel}' (category: '${categoryPreset?.id ?? 'default'}')`
    );

    const requiresVision = categoryPreset?.requiresVision ?? options?.requiresVision;
    const requiresTools = categoryPreset?.requiresTools ?? options?.requiresTools;

    if (
      preferredModel &&
      available.includes(preferredModel) &&
      modelSupportsCapabilities(preferredModel, { requiresVision, requiresTools, runtime })
    ) {
      return {
        agent: role.canonicalName,
        profile: profile.profileId,
        selectedModel: preferredModel,
        selectedRuntime: runtime,
        selectedProvider: 'cursor',
        routingTier: effectiveTier,
        reasoningEffort,
        resolutionStep: 'category_policy',
        reason: `Selected preferred model '${preferredModel}' for tier '${effectiveTier}'.`,
        history,
        routerCompatibility: true,
        availableModels: available,
        category: categoryPreset?.id,
      };
    }

    // Check top model in current tier satisfying capabilities
    const tierModels = DEFAULT_CURSOR_MODELS[effectiveTier];
    const matchingTierModel = tierModels.find(
      (m) => available.includes(m) && modelSupportsCapabilities(m, { requiresVision, requiresTools, runtime })
    );
    if (matchingTierModel) {
      history.push(`Step 4 (category_policy): Selected tier default '${matchingTierModel}' for tier '${effectiveTier}'`);
      return {
        agent: role.canonicalName,
        profile: profile.profileId,
        selectedModel: matchingTierModel,
        selectedRuntime: runtime,
        selectedProvider: 'cursor',
        routingTier: effectiveTier,
        reasoningEffort,
        resolutionStep: 'category_policy',
        reason: `Selected default Cursor Router model '${matchingTierModel}' for '${effectiveTier}' tier.`,
        history,
        routerCompatibility: true,
        availableModels: available,
        category: categoryPreset?.id,
      };
    }

    // 5. Compatible Cursor fallback tiers
    const fallbackTiers = categoryPreset?.fallbackTiers ?? role.model.fallbackTiers;
    history.push(`Step 5 (compatible_fallback): Checking fallback tiers: [${fallbackTiers.join(', ')}]`);
    for (const tier of fallbackTiers) {
      const tierCandidateModels = DEFAULT_CURSOR_MODELS[tier];
      for (const candidate of tierCandidateModels) {
        if (!available.includes(candidate)) continue;

        // Skip capability-incompatible models
        if (!modelSupportsCapabilities(candidate, { requiresVision, requiresTools, runtime })) {
          history.push(`Step 5 (compatible_fallback): Skipped incompatible model '${candidate}' in tier '${tier}'`);
          continue;
        }

        history.push(`Step 5 (compatible_fallback): Matched compatible fallback model '${candidate}' in tier '${tier}'`);
        return {
          agent: role.canonicalName,
          profile: profile.profileId,
          selectedModel: candidate,
          selectedRuntime: runtime,
          selectedProvider: 'cursor',
          routingTier: tier,
          reasoningEffort: 'low',
          resolutionStep: 'compatible_fallback',
          reason: `Selected compatible fallback model '${candidate}' in '${tier}' tier.`,
          history,
          routerCompatibility: true,
          availableModels: available,
          category: categoryPreset?.id,
        };
      }
    }
  } else {
    history.push('Step 4 (category_policy): Skipped for explicit external provider');
    history.push('Step 5 (compatible_fallback): Skipped for explicit external provider');
  }

  // 6. Explicit external provider ONLY when requested
  const explicitProvider = options?.provider ?? options?.externalProvider;
  if (explicitProvider && explicitProvider.trim().toLowerCase() !== 'cursor') {
    const targetProvider = explicitProvider.trim().toLowerCase();
    const targetModel = options?.externalModel ?? options?.model ?? defaultModelForProvider(targetProvider);
    history.push(`Step 6 (external_provider): Explicit external provider '${targetProvider}' requested with model '${targetModel}'`);
    return {
      agent: role.canonicalName,
      profile: profile.profileId,
      selectedModel: targetModel,
      selectedRuntime: 'external',
      selectedProvider: targetProvider,
      routingTier: effectiveTier,
      reasoningEffort: role.model.reasoningEffort,
      resolutionStep: 'external_provider',
      reason: `Selected external provider '${targetProvider}' (model: '${targetModel}') by explicit request.`,
      history,
      routerCompatibility: false,
      availableModels: available,
      category: categoryPreset?.id,
    };
  }

  history.push('Step 6 (external_provider): External provider not explicitly configured; silent fallback forbidden');

  // 7. Unavailable
  history.push('Step 7 (unavailable): No compatible Cursor model meets role requirements');
  return {
    agent: role.canonicalName,
    profile: profile.profileId,
    selectedModel: 'none',
    selectedRuntime: runtime,
    selectedProvider: 'cursor',
    routingTier: effectiveTier,
    resolutionStep: 'unavailable',
    reason: `E_MODEL_UNAVAILABLE: No available Cursor model meets role '${role.canonicalName}' requirements.`,
    history,
    routerCompatibility: false,
    availableModels: available,
    category: categoryPreset?.id,
  };
}

/**
 * Public route explain utility for CLI and programmatic consumers.
 */
export function explainAgentRoute(
  roleName: string,
  options?: RouteOptions
): RouteExplanation {
  const { role, profile } = resolveRoleAndProfile(roleName, options?.profile);
  return resolveAgentRoute(role, profile, options);
}
