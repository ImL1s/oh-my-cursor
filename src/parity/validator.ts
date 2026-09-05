import fs from 'node:fs';
import path from 'node:path';
import type {
  ParityLocks,
  ParityValidationResult,
  UpstreamLock,
  CursorSdkLock,
  CursorPluginsLock,
  CursorCookbookLock,
  CursorHostCapabilitiesLock,
  OmcuContractLock
} from './types.js';

export const REQUIRED_PARITY_DOCS = [
  'summary.md',
  'cursor-mechanisms.md',
  'skills-commands.md',
  'agents-routing.md',
  'hooks.md',
  'tools-mcp.md',
  'workflows.md',
  'background-team.md',
  'permissions.md',
  'artifacts.md',
  'config-install.md',
  'license-provenance.md'
] as const;

/**
 * Loads all 8 parity lock files from the target directory.
 */
export function loadParityLocks(baseDir: string = process.cwd()): ParityLocks {
  const parityDir = path.join(baseDir, 'parity');

  const omcPath = path.join(parityDir, 'upstreams', 'omc.lock.json');
  const omxPath = path.join(parityDir, 'upstreams', 'omx.lock.json');
  const omoPath = path.join(parityDir, 'upstreams', 'omo.lock.json');
  const sdkPath = path.join(parityDir, 'cursor', 'sdk.lock.json');
  const pluginsPath = path.join(parityDir, 'cursor', 'plugins.lock.json');
  const cookbookPath = path.join(parityDir, 'cursor', 'cookbook.lock.json');
  const hostPath = path.join(parityDir, 'cursor', 'host-capabilities.lock.json');
  const contractPath = path.join(parityDir, 'omcu-contract.lock.json');

  return {
    omc: JSON.parse(fs.readFileSync(omcPath, 'utf8')) as UpstreamLock,
    omx: JSON.parse(fs.readFileSync(omxPath, 'utf8')) as UpstreamLock,
    omo: JSON.parse(fs.readFileSync(omoPath, 'utf8')) as UpstreamLock,
    sdk: JSON.parse(fs.readFileSync(sdkPath, 'utf8')) as CursorSdkLock,
    plugins: JSON.parse(fs.readFileSync(pluginsPath, 'utf8')) as CursorPluginsLock,
    cookbook: JSON.parse(fs.readFileSync(cookbookPath, 'utf8')) as CursorCookbookLock,
    hostCapabilities: JSON.parse(fs.readFileSync(hostPath, 'utf8')) as CursorHostCapabilitiesLock,
    contract: JSON.parse(fs.readFileSync(contractPath, 'utf8')) as OmcuContractLock
  };
}

/**
 * Validates the integrity, schema compliance, 100% upstream coverage,
 * clean-room constraints, and mechanism mapping of all parity locks.
 */
