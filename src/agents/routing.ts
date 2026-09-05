import { getAgentRole, resolveRoleAndProfile } from './catalog.js';
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
  fast: ['claude-3-5-haiku', 'gpt-4o-mini', 'gemini-2.0-flash'],
};

export interface RouteOptions {
  readonly profile?: string | undefined;
  readonly model?: string | undefined;
  readonly runtime?: 'local' | 'cloud' | undefined;
  readonly userOverrides?: Readonly<Record<string, string>> | undefined;
  readonly availableModels?: readonly string[] | undefined;
}

/**
 * Resolves the model routing for an agent persona following the strict 7-step precedence ladder.
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

  // 1. Explicit model request
  if (options?.model) {
    const requested = options.model.trim();
    history.push(`Step 1 (explicit_model): User requested explicit model '${requested}'`);
    return {
      agent: role.canonicalName,
      profile: profile.profileId,
      selectedModel: requested,
      selectedRuntime: runtime,
      routingTier: role.model.routingTier,
      reasoningEffort: role.model.reasoningEffort,
      resolutionStep: 'explicit_model',
      reason: `User explicitly specified model '${requested}'.`,
      history,
      routerCompatibility: true,
      availableModels: available,
    };
  }

  // 2. Exact role/profile constraint
  const profileModel = profile.modelOverride?.preferredModel;
  const roleExact = role.model.exactModelRequired ? role.model.preferredModel : undefined;
  const constraintModel = profileModel ?? roleExact;

  if (constraintModel) {
    history.push(`Step 2 (profile_constraint): Found constraint model '${constraintModel}' on profile '${profile.profileId}'`);
    if (available.includes(constraintModel)) {
      return {
        agent: role.canonicalName,
        profile: profile.profileId,
        selectedModel: constraintModel,
        selectedRuntime: runtime,
        routingTier: profile.modelOverride?.routingTier ?? role.model.routingTier,
        reasoningEffort: profile.modelOverride?.reasoningEffort ?? role.model.reasoningEffort,
        resolutionStep: 'profile_constraint',
        reason: `Selected model '${constraintModel}' from role/profile constraint.`,
        history,
        routerCompatibility: true,
        availableModels: available,
      };
    }
    history.push(`Step 2 (profile_constraint): Constraint model '${constraintModel}' not present in available models`);
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
      routingTier: role.model.routingTier,
      reasoningEffort: role.model.reasoningEffort,
      resolutionStep: 'user_override',
      reason: `Selected model '${overrideModel}' from user role override.`,
      history,
      routerCompatibility: true,
      availableModels: available,
    };
  }

  // 4. Category / Router policy
  const effectiveTier: RoutingClass = profile.modelOverride?.routingTier ?? role.model.routingTier;
  const preferredModel = profile.modelOverride?.preferredModel ?? role.model.preferredModel;
  history.push(`Step 4 (category_policy): Checking tier '${effectiveTier}' with preferred model '${preferredModel}'`);

  if (preferredModel && available.includes(preferredModel)) {
    return {
      agent: role.canonicalName,
      profile: profile.profileId,
      selectedModel: preferredModel,
      selectedRuntime: runtime,
      routingTier: effectiveTier,
      reasoningEffort: profile.modelOverride?.reasoningEffort ?? role.model.reasoningEffort,
      resolutionStep: 'category_policy',
      reason: `Selected preferred model '${preferredModel}' for tier '${effectiveTier}'.`,
      history,
      routerCompatibility: true,
      availableModels: available,
    };
  }

  // Check top model in current tier
  const tierModels = DEFAULT_CURSOR_MODELS[effectiveTier];
  const matchingTierModel = tierModels.find((m) => available.includes(m));
  if (matchingTierModel) {
    history.push(`Step 4 (category_policy): Selected tier default '${matchingTierModel}' for tier '${effectiveTier}'`);
    return {
      agent: role.canonicalName,
      profile: profile.profileId,
      selectedModel: matchingTierModel,
      selectedRuntime: runtime,
      routingTier: effectiveTier,
      reasoningEffort: profile.modelOverride?.reasoningEffort ?? role.model.reasoningEffort,
      resolutionStep: 'category_policy',
      reason: `Selected default Cursor Router model '${matchingTierModel}' for '${effectiveTier}' tier.`,
      history,
      routerCompatibility: true,
      availableModels: available,
    };
  }

  // 5. Compatible Cursor fallback tiers
  const fallbackTiers = role.model.fallbackTiers;
  history.push(`Step 5 (compatible_fallback): Checking fallback tiers: [${fallbackTiers.join(', ')}]`);
  for (const tier of fallbackTiers) {
    const fallbackModel = DEFAULT_CURSOR_MODELS[tier].find((m) => available.includes(m));
    if (fallbackModel) {
      history.push(`Step 5 (compatible_fallback): Matched fallback model '${fallbackModel}' in tier '${tier}'`);
      return {
        agent: role.canonicalName,
        profile: profile.profileId,
        selectedModel: fallbackModel,
        selectedRuntime: runtime,
        routingTier: tier,
        reasoningEffort: 'low',
        resolutionStep: 'compatible_fallback',
        reason: `Selected compatible fallback model '${fallbackModel}' in '${tier}' tier.`,
        history,
        routerCompatibility: true,
        availableModels: available,
      };
    }
  }

  // 6. External provider
  history.push('Step 6 (external_provider): External provider not explicitly configured');

  // 7. Unavailable
  history.push('Step 7 (unavailable): No compatible model could be resolved');
  return {
    agent: role.canonicalName,
    profile: profile.profileId,
    selectedModel: 'none',
    selectedRuntime: runtime,
    routingTier: effectiveTier,
    resolutionStep: 'unavailable',
    reason: `E_MODEL_UNAVAILABLE: No available model meets role '${role.canonicalName}' requirements.`,
    history,
    routerCompatibility: false,
    availableModels: available,
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
