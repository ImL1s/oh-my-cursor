import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateFileWrite, validateToolCall } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Architect Agent Persona (omcu-agent-architect)', () => {
  it('loads canonical architect role definition and all source profiles', () => {
    const role = getAgentRole('omcu-agent-architect');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-architect');
    expect(role!.category).toBe('architecture');
    expect(role!.mode).toBe('either');
    expect(role!.model.routingTier).toBe('reasoning');
    expect(role!.model.reasoningEffort).toBe('high');

    // Upstream profiles: omc, omx, omo-oracle
    const profileIds = role!.profiles.map((p) => p.profileId);
    expect(profileIds).toContain('default');
    expect(profileIds).toContain('omc');
    expect(profileIds).toContain('omx');
    expect(profileIds).toContain('omo-oracle');
  });

  it('verifies alias resolution for architect across OMC, OMX, and OMO', () => {
    expect(getAgentRole('architect')?.id).toBe('omcu-agent-architect');
    expect(getAgentRole('omc_architect')?.id).toBe('omcu-agent-architect');
    expect(getAgentRole('omx_architect')?.id).toBe('omcu-agent-architect');
    expect(getAgentRole('oracle')?.id).toBe('omcu-agent-architect');
    expect(getAgentRole('omo_oracle')?.id).toBe('omcu-agent-architect');
  });

  it('enforces read-only tool sandbox and write restrictions', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-architect', 'omo-oracle');
    const enforcement = validateAgentInvocation(role, { profile: profile.profileId }, profile);
    expect(enforcement.allowed).toBe(true);

    const policy = enforcement.effectivePolicy!;
    expect(policy.writeScope).toBe('none');
    expect(validateToolCall(policy, 'read_file').allowed).toBe(true);
    expect(validateToolCall(policy, 'grep_search').allowed).toBe(true);
    expect(validateToolCall(policy, 'write_to_file').allowed).toBe(false);
    expect(validateToolCall(policy, 'run_command').allowed).toBe(false);

    expect(validateFileWrite(policy, 'src/index.ts', root).allowed).toBe(false);
  });

  it('composes prompt with deterministic SHA-256 hash and boundary rules', () => {
    const role = getAgentRole('omcu-architect')!;
    const composed = composeAgentPrompt(role, 'omo-oracle', {
      objective: 'Evaluate architectural boundaries and invariants',
    });

    expect(composed.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(composed.systemPrompt).toContain('Role: omcu-architect (omo-oracle)');
    expect(composed.systemPrompt).toContain('Do not spawn nested subagents.');
    expect(composed.systemPrompt).toContain('Redact secrets');
    expect(composed.systemPrompt).toContain('Clean-room high-reasoning oracle architecture advisor');
  });

  it('routes to high-reasoning model tier with router compatibility', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-architect', 'omo-oracle');
    const route = resolveAgentRoute(role, profile);

    expect(route.routingTier).toBe('reasoning');
    expect(route.reasoningEffort).toBe('high');
    expect(route.routerCompatibility).toBe(true);
    expect(route.selectedModel).toBe('claude-3-7-sonnet-thought');
  });

  it('verifies native Cursor agent definition file existence and boundaries', () => {
    const role = getAgentRole('omcu-architect')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-architect\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
