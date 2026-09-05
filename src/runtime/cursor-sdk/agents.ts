import { getAgentRole, resolveRoleAndProfile } from '../../agents/catalog.js';
import { composeAgentPrompt } from '../../agents/prompt.js';
import { resolveAgentRoute } from '../../agents/routing.js';
import { validateAgentInvocation } from '../../agents/enforcement.js';
import type { AgentRoleDefinition, AgentTaskContext, SourceProfile } from '../../agents/types.js';
import { createAutoReviewHandler, loadCursorPermissions, toSdkCustomTool, type OmcuToolDefinition } from './tools.js';

export interface SdkAgentProfile {
  readonly roleId: string;
  readonly canonicalName: string;
  readonly profileId: string;
  readonly model: string;
  readonly routingTier: string;
  readonly systemPrompt: string;
  readonly promptHash: string;
  readonly allowedTools: readonly string[];
  readonly deniedTools: readonly string[];
  readonly maxDepth: number;
  readonly canDelegate: boolean;
  readonly writeScope: string;
}

/**
 * Creates a configured SDK agent profile with prompt composition and mechanical constraints.
 */
export function createSdkAgentProfile(
  roleOrName: AgentRoleDefinition | string,
  profileName?: string,
  context?: AgentTaskContext
): SdkAgentProfile {
  const role = typeof roleOrName === 'string' ? getAgentRole(roleOrName) : roleOrName;
  if (!role) {
    throw new Error(`E_ROLE_NOT_FOUND: agent role '${roleOrName}' not found`);
  }

  const { profile } = resolveRoleAndProfile(role.canonicalName, profileName);
  const enforcement = validateAgentInvocation(role, { profile: profile.profileId }, profile);

  if (!enforcement.allowed) {
    throw new Error(`${enforcement.errorCode ?? 'E_ENFORCEMENT_FAILED'}: ${enforcement.reason}`);
  }

  const route = resolveAgentRoute(role, profile);
  const composed = composeAgentPrompt(role, profile.profileId, context);

  return {
    roleId: role.id,
    canonicalName: role.canonicalName,
    profileId: profile.profileId,
    model: route.selectedModel,
    routingTier: route.routingTier,
    systemPrompt: composed.systemPrompt,
    promptHash: composed.promptHash,
    allowedTools: composed.effectiveTools,
    deniedTools: composed.deniedTools,
    maxDepth: composed.maxDepth,
    canDelegate: composed.canDelegate,
    writeScope: composed.writeScope,
  };
}
