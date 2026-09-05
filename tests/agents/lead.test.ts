import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Lead Orchestrator Agent Persona (omcu-agent-lead)', () => {
  it('loads canonical lead role and omo-lead profile', () => {
    const role = getAgentRole('omcu-agent-lead');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-lead');
    expect(role!.category).toBe('coordination');
    expect(role!.mode).toBe('primary');
    expect(role!.delegation.canDelegate).toBe(true);
    expect(role!.delegation.maxDepth).toBe(1);

    const profileIds = role!.profiles.map((p) => p.profileId);
    expect(profileIds).toContain('default');
    expect(profileIds).toContain('omo-lead');
  });

  it('verifies alias resolution for lead and omo_lead', () => {
    expect(getAgentRole('lead')?.id).toBe('omcu-agent-lead');
    expect(getAgentRole('omo_lead')?.id).toBe('omcu-agent-lead');
  });

  it('supports delegating to worker, inspector, and explorer roles', () => {
    const role = getAgentRole('omcu-agent-lead')!;
    expect(role.delegation.allowedSubagentRoles).toContain('omcu-worker');
    expect(role.delegation.allowedSubagentRoles).toContain('omcu-inspector');
    expect(role.delegation.allowedSubagentRoles).toContain('omcu-explorer');
  });

  it('verifies native agent definition in agents/omcu-lead.md', () => {
    const role = getAgentRole('omcu-agent-lead')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-lead\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
