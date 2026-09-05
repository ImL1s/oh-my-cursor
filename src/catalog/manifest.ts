import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PACKAGE_VERSION } from '../version.js';
import type {
  AliasExplainReport,
  CatalogComponent,
  CatalogManifest,
  ComponentResolution,
  ComponentType,
  SupportTier,
} from './types.js';

interface RawComponentDef {
  readonly id: string;
  readonly type: ComponentType;
  readonly canonicalName: string;
  readonly nativeCursorPath: string;
  readonly fallbackPath?: string;
  readonly aliases: readonly string[];
  readonly pluginManifestEntry?: string;
  readonly sdkServiceEntry?: string;
  readonly supportTier: SupportTier;
  readonly description: string;
}

export const CANONICAL_COMPONENT_DEFS: readonly RawComponentDef[] = [
  // Skills
  {
    id: 'omcu-skill-autopilot',
    type: 'skill',
    canonicalName: 'omcu-autopilot',
    nativeCursorPath: 'skills/omcu-autopilot/SKILL.md',
    fallbackPath: 'skills/autopilot/SKILL.md',
    aliases: ['autopilot', 'omc_autopilot', 'omx_autopilot', 'omo_autopilot'],
    pluginManifestEntry: 'skills',
    sdkServiceEntry: 'autopilot',
    supportTier: 'composed',
    description: '[omcu:0.3.0] Complete a clear local task end to end with conservative automation.',
  },
  {
    id: 'omcu-skill-ralph',
    type: 'skill',
    canonicalName: 'omcu-ralph',
    nativeCursorPath: 'skills/omcu-ralph/SKILL.md',
    fallbackPath: 'skills/ralph/SKILL.md',
    aliases: ['ralph', 'omc_ralph', 'omx_ralph', 'omo_ralph'],
    pluginManifestEntry: 'skills',
    sdkServiceEntry: 'ralph',
    supportTier: 'composed',
    description: '[omcu:0.3.0] Self-referential loop until task completion with architect verification.',
  },
  {
    id: 'omcu-skill-ralplan',
    type: 'skill',
    canonicalName: 'omcu-ralplan',
    nativeCursorPath: 'skills/omcu-ralplan/SKILL.md',
    fallbackPath: 'skills/ralplan/SKILL.md',
    aliases: ['ralplan', 'omc_ralplan', 'omx_ralplan'],
    pluginManifestEntry: 'skills',
    sdkServiceEntry: 'ralplan',
    supportTier: 'composed',
    description: '[omcu:0.3.0] Strategic planning consensus across architect, critic, and verifier roles.',
  },
  {
    id: 'omcu-skill-ulw',
    type: 'skill',
    canonicalName: 'omcu-ulw',
    nativeCursorPath: 'skills/omcu-ulw/SKILL.md',
    fallbackPath: 'skills/ulw/SKILL.md',
    aliases: ['ulw', 'omc_ultrawork', 'omx_ultrawork', 'ultrawork'],
    pluginManifestEntry: 'skills',
    sdkServiceEntry: 'ulw',
    supportTier: 'composed',
    description: '[omcu:0.3.0] Parallel execution engine for high-throughput task completion.',
  },
  {
    id: 'omcu-skill-setup',
    type: 'skill',
    canonicalName: 'omcu-setup',
    nativeCursorPath: 'skills/omcu-setup/SKILL.md',
    fallbackPath: 'skills/setup/SKILL.md',
    aliases: ['setup', 'omx_setup'],
    pluginManifestEntry: 'skills',
    sdkServiceEntry: 'setup',
    supportTier: 'native',
    description: '[omcu:0.3.0] Set up and configure oh-my-cursor runtime and receipts.',
  },
  {
    id: 'omcu-skill-doctor',
    type: 'skill',
    canonicalName: 'omcu-doctor',
    nativeCursorPath: 'skills/omcu-doctor/SKILL.md',
    fallbackPath: 'skills/doctor/SKILL.md',
    aliases: ['doctor', 'omx_doctor'],
    pluginManifestEntry: 'skills',
    sdkServiceEntry: 'doctor',
    supportTier: 'native',
    description: '[omcu:0.3.0] Diagnose and report Cursor Agent environment, plugin, and journal status.',
  },
  {
    id: 'omcu-skill-resume',
    type: 'skill',
    canonicalName: 'omcu-resume',
    nativeCursorPath: 'skills/omcu-resume/SKILL.md',
    fallbackPath: 'skills/resume/SKILL.md',
    aliases: ['resume', 'omc_resume'],
    pluginManifestEntry: 'skills',
    sdkServiceEntry: 'resume',
    supportTier: 'native',
    description: '[omcu:0.3.0] Resume an existing Cursor Agent session by ID.',
  },
  {
    id: 'omcu-skill-recover',
    type: 'skill',
    canonicalName: 'omcu-recover',
    nativeCursorPath: 'skills/omcu-recover/SKILL.md',
    fallbackPath: 'skills/recover/SKILL.md',
    aliases: ['recover', 'omc_recover'],
    pluginManifestEntry: 'skills',
    sdkServiceEntry: 'recover',
    supportTier: 'native',
    description: '[omcu:0.3.0] Inspect or restore bounded immutable recovery snapshots.',
  },
  {
    id: 'omcu-skill-workflow',
    type: 'skill',
    canonicalName: 'omcu-workflow',
    nativeCursorPath: 'skills/omcu-workflow/SKILL.md',
    fallbackPath: 'skills/workflow/SKILL.md',
    aliases: ['workflow', 'omc_workflow'],
    pluginManifestEntry: 'skills',
    sdkServiceEntry: 'workflow',
    supportTier: 'composed',
    description: '[omcu:0.3.0] Multi-stage orchestrator with DAG leases and journal checkpoints.',
  },
  {
    id: 'omcu-skill-team',
    type: 'skill',
    canonicalName: 'omcu-team',
    nativeCursorPath: 'skills/omcu-team/SKILL.md',
    fallbackPath: 'skills/team/SKILL.md',
    aliases: ['team', 'omc_team', 'omx_team'],
    pluginManifestEntry: 'skills',
    sdkServiceEntry: 'team',
    supportTier: 'composed',
    description: '[omcu:0.3.0] Coordinated worker task leasing and mailbox dispatch.',
  },
  {
    id: 'omcu-skill-review',
    type: 'skill',
    canonicalName: 'omcu-review',
    nativeCursorPath: 'skills/omcu-review/SKILL.md',
    fallbackPath: 'skills/review/SKILL.md',
    aliases: ['review', 'omc_review', 'omx_code_review', 'code-review'],
    pluginManifestEntry: 'skills',
    sdkServiceEntry: 'review',
    supportTier: 'native',
    description: '[omcu:0.3.0] Independent code review pass against diffs and requirements.',
  },
  {
    id: 'omcu-skill-qa',
    type: 'skill',
    canonicalName: 'omcu-qa',
    nativeCursorPath: 'skills/omcu-qa/SKILL.md',
    fallbackPath: 'skills/qa/SKILL.md',
    aliases: ['qa', 'omc_qa', 'omx_ultraqa', 'ultraqa'],
    pluginManifestEntry: 'skills',
    sdkServiceEntry: 'qa',
    supportTier: 'composed',
    description: '[omcu:0.3.0] Adversarial dynamic test execution and failure reproduction.',
  },
  {
    id: 'omcu-skill-accept',
    type: 'skill',
    canonicalName: 'omcu-accept',
    nativeCursorPath: 'skills/omcu-accept/SKILL.md',
    fallbackPath: 'skills/accept/SKILL.md',
    aliases: ['accept', 'omc_accept'],
    pluginManifestEntry: 'skills',
    sdkServiceEntry: 'accept',
    supportTier: 'native',
    description: '[omcu:0.3.0] Verification gate check and task acceptance record.',
  },
  {
    id: 'omcu-skill-provenance-probe',
    type: 'skill',
    canonicalName: 'omcu-provenance-probe',
    nativeCursorPath: 'skills/omcu-provenance-probe/SKILL.md',
    aliases: ['probe', 'omcu-probe', 'provenance-probe'],
    pluginManifestEntry: 'skills',
    sdkServiceEntry: 'probe',
    supportTier: 'native',
    description: '[omcu:0.3.0] Unique OMCU provenance activation fixture.',
  },

  // Agents
  {
    id: 'omcu-agent-architect',
    type: 'agent',
    canonicalName: 'omcu-architect',
    nativeCursorPath: 'agents/omcu-architect.md',
    fallbackPath: 'agents/architect.md',
    aliases: ['architect', 'omc_architect', 'omx_architect', 'oracle', 'omo_oracle'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Evaluates architectural integrity, lifecycle boundaries, and system invariants.',
  },
  {
    id: 'omcu-agent-critic',
    type: 'agent',
    canonicalName: 'omcu-critic',
    nativeCursorPath: 'agents/omcu-critic.md',
    fallbackPath: 'agents/critic.md',
    aliases: ['critic', 'omc_critic', 'momus', 'omo_momus'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Adversarially critiques implementation plans, design documents, and diff proposals.',
  },
  {
    id: 'omcu-agent-debugger',
    type: 'agent',
    canonicalName: 'omcu-debugger',
    nativeCursorPath: 'agents/omcu-debugger.md',
    fallbackPath: 'agents/debugger.md',
    aliases: ['debugger', 'omc_debugger', 'omx_debugger'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Isolates regression causes, performs call stack analysis, and executes diagnostic tests.',
  },
  {
    id: 'omcu-agent-executor',
    type: 'agent',
    canonicalName: 'omcu-executor',
    nativeCursorPath: 'agents/omcu-executor.md',
    fallbackPath: 'agents/executor.md',
    aliases: ['executor', 'implementer', 'omcu-implementer', 'omc_executor', 'omx_executor', 'junior', 'omo_junior', 'hephaestus', 'omo_hephaestus'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Implements code modifications in compliance with architectural guidelines.',
  },
  {
    id: 'omcu-agent-planner',
    type: 'agent',
    canonicalName: 'omcu-planner',
    nativeCursorPath: 'agents/omcu-planner.md',
    fallbackPath: 'agents/planner.md',
    aliases: ['planner', 'omc_planner', 'omx_planner', 'prometheus', 'omo_prometheus'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Build a file-level implementation plan from repository evidence.',
  },
  {
    id: 'omcu-agent-reviewer',
    type: 'agent',
    canonicalName: 'omcu-reviewer',
    nativeCursorPath: 'agents/omcu-reviewer.md',
    fallbackPath: 'agents/reviewer.md',
    aliases: ['reviewer', 'omc_reviewer', 'omx_reviewer'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Review code changes for bugs, regression risk, and convention fit.',
  },
  {
    id: 'omcu-agent-verifier',
    type: 'agent',
    canonicalName: 'omcu-verifier',
    nativeCursorPath: 'agents/omcu-verifier.md',
    fallbackPath: 'agents/verifier.md',
    aliases: ['verifier', 'omc_verifier', 'omx_verifier'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Gatekeeper agent that verifies evidence before task completion.',
  },
  {
    id: 'omcu-agent-implementer',
    type: 'agent',
    canonicalName: 'omcu-implementer',
    nativeCursorPath: 'agents/omcu-implementer.md',
    fallbackPath: 'agents/implementer.md',
    aliases: ['implementer', 'executor-alias'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Execute scoped code changes according to plan.',
  },
  {
    id: 'omcu-agent-explorer',
    type: 'agent',
    canonicalName: 'omcu-explorer',
    nativeCursorPath: 'agents/omcu-explorer.md',
    fallbackPath: 'agents/explorer.md',
    aliases: ['explorer', 'explore', 'omcu-explore', 'omc_explore', 'omx_explore', 'hermes', 'omo_hermes'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Explore repository structure, patterns, and symbols.',
  },
  {
    id: 'omcu-agent-qa',
    type: 'agent',
    canonicalName: 'omcu-qa',
    nativeCursorPath: 'agents/omcu-qa.md',
    fallbackPath: 'agents/qa.md',
    aliases: ['qa-agent', 'qa-tester', 'omcu-qa-tester', 'omc_qa_tester', 'omx_qa_tester', 'athena', 'omo_athena'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Adversarial test generator and dynamic test runner.',
  },
  {
    id: 'omcu-agent-scientist',
    type: 'agent',
    canonicalName: 'omcu-scientist',
    nativeCursorPath: 'agents/omcu-scientist.md',
    fallbackPath: 'agents/scientist.md',
    aliases: ['scientist', 'omc_scientist', 'omx_scientist'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Conducts empirical benchmarking, metrics collection, and hypothesis testing.',
  },
  {
    id: 'omcu-agent-writer',
    type: 'agent',
    canonicalName: 'omcu-writer',
    nativeCursorPath: 'agents/omcu-writer.md',
    fallbackPath: 'agents/writer.md',
    aliases: ['writer', 'omc_writer', 'omx_writer'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Drafts technical documentation, release notes, and documentation parity updates.',
  },
  {
    id: 'omcu-agent-analyst',
    type: 'agent',
    canonicalName: 'omcu-analyst',
    nativeCursorPath: 'agents/omcu-analyst.md',
    fallbackPath: 'agents/analyst.md',
    aliases: ['analyst', 'omx_analyst', 'metis', 'omo_metis'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Analyzes user prompts, clarifies requirements, and extracts formal acceptance criteria.',
  },
  {
    id: 'omcu-agent-build-fixer',
    type: 'agent',
    canonicalName: 'omcu-build-fixer',
    nativeCursorPath: 'agents/omcu-build-fixer.md',
    fallbackPath: 'agents/build-fixer.md',
    aliases: ['build-fixer', 'omx_build_fixer'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Applies minimal non-behavioral diffs to resolve compiler and type errors.',
  },
  {
    id: 'omcu-agent-code-simplifier',
    type: 'agent',
    canonicalName: 'omcu-code-simplifier',
    nativeCursorPath: 'agents/omcu-code-simplifier.md',
    fallbackPath: 'agents/code-simplifier.md',
    aliases: ['code-simplifier', 'omx_code_simplifier'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Reduces cyclomatic complexity and dead code while preserving behavioral invariants.',
  },
  {
    id: 'omcu-agent-git-master',
    type: 'agent',
    canonicalName: 'omcu-git-master',
    nativeCursorPath: 'agents/omcu-git-master.md',
    fallbackPath: 'agents/git-master.md',
    aliases: ['git-master', 'omx_git_master'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Enforces imperative commit conventions, branch isolation, and atomic commits.',
  },
  {
    id: 'omcu-agent-lead',
    type: 'agent',
    canonicalName: 'omcu-lead',
    nativeCursorPath: 'agents/omcu-lead.md',
    fallbackPath: 'agents/lead.md',
    aliases: ['lead', 'omo_lead'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Coordinates subagents running in separate worktrees and merges validated results.',
  },
  {
    id: 'omcu-agent-worker',
    type: 'agent',
    canonicalName: 'omcu-worker',
    nativeCursorPath: 'agents/omcu-worker.md',
    fallbackPath: 'agents/worker.md',
    aliases: ['worker', 'omo_worker'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Executes coding tasks confined strictly to assigned worktree directory.',
  },
  {
    id: 'omcu-agent-inspector',
    type: 'agent',
    canonicalName: 'omcu-inspector',
    nativeCursorPath: 'agents/omcu-inspector.md',
    fallbackPath: 'agents/inspector.md',
    aliases: ['inspector', 'omo_inspector', 'argus', 'omo_argus'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Performs isolated read-only audit of completed worktree branches against contract specifications.',
  },
  {
    id: 'omcu-agent-provenance-agent',
    type: 'agent',
    canonicalName: 'omcu-provenance-agent',
    nativeCursorPath: 'agents/omcu-provenance-agent.md',
    aliases: ['provenance-agent'],
    pluginManifestEntry: 'agents',
    supportTier: 'native',
    description: '[omcu:0.3.0] Provenance and role-policy verification custom agent.',
  },

  // Rules
  {
    id: 'omcu-rule-oh-my-cursor',
    type: 'rule',
    canonicalName: 'omcu-rule-oh-my-cursor',
    nativeCursorPath: '.cursor/rules/oh-my-cursor.mdc',
    aliases: ['oh-my-cursor', 'omcu-rule', 'omc_rule'],
    pluginManifestEntry: 'rules',
    supportTier: 'native',
    description: '[omcu:0.3.0] Canonical Cursor Agent persistent guidance rules.',
  },

  // Hooks
  {
    id: 'omcu-hook-lifecycle',
    type: 'hook',
    canonicalName: 'omcu-hook-lifecycle',
    nativeCursorPath: 'hooks/hooks.json',
    aliases: ['hooks', 'lifecycle-hooks', 'omc_hooks', 'omx_subagent_stop'],
    pluginManifestEntry: 'hooks',
    supportTier: 'native',
    description: '[omcu:0.3.0] Event handlers for Cursor lifecycle hooks.',
  },
  {
    id: 'omcu-hook-context-compact',
    type: 'hook',
    canonicalName: 'omcu-hook-context-compact',
    nativeCursorPath: 'hooks/hooks.json',
    aliases: ['context-compact', 'omx_context_compact'],
    pluginManifestEntry: 'hooks',
    supportTier: 'thin-extension',
    description: '[omcu:0.3.0] Persists active session state to disk prior to LLM context window compaction.',
  },
  {
    id: 'omcu-hook-pre-step-gate',
    type: 'hook',
    canonicalName: 'omcu-hook-pre-step-gate',
    nativeCursorPath: 'hooks/hooks.json',
    aliases: ['pre-step-gate', 'omo_pre_step_gate'],
    pluginManifestEntry: 'hooks',
    supportTier: 'native',
    description: '[omcu:0.3.0] Evaluates proposed filesystem edits against destructive command blacklist.',
  },
  {
    id: 'omcu-hook-post-step-audit',
    type: 'hook',
    canonicalName: 'omcu-hook-post-step-audit',
    nativeCursorPath: 'hooks/hooks.json',
    aliases: ['post-step-audit', 'omo_post_step_audit'],
    pluginManifestEntry: 'hooks',
    supportTier: 'thin-extension',
    description: '[omcu:0.3.0] Validates that step edits did not introduce syntax errors or broken tests.',
  },

  // MCP
  {
    id: 'omcu-mcp-health',
    type: 'mcp',
    canonicalName: 'omcu-mcp-health',
    nativeCursorPath: '.mcp.json',
    aliases: ['mcp', 'omcu-mcp', 'omc_mcp'],
    pluginManifestEntry: 'mcpServers',
    supportTier: 'native',
    description: '[omcu:0.3.0] Managed Model Context Protocol configuration and tools.',
  },

  // SDK Service
  {
    id: 'omcu-sdk-service',
    type: 'sdk-service',
    canonicalName: 'omcu-sdk-service',
    nativeCursorPath: 'src/runtime/cursor-sdk/index.ts',
    fallbackPath: 'dist/src/runtime/cursor-sdk/index.js',
    aliases: ['sdk', 'cursor-sdk', 'omcu-sdk'],
    sdkServiceEntry: 'cursor-sdk',
    supportTier: 'native',
    description: '[omcu:0.3.0] Cursor SDK runtime, projections, and auto-review tools.',
  },
];

export function fileSha256(filePath: string): string {
  try {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  } catch {
    return '0'.repeat(64);
  }
}

export function buildCatalogManifest(packageRoot: string): CatalogManifest {
  const components: CatalogComponent[] = CANONICAL_COMPONENT_DEFS.map((def) => {
    let target = path.join(packageRoot, def.nativeCursorPath);
    if (!fs.existsSync(target) && def.fallbackPath) {
      const fallbackTarget = path.join(packageRoot, def.fallbackPath);
      if (fs.existsSync(fallbackTarget)) {
        target = fallbackTarget;
      }
    }
    const hash = fs.existsSync(target) ? fileSha256(target) : '0'.repeat(64);
    return {
      id: def.id,
      type: def.type,
      canonicalName: def.canonicalName,
      nativeCursorPath: def.nativeCursorPath,
      aliases: def.aliases,
      version: PACKAGE_VERSION,
      contentSha256: hash,
      pluginManifestEntry: def.pluginManifestEntry,
      sdkServiceEntry: def.sdkServiceEntry,
      supportTier: def.supportTier,
      description: def.description,
      provenanceMarker: `omcu:${PACKAGE_VERSION}:${def.id}`,
    };
  });

  return {
    schema_version: 1,
    omcu_version: PACKAGE_VERSION,
    generated_at: new Date().toISOString(),
    components,
  };
}

export function resolveCatalogComponents(packageRoot: string): ComponentResolution[] {
  return CANONICAL_COMPONENT_DEFS.map((def) => {
    let resolvedPath: string | null = null;
    const primary = path.join(packageRoot, def.nativeCursorPath);
    if (fs.existsSync(primary)) {
      resolvedPath = primary;
    } else if (def.fallbackPath) {
      const fallback = path.join(packageRoot, def.fallbackPath);
      if (fs.existsSync(fallback)) {
        resolvedPath = fallback;
      }
    }
    const hash = resolvedPath ? fileSha256(resolvedPath) : '0'.repeat(64);
    const status = resolvedPath ? 'resolved' : 'missing';

    return {
      id: def.id,
      canonicalName: def.canonicalName,
      type: def.type,
      nativeCursorPath: def.nativeCursorPath,
      aliases: def.aliases,
      version: PACKAGE_VERSION,
      contentSha256: hash,
      resolvedPath,
      supportTier: def.supportTier,
      provenanceMarker: `omcu:${PACKAGE_VERSION}:${def.id}`,
      status,
    };
  });
}

export function findComponentByQuery(query: string): RawComponentDef | undefined {
  const normalized = query.trim().toLowerCase();
  return CANONICAL_COMPONENT_DEFS.find((comp) =>
    comp.id.toLowerCase() === normalized
    || comp.canonicalName.toLowerCase() === normalized
    || comp.aliases.some((alias) => alias.toLowerCase() === normalized));
}

export function explainAlias(query: string, packageRoot: string): AliasExplainReport {
  const trimmed = query.trim();
  const found = findComponentByQuery(trimmed);

  if (!found) {
    return {
      query: trimmed,
      found: false,
      is_canonical: false,
      canonical_id: null,
      canonical_name: null,
      type: null,
      aliases: [],
      canonical_replacement: null,
      collisions: [],
      support_tier: null,
      target_mechanism: null,
      guidance: `Unknown component or alias "${trimmed}". Canonical public OMCU components use the "omcu-*" namespace.`,
    };
  }

  const isCanonical = trimmed.toLowerCase() === found.canonicalName.toLowerCase() || trimmed.toLowerCase() === found.id.toLowerCase();
  const guidance = isCanonical
    ? `"${trimmed}" is a canonical OMCU component (${found.id}). Use directly in Cursor Agent prompts or workflow configurations.`
    : `"${trimmed}" is a backward-compatible alias for canonical component "${found.canonicalName}" (${found.id}). To ensure deterministic resolution and prevent collision with other plugins or local files, prefer "${found.canonicalName}".`;

  return {
    query: trimmed,
    found: true,
    is_canonical: isCanonical,
    canonical_id: found.id,
    canonical_name: found.canonicalName,
    type: found.type,
    aliases: found.aliases,
    canonical_replacement: found.canonicalName,
    collisions: [],
    support_tier: found.supportTier,
    target_mechanism: found.pluginManifestEntry ?? found.sdkServiceEntry ?? 'native-cursor',
    guidance,
  };
}
