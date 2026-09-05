import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Writer Documentation Agent (omcu-agent-writer)', () => {
  it('loads canonical writer role and profiles', () => {
    const role = getAgentRole('omcu-agent-writer');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-writer');
    expect(role!.category).toBe('documentation');
    expect(role!.model.routingTier).toBe('fast');

    const profileIds = role!.profiles.map((p) => p.profileId);
    expect(profileIds).toContain('default');
    expect(profileIds).toContain('omc');
    expect(profileIds).toContain('omx');
  });

  it('verifies alias resolution for writer', () => {
    expect(getAgentRole('writer')?.id).toBe('omcu-agent-writer');
    expect(getAgentRole('omc_writer')?.id).toBe('omcu-agent-writer');
    expect(getAgentRole('omx_writer')?.id).toBe('omcu-agent-writer');
  });

  it('restricts write scope strictly to documentation / markdown assets and forbids shell', () => {
    const role = getAgentRole('omcu-agent-writer')!;
    const enforcement = validateAgentInvocation(role, {});
    const policy = enforcement.effectivePolicy!;

    expect(policy.writeScope).toBe('markdown-only');
    expect(validateToolCall(policy, 'run_command').allowed).toBe(false);
    expect(validateFileWrite(policy, 'docs/guide.md', root).allowed).toBe(true);
    expect(validateFileWrite(policy, 'src/main.ts', root).allowed).toBe(false);
  });

  it('verifies native agent definition in agents/omcu-writer.md', () => {
    const role = getAgentRole('omcu-agent-writer')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-writer\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
