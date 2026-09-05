import path from 'node:path';
import type {
  AgentRoleDefinition,
  EffectiveAgentPolicy,
  EnforcementResult,
  SourceProfile,
  WriteScope,
} from './types.js';

export interface InvocationOptions {
  readonly runtime?: 'local' | 'cloud';
  readonly isTeamWorker?: boolean;
  readonly isBackground?: boolean;
  readonly parentPolicy?: EffectiveAgentPolicy;
  readonly profile?: string;
  readonly targetWorktree?: string;
}

/**
 * Computes effective policy for a child agent by intersecting parent authority with role declaration.
 */
export function intersectPolicy(
  parent: EffectiveAgentPolicy,
  child: AgentRoleDefinition,
  profile?: SourceProfile
): EffectiveAgentPolicy {
  const childAllowed = profile?.toolPolicyOverride?.allow ?? child.tools.allow;
  const childDenied = profile?.toolPolicyOverride?.deny ?? child.tools.deny;
  const childWriteScope = profile?.toolPolicyOverride?.writeScope ?? child.tools.writeScope;

  // Intersect allowed tools (child cannot have tools parent doesn't have)
  const allowedTools = childAllowed.filter((t) => parent.allowedTools.includes(t));

  // Union denied tools
  const deniedTools = Array.from(new Set([...parent.deniedTools, ...childDenied]));

  // Strictest write scope wins
  let writeScope: WriteScope = childWriteScope;
  if (parent.writeScope === 'none') {
    writeScope = 'none';
  } else if (parent.writeScope === 'markdown-only') {
    if (childWriteScope === 'all' || childWriteScope === 'path-scoped') {
      writeScope = 'markdown-only';
    }
  } else if (parent.writeScope === 'worktree-only') {
    if (childWriteScope === 'all') {
      writeScope = 'worktree-only';
    }
  }

  // Decrement max depth
  const maxDepth = Math.min(child.delegation.maxDepth, Math.max(0, parent.maxDepth - 1));
  const canDelegate = maxDepth > 0 && child.delegation.canDelegate && parent.canDelegate;

  // Workspace isolation
  let workspaceIsolation: 'shared' | 'isolated-worktree' | 'read-only' = child.workspace.isolationLevel;
  if (parent.workspaceIsolation === 'read-only') {
    workspaceIsolation = 'read-only';
  } else if (parent.workspaceIsolation === 'isolated-worktree') {
    workspaceIsolation = 'isolated-worktree';
  }

  return {
    allowedTools,
    deniedTools,
    writeScope,
    maxDepth,
    canDelegate,
    workspaceIsolation,
  };
}

/**
 * Validates whether an agent can be invoked under the given runtime and team constraints.
 */
export function validateAgentInvocation(
  role: AgentRoleDefinition,
  options: InvocationOptions,
  profile?: SourceProfile
): EnforcementResult {
  // 1. Team eligibility check
  if (options.isTeamWorker && !role.eligibility.team) {
    return {
      allowed: false,
      errorCode: 'E_ROLE_TEAM_INELIGIBLE',
      reason:
        role.eligibility.teamIneligibilityReason ??
        `Agent '${role.canonicalName}' is not eligible for parallel Team execution.`,
    };
  }

  // 2. Cloud runtime eligibility
  if (options.runtime === 'cloud' && !role.eligibility.cloud) {
    return {
      allowed: false,
      errorCode: 'E_ROLE_CLOUD_UNSUPPORTED',
      reason: `Agent '${role.canonicalName}' does not support cloud runtime.`,
    };
  }

  // 3. Background execution eligibility
  if (options.isBackground && !role.eligibility.background) {
    return {
      allowed: false,
      errorCode: 'E_ROLE_BACKGROUND_UNSUPPORTED',
      reason: `Agent '${role.canonicalName}' does not support background execution.`,
    };
  }

  // 4. Parent policy delegation boundary
  if (options.parentPolicy) {
    if (options.parentPolicy.maxDepth <= 0) {
      return {
        allowed: false,
        errorCode: 'E_DELEGATION_DEPTH_EXCEEDED',
        reason: 'Parent subagent delegation depth exceeded (depth limit 0).',
      };
    }
    if (!options.parentPolicy.canDelegate) {
      return {
        allowed: false,
        errorCode: 'E_DELEGATION_FORBIDDEN',
        reason: 'Parent agent policy strictly forbids subagent delegation.',
      };
    }

    const effectivePolicy = intersectPolicy(options.parentPolicy, role, profile);
    return {
      allowed: true,
      effectivePolicy,
    };
  }

  // Top-level effective policy
  const allowedTools = profile?.toolPolicyOverride?.allow ?? role.tools.allow;
  const deniedTools = profile?.toolPolicyOverride?.deny ?? role.tools.deny;
  const writeScope = profile?.toolPolicyOverride?.writeScope ?? role.tools.writeScope;

  return {
    allowed: true,
    effectivePolicy: {
      allowedTools,
      deniedTools,
      writeScope,
      maxDepth: role.delegation.maxDepth,
      canDelegate: role.delegation.canDelegate && role.delegation.maxDepth > 0,
      workspaceIsolation: role.workspace.isolationLevel,
    },
  };
}

/**
 * Validates whether a file write is allowed under the current effective policy.
 */
export function validateFileWrite(
  policy: EffectiveAgentPolicy,
  targetPath: string,
  projectRoot: string,
  worktreePath?: string
): { allowed: boolean; reason?: string } {
  if (policy.writeScope === 'none') {
    return {
      allowed: false,
      reason: 'E_PERMISSION_DENIED: Read-only agent policy forbids file writing.',
    };
  }

  if (policy.writeScope === 'markdown-only') {
    const isDocOrArtifact =
      targetPath.endsWith('.md') ||
      targetPath.endsWith('.markdown') ||
      targetPath.endsWith('.json') ||
      targetPath.includes('/artifacts/') ||
      targetPath.includes('docs/');

    if (!isDocOrArtifact) {
      return {
        allowed: false,
        reason: `E_WRITE_SCOPE_VIOLATION: Write restricted to markdown or artifact documentation (${targetPath}).`,
      };
    }
  }

  if (policy.writeScope === 'worktree-only') {
    if (!worktreePath) {
      return {
        allowed: false,
        reason: 'E_WRITE_SCOPE_VIOLATION: Worktree agent requires assigned worktree path for writes.',
      };
    }
    const resolvedTarget = path.resolve(projectRoot, targetPath);
    const resolvedWorktree = path.resolve(worktreePath);
    if (!resolvedTarget.startsWith(resolvedWorktree)) {
      return {
        allowed: false,
        reason: `E_WORKTREE_ESCAPED: Write to '${targetPath}' escapes assigned worktree '${worktreePath}'.`,
      };
    }
  }

  return { allowed: true };
}

/**
 * Validates whether a tool call is permitted by policy.
 */
export function validateToolCall(
  policy: EffectiveAgentPolicy,
  toolName: string
): { allowed: boolean; reason?: string } {
  if (policy.deniedTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `E_TOOL_DENIED: Tool '${toolName}' is explicitly denied by role policy.`,
    };
  }
  if (!policy.allowedTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `E_TOOL_NOT_ALLOWED: Tool '${toolName}' is not in the permitted tools list.`,
    };
  }
  return { allowed: true };
}
