import { describe, expect, it } from 'vitest';
import {
  PRESET_CATEGORIES,
  resolveCategoryPolicy,
} from '../../src/routing/categories.js';

describe('Semantic Category Presets (Issue #31)', () => {
  const REQUIRED_CATEGORIES = [
    'visual-engineering',
    'ultrabrain',
    'deep',
    'artistry',
    'quick',
    'unspecified-low',
    'unspecified-high',
    'writing',
    'architecture',
    'planning',
    'execution',
    'research',
    'review',
    'security',
    'QA/testing',
    'product/UX',
    'documentation',
    'data/analysis',
  ];

  it('defines all 18 specified category policy presets', () => {
    expect(PRESET_CATEGORIES.length).toBe(18);
    for (const requiredId of REQUIRED_CATEGORIES) {
      const preset = PRESET_CATEGORIES.find((p) => p.id === requiredId);
      expect(preset, `Preset '${requiredId}' should exist`).toBeDefined();
      expect(preset?.routingTier).toMatch(/^(reasoning|smart|fast)$/);
      expect(preset?.fallbackTiers.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('normalizes category lookups across case, slashes, and dashes', () => {
    // Exact
    expect(resolveCategoryPolicy('ultrabrain')?.id).toBe('ultrabrain');
    // Case-insensitive
    expect(resolveCategoryPolicy('ULTRABRAIN')?.id).toBe('ultrabrain');

    // QA/testing variations
    expect(resolveCategoryPolicy('QA/testing')?.id).toBe('QA/testing');
    expect(resolveCategoryPolicy('qa/testing')?.id).toBe('QA/testing');
    expect(resolveCategoryPolicy('qa-testing')?.id).toBe('QA/testing');
    expect(resolveCategoryPolicy('qa')?.id).toBe('QA/testing');

    // Product/UX variations
    expect(resolveCategoryPolicy('product/UX')?.id).toBe('product/UX');
    expect(resolveCategoryPolicy('product-ux')?.id).toBe('product/UX');
    expect(resolveCategoryPolicy('ux')?.id).toBe('product/UX');

    // Data/analysis variations
    expect(resolveCategoryPolicy('data/analysis')?.id).toBe('data/analysis');
    expect(resolveCategoryPolicy('data-analysis')?.id).toBe('data/analysis');
    expect(resolveCategoryPolicy('analytics')?.id).toBe('data/analysis');
  });

  it('declares vision requirement for visual-engineering, artistry, and product/UX', () => {
    expect(resolveCategoryPolicy('visual-engineering')?.requiresVision).toBe(true);
    expect(resolveCategoryPolicy('artistry')?.requiresVision).toBe(true);
    expect(resolveCategoryPolicy('product/UX')?.requiresVision).toBe(true);
    expect(resolveCategoryPolicy('ultrabrain')?.requiresVision).toBe(false);
  });

  it('declares high reasoning effort for ultrabrain, deep, architecture, review, security', () => {
    expect(resolveCategoryPolicy('ultrabrain')?.reasoningEffort).toBe('high');
    expect(resolveCategoryPolicy('deep')?.reasoningEffort).toBe('high');
    expect(resolveCategoryPolicy('architecture')?.reasoningEffort).toBe('high');
    expect(resolveCategoryPolicy('review')?.reasoningEffort).toBe('high');
    expect(resolveCategoryPolicy('security')?.reasoningEffort).toBe('high');
  });

  it('declares fast low-latency tier for quick, documentation, and unspecified-low', () => {
    expect(resolveCategoryPolicy('quick')?.routingTier).toBe('fast');
    expect(resolveCategoryPolicy('documentation')?.routingTier).toBe('fast');
    expect(resolveCategoryPolicy('unspecified-low')?.routingTier).toBe('fast');
  });
});
