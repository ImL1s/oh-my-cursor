import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Git Master Hygiene Agent (omcu-agent-git-master)', () => {
  it('loads canonical git-master role and profiles', () => {
    const role = getAgentRole('omcu-agent-git-master');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-git-master');
    expect(role!.category).toBe('operations');
    expect(role!.model.routingTier).toBe('fast');
  });

  it('verifies alias resolution for git-master', () => {
    expect(getAgentRole('git-master')?.id).toBe('omcu-agent-git-master');
    expect(getAgentRole('omx_git_master')?.id).toBe('omcu-agent-git-master');
  });

  it('enforces single-threaded repository lock and team ineligibility', () => {
    const role = getAgentRole('omcu-agent-git-master')!;
    expect(role.eligibility.team).toBe(false);
    expect(role.eligibility.cloud).toBe(false);
    expect(role.eligibility.background).toBe(false);

    // Team invocation fails closed
    const teamCheck = validateAgentInvocation(role, { isTeamWorker: true });
    expect(teamCheck.allowed).toBe(false);
    expect(teamCheck.errorCode).toBe('E_ROLE_TEAM_INELIGIBLE');

    // Cloud invocation fails closed
    const cloudCheck = validateAgentInvocation(role, { runtime: 'cloud' });
    expect(cloudCheck.allowed).toBe(false);
    expect(cloudCheck.errorCode).toBe('E_ROLE_CLOUD_UNSUPPORTED');

    // Background invocation fails closed
    const bgCheck = validateAgentInvocation(role, { isBackground: true });
    expect(bgCheck.allowed).toBe(false);
    expect(bgCheck.errorCode).toBe('E_ROLE_BACKGROUND_UNSUPPORTED');
  });

  it('verifies native agent definition in agents/omcu-git-master.md', () => {
    const role = getAgentRole('omcu-agent-git-master')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-git-master\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
