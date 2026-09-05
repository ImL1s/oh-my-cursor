import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { resolveAgentRoute, explainAgentRoute, DEFAULT_CURSOR_MODELS } from '../../src/agents/routing.js';

describe('Cursor Model Router & Precedence Ladder (Issue #26)', () => {
  it('precedence step 1: honors explicit model request', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-architect');
    const route = resolveAgentRoute(role, profile, { model: 'custom-fine-tuned-model' });

    expect(route.resolutionStep).toBe('explicit_model');
    expect(route.selectedModel).toBe('custom-fine-tuned-model');
  });

  it('precedence step 2: honors exact profile constraint', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-architect', 'omo-oracle');
    const route = resolveAgentRoute(role, profile);

    expect(route.routingTier).toBe('reasoning');
    expect(route.selectedModel).toBe('claude-3-7-sonnet-thought');
  });

  it('precedence step 3: honors user / project role override', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-planner');
    const route = resolveAgentRoute(role, profile, {
      userOverrides: {
        'omcu-planner': 'gpt-4o',
      },
    });

    expect(route.resolutionStep).toBe('user_override');
    expect(route.selectedModel).toBe('gpt-4o');
  });

  it('precedence step 4: falls back to category tier default when preferred model is absent', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-writer');
    // Simulate available models without preferred claude-3-5-haiku
    const available = ['gpt-4o-mini', 'gemini-2.0-flash'];
    const route = resolveAgentRoute(role, profile, { availableModels: available });

    expect(route.resolutionStep).toBe('category_policy');
    expect(route.selectedModel).toBe('gpt-4o-mini');
  });

  it('precedence step 5: falls back to compatible tiers when tier has no models', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-executor');
    // Executor is smart tier with fallback to fast. Provide only fast models.
    const available = ['claude-3-5-haiku'];
    const route = resolveAgentRoute(role, profile, { availableModels: available });

    expect(route.resolutionStep).toBe('compatible_fallback');
    expect(route.selectedModel).toBe('claude-3-5-haiku');
    expect(route.routingTier).toBe('fast');
  });

  it('precedence step 7: reports unavailable when zero matching models exist', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-architect');
    const route = resolveAgentRoute(role, profile, { availableModels: [] });

    expect(route.resolutionStep).toBe('unavailable');
    expect(route.selectedModel).toBe('none');
    expect(route.routerCompatibility).toBe(false);
  });

  it('explains agent route clearly for CLI consumers', () => {
    const explanation = explainAgentRoute('omcu-executor', { profile: 'omo-junior' });

    expect(explanation.agent).toBe('omcu-executor');
    expect(explanation.profile).toBe('omo-junior');
    expect(explanation.routingTier).toBe('fast');
    expect(explanation.history.length).toBeGreaterThanOrEqual(1);
  });
});
