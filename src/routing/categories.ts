import type { ReasoningEffort, RoutingClass } from '../agents/types.js';

export interface CategoryPolicy {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly routingTier: RoutingClass;
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly requiresVision?: boolean | undefined;
  readonly requiresTools?: boolean | undefined;
  readonly runtimePreference?: 'local' | 'cloud' | 'either' | undefined;
  readonly latencyCostPreference?:
    | 'low-latency'
    | 'low-cost'
    | 'balanced'
    | 'high-capability'
    | undefined;
  readonly preferredModel?: string | undefined;
  readonly fallbackTiers: readonly RoutingClass[];
  readonly routerMode?: 'auto' | 'exact' | 'tiered' | undefined;
  readonly aliases: readonly string[];
}

export const PRESET_CATEGORIES: readonly CategoryPolicy[] = [
  {
    id: 'visual-engineering',
    name: 'Visual Engineering',
    description: 'Frontend UI/UX design and visual implementation requiring vision and tool precision',
    routingTier: 'smart',
    reasoningEffort: 'medium',
    requiresVision: true,
    requiresTools: true,
    runtimePreference: 'cloud',
    latencyCostPreference: 'balanced',
    preferredModel: 'claude-3-5-sonnet',
    fallbackTiers: ['smart', 'reasoning'],
    routerMode: 'auto',
    aliases: ['visual_engineering', 'visualengineering', 'ui-engineering'],
  },
  {
    id: 'ultrabrain',
    name: 'Ultrabrain',
    description: 'Maximum-depth reasoning for complex algorithms, hard bugs, and system architecture',
    routingTier: 'reasoning',
    reasoningEffort: 'high',
    requiresVision: false,
    requiresTools: true,
    runtimePreference: 'cloud',
    latencyCostPreference: 'high-capability',
    preferredModel: 'claude-3-7-sonnet-thought',
    fallbackTiers: ['reasoning', 'smart'],
    routerMode: 'tiered',
    aliases: ['ultra-brain', 'ultrabrain-reasoning', 'heavy-reasoning'],
  },
  {
    id: 'deep',
    name: 'Deep Reasoning',
    description: 'Specialized deep analytical reasoning for mathematical or logic-dense specifications',
    routingTier: 'reasoning',
    reasoningEffort: 'high',
    requiresVision: false,
    requiresTools: true,
    runtimePreference: 'cloud',
    latencyCostPreference: 'high-capability',
    preferredModel: 'o3-mini',
    fallbackTiers: ['reasoning', 'smart'],
    routerMode: 'tiered',
    aliases: ['deep-reasoning', 'deepthink'],
  },
  {
    id: 'artistry',
    name: 'Artistry',
    description: 'Creative design, styling, and visual nuance exploration',
    routingTier: 'smart',
    reasoningEffort: 'medium',
    requiresVision: true,
    requiresTools: true,
    runtimePreference: 'cloud',
    latencyCostPreference: 'balanced',
    preferredModel: 'claude-3-5-sonnet',
    fallbackTiers: ['smart', 'fast'],
    routerMode: 'auto',
    aliases: ['creative', 'styling', 'visual-art'],
  },
  {
    id: 'quick',
    name: 'Quick',
    description: 'Ultra-low latency operations, small edits, and rapid sanity checks',
    routingTier: 'fast',
    reasoningEffort: 'low',
    requiresVision: false,
    requiresTools: true,
    runtimePreference: 'either',
    latencyCostPreference: 'low-latency',
    preferredModel: 'claude-3-5-haiku',
    fallbackTiers: ['fast', 'smart'],
    routerMode: 'auto',
    aliases: ['fast', 'speed', 'rapid'],
  },
  {
    id: 'unspecified-low',
    name: 'Unspecified Low Cost',
    description: 'Budget-conscious execution when model requirements are minimal',
    routingTier: 'fast',
    reasoningEffort: 'low',
    requiresVision: false,
    requiresTools: true,
    runtimePreference: 'either',
    latencyCostPreference: 'low-cost',
    preferredModel: 'gpt-4o-mini',
    fallbackTiers: ['fast', 'smart'],
    routerMode: 'auto',
    aliases: ['unspecified_low', 'low-tier', 'economy'],
  },
  {
    id: 'unspecified-high',
    name: 'Unspecified High Capability',
    description: 'Balanced high-capability default when role does not specify exact constraints',
    routingTier: 'smart',
    reasoningEffort: 'medium',
    requiresVision: true,
    requiresTools: true,
    runtimePreference: 'cloud',
    latencyCostPreference: 'balanced',
    preferredModel: 'claude-3-5-sonnet',
    fallbackTiers: ['smart', 'reasoning'],
    routerMode: 'auto',
    aliases: ['unspecified_high', 'high-tier', 'general'],
  },
  {
    id: 'writing',
    name: 'Writing & Editorial',
    description: 'Prose, documentation drafting, changelogs, and user-facing communications',
    routingTier: 'smart',
    reasoningEffort: 'low',
    requiresVision: false,
    requiresTools: false,
    runtimePreference: 'cloud',
    latencyCostPreference: 'balanced',
    preferredModel: 'claude-3-5-sonnet',
    fallbackTiers: ['smart', 'fast'],
    routerMode: 'auto',
    aliases: ['prose', 'editorial', 'copywriting'],
  },
  {
    id: 'architecture',
    name: 'Architecture',
    description: 'System design, boundary specification, interface contracts, and module decomposition',
    routingTier: 'reasoning',
    reasoningEffort: 'high',
    requiresVision: false,
    requiresTools: true,
    runtimePreference: 'cloud',
    latencyCostPreference: 'high-capability',
    preferredModel: 'claude-3-7-sonnet-thought',
    fallbackTiers: ['reasoning', 'smart'],
    routerMode: 'tiered',
    aliases: ['sys-arch', 'system-design'],
  },
  {
    id: 'planning',
    name: 'Planning',
    description: 'Multi-step goal breakdown, dependency DAG ordering, and milestone planning',
    routingTier: 'reasoning',
    reasoningEffort: 'medium',
    requiresVision: false,
    requiresTools: true,
    runtimePreference: 'cloud',
    latencyCostPreference: 'balanced',
    preferredModel: 'claude-3-7-sonnet-thought',
    fallbackTiers: ['reasoning', 'smart'],
    routerMode: 'tiered',
    aliases: ['planner', 'roadmap'],
  },
  {
    id: 'execution',
    name: 'Execution',
    description: 'Core software engineering, code changes, and mechanical implementation',
    routingTier: 'smart',
    reasoningEffort: 'low',
    requiresVision: false,
    requiresTools: true,
    runtimePreference: 'cloud',
    latencyCostPreference: 'balanced',
    preferredModel: 'claude-3-5-sonnet',
    fallbackTiers: ['smart', 'fast'],
    routerMode: 'auto',
    aliases: ['coder', 'developer', 'implementer'],
  },
  {
    id: 'research',
    name: 'Research & Reconnaissance',
    description: 'Deep codebase investigation, upstream API research, and fact verification',
    routingTier: 'reasoning',
    reasoningEffort: 'medium',
    requiresVision: false,
    requiresTools: true,
    runtimePreference: 'cloud',
    latencyCostPreference: 'balanced',
    preferredModel: 'claude-3-7-sonnet-thought',
    fallbackTiers: ['reasoning', 'smart'],
    routerMode: 'tiered',
    aliases: ['investigation', 'explore', 'deepsearch'],
  },
  {
    id: 'review',
    name: 'Review & Audit',
    description: 'Rigorous code review, invariants verification, and defect detection',
    routingTier: 'reasoning',
    reasoningEffort: 'high',
    requiresVision: false,
    requiresTools: true,
    runtimePreference: 'cloud',
    latencyCostPreference: 'high-capability',
    preferredModel: 'claude-3-7-sonnet-thought',
    fallbackTiers: ['reasoning', 'smart'],
    routerMode: 'tiered',
    aliases: ['code-review', 'critic', 'audit'],
  },
  {
    id: 'security',
    name: 'Security & Vulnerability Analysis',
    description: 'Security auditing, attack vector modeling, boundary taint analysis',
    routingTier: 'reasoning',
    reasoningEffort: 'high',
    requiresVision: false,
    requiresTools: true,
    runtimePreference: 'cloud',
    latencyCostPreference: 'high-capability',
    preferredModel: 'o3-mini',
    fallbackTiers: ['reasoning', 'smart'],
    routerMode: 'tiered',
    aliases: ['sec', 'infosec', 'pentest'],
  },
  {
    id: 'QA/testing',
    name: 'QA & Testing',
    description: 'Test case generation, fixture construction, edge case exploration, and regression testing',
    routingTier: 'smart',
    reasoningEffort: 'medium',
    requiresVision: false,
    requiresTools: true,
    runtimePreference: 'cloud',
    latencyCostPreference: 'balanced',
    preferredModel: 'claude-3-5-sonnet',
    fallbackTiers: ['smart', 'fast'],
    routerMode: 'auto',
    aliases: ['qa', 'testing', 'qa/testing', 'qa-testing', 'qa_testing'],
  },
  {
    id: 'product/UX',
    name: 'Product & UX',
    description: 'User experience flows, user journey analysis, and product requirements refinement',
    routingTier: 'smart',
    reasoningEffort: 'medium',
    requiresVision: true,
    requiresTools: false,
    runtimePreference: 'cloud',
    latencyCostPreference: 'balanced',
    preferredModel: 'claude-3-5-sonnet',
    fallbackTiers: ['smart', 'fast'],
    routerMode: 'auto',
    aliases: ['product', 'ux', 'product/ux', 'product-ux', 'product_ux'],
  },
  {
    id: 'documentation',
    name: 'Documentation',
    description: 'Reference docs, API guides, READMEs, and technical tutorials',
    routingTier: 'fast',
    reasoningEffort: 'low',
    requiresVision: false,
    requiresTools: true,
    runtimePreference: 'either',
    latencyCostPreference: 'low-latency',
    preferredModel: 'claude-3-5-haiku',
    fallbackTiers: ['fast', 'smart'],
    routerMode: 'auto',
    aliases: ['docs', 'manuals', 'technical-writing'],
  },
  {
    id: 'data/analysis',
    name: 'Data & Analysis',
    description: 'Metrics analysis, benchmark interpretation, logs aggregation, and structured data synthesis',
    routingTier: 'smart',
    reasoningEffort: 'medium',
    requiresVision: false,
    requiresTools: true,
    runtimePreference: 'cloud',
    latencyCostPreference: 'balanced',
    preferredModel: 'gpt-4o',
    fallbackTiers: ['smart', 'reasoning'],
    routerMode: 'auto',
    aliases: ['data', 'analytics', 'data/analysis', 'data-analysis', 'data_analysis'],
  },
];

/**
 * Resolves a semantic category policy preset by canonical ID or alias.
 * Handles case-insensitivity, forward slashes, and dashes.
 */
export function resolveCategoryPolicy(categoryName: string): CategoryPolicy | undefined {
  if (!categoryName || typeof categoryName !== 'string') return undefined;
  const normalized = categoryName.trim().toLowerCase();

  for (const preset of PRESET_CATEGORIES) {
    if (preset.id.toLowerCase() === normalized) {
      return preset;
    }
    // Check without slash/dash variations
    const presetIdNormalized = preset.id.toLowerCase().replace(/[/_-]/g, '');
    const queryNormalized = normalized.replace(/[/_-]/g, '');
    if (presetIdNormalized === queryNormalized) {
      return preset;
    }
    if (preset.aliases.some((a) => a.toLowerCase() === normalized || a.toLowerCase().replace(/[/_-]/g, '') === queryNormalized)) {
      return preset;
    }
  }

  return undefined;
}
