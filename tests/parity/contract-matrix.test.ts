import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadParityLocks,
  validateParityLocks,
  validateParityDocs,
  runParityAudit,
  REQUIRED_PARITY_DOCS
} from '../../src/parity/validator.js';
import type { ParityLocks } from '../../src/parity/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('Parity Contract Matrix & Clean-Room Provenance Lock (Issue #25)', () => {
  it('loads all 8 parity lock files successfully', () => {
    const locks = loadParityLocks(REPO_ROOT);
    expect(locks.omc).toBeDefined();
    expect(locks.omx).toBeDefined();
    expect(locks.omo).toBeDefined();
    expect(locks.sdk).toBeDefined();
    expect(locks.plugins).toBeDefined();
    expect(locks.cookbook).toBeDefined();
    expect(locks.hostCapabilities).toBeDefined();
    expect(locks.contract).toBeDefined();
  });

  it('validates schema versions of all 8 lock files', () => {
    const locks = loadParityLocks(REPO_ROOT);
    expect(locks.omc.schema_version).toBe(1);
    expect(locks.omx.schema_version).toBe(1);
    expect(locks.omo.schema_version).toBe(1);
    expect(locks.sdk.schema_version).toBe(1);
    expect(locks.plugins.schema_version).toBe(1);
    expect(locks.cookbook.schema_version).toBe(1);
    expect(locks.hostCapabilities.schema_version).toBe(2);
    expect(locks.contract.schema_version).toBe(1);
  });

  it('verifies 100% upstream source coverage (OMC, OMX, OMO)', () => {
    const locks = loadParityLocks(REPO_ROOT);
    const result = validateParityLocks(locks);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.totalUpstreamItems).toBe(57);
    expect(result.mappedUpstreamItems).toBe(57);
    expect(result.totalContracts).toBe(50);
    expect(result.cleanRoomPassed).toBe(true);
    expect(result.mechanismsValidated).toBe(18);
  });

  it('verifies deterministic sha256 hashes on all upstream items', () => {
    const locks = loadParityLocks(REPO_ROOT);
    const allItems = [...locks.omc.items, ...locks.omx.items, ...locks.omo.items];

    for (const item of allItems) {
      expect(item.id).toMatch(/^(omc|omx|omo)_[a-z0-9_]+$/);
      expect(item.hash_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(item.path).toBeTruthy();
      expect(item.surface_family).toBeTruthy();
      expect(item.upstream_evidence).toBeTruthy();
    }
  });

  it('verifies Cursor host capabilities primitives (all 18 official mechanisms)', () => {
    const locks = loadParityLocks(REPO_ROOT);
    expect(locks.hostCapabilities.mechanisms.length).toBe(18);

    const expectedMechanisms = [
      'cursor-sdk-local',
      'cursor-sdk-cloud',
      'cursor-sdk-resume',
      'cursor-sdk-subagent',
      'cursor-sdk-custom-tools',
      'cursor-plugin-skill',
      'cursor-plugin-agent',
      'cursor-plugin-rule',
      'cursor-plugin-hook',
      'cursor-mcp',
      'cursor-permissions-auto-review',
      'cursor-cli',
      'cursor-agent-window',
      'cursor-worktree',
      'cursor-automation',
      'cursor-canvas',
      'cursor-router',
      'omcu-domain-layer'
    ];

    const actualIds = locks.hostCapabilities.mechanisms.map((m) => m.mechanism_id);
    expect(actualIds.sort()).toEqual(expectedMechanisms.sort());

    for (const m of locks.hostCapabilities.mechanisms) {
      expect(m.name).toBeTruthy();
      expect(m.source_evidence).toBeTruthy();
      expect(m.contract.input).toBeTruthy();
      expect(m.contract.output).toBeTruthy();
      expect(m.contract.lifecycle).toBeTruthy();
      expect(m.status).toBe('live');
    }
  });

  it('verifies strict clean-room boundaries for OMO items', () => {
    const locks = loadParityLocks(REPO_ROOT);

    // 1. All OMO upstream items must be marked clean_room_required
    for (const item of locks.omo.items) {
      expect(item.license_class).toBe('clean_room_required');
      // Must not contain copied prompt text
      expect(item.upstream_evidence).toContain('clean-room');
    }

    // 2. All contracts mapping OMO items must have clean_room_spec strategy
    const omoContracts = locks.contract.contracts.filter((c) => c.source_analogs.omo);
    expect(omoContracts.length).toBeGreaterThan(0);
    for (const c of omoContracts) {
      expect(c.license_strategy).toBe('clean_room_spec');
    }
  });

  it('verifies all 12 generated parity reports exist and are non-empty', () => {
    const docsResult = validateParityDocs(REPO_ROOT);
    expect(docsResult.valid).toBe(true);
    expect(docsResult.errors).toEqual([]);

    for (const docName of REQUIRED_PARITY_DOCS) {
      const docPath = path.join(REPO_ROOT, 'docs', 'parity', docName);
      const content = fs.readFileSync(docPath, 'utf8');
      expect(content.length).toBeGreaterThan(100);
      expect(content).toContain('# ');
    }
  });

  it('verifies THIRD-PARTY-NOTICES.md has required upstream notices and clean-room attestation', () => {
    const noticesPath = path.join(REPO_ROOT, 'THIRD-PARTY-NOTICES.md');
    const content = fs.readFileSync(noticesPath, 'utf8');

    expect(content).toContain('oh-my-claudecode (OMC)');
    expect(content).toContain('oh-my-codex (OMX)');
    expect(content).toContain('oh-my-openagent (OMO)');
    expect(content).toContain('MIT License');
    expect(content).toContain('clean_room_required');
    expect(content).toContain('Clean-Room Attestation');
  });

  it('runs high-level runParityAudit cleanly', () => {
    const audit = runParityAudit(REPO_ROOT);
    expect(audit.valid).toBe(true);
    expect(audit.errors).toEqual([]);
    expect(audit.lockResult.valid).toBe(true);
    expect(audit.docsResult.valid).toBe(true);
  });

  describe('Negative & Boundary Validation Tests', () => {
    it('detects unmapped upstream item', () => {
      const locks = loadParityLocks(REPO_ROOT);
      // Inject an unmapped item into omc
      const clonedLocks: ParityLocks = {
        ...locks,
        omc: {
          ...locks.omc,
          items: [
            ...locks.omc.items,
            {
              id: 'omc_unmapped_mystery_feature',
              source_project: 'Yeachan-Heo/oh-my-claudecode',
              commit: '41a4c0f77144c5beb5f5f000a89cff379c680606',
              path: 'skills/mystery/SKILL.md',
              hash_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
              license_class: 'mit',
              surface_family: 'skill',
              source_name: 'mystery',
              aliases: [],
              invocation_grammar: '/mystery',
              agents_models_tools_hooks: [],
              state_lifecycle: 'none',
              parallel_team_behavior: 'none',
              permission_requirements: [],
              artifacts_verification: 'none',
              cancel_resume_recovery: 'none',
              upstream_evidence: 'none'
            }
          ]
        }
      };

      const result = validateParityLocks(clonedLocks);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Upstream item unmapped in contract matrix: Yeachan-Heo/oh-my-claudecode -> omc_unmapped_mystery_feature'))).toBe(true);
    });

    it('detects invalid schema_version', () => {
      const locks = loadParityLocks(REPO_ROOT);
      const clonedLocks: ParityLocks = {
        ...locks,
        omc: {
          ...locks.omc,
          schema_version: 99 as any
        }
      };

      const result = validateParityLocks(clonedLocks);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('omc.lock.json: invalid schema_version 99'))).toBe(true);
    });

    it('detects unknown Cursor mechanism reference', () => {
      const locks = loadParityLocks(REPO_ROOT);
      const clonedContracts = locks.contract.contracts.map((c, i) =>
        i === 0
          ? { ...c, selected_cursor_mechanisms: ['cursor-alien-mechanism'] }
          : c
      );

      const clonedLocks: ParityLocks = {
        ...locks,
        contract: {
          ...locks.contract,
          contracts: clonedContracts
        }
      };

      const result = validateParityLocks(clonedLocks);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('references unknown Cursor mechanism: cursor-alien-mechanism'))).toBe(true);
    });

    it('detects clean-room violation when OMO contract has wrong license_strategy', () => {
      const locks = loadParityLocks(REPO_ROOT);
      const clonedContracts = locks.contract.contracts.map((c) =>
        c.source_analogs.omo
          ? { ...c, license_strategy: 'mit_attribution' as any }
          : c
      );

      const clonedLocks: ParityLocks = {
        ...locks,
        contract: {
          ...locks.contract,
          contracts: clonedContracts
        }
      };

      const result = validateParityLocks(clonedLocks);
      expect(result.valid).toBe(false);
      expect(result.cleanRoomPassed).toBe(false);
      expect(result.errors.some((e) => e.includes('license_strategy is not \'clean_room_spec\''))).toBe(true);
    });

    it('detects disposition count mismatch in contract lock', () => {
      const locks = loadParityLocks(REPO_ROOT);
      const clonedLocks: ParityLocks = {
        ...locks,
        contract: {
          ...locks.contract,
          disposition_counts: {
            ...locks.contract.disposition_counts,
            native: 9999
          }
        }
      };

      const result = validateParityLocks(clonedLocks);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('Disposition count mismatch for \'native\''))).toBe(true);
    });

    it('detects missing documentation file', () => {
      const docsResult = validateParityDocs('/tmp');
      expect(docsResult.valid).toBe(false);
      expect(docsResult.errors.length).toBeGreaterThan(0);
      expect(docsResult.errors.some((e) => e.includes('Missing required parity doc'))).toBe(true);
    });
  });
});
