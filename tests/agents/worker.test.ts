import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getAgentRole, resolveRoleAndProfile } from '../../src/agents/catalog.js';
import { composeAgentPrompt } from '../../src/agents/prompt.js';
import { resolveAgentRoute } from '../../src/agents/routing.js';
import { validateAgentInvocation, validateToolCall, validateFileWrite } from '../../src/agents/enforcement.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('Worktree Worker Agent Persona (omcu-agent-worker)', () => {
  it('loads canonical worker role and omo-worker profile', () => {
    const role = getAgentRole('omcu-agent-worker');
    expect(role).toBeDefined();
    expect(role!.canonicalName).toBe('omcu-worker');
    expect(role!.category).toBe('execution');
    expect(role!.workspace.requiresWorktree).toBe(true);
    expect(role!.workspace.isolationLevel).toBe('isolated-worktree');

    const profileIds = role!.profiles.map((p) => p.profileId);
    expect(profileIds).toContain('default');
    expect(profileIds).toContain('omo-worker');
  });

  it('verifies alias resolution for worker and omo_worker', () => {
    expect(getAgentRole('worker')?.id).toBe('omcu-agent-worker');
    expect(getAgentRole('omo_worker')?.id).toBe('omcu-agent-worker');
  });

  it('restricts writes strictly to designated worktree path', () => {
    const role = getAgentRole('omcu-agent-worker')!;
    const enforcement = validateAgentInvocation(role, {});
    const policy = enforcement.effectivePolicy!;

    const worktreePath = path.join(root, '.omcu/worktrees/wt-1');
    const insideFile = path.join(worktreePath, 'src/code.ts');
    const outsideFile = path.join(root, 'src/code.ts');

    expect(policy.writeScope).toBe('worktree-only');
    expect(validateFileWrite(policy, insideFile, root, worktreePath).allowed).toBe(true);
    expect(validateFileWrite(policy, outsideFile, root, worktreePath).allowed).toBe(false);
  });

  it('verifies native agent definition in agents/omcu-worker.md', () => {
    const role = getAgentRole('omcu-agent-worker')!;
    const filePath = path.join(root, role.agentFile);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^---\nname: omcu-worker\ndescription: .+\nmodel: inherit\n/m);
    expect(content).toContain('Do not spawn nested subagents.');
  });
});
