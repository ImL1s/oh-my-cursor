import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Executor Agent Persona (omcu-agent-executor)', () => {
  it('loads canonical executor role and maps junior / hephaestus profiles', () => {
    const role = getAgentRole('omcu-agent-executor');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-executor');
    expect(role!.category).toBe('execution');

    const profileIds = role!.profiles.map((p) => p.profileId);
    expect(profileIds).toContain('default');
    expect(profileIds).toContain('omc');
    expect(profileIds).toContain('omx');
    expect(profileIds).toContain('omo-junior');
    expect(profileIds).toContain('omo-hephaestus');
  });

  it('verifies alias resolution for executor / implementer / junior', () => {
    expect(getAgentRole('executor')?.id).toBe('omcu-agent-executor');
    expect(getAgentRole('implementer')?.id).toBe('omcu-agent-executor');
    expect(getAgentRole('omc_executor')?.id).toBe('omcu-agent-executor');
    expect(getAgentRole('omx_executor')?.id).toBe('omcu-agent-executor');
    expect(getAgentRole('junior')?.id).toBe('omcu-agent-executor');
    expect(getAgentRole('omo_junior')?.id).toBe('omcu-agent-executor');
    expect(getAgentRole('hephaestus')?.id).toBe('omcu-agent-executor');
    expect(getAgentRole('omo_hephaestus')?.id).toBe('omcu-agent-executor');
  });

  it('allows full write permissions and shell execution', () => {
    const role = getAgentRole('omcu-executor')!;
    const enforcement = validateAgentInvocation(role, {});
    const policy = enforcement.effectivePolicy!;

    expect(policy.writeScope).toBe('all');
    expect(validateToolCall(policy, 'write_to_file').allowed).toBe(true);
    expect(validateToolCall(policy, 'replace_file_content').allowed).toBe(true);
    expect(validateToolCall(policy, 'run_command').allowed).toBe(true);
    expect(validateFileWrite(policy, 'src/test.ts', root).allowed).toBe(true);
  });

  it('routes junior profile to fast model tier and hephaestus to smart tier', () => {
    const { role: r1, profile: p1 } = resolveRoleAndProfile('omcu-executor', 'omo-junior');
    const route1 = resolveAgentRoute(r1, p1);
    expect(route1.routingTier).toBe('fast');

    const { role: r2, profile: p2 } = resolveRoleAndProfile('omcu-executor', 'omo-hephaestus');
    const route2 = resolveAgentRoute(r2, p2);
    expect(route2.routingTier).toBe('smart');
  });

  it('verifies native agent definition in agents/omcu-executor.md', () => {
    const role = getAgentRole('omcu-executor')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-executor\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
