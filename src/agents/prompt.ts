import crypto from 'node:crypto';
import type {
  AgentRoleDefinition,
  AgentTaskContext,
  ComposedPrompt,
  PromptSections,
  SourceProfile,
  WriteScope,
} from './types.js';

/**
 * Builds the Identity section of the composed prompt.
 */
function buildIdentitySection(role: AgentRoleDefinition, profile: SourceProfile): string {
  const lines: string[] = [
    `# Role: ${role.canonicalName} (${profile.profileId})`,
    '',
    `Category: ${role.category}`,
    `Execution Mode: ${role.mode}`,
    `Profile Description: ${profile.description}`,
    '',
    '## Boundaries',
    '- You are a one-level Cursor custom subagent. Do not spawn nested subagents.',
    '- Do not launch another agent CLI as a worker.',
    '- Do not claim sandbox isolation or write CLI-owned verification state.',
    '- Redact secrets from all output.',
  ];

  if (!role.delegation.canDelegate) {
    lines.push('- You are a leaf agent. You cannot delegate or spawn child subagents.');
  }

  return lines.join('\n');
}

/**
 * Builds the Task Contract section.
 */
function buildTaskContractSection(role: AgentRoleDefinition, context?: AgentTaskContext): string {
  const lines: string[] = [
    '## Task Contract',
    `- Expected Inputs: ${role.artifacts.expectedInputs.join(', ') || 'none'}`,
    `- Expected Outputs: ${role.artifacts.expectedOutputs.join(', ') || 'none'}`,
  ];

  if (role.artifacts.artifactPathPattern) {
    lines.push(`- Artifact Destination: ${role.artifacts.artifactPathPattern}`);
  }

  if (context?.objective) {
    lines.push('', '### Current Objective', context.objective);
  }

  if (context?.handoffArtifact) {
    lines.push('', '### Handoff Artifact', context.handoffArtifact);
  }

  return lines.join('\n');
}

/**
 * Builds the Tool Policy section.
 */
function buildToolPolicySection(
  role: AgentRoleDefinition,
  profile: SourceProfile,
  effectiveWriteScope: WriteScope
): string {
  const allowedTools = profile.toolPolicyOverride?.allow ?? role.tools.allow;
  const deniedTools = profile.toolPolicyOverride?.deny ?? role.tools.deny;

  const lines: string[] = [
    '## Tool & Mechanical Policy',
    `- Allowed Tools: ${allowedTools.join(', ') || 'none'}`,
    `- Denied Tools: ${deniedTools.join(', ') || 'none'}`,
    `- Write Scope: ${effectiveWriteScope}`,
    '- Tool permissions are mechanically enforced. You cannot self-upgrade or bypass tool boundaries.',
  ];

  switch (effectiveWriteScope) {
    case 'none':
      lines.push('- Read-only persona: Any attempt to write, replace, or edit files will fail closed.');
      break;
    case 'markdown-only':
      lines.push('- Markdown-only persona: Writes are restricted to documentation and markdown artifacts.');
      break;
    case 'worktree-only':
      lines.push('- Worktree persona: Writes are strictly isolated to your designated worktree directory.');
      break;
    case 'path-scoped':
      lines.push('- Path-scoped persona: Writes are restricted to files identified in the task contract.');
      break;
    case 'all':
      lines.push('- Full write persona: Modifications must comply with repository guidelines.');
      break;
  }

  return lines.join('\n');
}

/**
 * Builds the Evidence & Verification Rules section.
 */
function buildEvidenceRulesSection(): string {
  return [
    '## Evidence & Verification Rules',
    '- Ground all findings and assertions in concrete repository observations.',
    '- Never assert tests pass without fresh automated execution proof.',
    '- State file paths, line numbers, and error signatures explicitly.',
    '- Only the authoritative verifier and CLI state may stamp verified completion.',
  ].join('\n');
}

/**
 * Builds the Source Profile Nuance section.
 */