export function validateParityLocks(locks: ParityLocks): ParityValidationResult {
  const errors: string[] = [];

  // 1. Schema version checks
  if (locks.omc.schema_version !== 1) errors.push(`omc.lock.json: invalid schema_version ${locks.omc.schema_version}, expected 1`);
  if (locks.omx.schema_version !== 1) errors.push(`omx.lock.json: invalid schema_version ${locks.omx.schema_version}, expected 1`);
  if (locks.omo.schema_version !== 1) errors.push(`omo.lock.json: invalid schema_version ${locks.omo.schema_version}, expected 1`);
  if (locks.sdk.schema_version !== 1) errors.push(`sdk.lock.json: invalid schema_version ${locks.sdk.schema_version}, expected 1`);
  if (locks.plugins.schema_version !== 1) errors.push(`plugins.lock.json: invalid schema_version ${locks.plugins.schema_version}, expected 1`);
  if (locks.cookbook.schema_version !== 1) errors.push(`cookbook.lock.json: invalid schema_version ${locks.cookbook.schema_version}, expected 1`);
  if (locks.hostCapabilities.schema_version !== 2) errors.push(`host-capabilities.lock.json: invalid schema_version ${locks.hostCapabilities.schema_version}, expected 2`);
  if (locks.contract.schema_version !== 1) errors.push(`omcu-contract.lock.json: invalid schema_version ${locks.contract.schema_version}, expected 1`);

  // 2. Upstream item integrity
  const totalUpstream = locks.omc.items.length + locks.omx.items.length + locks.omo.items.length;
  const allUpstreamItems = [...locks.omc.items, ...locks.omx.items, ...locks.omo.items];

  for (const item of allUpstreamItems) {
    if (!item.id) errors.push(`Missing id on upstream item: ${JSON.stringify(item)}`);
    if (!item.hash_sha256 || item.hash_sha256.length !== 64) {
      errors.push(`Invalid sha256 hash on upstream item ${item.id}`);
    }
    if (!item.license_class) errors.push(`Missing license_class on upstream item ${item.id}`);
    if (!item.surface_family) errors.push(`Missing surface_family on upstream item ${item.id}`);
  }

  // 3. 100% Upstream Source Coverage Check
  const mappedAnalogIds = new Set<string>();
  for (const contract of locks.contract.contracts) {
    for (const [key, analogId] of Object.entries(contract.source_analogs)) {
      if (analogId && typeof analogId === 'string') {
        mappedAnalogIds.add(analogId);
      }
    }
  }

  let mappedUpstreamCount = 0;
  for (const item of allUpstreamItems) {
    if (mappedAnalogIds.has(item.id)) {
      mappedUpstreamCount++;
    } else {
      errors.push(`Upstream item unmapped in contract matrix: ${item.source_project} -> ${item.id}`);
    }
  }

  // 4. Cursor Host Capabilities Mapping Check
  const validMechanismIds = new Set<string>(
    locks.hostCapabilities.mechanisms.map((m) => m.mechanism_id)
  );

  for (const contract of locks.contract.contracts) {
    if (!contract.selected_cursor_mechanisms || contract.selected_cursor_mechanisms.length === 0) {
      errors.push(`Contract ${contract.canonical_id} has no selected Cursor mechanisms`);
    } else {
      for (const mechId of contract.selected_cursor_mechanisms) {
        if (!validMechanismIds.has(mechId)) {
          errors.push(`Contract ${contract.canonical_id} references unknown Cursor mechanism: ${mechId}`);
        }
      }
    }
  }

  // 5. Clean-Room Boundary Check
  let cleanRoomPassed = true;
  for (const item of locks.omo.items) {
    if (item.license_class !== 'clean_room_required') {
      cleanRoomPassed = false;
      errors.push(`OMO item ${item.id} must have license_class 'clean_room_required', found '${item.license_class}'`);
    }
  }

  for (const contract of locks.contract.contracts) {
    if (contract.source_analogs.omo) {
      if (contract.license_strategy !== 'clean_room_spec') {
        cleanRoomPassed = false;
        errors.push(`Contract ${contract.canonical_id} maps OMO analog ${contract.source_analogs.omo} but license_strategy is not 'clean_room_spec'`);
      }
    }
  }

  // 6. Contract count & disposition consistency
  if (locks.contract.total_contracts !== locks.contract.contracts.length) {
    errors.push(`Contract count mismatch: total_contracts=${locks.contract.total_contracts}, actual=${locks.contract.contracts.length}`);
  }

  const calculatedDispositions: Record<string, number> = {};
  const calculatedStatuses: Record<string, number> = {};
  for (const contract of locks.contract.contracts) {
    calculatedDispositions[contract.disposition] = (calculatedDispositions[contract.disposition] ?? 0) + 1;
    calculatedStatuses[contract.status] = (calculatedStatuses[contract.status] ?? 0) + 1;
  }

  for (const [disp, count] of Object.entries(locks.contract.disposition_counts)) {
    if ((calculatedDispositions[disp] ?? 0) !== count) {
      errors.push(`Disposition count mismatch for '${disp}': lock has ${count}, calculated ${calculatedDispositions[disp] ?? 0}`);
    }
  }

  for (const [status, count] of Object.entries(locks.contract.status_counts)) {
    if ((calculatedStatuses[status] ?? 0) !== count) {
      errors.push(`Status count mismatch for '${status}': lock has ${count}, calculated ${calculatedStatuses[status] ?? 0}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    totalUpstreamItems: totalUpstream,
    mappedUpstreamItems: mappedUpstreamCount,
    totalContracts: locks.contract.contracts.length,
    cleanRoomPassed,
    mechanismsValidated: validMechanismIds.size
  };
}

/**
 * Validates that all 12 parity reports and THIRD-PARTY-NOTICES.md exist and are non-empty.
 */
export function validateParityDocs(baseDir: string = process.cwd()): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const docsDir = path.join(baseDir, 'docs', 'parity');

  for (const docName of REQUIRED_PARITY_DOCS) {
    const docPath = path.join(docsDir, docName);
    if (!fs.existsSync(docPath)) {
      errors.push(`Missing required parity doc: docs/parity/${docName}`);
    } else {
      const content = fs.readFileSync(docPath, 'utf8').trim();
      if (content.length === 0) {
        errors.push(`Empty parity doc: docs/parity/${docName}`);
      }
    }
  }

  const noticesPath = path.join(baseDir, 'THIRD-PARTY-NOTICES.md');
  if (!fs.existsSync(noticesPath)) {
    errors.push('Missing THIRD-PARTY-NOTICES.md');
  } else {
    const content = fs.readFileSync(noticesPath, 'utf8').trim();
    if (content.length === 0) {
      errors.push('Empty THIRD-PARTY-NOTICES.md');
    }
    if (!content.includes('oh-my-claudecode') || !content.includes('oh-my-codex') || !content.includes('oh-my-openagent')) {
      errors.push('THIRD-PARTY-NOTICES.md is missing required upstream mentions (omc, omx, omo)');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * High-level audit runner verifying both locks and documentation.
 */
export function runParityAudit(baseDir: string = process.cwd()): {
  valid: boolean;
  errors: string[];
  lockResult: ParityValidationResult;
  docsResult: { valid: boolean; errors: string[] };
} {
  const locks = loadParityLocks(baseDir);
  const lockResult = validateParityLocks(locks);
  const docsResult = validateParityDocs(baseDir);

  const errors = [...lockResult.errors, ...docsResult.errors];
  return {
    valid: errors.length === 0,
    errors,
    lockResult,
    docsResult
  };
}
