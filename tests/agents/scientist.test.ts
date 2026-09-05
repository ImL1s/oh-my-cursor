import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Scientist Empirical Agent (omcu-agent-scientist)', () => {
  it('loads canonical scientist role and profiles', () => {
    const role = getAgentRole('omcu-agent-scientist');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-scientist');
    expect(role!.category).toBe('research');
    expect(role!.model.routingTier).toBe('reasoning');

    const profileIds = role!.profiles.map((p) => p.profileId);
    expect(profileIds).toContain('default');
    expect(profileIds).toContain('omc');
    expect(profileIds).toContain('omx');
  });

  it('verifies alias resolution for scientist', () => {
    expect(getAgentRole('scientist')?.id).toBe('omcu-agent-scientist');
    expect(getAgentRole('omc_scientist')?.id).toBe('omcu-agent-scientist');
    expect(getAgentRole('omx_scientist')?.id).toBe('omcu-agent-scientist');
  });

  it('allows benchmark command execution and limits writes to markdown/artifacts', () => {
    const role = getAgentRole('omcu-agent-scientist')!;
    const enforcement = validateAgentInvocation(role, {});
    const policy = enforcement.effectivePolicy!;

    expect(validateToolCall(policy, 'run_command').allowed).toBe(true);
    expect(validateFileWrite(policy, '.omcu/artifacts/bench.json', root).allowed).toBe(true);
    expect(validateFileWrite(policy, 'src/index.ts', root).allowed).toBe(false);
  });

  it('verifies native agent definition in agents/omcu-scientist.md', () => {
    const role = getAgentRole('omcu-agent-scientist')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-scientist\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
