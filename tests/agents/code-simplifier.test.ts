import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Code Simplifier Agent (omcu-agent-code-simplifier)', () => {
  it('loads canonical code-simplifier role and profiles', () => {
    const role = getAgentRole('omcu-agent-code-simplifier');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-code-simplifier');
    expect(role!.category).toBe('refactoring');
    expect(role!.model.routingTier).toBe('smart');
  });

  it('verifies alias resolution for code-simplifier', () => {
    expect(getAgentRole('code-simplifier')?.id).toBe('omcu-agent-code-simplifier');
    expect(getAgentRole('omx_code_simplifier')?.id).toBe('omcu-agent-code-simplifier');
  });

  it('allows write and test run permissions while forbidding child delegation', () => {
    const role = getAgentRole('omcu-agent-code-simplifier')!;
    const enforcement = validateAgentInvocation(role, {});
    const policy = enforcement.effectivePolicy!;

    expect(policy.canDelegate).toBe(false);
    expect(policy.maxDepth).toBe(0);
    expect(validateToolCall(policy, 'run_command').allowed).toBe(true);
    expect(validateToolCall(policy, 'write_to_file').allowed).toBe(true);
  });

  it('verifies native agent definition in agents/omcu-code-simplifier.md', () => {
    const role = getAgentRole('omcu-agent-code-simplifier')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-code-simplifier\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
