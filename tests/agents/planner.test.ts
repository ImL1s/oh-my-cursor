import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Planner Agent Persona (omcu-agent-planner)', () => {
  it('loads canonical planner role and prometheus profile', () => {
    const role = getAgentRole('omcu-agent-planner');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-planner');
    expect(role!.category).toBe('planning');
    expect(role!.model.routingTier).toBe('reasoning');
    expect(role!.model.reasoningEffort).toBe('high');

    const profileIds = role!.profiles.map((p) => p.profileId);
    expect(profileIds).toContain('default');
    expect(profileIds).toContain('omc');
    expect(profileIds).toContain('omx');
    expect(profileIds).toContain('omo-prometheus');
  });

  it('verifies alias resolution for planner across OMC, OMX, and OMO', () => {
    expect(getAgentRole('planner')?.id).toBe('omcu-agent-planner');
    expect(getAgentRole('omc_planner')?.id).toBe('omcu-agent-planner');
    expect(getAgentRole('omx_planner')?.id).toBe('omcu-agent-planner');
    expect(getAgentRole('prometheus')?.id).toBe('omcu-agent-planner');
    expect(getAgentRole('omo_prometheus')?.id).toBe('omcu-agent-planner');
  });

  it('enforces markdown-only write scope and single-level subagent delegation', () => {
    const role = getAgentRole('omcu-agent-planner')!;
    const enforcement = validateAgentInvocation(role, {});
    const policy = enforcement.effectivePolicy!;

    expect(policy.writeScope).toBe('markdown-only');
    expect(policy.maxDepth).toBe(1);
    expect(policy.canDelegate).toBe(true);

    // Markdown/artifact write allowed, code file write rejected
    expect(validateFileWrite(policy, 'docs/plan.md', root).allowed).toBe(true);
    expect(validateFileWrite(policy, '.omcu/artifacts/plan-1.md', root).allowed).toBe(true);
    expect(validateFileWrite(policy, 'src/index.ts', root).allowed).toBe(false);

    // Shell execution denied
    expect(validateToolCall(policy, 'run_command').allowed).toBe(false);
  });

  it('composes prometheus prompt with deterministic SHA-256 hash', () => {
    const role = getAgentRole('omcu-agent-planner')!;
    const composed = composeAgentPrompt(role, 'omo-prometheus', {
      objective: 'Synthesize requirements into ordered DAG milestones',
    });

    expect(composed.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(composed.systemPrompt).toContain('Role: omcu-planner (omo-prometheus)');
    expect(composed.systemPrompt).toContain('Clean-room foresight planner');
  });

  it('verifies native agent definition in agents/omcu-planner.md', () => {
    const role = getAgentRole('omcu-agent-planner')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-planner\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