function buildSourceProfileSection(profile: SourceProfile): string {
  return [
    `## Source Profile: ${profile.sourceName} (${profile.source})`,
    profile.description,
    '',
    `### Intentional Architecture Differences`,
    profile.intentionalDifferences,
  ].join('\n');
}

/**
 * Builds the Host Limitations section.
 */
function buildHostLimitationsSection(): string {
  return [
    '## Host Limitations',
    '- Native host runtime: Cursor Agent (@cursor/sdk).',
    '- Context compaction resilience: Retain state in structured task receipts.',
    '- Authority boundary: Workflow and mode outputs never self-assert verified status.',
  ].join('\n');
}

/**
 * Compiles a bounded child handoff artifact ensuring no parent conversation bleed.
 */
export function compileChildHandoffArtifact(context: AgentTaskContext): string {
  const handoff = {
    objective: context.objective,
    handoffArtifact: context.handoffArtifact ?? null,
    workingDirectory: context.workingDirectory ?? null,
    parentRunId: context.parentRunId ?? null,
    contextData: context.contextData ?? {},
    timestamp: new Date().toISOString(),
  };
  return JSON.stringify(handoff, null, 2);
}

/**
 * Composes a full agent prompt from small modular sections and computes its SHA-256 hash.
 */
export function composeAgentPrompt(
  role: AgentRoleDefinition,
  profileName?: string,
  taskContext?: AgentTaskContext
): ComposedPrompt {
  const requestedProfile = profileName?.trim().toLowerCase() ?? role.defaultProfile;
  const profile =
    role.profiles.find((p) => p.profileId === requestedProfile) ??
    role.profiles.find((p) => p.source === requestedProfile) ??
    role.profiles.find((p) => p.profileId === role.defaultProfile) ??
    role.profiles[0]!;

  // Effective tool allow/deny and write scope
  const allowedTools = profile.toolPolicyOverride?.allow ?? role.tools.allow;
  const deniedTools = profile.toolPolicyOverride?.deny ?? role.tools.deny;
  let writeScope: WriteScope = profile.toolPolicyOverride?.writeScope ?? role.tools.writeScope;

  // If parent policy exists, intersect writeScope
  if (taskContext?.parentPolicy) {
    if (taskContext.parentPolicy.writeScope === 'none') {
      writeScope = 'none';
    } else if (
      taskContext.parentPolicy.writeScope === 'markdown-only' &&
      writeScope === 'all'
    ) {
      writeScope = 'markdown-only';
    }
  }

  const sections: PromptSections = {
    identity: buildIdentitySection(role, profile),
    taskContract: buildTaskContractSection(role, taskContext),
    toolPolicy: buildToolPolicySection(role, profile, writeScope),
    evidenceRules: buildEvidenceRulesSection(),
    sourceProfile: buildSourceProfileSection(profile),
    hostLimitations: buildHostLimitationsSection(),
  };

  const systemPrompt = [
    sections.identity,
    '',
    sections.taskContract,
    '',
    sections.toolPolicy,
    '',
    sections.evidenceRules,
    '',
    sections.sourceProfile,
    '',
    sections.hostLimitations,
  ].join('\n');

  // Compute deterministic SHA-256 prompt hash
  const hash = crypto.createHash('sha256');
  hash.update(systemPrompt);
  if (taskContext?.objective) {
    hash.update(taskContext.objective);
  }
  const promptHash = hash.digest('hex');

  const maxDepth = taskContext?.parentPolicy
    ? Math.min(role.delegation.maxDepth, Math.max(0, taskContext.parentPolicy.maxDepth - 1))
    : role.delegation.maxDepth;

  const canDelegate = maxDepth > 0 && role.delegation.canDelegate;

  return {
    roleId: role.id,
    profileId: profile.profileId,
    systemPrompt,
    sections,
    promptHash,
    effectiveTools: allowedTools,
    deniedTools,
    writeScope,
    maxDepth,
    canDelegate,
    timestamp: new Date().toISOString(),
  };
}
