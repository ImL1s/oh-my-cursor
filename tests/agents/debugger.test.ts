import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Debugger Agent Persona (omcu-agent-debugger)', () => {
  it('loads canonical debugger role and verifies profiles', () => {
    const role = getAgentRole('omcu-agent-debugger');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-debugger');
    expect(role!.category).toBe('debugging');
    expect(role!.model.routingTier).toBe('smart');

    const profileIds = role!.profiles.map((p) => p.profileId);
    expect(profileIds).toContain('default');
    expect(profileIds).toContain('omc');
    expect(profileIds).toContain('omx');
  });

  it('verifies alias resolution for debugger', () => {
    expect(getAgentRole('debugger')?.id).toBe('omcu-agent-debugger');
    expect(getAgentRole('omc_debugger')?.id).toBe('omcu-agent-debugger');
    expect(getAgentRole('omx_debugger')?.id).toBe('omcu-agent-debugger');
  });

  it('allows diagnostic shell commands but forbids code edits', () => {
    const role = getAgentRole('omcu-debugger')!;
    const enforcement = validateAgentInvocation(role, {});
    const policy = enforcement.effectivePolicy!;

    expect(validateToolCall(policy, 'run_command').allowed).toBe(true);
    expect(validateToolCall(policy, 'read_file').allowed).toBe(true);
    expect(validateToolCall(policy, 'write_to_file').allowed).toBe(false);
    expect(validateFileWrite(policy, 'src/index.ts', root).allowed).toBe(false);
  });

  it('routes to smart model tier with background eligibility', () => {
    const { role, profile } = resolveRoleAndProfile('omcu-debugger');
    const route = resolveAgentRoute(role, profile);

    expect(route.routingTier).toBe('smart');
    expect(role.eligibility.background).toBe(true);
  });

  it('verifies native agent definition in agents/omcu-debugger.md', () => {
    const role = getAgentRole('omcu-debugger')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-debugger\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
