import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Build Fixer Agent (omcu-agent-build-fixer)', () => {
  it('loads canonical build-fixer role and profiles', () => {
    const role = getAgentRole('omcu-agent-build-fixer');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-build-fixer');
    expect(role!.category).toBe('debugging');
    expect(role!.model.routingTier).toBe('fast');
  });

  it('verifies alias resolution for build-fixer', () => {
    expect(getAgentRole('build-fixer')?.id).toBe('omcu-agent-build-fixer');
    expect(getAgentRole('omx_build_fixer')?.id).toBe('omcu-agent-build-fixer');
  });

  it('enforces path-scoped write permissions and compiler command execution', () => {
    const role = getAgentRole('omcu-agent-build-fixer')!;
    const enforcement = validateAgentInvocation(role, {});
    const policy = enforcement.effectivePolicy!;

    expect(policy.writeScope).toBe('path-scoped');
    expect(validateToolCall(policy, 'run_command').allowed).toBe(true);
    expect(validateToolCall(policy, 'write_to_file').allowed).toBe(true);
  });

  it('verifies native agent definition in agents/omcu-build-fixer.md', () => {
    const role = getAgentRole('omcu-agent-build-fixer')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-build-fixer\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
