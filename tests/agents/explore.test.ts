import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Explore Reconnaissance Agent (omcu-agent-explore)', () => {
  it('loads canonical explore role and profiles including hermes', () => {
    const role = getAgentRole('omcu-agent-explore');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-explorer');
    expect(role!.category).toBe('reconnaissance');
    expect(role!.model.routingTier).toBe('fast');

    const profileIds = role!.profiles.map((p) => p.profileId);
    expect(profileIds).toContain('default');
    expect(profileIds).toContain('omc');
    expect(profileIds).toContain('omx');
    expect(profileIds).toContain('omo-hermes');
  });

  it('verifies alias resolution for explore / explorer / hermes', () => {
    expect(getAgentRole('explore')?.id).toBe('omcu-agent-explore');
    expect(getAgentRole('explorer')?.id).toBe('omcu-agent-explore');
    expect(getAgentRole('omc_explore')?.id).toBe('omcu-agent-explore');
    expect(getAgentRole('omx_explore')?.id).toBe('omcu-agent-explore');
    expect(getAgentRole('hermes')?.id).toBe('omcu-agent-explore');
    expect(getAgentRole('omo_hermes')?.id).toBe('omcu-agent-explore');
  });

  it('strictly limits tools to read-only discovery', () => {
    const role = getAgentRole('omcu-agent-explore')!;
    const enforcement = validateAgentInvocation(role, {});
    const policy = enforcement.effectivePolicy!;

    expect(policy.writeScope).toBe('none');
    expect(validateToolCall(policy, 'read_file').allowed).toBe(true);
    expect(validateToolCall(policy, 'grep_search').allowed).toBe(true);
    expect(validateToolCall(policy, 'find_by_name').allowed).toBe(true);
    expect(validateToolCall(policy, 'list_dir').allowed).toBe(true);
    expect(validateToolCall(policy, 'write_to_file').allowed).toBe(false);
    expect(validateToolCall(policy, 'run_command').allowed).toBe(false);
  });

  it('routes to fast tier with low latency model', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-explorer');
    const route = resolveAgentRoute(role, profile);

    expect(route.routingTier).toBe('fast');
    expect(route.selectedModel).toBe('claude-3-5-haiku');
  });

  it('verifies native agent definition in agents/omcu-explorer.md', () => {
    const role = getAgentRole('omcu-agent-explore')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-explorer\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
