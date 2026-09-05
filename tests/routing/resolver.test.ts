import { describe, expect, it } from 'vitest';
import { resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { resolveAgentRoute, explainAgentRoute } from '../../src/agents/routing.js';

describe('Strict Cursor-First Precedence Ladder & Routing Resolver (Issue #31)', () => {
  it('Step 1: explicit model override takes top precedence', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-architect');
    const route = resolveAgentRoute(role, profile, { model: 'claude-3-5-sonnet' });

    expect(route.resolutionStep).toBe('explicit_model');
    expect(route.selectedModel).toBe('claude-3-5-sonnet');
    expect(route.selectedProvider).toBe('cursor');
  });

  it('Step 2: exact role requirement fails closed when unavailable in account', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-architect');
    // Simulate role with exactModelRequired: true
    const strictRole = {
      ...role,
      model: {
        ...role.model,
        exactModelRequired: true,
        preferredModel: 'exact-must-have-model',
      },
    };

    // available models missing the required model
    const route = resolveAgentRoute(strictRole, profile, {
      availableModels: ['claude-3-5-sonnet', 'gpt-4o'],
    });

    expect(route.resolutionStep).toBe('unavailable');
    expect(route.selectedModel).toBe('none');
    expect(route.reason).toContain('E_MODEL_UNAVAILABLE');
    expect(route.reason).toContain('exact-must-have-model');
  });

  it('Step 3: user/project role override takes precedence over categories', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-planner');
    const route = resolveAgentRoute(role, profile, {
      userOverrides: {
        'omcu-planner': 'gpt-4o',
      },
    });

    expect(route.resolutionStep).toBe('user_override');
    expect(route.selectedModel).toBe('gpt-4o');
  });

  it('Step 4: category policy presets map to appropriate tiers and models', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-executor');

    // Specify ultrabrain category override
    const ultrabrainRoute = resolveAgentRoute(role, profile, {
      category: 'ultrabrain',
    });
    expect(ultrabrainRoute.resolutionStep).toBe('category_policy');
    expect(ultrabrainRoute.routingTier).toBe('reasoning');
    expect(ultrabrainRoute.selectedModel).toBe('claude-3-7-sonnet-thought');

    // Specify quick category override
    const quickRoute = resolveAgentRoute(role, profile, {
      category: 'quick',
    });
    expect(quickRoute.resolutionStep).toBe('category_policy');
    expect(quickRoute.routingTier).toBe('fast');
    expect(quickRoute.selectedModel).toBe('claude-3-5-haiku');
  });

  it('Step 5: skips capability-incompatible models in fallback tiers', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-executor');
    // Executor tier is smart (claude-3-5-sonnet is cloud-only, so skipped for local).
    // Fallback tier is fast, where cursor-small supports local.
    const available = ['claude-3-5-sonnet', 'cursor-small'];

    // Require local runtime
    const localRoute = resolveAgentRoute(role, profile, {
      runtime: 'local',
      availableModels: available,
    });

    // cursor-small is in fast tier and supports local
    expect(localRoute.resolutionStep).toBe('compatible_fallback');
    expect(localRoute.selectedModel).toBe('cursor-small');
  });

  it('Step 6: external provider resolves ONLY when explicitly requested', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-executor');

    // Explicitly requested Claude external provider
    const externalRoute = resolveAgentRoute(role, profile, {
      provider: 'claude',
      model: 'claude-3-7-sonnet',
    });

    expect(externalRoute.resolutionStep).toBe('external_provider');
    expect(externalRoute.selectedProvider).toBe('claude');
    expect(externalRoute.selectedRuntime).toBe('external');
    expect(externalRoute.selectedModel).toBe('claude-3-7-sonnet');
  });

  it('Invariant: never silently falls back to external provider when Cursor models are unavailable', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-architect');

    // Empty Cursor models list; NO external provider requested
    const route = resolveAgentRoute(role, profile, {
      availableModels: [],
    });

    expect(route.resolutionStep).toBe('unavailable');
    expect(route.selectedModel).toBe('none');
    expect(route.selectedProvider).toBe('cursor');
    expect(route.history.some((h) => h.includes('silent fallback forbidden'))).toBe(true);
  });

  it('explains route with category and history for CLI', () => {
    const explanation = explainAgentRoute('omcu-architect', {
      category: 'security',
    });

    expect(explanation.agent).toBe('omcu-architect');
    expect(explanation.category).toBe('security');
    expect(explanation.routingTier).toBe('reasoning');
    expect(explanation.history.length).toBeGreaterThanOrEqual(1);
  });
});
