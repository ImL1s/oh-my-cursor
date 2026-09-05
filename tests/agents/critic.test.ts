import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Critic Agent Persona (omcu-agent-critic)', () => {
  it('loads canonical critic role definition and profiles', () => {
    const role = getAgentRole('omcu-agent-critic');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-critic');
    expect(role!.category).toBe('review');
    expect(role!.mode).toBe('subagent');
    expect(role!.model.routingTier).toBe('reasoning');
    expect(role!.delegation.canDelegate).toBe(false);
    expect(role!.delegation.maxDepth).toBe(0);

    const profileIds = role!.profiles.map((p) => p.profileId);
    expect(profileIds).toContain('default');
    expect(profileIds).toContain('omc');
    expect(profileIds).toContain('omo-momus');
  });

  it('verifies alias resolution for critic across OMC and OMO', () => {
    expect(getAgentRole('critic')?.id).toBe('omcu-agent-critic');
    expect(getAgentRole('omc_critic')?.id).toBe('omcu-agent-critic');
    expect(getAgentRole('momus')?.id).toBe('omcu-agent-critic');
    expect(getAgentRole('omo_momus')?.id).toBe('omcu-agent-critic');
  });

  it('strictly enforces leaf delegation (maxDepth 0, cannot delegate)', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-critic', 'omo-momus');
    const enforcement = validateAgentInvocation(role, { profile: profile.profileId }, profile);
    expect(enforcement.allowed).toBe(true);
    expect(enforcement.effectivePolicy!.maxDepth).toBe(0);
    expect(enforcement.effectivePolicy!.canDelegate).toBe(false);
  });

  it('strictly forbids file modification and subprocess execution', () => {
    const role = getAgentRole('omcu-critic')!;
    const enforcement = validateAgentInvocation(role, {});
    const policy = enforcement.effectivePolicy!;

    expect(policy.writeScope).toBe('none');
    expect(validateToolCall(policy, 'run_command').allowed).toBe(false);
    expect(validateToolCall(policy, 'write_to_file').allowed).toBe(false);
    expect(validateFileWrite(policy, 'test.md', root).allowed).toBe(false);
  });

  it('composes critic prompt with momus profile and deterministic hash', () => {
    const role = getAgentRole('omcu-critic')!;
    const composed = composeAgentPrompt(role, 'omo-momus', {
      objective: 'Adversarially challenge plan assumptions',
    });

    expect(composed.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(composed.systemPrompt).toContain('Role: omcu-critic (omo-momus)');
    expect(composed.systemPrompt).toContain('Clean-room adversarial challenger');
  });

  it('verifies native agent definition in agents/omcu-critic.md', () => {
    const role = getAgentRole('omcu-critic')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-critic\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
