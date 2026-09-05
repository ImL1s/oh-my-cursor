import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('QA Tester Agent Persona (omcu-agent-qa-tester)', () => {
  it('loads canonical qa-tester role and athena profile', () => {
    const role = getAgentRole('omcu-agent-qa-tester');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-qa-tester');
    expect(role!.category).toBe('testing');
    expect(role!.model.routingTier).toBe('smart');

    const profileIds = role!.profiles.map((p) => p.profileId);
    expect(profileIds).toContain('default');
    expect(profileIds).toContain('omc');
    expect(profileIds).toContain('omx');
    expect(profileIds).toContain('omo-athena');
  });

  it('verifies alias resolution for qa-tester / qa / athena', () => {
    expect(getAgentRole('qa-tester')?.id).toBe('omcu-agent-qa-tester');
    expect(getAgentRole('qa')?.id).toBe('omcu-agent-qa-tester');
    expect(getAgentRole('omc_qa_tester')?.id).toBe('omcu-agent-qa-tester');
    expect(getAgentRole('omx_qa_tester')?.id).toBe('omcu-agent-qa-tester');
    expect(getAgentRole('athena')?.id).toBe('omcu-agent-qa-tester');
    expect(getAgentRole('omo_athena')?.id).toBe('omcu-agent-qa-tester');
  });

  it('allows write and test command execution for test suite validation', () => {
    const role = getAgentRole('omcu-agent-qa-tester')!;
    const enforcement = validateAgentInvocation(role, {});
    const policy = enforcement.effectivePolicy!;

    expect(validateToolCall(policy, 'run_command').allowed).toBe(true);
    expect(validateToolCall(policy, 'write_to_file').allowed).toBe(true);
    expect(validateFileWrite(policy, 'tests/sample.test.ts', root).allowed).toBe(true);
  });

  it('verifies native agent definition in agents/omcu-qa-tester.md', () => {
    const role = getAgentRole('omcu-agent-qa-tester')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-qa-tester\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
