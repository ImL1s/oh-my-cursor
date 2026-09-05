import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_AGENT_ROLES,
  getAgentRole,
  listAgentRoles,
  resolveRoleAndProfile,
  discoverCustomAgents,
} from '../../src/agents/catalog.js';
import { composeAgentPrompt, compileChildHandoffArtifact } from '../../src/agents/prompt.js';
import { resolveAgentRoute, explainAgentRoute } from '../../src/agents/routing.js';
import {
  validateAgentInvocation,
  intersectPolicy,
  validateFileWrite,
  validateToolCall,
} from '../../src/agents/enforcement.js';
import { createSdkAgentProfile } from '../../src/runtime/cursor-sdk/agents.js';
import { loadParityLocks } from '../../src/parity/validator.js';

const root = path.resolve(import.meta.dirname, '../..');

describe('OMCU Comprehensive Role Catalog & Parity Conformance (Issue #26)', () => {
  it('maps every upstream role from OMC, OMX, and OMO locks to a canonical agent or profile', () => {
    const locks = loadParityLocks(root);

    // 1. OMC items
    const omcAgents = locks.omc.items.filter((item) => item.surface_family === 'agent');
    expect(omcAgents.length).toBeGreaterThanOrEqual(10);
    for (const item of omcAgents) {
      const resolved = getAgentRole(item.id) ?? getAgentRole(item.source_name);
      expect(
        resolved,
        `Expected upstream OMC agent '${item.id}' (${item.source_name}) to resolve in canonical catalog`
      ).toBeDefined();
    }

    // 2. OMX items
    const omxAgents = locks.omx.items.filter((item) => item.surface_family === 'agent');
    expect(omxAgents.length).toBeGreaterThanOrEqual(4);
    for (const item of omxAgents) {
      const resolved = getAgentRole(item.id) ?? getAgentRole(item.source_name);
      expect(
        resolved,
        `Expected upstream OMX agent '${item.id}' (${item.source_name}) to resolve in canonical catalog`
      ).toBeDefined();
    }

    // 3. OMO items (lead, worker, inspector, and 11 built-in roles)
    const omoAgents = locks.omo.items.filter((item) => item.surface_family === 'agent');
    expect(omoAgents.length).toBeGreaterThanOrEqual(3);
    for (const item of omoAgents) {
      const resolved = getAgentRole(item.id) ?? getAgentRole(item.source_name);
      expect(
        resolved,
        `Expected upstream OMO agent '${item.id}' (${item.source_name}) to resolve in canonical catalog`
      ).toBeDefined();
    }

    // Check all 11 built-in OMO roles: oracle, junior, prometheus, momus, metis, hephaestus, argus, hermes, athena, lead, worker
    const omo11Builtins = [
      'oracle',
      'junior',
      'prometheus',
      'momus',
      'metis',
      'hephaestus',
      'argus',
      'hermes',
      'athena',
      'lead',
      'worker',
    ];
    for (const roleName of omo11Builtins) {
      const resolved = getAgentRole(roleName);
      expect(resolved, `Expected OMO built-in role '${roleName}' to resolve in canonical catalog`).toBeDefined();
      expect(
        resolved!.profiles.some((p) => p.source === 'omo'),
        `Expected role '${roleName}' to contain an OMO clean-room profile`
      ).toBe(true);
    }
  });

  it('fails validation when an unmapped upstream agent role is detected', () => {
    // Simulating CI check: every role from an upstream catalog must resolve
    const mockUpstreamRole = 'omc_unmapped_alien_agent';
    const resolved = getAgentRole(mockUpstreamRole);
    expect(resolved).toBeUndefined();

    // Assertion that a strict checker will reject unmapped entries
    const checkMapping = (id: string) => {
      const r = getAgentRole(id);
      if (!r) throw new Error(`CI_UNMAPPED_AGENT: Upstream role '${id}' has no canonical mapping`);
      return r;
    };

    expect(() => checkMapping(mockUpstreamRole)).toThrow('CI_UNMAPPED_AGENT');
  });

  it('generates reproducible SHA-256 prompt hashes without transcript bleed', () => {
    const role = getAgentRole('omcu-architect')!;
    const prompt1 = composeAgentPrompt(role, 'default', { objective: 'Design clean boundaries' });
    const prompt2 = composeAgentPrompt(role, 'default', { objective: 'Design clean boundaries' });

    expect(prompt1.promptHash).toBe(prompt2.promptHash);
    expect(prompt1.promptHash).toMatch(/^[a-f0-9]{64}$/);

    // Handoff compiler produces minimal bounded context without conversation transcript
    const handoff = compileChildHandoffArtifact({
      objective: 'Check boundaries',
      handoffArtifact: 'arch-spec-1.md',
    });
    const parsed = JSON.parse(handoff);
    expect(parsed.objective).toBe('Check boundaries');
    expect(parsed.handoffArtifact).toBe('arch-spec-1.md');
    expect(parsed.conversationTranscript).toBeUndefined();
  });

  it('intersects parent and child policies correctly (narrowing permissions)', () => {
    const parentPolicy = {
      allowedTools: ['read_file', 'grep_search', 'list_dir'],
      deniedTools: ['write_to_file', 'run_command'],
      writeScope: 'none' as const,
      maxDepth: 2,
      canDelegate: true,
      workspaceIsolation: 'read-only' as const,
    };

    // Child executor nominally allows write and shell
    const childExecutor = getAgentRole('omcu-executor')!;
    const intersected = intersectPolicy(parentPolicy, childExecutor);

    // After intersection, child cannot exceed parent's read-only authority
    expect(intersected.allowedTools).toEqual(['read_file', 'grep_search', 'list_dir']);
    expect(intersected.writeScope).toBe('none');
    expect(intersected.maxDepth).toBe(0); // executor maxDepth 0 vs parent maxDepth - 1
    expect(intersected.canDelegate).toBe(false);
  });

  it('creates programmatically valid SDK agent profiles with @cursor/sdk bindings', () => {
    const sdkProfile = createSdkAgentProfile('omcu-planner', 'omo-prometheus', {
      objective: 'Compile DAG milestones',
    });

    expect(sdkProfile.roleId).toBe('omcu-agent-planner');
    expect(sdkProfile.canonicalName).toBe('omcu-planner');
    expect(sdkProfile.profileId).toBe('omo-prometheus');
    expect(sdkProfile.routingTier).toBe('reasoning');
    expect(sdkProfile.writeScope).toBe('markdown-only');
    expect(sdkProfile.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(sdkProfile.systemPrompt).toContain('Do not spawn nested subagents.');
  });

  it('discovers custom user agents safely without collision with built-ins', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-custom-agents-'));
    try {
      const customAgentDir = path.join(tempDir, '.cursor', 'agents');
      fs.mkdirSync(customAgentDir, { recursive: true });

      // Write a valid custom agent
      fs.writeFileSync(
        path.join(customAgentDir, 'custom-auditor.md'),
        '---\nname: custom-auditor\ndescription: Custom project auditor\nreadonly: true\n---\n\nAudit things.\n',
        'utf8'
      );

      // Write a colliding file (should be ignored)
      fs.writeFileSync(
        path.join(customAgentDir, 'omcu-architect.md'),
        '---\nname: omcu-architect\ndescription: Fake architect\n---\n',
        'utf8'
      );

      const discovered = discoverCustomAgents(tempDir);
      expect(discovered.length).toBe(1);
      expect(discovered[0]!.canonicalName).toBe('custom-auditor');
      expect(discovered[0]!.custom).toBe(true);
      expect(discovered[0]!.tools.writeScope).toBe('none');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
