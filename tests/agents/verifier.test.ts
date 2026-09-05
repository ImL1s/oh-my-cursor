import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Verifier Gatekeeper Agent (omcu-agent-verifier)', () => {
  it('loads canonical verifier role and profiles', () => {
    const role = getAgentRole('omcu-agent-verifier');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-verifier');
    expect(role!.category).toBe('verification');
    expect(role!.model.routingTier).toBe('reasoning');
    expect(role!.model.reasoningEffort).toBe('high');

    const profileIds = role!.profiles.map((p) => p.profileId);
    expect(profileIds).toContain('default');
    expect(profileIds).toContain('omc');
    expect(profileIds).toContain('omx');
  });

  it('verifies alias resolution for verifier', () => {
    expect(getAgentRole('verifier')?.id).toBe('omcu-agent-verifier');
    expect(getAgentRole('omc_verifier')?.id).toBe('omcu-agent-verifier');
    expect(getAgentRole('omx_verifier')?.id).toBe('omcu-agent-verifier');
  });

  it('allows automated test verification commands while strictly forbidding code modification', () => {
    const role = getAgentRole('omcu-agent-verifier')!;
    const enforcement = validateAgentInvocation(role, {});
    const policy = enforcement.effectivePolicy!;

    expect(validateToolCall(policy, 'run_command').allowed).toBe(true);
    expect(validateToolCall(policy, 'read_file').allowed).toBe(true);
    expect(validateToolCall(policy, 'write_to_file').allowed).toBe(false);
    expect(validateToolCall(policy, 'replace_file_content').allowed).toBe(false);
    expect(validateFileWrite(policy, 'src/index.ts', root).allowed).toBe(false);
  });

  it('never delegates and enforces leaf execution', () => {
    const role = getAgentRole('omcu-agent-verifier')!;
    expect(role.delegation.canDelegate).toBe(false);
    expect(role.delegation.maxDepth).toBe(0);
  });

  it('verifies native agent definition in agents/omcu-verifier.md', () => {
    const role = getAgentRole('omcu-agent-verifier')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-verifier\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
