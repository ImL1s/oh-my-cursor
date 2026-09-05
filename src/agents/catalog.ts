import fs from 'node:fs';
import path from 'node:path';
import type { AgentRoleDefinition, SourceProfile } from './types.js';

export const CANONICAL_AGENT_ROLES: readonly AgentRoleDefinition[] = [
  // 1. Architect
  {
    id: 'omcu-agent-architect',
    canonicalName: 'omcu-architect',
    agentFile: 'agents/omcu-architect.md',
    fallbackFile: 'agents/architect.md',
    aliases: ['architect', 'omc_architect', 'omx_architect', 'oracle', 'omo_oracle'],
    mode: 'either',
    category: 'architecture',
    model: {
      preferredModel: 'claude-3-7-sonnet-thought',
      routingTier: 'reasoning',
      reasoningEffort: 'high',
      fallbackTiers: ['smart'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir'],
      deny: ['write_to_file', 'replace_file_content', 'run_command'],
      toolClasses: ['read'],
      writeScope: 'none',
    },
    delegation: {
      canDelegate: true,
      maxDepth: 1,
      allowedSubagentRoles: ['omcu-explorer', 'omcu-analyst', 'omcu-critic'],
    },
    eligibility: {
      local: true,
      cloud: true,
      background: false,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'read-only',
    },
    context: {
      requiredSkills: ['omcu-setup'],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['goal', 'requirements'],
      expectedOutputs: ['architecture-spec', 'decision-record'],
      artifactPathPattern: '.omcu/artifacts/arch-*.md',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-architect',
        description: 'Canonical balanced architectural boundary and lifecycle enforcement.',
        intentionalDifferences: 'Native Cursor read-only subagent with single-level delegation boundary.',
      },
      {
        profileId: 'omc',
        source: 'omc',
        sourceName: 'omc_architect',
        description: 'High-level system boundary, lifecycle constraints, and invariants analysis.',
        intentionalDifferences: 'Eliminates shell command execution; enforces read-only codebase access.',
      },
      {
        profileId: 'omx',
        source: 'omx',
        sourceName: 'omx_architect',
        description: 'Structural decomposition, component boundaries, and dependency integrity.',
        intentionalDifferences: 'Replaces proprietary planner integration with Cursor SDK subagent profiles.',
      },
      {
        profileId: 'omo-oracle',
        source: 'omo',
        sourceName: 'omo_oracle',
        description: 'Clean-room high-reasoning oracle architecture advisor exploring foundational trade-offs.',
        modelOverride: {
          routingTier: 'reasoning',
          reasoningEffort: 'high',
        },
        intentionalDifferences: 'Clean-room specification without proprietary prompt duplication.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Uses native Cursor read-only subagents instead of unbounded shell sessions.',
  },

  // 2. Critic
  {
    id: 'omcu-agent-critic',
    canonicalName: 'omcu-critic',
    agentFile: 'agents/omcu-critic.md',
    fallbackFile: 'agents/critic.md',
    aliases: ['critic', 'omc_critic', 'momus', 'omo_momus'],
    mode: 'subagent',
    category: 'review',
    model: {
      preferredModel: 'claude-3-7-sonnet-thought',
      routingTier: 'reasoning',
      reasoningEffort: 'high',
      fallbackTiers: ['smart'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir'],
      deny: ['write_to_file', 'replace_file_content', 'run_command'],
      toolClasses: ['read'],
      writeScope: 'none',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: true,
      background: false,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'read-only',
    },
    context: {
      requiredSkills: [],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['plan', 'diff'],
      expectedOutputs: ['critique-report'],
      artifactPathPattern: '.omcu/artifacts/critique-*.md',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-critic',
        description: 'Adversarial plan and diff critique identifying flaws and unstated assumptions.',
        intentionalDifferences: 'Read-only tool sandbox; cannot execute shell commands or write code.',
      },
      {
        profileId: 'omc',
        source: 'omc',
        sourceName: 'omc_critic',
        description: 'Adversarial review of implementation plans and proposed code diffs.',
        intentionalDifferences: 'Strict leaf agent that cannot spawn nested subagents.',
      },
      {
        profileId: 'omo-momus',
        source: 'omo',
        sourceName: 'omo_momus',
        description: 'Clean-room adversarial challenger identifying subtle regression risks.',
        modelOverride: {
          routingTier: 'reasoning',
          reasoningEffort: 'high',
        },
        intentionalDifferences: 'Clean-room persona specification strictly bounded to critique generation.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Read-only tool sandbox; cannot execute shell commands or write code.',
  },

  // 3. Debugger
  {
    id: 'omcu-agent-debugger',
    canonicalName: 'omcu-debugger',
    agentFile: 'agents/omcu-debugger.md',
    fallbackFile: 'agents/debugger.md',
    aliases: ['debugger', 'omc_debugger', 'omc-debugger', 'omx_debugger', 'omx-debugger', 'tracer', 'omx_tracer', 'omx-tracer'],
    mode: 'either',
    category: 'debugging',
    model: {
      preferredModel: 'claude-3-5-sonnet',
      routingTier: 'smart',
      reasoningEffort: 'medium',
      fallbackTiers: ['fast'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir', 'run_command'],
      deny: ['write_to_file', 'replace_file_content'],
      toolClasses: ['read', 'shell'],
      writeScope: 'none',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: true,
      background: true,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'read-only',
    },
    context: {
      requiredSkills: [],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['error-log', 'stack-trace'],
      expectedOutputs: ['root-cause-analysis'],
      artifactPathPattern: '.omcu/artifacts/debug-*.md',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-debugger',
        description: 'Root cause investigation and diagnostic reproduction without code mutation.',
        intentionalDifferences: 'Diagnostic command execution allowed; source mutation forbidden.',
      },
      {
        profileId: 'omc',
        source: 'omc',
        sourceName: 'omc_debugger',
        description: 'Call stack tracing, failure isolation, and regression verification.',
        intentionalDifferences: 'Isolated diagnostic sandbox with read-only repository view.',
      },
      {
        profileId: 'omx',
        source: 'omx',
        sourceName: 'omx_debugger',
        description: 'Systematic diagnostic hypothesis testing with structured error parsing.',
        intentionalDifferences: 'Integrates directly with Cursor test runner output streams.',
      },
      {
        profileId: 'omx-tracer',
        source: 'omx',
        sourceName: 'omx-tracer',
        description: 'Call graph and data flow tracer analyzing execution paths.',
        intentionalDifferences: 'Produces structured telemetry records without interactive pty.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Equipped with structured diagnostic tools and vitest runners; cannot edit code.',
  },

  // 4. Executor
  {
    id: 'omcu-agent-executor',
    canonicalName: 'omcu-executor',
    agentFile: 'agents/omcu-executor.md',
    fallbackFile: 'agents/executor.md',
    aliases: [
      'executor',
      'implementer',
      'omcu-implementer',
      'omc_executor',
      'omx_executor',
      'junior',
      'omo_junior',
      'hephaestus',
      'omo_hephaestus',
    ],
    mode: 'either',
    category: 'execution',
    model: {
      preferredModel: 'claude-3-5-sonnet',
      routingTier: 'smart',
      fallbackTiers: ['fast'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir', 'write_to_file', 'replace_file_content', 'run_command'],
      deny: [],
      toolClasses: ['read', 'write', 'shell'],
      writeScope: 'all',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: true,
      background: true,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'shared',
    },
    context: {
      requiredSkills: [],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['plan-step', 'spec'],
      expectedOutputs: ['execution-diff', 'receipt'],
      artifactPathPattern: '.omcu/artifacts/exec-*.json',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-executor',
        description: 'Scoped code modifications strictly following implementation plan.',
        intentionalDifferences: 'Enforces generation fencing and atomic transaction boundaries.',
      },
      {
        profileId: 'omc',
        source: 'omc',
        sourceName: 'omc_executor',
        description: 'Generation-fenced code changes with atomic state recording.',
        intentionalDifferences: 'Relies on OMCU atomic file transactions instead of external shell lock.',
      },
      {
        profileId: 'omx',
        source: 'omx',
        sourceName: 'omx_executor',
        description: 'Direct targeted implementation preserving test invariants.',
        intentionalDifferences: 'Bound to local worktree directory or explicit change list.',
      },
      {
        profileId: 'omo-junior',
        source: 'omo',
        sourceName: 'omo_junior',
        description: 'Fast scoped code modifications with low token overhead.',
        modelOverride: {
          routingTier: 'fast',
          fallbackTiers: ['smart'],
        },
        intentionalDifferences: 'Prioritizes lightweight low-cost models for simple execution steps.',
      },
      {
        profileId: 'omo-hephaestus',
        source: 'omo',
        sourceName: 'omo_hephaestus',
        description: 'Clean-room comprehensive builder implementing multi-file feature sets.',
        modelOverride: {
          routingTier: 'smart',
        },
        intentionalDifferences: 'Clean-room implementation persona adhering to architectural plan.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Subject to OMCU lease boundaries and generation fencing.',
  },

  // 5. Explorer
  {
    id: 'omcu-agent-explore',
    canonicalName: 'omcu-explorer',
    agentFile: 'agents/omcu-explorer.md',
    fallbackFile: 'agents/explorer.md',
    aliases: ['explorer', 'explore', 'omcu-explore', 'omc_explore', 'omx_explore', 'hermes', 'omo_hermes'],
    mode: 'subagent',
    category: 'reconnaissance',
    model: {
      preferredModel: 'claude-3-5-haiku',
      routingTier: 'fast',
      fallbackTiers: ['smart'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir'],
      deny: ['write_to_file', 'replace_file_content', 'run_command'],
      toolClasses: ['read'],
      writeScope: 'none',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: true,
      background: true,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'read-only',
    },
    context: {
      requiredSkills: [],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['query', 'scope'],
      expectedOutputs: ['reconnaissance-report'],
      artifactPathPattern: '.omcu/artifacts/explore-*.md',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-explorer',
        description: 'Fast repository reconnaissance and symbol discovery without file edits.',
        intentionalDifferences: 'Scoped with read-only tools and symbol grep utilities.',
      },
      {
        profileId: 'omc',
        source: 'omc',
        sourceName: 'omc_explore',
        description: 'Codebase reconnaissance mapping directories, types, and dependencies.',
        intentionalDifferences: 'Subagent runtime with zero mutation capability.',
      },
      {
        profileId: 'omx',
        source: 'omx',
        sourceName: 'omx_explore',
        description: 'Structural symbol grep and pattern reconnaissance across files.',
        intentionalDifferences: 'Uses native Cursor file indexing instead of background python processes.',
      },
      {
        profileId: 'omo-hermes',
        source: 'omo',
        sourceName: 'omo_hermes',
        description: 'Clean-room fast reconnaissance messenger mapping codebase topology.',
        modelOverride: {
          routingTier: 'fast',
        },
        intentionalDifferences: 'Clean-room exploration persona strictly bounded to fast information gathering.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Scoped with read-only tools and symbol grep utilities.',
  },

  // 6. Planner
  {
    id: 'omcu-agent-planner',
    canonicalName: 'omcu-planner',
    agentFile: 'agents/omcu-planner.md',
    fallbackFile: 'agents/planner.md',
    aliases: ['planner', 'omc_planner', 'omx_planner', 'prometheus', 'omo_prometheus'],
    mode: 'either',
    category: 'planning',
    model: {
      preferredModel: 'claude-3-7-sonnet-thought',
      routingTier: 'reasoning',
      reasoningEffort: 'high',
      fallbackTiers: ['smart'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir', 'write_to_file', 'replace_file_content'],
      deny: ['run_command'],
      toolClasses: ['read', 'write'],
      writeScope: 'markdown-only',
    },
    delegation: {
      canDelegate: true,
      maxDepth: 1,
      allowedSubagentRoles: ['omcu-explorer'],
    },
    eligibility: {
      local: true,
      cloud: true,
      background: false,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'shared',
    },
    context: {
      requiredSkills: ['omcu-ralplan'],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['task', 'context'],
      expectedOutputs: ['plan-dag', 'milestones'],
      artifactPathPattern: '.omcu/artifacts/plan-*.md',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-planner',
        description: 'Build a file-level implementation plan from repository evidence.',
        intentionalDifferences: 'Generates structured JSON task DAGs; write scope limited to markdown.',
      },
      {
        profileId: 'omc',
        source: 'omc',
        sourceName: 'omc_planner',
        description: 'Dependency-ordered DAG batch task generation for workflow coordination.',
        intentionalDifferences: 'Outputs compatible with Cursor DAG runner and cookbook executor.',
      },
      {
        profileId: 'omx',
        source: 'omx',
        sourceName: 'omx_planner',
        description: 'Step-by-step phased execution plan with strict acceptance criteria.',
        intentionalDifferences: 'Encapsulated into Markdown artifacts without invoking shell scripts.',
      },
      {
        profileId: 'omo-prometheus',
        source: 'omo',
        sourceName: 'omo_prometheus',
        description: 'Clean-room foresight planner synthesizing requirements into verifiable milestones.',
        modelOverride: {
          routingTier: 'reasoning',
          reasoningEffort: 'high',
        },
        intentionalDifferences: 'Clean-room planning persona with strict milestone decomposition.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Generates structured JSON task DAGs compatible with cookbook runner.',
  },

  // 7. QA Tester
  {
    id: 'omcu-agent-qa-tester',
    canonicalName: 'omcu-qa-tester',
    agentFile: 'agents/omcu-qa-tester.md',
    fallbackFile: 'agents/qa-tester.md',
    aliases: ['qa-tester', 'qa', 'omcu-qa', 'omc_qa_tester', 'omx_qa_tester', 'athena', 'omo_athena'],
    mode: 'either',
    category: 'testing',
    model: {
      preferredModel: 'claude-3-5-sonnet',
      routingTier: 'smart',
      reasoningEffort: 'medium',
      fallbackTiers: ['fast'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir', 'write_to_file', 'replace_file_content', 'run_command'],
      deny: [],
      toolClasses: ['read', 'write', 'shell'],
      writeScope: 'all',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: true,
      background: true,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'shared',
    },
    context: {
      requiredSkills: ['omcu-qa'],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['specification', 'implementation'],
      expectedOutputs: ['test-suite', 'qa-verdict'],
      artifactPathPattern: '.omcu/artifacts/qa-*.json',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-qa-tester',
        description: 'Adversarial dynamic test execution and failure reproduction.',
        intentionalDifferences: 'Adheres to repository-specific Vitest suites with isolated temporary directories.',
      },
      {
        profileId: 'omc',
        source: 'omc',
        sourceName: 'omc_qa_tester',
        description: 'Automated test suite authoring and adversarial boundary checking.',
        intentionalDifferences: 'Constrained to test authoring and execution; no prod code modification.',
      },
      {
        profileId: 'omx',
        source: 'omx',
        sourceName: 'omx_qa_tester',
        description: 'Dynamic test generation, failure reproduction, and regression detection.',
        intentionalDifferences: 'Executes via npm test runner without external container requirements.',
      },
      {
        profileId: 'omo-athena',
        source: 'omo',
        sourceName: 'omo_athena',
        description: 'Clean-room strategic test validator and quality champion.',
        modelOverride: {
          routingTier: 'smart',
        },
        intentionalDifferences: 'Clean-room test validation persona emphasizing hostile boundary probing.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Adheres to repository-specific Vitest unit and integration suites.',
  },

  // 8. Scientist
  {
    id: 'omcu-agent-scientist',
    canonicalName: 'omcu-scientist',
    agentFile: 'agents/omcu-scientist.md',
    fallbackFile: 'agents/scientist.md',
    aliases: ['scientist', 'omc_scientist', 'omx_scientist'],
    mode: 'subagent',
    category: 'research',
    model: {
      preferredModel: 'claude-3-7-sonnet-thought',
      routingTier: 'reasoning',
      reasoningEffort: 'medium',
      fallbackTiers: ['smart'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir', 'run_command', 'write_to_file', 'replace_file_content'],
      deny: [],
      toolClasses: ['read', 'write', 'shell'],
      writeScope: 'markdown-only',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: true,
      background: true,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'shared',
    },
    context: {
      requiredSkills: [],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['hypothesis', 'benchmark-spec'],
      expectedOutputs: ['empirical-report', 'telemetry'],
      artifactPathPattern: '.omcu/artifacts/scientist-*.json',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-scientist',
        description: 'Conducts empirical benchmarking and hypothesis testing.',
        intentionalDifferences: 'Emits structured telemetry JSON to .omcu/artifacts/.',
      },
      {
        profileId: 'omc',
        source: 'omc',
        sourceName: 'omc_scientist',
        description: 'Empirical experimentation and benchmark validation.',
        intentionalDifferences: 'Produces verifiable JSON artifacts instead of raw console output.',
      },
      {
        profileId: 'omx',
        source: 'omx',
        sourceName: 'omx_scientist',
        description: 'Performance metrics capture and invariant proof.',
        intentionalDifferences: 'Bound to read-only benchmarks without persistent system mutation.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Emits structured telemetry JSON to .omcu/artifacts/.',
  },

  // 9. Verifier
  {
    id: 'omcu-agent-verifier',
    canonicalName: 'omcu-verifier',
    agentFile: 'agents/omcu-verifier.md',
    fallbackFile: 'agents/verifier.md',
    aliases: ['verifier', 'omc_verifier', 'omx_verifier'],
    mode: 'subagent',
    category: 'verification',
    model: {
      preferredModel: 'claude-3-7-sonnet-thought',
      routingTier: 'reasoning',
      reasoningEffort: 'high',
      fallbackTiers: ['smart'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir', 'run_command'],
      deny: ['write_to_file', 'replace_file_content'],
      toolClasses: ['read', 'shell'],
      writeScope: 'none',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: true,
      background: false,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'read-only',
    },
    context: {
      requiredSkills: ['omcu-accept'],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['target-state', 'proof-command'],
      expectedOutputs: ['verification-verdict', 'proof-log'],
      artifactPathPattern: '.omcu/artifacts/verdict-*.json',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-verifier',
        description: 'Authoritative completion verifier requiring fresh build/test proof.',
        intentionalDifferences: 'Never self-approves unverified code; requires nonzero automated proof.',
      },
      {
        profileId: 'omc',
        source: 'omc',
        sourceName: 'omc_verifier',
        description: 'Gatekeeper requiring nonzero automated proof before accepting changes.',
        intentionalDifferences: 'Read-only codebase access; write operations strictly forbidden.',
      },
      {
        profileId: 'omx',
        source: 'omx',
        sourceName: 'omx_verifier',
        description: 'Release gatekeeper validating invariant checks and zero regression.',
        intentionalDifferences: 'Runs as a strict leaf validator in the verification stage.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Never self-approves unverified code; requires nonzero automated proof.',
  },

  // 10. Writer
  {
    id: 'omcu-agent-writer',
    canonicalName: 'omcu-writer',
    agentFile: 'agents/omcu-writer.md',
    fallbackFile: 'agents/writer.md',
    aliases: ['writer', 'omc_writer', 'omx_writer'],
    mode: 'either',
    category: 'documentation',
    model: {
      preferredModel: 'claude-3-5-haiku',
      routingTier: 'fast',
      fallbackTiers: ['smart'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir', 'write_to_file', 'replace_file_content'],
      deny: ['run_command'],
      toolClasses: ['read', 'write'],
      writeScope: 'markdown-only',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: true,
      background: true,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'shared',
    },
    context: {
      requiredSkills: [],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['codebase-changes', 'doc-scope'],
      expectedOutputs: ['documentation-update', 'changelog'],
      artifactPathPattern: 'docs/**',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-writer',
        description: 'Drafts technical documentation, guides, and changelogs.',
        intentionalDifferences: 'Scoped strictly to docs/ and markdown assets; shell access disabled.',
      },
      {
        profileId: 'omc',
        source: 'omc',
        sourceName: 'omc_writer',
        description: 'Technical documentation authoring and documentation parity.',
        intentionalDifferences: 'Writes exclusively markdown files; code modification forbidden.',
      },
      {
        profileId: 'omx',
        source: 'omx',
        sourceName: 'omx_writer',
        description: 'Release documentation, API docs, and architecture documentation.',
        intentionalDifferences: 'Single-purpose leaf agent with zero subprocess execution permissions.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Scoped strictly to docs/ and markdown assets.',
  },

  // 11. Analyst
  {
    id: 'omcu-agent-analyst',
    canonicalName: 'omcu-analyst',
    agentFile: 'agents/omcu-analyst.md',
    fallbackFile: 'agents/analyst.md',
    aliases: ['analyst', 'omx_analyst', 'metis', 'omo_metis'],
    mode: 'subagent',
    category: 'analysis',
    model: {
      preferredModel: 'claude-3-5-sonnet',
      routingTier: 'smart',
      fallbackTiers: ['fast'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir'],
      deny: ['write_to_file', 'replace_file_content', 'run_command'],
      toolClasses: ['read'],
      writeScope: 'none',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: true,
      background: false,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'read-only',
    },
    context: {
      requiredSkills: [],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['user-prompt', 'problem-statement'],
      expectedOutputs: ['requirements-sheet', 'acceptance-criteria'],
      artifactPathPattern: '.omcu/artifacts/analyst-*.md',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-analyst',
        description: 'Analyzes user prompts and extracts formal acceptance criteria.',
        intentionalDifferences: 'Generates structured JSON/Markdown intake sheets without side effects.',
      },
      {
        profileId: 'omx',
        source: 'omx',
        sourceName: 'omx_analyst',
        description: 'Intake and ambiguity analysis agent extracting formal criteria.',
        intentionalDifferences: 'Read-only intake without modifying project state.',
      },
      {
        profileId: 'omo-metis',
        source: 'omo',
        sourceName: 'omo_metis',
        description: 'Clean-room user intent clarification, edge-case discovery, and intake sheets.',
        modelOverride: {
          routingTier: 'smart',
        },
        intentionalDifferences: 'Clean-room analysis persona clarifying ambiguous user requirements.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Generates structured JSON/Markdown intake sheets.',
  },

  // 12. Build Fixer
  {
    id: 'omcu-agent-build-fixer',
    canonicalName: 'omcu-build-fixer',
    agentFile: 'agents/omcu-build-fixer.md',
    fallbackFile: 'agents/build-fixer.md',
    aliases: ['build-fixer', 'omx_build_fixer'],
    mode: 'subagent',
    category: 'debugging',
    model: {
      preferredModel: 'claude-3-5-haiku',
      routingTier: 'fast',
      fallbackTiers: ['smart'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir', 'write_to_file', 'replace_file_content', 'run_command'],
      deny: [],
      toolClasses: ['read', 'write', 'shell'],
      writeScope: 'path-scoped',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: true,
      background: true,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'shared',
    },
    context: {
      requiredSkills: [],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['compiler-error', 'diagnostic-span'],
      expectedOutputs: ['build-fix-diff'],
      artifactPathPattern: '.omcu/artifacts/build-fix-*.json',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-build-fixer',
        description: 'Applies minimal non-behavioral diffs to resolve compiler/type errors.',
        intentionalDifferences: 'Restricted to touch only lines identified by compiler error spans.',
      },
      {
        profileId: 'omx',
        source: 'omx',
        sourceName: 'omx_build_fixer',
        description: 'Minimal diff compiler error fixer with rollback guarantee on persistent error.',
        intentionalDifferences: 'Restricted to error span paths; never refactors surrounding code.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Restricted to touch only lines identified by compiler error spans.',
  },

  // 13. Code Simplifier
  {
    id: 'omcu-agent-code-simplifier',
    canonicalName: 'omcu-code-simplifier',
    agentFile: 'agents/omcu-code-simplifier.md',
    fallbackFile: 'agents/code-simplifier.md',
    aliases: ['code-simplifier', 'omx_code_simplifier'],
    mode: 'subagent',
    category: 'refactoring',
    model: {
      preferredModel: 'claude-3-5-sonnet',
      routingTier: 'smart',
      fallbackTiers: ['fast'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir', 'write_to_file', 'replace_file_content', 'run_command'],
      deny: [],
      toolClasses: ['read', 'write', 'shell'],
      writeScope: 'all',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: true,
      background: true,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'shared',
    },
    context: {
      requiredSkills: [],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['target-file', 'complexity-metric'],
      expectedOutputs: ['simplified-diff', 'invariant-proof'],
      artifactPathPattern: '.omcu/artifacts/simplify-*.json',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-code-simplifier',
        description: 'Reduces cyclomatic complexity and dead code while preserving test invariants.',
        intentionalDifferences: 'Requires full test suite pass before and after each simplification step.',
      },
      {
        profileId: 'omx',
        source: 'omx',
        sourceName: 'omx_code_simplifier',
        description: 'Bounded complexity reduction without behavior change.',
        intentionalDifferences: 'Reverts changes automatically if any existing test fails.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Requires full test suite pass before and after each simplification step.',
  },

  // 14. Git Master
  {
    id: 'omcu-agent-git-master',
    canonicalName: 'omcu-git-master',
    agentFile: 'agents/omcu-git-master.md',
    fallbackFile: 'agents/git-master.md',
    aliases: ['git-master', 'omx_git_master'],
    mode: 'either',
    category: 'operations',
    model: {
      preferredModel: 'claude-3-5-haiku',
      routingTier: 'fast',
      fallbackTiers: ['smart'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir', 'run_command'],
      deny: ['write_to_file', 'replace_file_content'],
      toolClasses: ['read', 'shell'],
      writeScope: 'none',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: false,
      background: false,
      team: false,
      teamIneligibilityReason: 'Git operations require exclusive repository lock and cannot run in parallel teams.',
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'shared',
    },
    context: {
      requiredSkills: [],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['staged-diff', 'branch-name'],
      expectedOutputs: ['atomic-commit', 'branch-log'],
      artifactPathPattern: '.omcu/artifacts/git-*.json',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-git-master',
        description: 'Enforces imperative commit conventions, branch isolation, and atomic commits.',
        intentionalDifferences: 'Runs locally with reflog protection; ineligible for parallel team execution.',
      },
      {
        profileId: 'omx',
        source: 'omx',
        sourceName: 'omx_git_master',
        description: 'Atomic commit author and branch hygiene expert.',
        intentionalDifferences: 'Operates directly with git lock guards; cannot mutate un-staged files.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Ineligible for parallel team orchestration; enforces single-threaded repo git lock.',
  },

  // 15. Lead
  {
    id: 'omcu-agent-lead',
    canonicalName: 'omcu-lead',
    agentFile: 'agents/omcu-lead.md',
    fallbackFile: 'agents/lead.md',
    aliases: ['lead', 'omo_lead'],
    mode: 'primary',
    category: 'coordination',
    model: {
      preferredModel: 'claude-3-7-sonnet-thought',
      routingTier: 'reasoning',
      reasoningEffort: 'high',
      fallbackTiers: ['smart'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir', 'write_to_file', 'replace_file_content', 'run_command'],
      deny: [],
      toolClasses: ['read', 'write', 'shell'],
      writeScope: 'all',
    },
    delegation: {
      canDelegate: true,
      maxDepth: 1,
      allowedSubagentRoles: ['omcu-worker', 'omcu-inspector', 'omcu-explorer'],
    },
    eligibility: {
      local: true,
      cloud: true,
      background: true,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'shared',
    },
    context: {
      requiredSkills: [],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['project-goal', 'task-list'],
      expectedOutputs: ['worktree-manifest', 'lead-synthesis'],
      artifactPathPattern: '.omcu/artifacts/lead-*.json',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-lead',
        description: 'Coordinates subagents running in separate worktrees and merges results.',
        intentionalDifferences: 'Clean-room independent persona specification.',
      },
      {
        profileId: 'omo-lead',
        source: 'omo',
        sourceName: 'omo_lead',
        description: 'Clean-room multi-worktree orchestrator allocating tasks and evaluating completions.',
        modelOverride: {
          routingTier: 'reasoning',
          reasoningEffort: 'high',
        },
        intentionalDifferences: 'Clean-room persona coordinating isolated worktree workers.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Clean-room independent persona specification coordinating Cursor subagents.',
  },

  // 16. Worker
  {
    id: 'omcu-agent-worker',
    canonicalName: 'omcu-worker',
    agentFile: 'agents/omcu-worker.md',
    fallbackFile: 'agents/worker.md',
    aliases: ['worker', 'omo_worker'],
    mode: 'subagent',
    category: 'execution',
    model: {
      preferredModel: 'claude-3-5-sonnet',
      routingTier: 'smart',
      fallbackTiers: ['fast'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir', 'write_to_file', 'replace_file_content', 'run_command'],
      deny: [],
      toolClasses: ['read', 'write', 'shell'],
      writeScope: 'worktree-only',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: true,
      background: true,
      team: true,
    },
    workspace: {
      requiresWorktree: true,
      isolationLevel: 'isolated-worktree',
    },
    context: {
      requiredSkills: [],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['worktree-task', 'worktree-path'],
      expectedOutputs: ['worktree-commit', 'task-receipt'],
      artifactPathPattern: '.omcu/artifacts/worker-*.json',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-worker',
        description: 'Executes coding tasks confined strictly to assigned worktree directory.',
        intentionalDifferences: 'Clean-room independent persona specification.',
      },
      {
        profileId: 'omo-worker',
        source: 'omo',
        sourceName: 'omo_worker',
        description: 'Clean-room isolated worktree worker operating inside designated worktree.',
        modelOverride: {
          routingTier: 'smart',
        },
        intentionalDifferences: 'Strict worktree boundary enforcement with zero escape to parent repository.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Clean-room independent persona specification; restricted to worktree directory.',
  },

  // 17. Inspector
  {
    id: 'omcu-agent-inspector',
    canonicalName: 'omcu-inspector',
    agentFile: 'agents/omcu-inspector.md',
    fallbackFile: 'agents/inspector.md',
    aliases: ['inspector', 'omo_inspector', 'argus', 'omo_argus'],
    mode: 'subagent',
    category: 'review',
    model: {
      preferredModel: 'claude-3-5-sonnet',
      routingTier: 'smart',
      fallbackTiers: ['fast'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir'],
      deny: ['write_to_file', 'replace_file_content', 'run_command'],
      toolClasses: ['read'],
      writeScope: 'none',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: true,
      background: false,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'read-only',
    },
    context: {
      requiredSkills: [],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['worktree-branch', 'contract-spec'],
      expectedOutputs: ['audit-verdict'],
      artifactPathPattern: '.omcu/artifacts/inspector-*.json',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-inspector',
        description: 'Performs isolated read-only audit of completed worktree branches against contracts.',
        intentionalDifferences: 'Clean-room independent persona specification; strictly read-only inspection.',
      },
      {
        profileId: 'omo-inspector',
        source: 'omo',
        sourceName: 'omo_inspector',
        description: 'Clean-room contract audit of isolated worktrees before merge.',
        intentionalDifferences: 'Evaluates branch diffs against contracts without modifying working tree.',
      },
      {
        profileId: 'omo-argus',
        source: 'omo',
        sourceName: 'omo_argus',
        description: 'Clean-room deep invariant inspector guarding system boundaries and contracts.',
        modelOverride: {
          routingTier: 'smart',
        },
        intentionalDifferences: 'Clean-room persona guarding contract invariants and API consistency.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Clean-room independent persona specification; strictly read-only inspection.',
  },

  // 18. Reviewer
  {
    id: 'omcu-agent-reviewer',
    canonicalName: 'omcu-reviewer',
    agentFile: 'agents/omcu-reviewer.md',
    fallbackFile: 'agents/reviewer.md',
    aliases: [
      'reviewer',
      'omc_reviewer',
      'omc-reviewer',
      'omx_reviewer',
      'omx-reviewer',
      'security-reviewer',
      'omcu-security-reviewer',
      'omx_security_reviewer',
      'omx-security-reviewer',
    ],
    mode: 'subagent',
    category: 'review',
    model: {
      preferredModel: 'claude-3-5-sonnet',
      routingTier: 'smart',
      fallbackTiers: ['fast'],
    },
    tools: {
      allow: ['read_file', 'grep_search', 'find_by_name', 'list_dir'],
      deny: ['write_to_file', 'replace_file_content', 'run_command'],
      toolClasses: ['read'],
      writeScope: 'none',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: true,
      background: false,
      team: true,
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'read-only',
    },
    context: {
      requiredSkills: [],
      requiredRules: ['oh-my-cursor'],
    },
    artifacts: {
      expectedInputs: ['diff', 'guidelines'],
      expectedOutputs: ['review-feedback'],
      artifactPathPattern: '.omcu/artifacts/review-*.md',
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-reviewer',
        description: 'Review code changes for bugs, regression risk, and convention fit.',
        intentionalDifferences: 'Purely advisory feedback; cannot self-approve or write code.',
      },
      {
        profileId: 'omc',
        source: 'omc',
        sourceName: 'omc_reviewer',
        description: 'Structured code review with actionable feedback.',
        intentionalDifferences: 'Read-only tool policy; no execution or file writes.',
      },
      {
        profileId: 'omx',
        source: 'omx',
        sourceName: 'omx_reviewer',
        description: 'Dual-review verifier and diff safety auditor.',
        intentionalDifferences: 'Produces structured findings list with explicit severity tiers.',
      },
      {
        profileId: 'omx-security-reviewer',
        source: 'omx',
        sourceName: 'omx-security-reviewer',
        description: 'Security and vulnerability auditor evaluating dependencies and attack surfaces.',
        intentionalDifferences: 'Read-only security review without executing untrusted code.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Purely advisory feedback; cannot self-approve or write code.',
  },

  // 19. Provenance Probe Agent
  {
    id: 'omcu-agent-provenance-agent',
    canonicalName: 'omcu-provenance-agent',
    agentFile: 'agents/omcu-provenance-agent.md',
    aliases: ['provenance-agent'],
    mode: 'subagent',
    category: 'verification',
    model: {
      routingTier: 'fast',
      fallbackTiers: [],
    },
    tools: {
      allow: ['read_file'],
      deny: ['write_to_file', 'replace_file_content', 'run_command'],
      toolClasses: ['read'],
      writeScope: 'none',
    },
    delegation: {
      canDelegate: false,
      maxDepth: 0,
    },
    eligibility: {
      local: true,
      cloud: false,
      background: false,
      team: false,
      teamIneligibilityReason: 'Test fixture only',
    },
    workspace: {
      requiresWorktree: false,
      isolationLevel: 'read-only',
    },
    context: {
      requiredSkills: [],
      requiredRules: [],
    },
    artifacts: {
      expectedInputs: ['nonce'],
      expectedOutputs: ['provenance-ack'],
    },
    profiles: [
      {
        profileId: 'default',
        source: 'omcu',
        sourceName: 'omcu-provenance-agent',
        description: 'Provenance and role-policy verification custom agent.',
        intentionalDifferences: 'Single-purpose provenance probe fixture.',
      },
    ],
    defaultProfile: 'default',
    intentionalDifferences: 'Provenance and role-policy verification fixture.',
  },
];

/**
 * Finds an agent role by canonical ID, canonical name, or alias.
 */
export function getAgentRole(nameOrAlias: string): AgentRoleDefinition | undefined {
  const raw = nameOrAlias.trim().toLowerCase();
  const candidates = [
    raw,
    raw.replace(/_/g, '-'),
    raw.replace(/-/g, '_'),
  ];
  for (const role of CANONICAL_AGENT_ROLES) {
    for (const candidate of candidates) {
      if (
        role.id === candidate ||
        role.canonicalName === candidate ||
        role.aliases.includes(candidate)
      ) {
        return role;
      }
    }
  }
  return undefined;
}

/**
 * Lists all agent roles, optionally filtered by source or category.
 */
export function listAgentRoles(filter?: {
  source?: string;
  category?: string;
}): readonly AgentRoleDefinition[] {
  let list = CANONICAL_AGENT_ROLES;
  if (filter?.category) {
    const cat = filter.category.toLowerCase();
    list = list.filter((r) => r.category === cat);
  }
  if (filter?.source && filter.source !== 'all') {
    const src = filter.source.toLowerCase();
    list = list.filter((r) =>
      r.profiles.some((p) => p.source.toLowerCase() === src || (src === 'custom' && r.custom))
    );
  }
  return list;
}

/**
 * Resolves a role and a specific source profile.
 */
export function resolveRoleAndProfile(
  roleName: string,
  profileName?: string
): { role: AgentRoleDefinition; profile: SourceProfile } {
  const role = getAgentRole(roleName);
  if (!role) {
    throw new Error(`E_ROLE_NOT_FOUND: agent role '${roleName}' not found in catalog`);
  }
  const requestedProfile = profileName?.trim().toLowerCase() ?? role.defaultProfile;
  const profile =
    role.profiles.find((p) => p.profileId === requestedProfile) ??
    role.profiles.find((p) => p.source === requestedProfile) ??
    role.profiles.find((p) => p.profileId === role.defaultProfile);

  if (!profile) {
    throw new Error(
      `E_PROFILE_NOT_FOUND: profile '${requestedProfile}' not found on role '${role.canonicalName}'`
    );
  }
  return { role, profile };
}

/**
 * Scans for custom agent markdown files under .cursor/agents/ or agents/custom/.
 */
export function discoverCustomAgents(projectRoot: string): readonly AgentRoleDefinition[] {
  const customAgents: AgentRoleDefinition[] = [];
  const searchDirs = [
    path.join(projectRoot, '.cursor', 'agents'),
    path.join(projectRoot, 'agents', 'custom'),
  ];

  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const fullPath = path.join(dir, file);
        const name = path.basename(file, '.md');
        // If it collides with a canonical name, reject/ignore as custom
        if (getAgentRole(name)) continue;
        const content = fs.readFileSync(fullPath, 'utf8');
        const descMatch = /^description:\s*(.+)$/m.exec(content);
        const description = descMatch?.[1]?.trim() ?? 'Custom user agent';
        const isReadOnly = /^readonly:\s*true/m.test(content);

        customAgents.push({
          id: `custom-agent-${name}`,
          canonicalName: name,
          agentFile: path.relative(projectRoot, fullPath),
          aliases: [name],
          mode: 'subagent',
          category: 'execution',
          model: {
            routingTier: 'smart',
            fallbackTiers: ['fast'],
          },
          tools: {
            allow: isReadOnly
              ? ['read_file', 'grep_search', 'find_by_name', 'list_dir']
              : ['read_file', 'grep_search', 'find_by_name', 'list_dir', 'write_to_file', 'replace_file_content'],
            deny: isReadOnly ? ['write_to_file', 'replace_file_content', 'run_command'] : [],
            toolClasses: isReadOnly ? ['read'] : ['read', 'write'],
            writeScope: isReadOnly ? 'none' : 'path-scoped',
          },
          delegation: {
            canDelegate: false,
            maxDepth: 0,
          },
          eligibility: {
            local: true,
            cloud: false,
            background: false,
            team: false,
            teamIneligibilityReason: 'Custom agent requires explicit review before team eligibility',
          },
          workspace: {
            requiresWorktree: false,
            isolationLevel: isReadOnly ? 'read-only' : 'shared',
          },
          context: {
            requiredSkills: [],
            requiredRules: ['oh-my-cursor'],
          },
          artifacts: {
            expectedInputs: ['prompt'],
            expectedOutputs: ['response'],
          },
          profiles: [
            {
              profileId: 'default',
              source: 'custom',
              sourceName: name,
              description,
              intentionalDifferences: 'User-defined custom agent.',
            },
          ],
          defaultProfile: 'default',
          intentionalDifferences: 'Project-local custom agent.',
          custom: true,
        });
      }
    } catch {
      // Ignore read errors
    }
  }

  return customAgents;
}
