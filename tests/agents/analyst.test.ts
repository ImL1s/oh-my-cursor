import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Analyst Requirements Agent (omcu-agent-analyst)', () => {
  it('loads canonical analyst role and metis profile', () => {
    const role = getAgentRole('omcu-agent-analyst');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-analyst');
    expect(role!.category).toBe('analysis');
    expect(role!.model.routingTier).toBe('smart');

    const profileIds = role!.profiles.map((p) => p.profileId);
    expect(profileIds).toContain('default');
    expect(profileIds).toContain('omx');
    expect(profileIds).toContain('omo-metis');
  });

  it('verifies alias resolution for analyst and metis', () => {
    expect(getAgentRole('analyst')?.id).toBe('omcu-agent-analyst');
    expect(getAgentRole('omx_analyst')?.id).toBe('omcu-agent-analyst');
    expect(getAgentRole('metis')?.id).toBe('omcu-agent-analyst');
    expect(getAgentRole('omo_metis')?.id).toBe('omcu-agent-analyst');
  });

  it('enforces read-only analysis without shell execution or file writes', () => {
    const role = getAgentRole('omcu-agent-analyst')!;
    const enforcement = validateAgentInvocation(role, {});
    const policy = enforcement.effectivePolicy!;

    expect(policy.writeScope).toBe('none');
    expect(validateToolCall(policy, 'run_command').allowed).toBe(false);
    expect(validateToolCall(policy, 'write_to_file').allowed).toBe(false);
    expect(validateToolCall(policy, 'read_file').allowed).toBe(true);
  });

  it('verifies native agent definition in agents/omcu-analyst.md', () => {
    const role = getAgentRole('omcu-agent-analyst')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-analyst\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
