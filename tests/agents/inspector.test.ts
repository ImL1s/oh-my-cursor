import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Inspector Review Agent Persona (omcu-agent-inspector)', () => {
  it('loads canonical inspector role and argus profile', () => {
    const role = getAgentRole('omcu-agent-inspector');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-inspector');
    expect(role!.category).toBe('review');
    expect(role!.mode).toBe('subagent');

    const profileIds = role!.profiles.map((p) => p.profileId);
    expect(profileIds).toContain('default');
    expect(profileIds).toContain('omo-inspector');
    expect(profileIds).toContain('omo-argus');
  });

  it('verifies alias resolution for inspector and argus', () => {
    expect(getAgentRole('inspector')?.id).toBe('omcu-agent-inspector');
    expect(getAgentRole('omo_inspector')?.id).toBe('omcu-agent-inspector');
    expect(getAgentRole('argus')?.id).toBe('omcu-agent-inspector');
    expect(getAgentRole('omo_argus')?.id).toBe('omcu-agent-inspector');
  });

  it('enforces read-only audit with zero file modification or command execution', () => {
    const role = getAgentRole('omcu-agent-inspector')!;
    const enforcement = validateAgentInvocation(role, {});
    const policy = enforcement.effectivePolicy!;

    expect(policy.writeScope).toBe('none');
    expect(validateToolCall(policy, 'read_file').allowed).toBe(true);
    expect(validateToolCall(policy, 'write_to_file').allowed).toBe(false);
    expect(validateToolCall(policy, 'run_command').allowed).toBe(false);
  });

  it('verifies native agent definition in agents/omcu-inspector.md', () => {
    const role = getAgentRole('omcu-agent-inspector')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-inspector\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
