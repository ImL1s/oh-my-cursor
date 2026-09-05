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
  OmcuContractLock,
  ContractDisposition,
  ContractStatus
} from './types.js';

export const ALL_CONTRACT_DISPOSITIONS: readonly ContractDisposition[] = [
  'native',
  'composed',
  'thin-extension',
  'fallback',
  'unsupported'
];

export const ALL_CONTRACT_STATUSES: readonly ContractStatus[] = [
  'pass',
  'partial',
  'blocked',
  'unsupported',
  'not_run',
  'drifted',
  'license_review_required'
];

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

  // 1b. Cursor SDK integrity check
  if (!locks.sdk.integrity || !locks.sdk.integrity.startsWith('sha512-')) {
    errors.push(`sdk.lock.json: integrity digest must start with 'sha512-', found '${locks.sdk.integrity}'`);
  } else {
    const b64 = locks.sdk.integrity.slice('sha512-'.length);
    try {
      const buf = Buffer.from(b64, 'base64');
      if (buf.length !== 64 || buf.toString('base64') !== b64) {
        errors.push(`sdk.lock.json: integrity sha512 digest must decode to exactly 64 bytes, decoded to ${buf.length}`);
      }
    } catch {
      errors.push(`sdk.lock.json: invalid base64 in integrity digest: '${locks.sdk.integrity}'`);
    }
  }

  // 2. Upstream item integrity
  const totalUpstream = locks.omc.items.length + locks.omx.items.length + locks.omo.items.length;
  const allUpstreamItems = [...locks.omc.items, ...locks.omx.items, ...locks.omo.items];

  const seenUpstreamIds = new Set<string>();
  for (const item of allUpstreamItems) {
    if (!item.id) {
      errors.push(`Missing id on upstream item: ${JSON.stringify(item)}`);
    } else if (seenUpstreamIds.has(item.id)) {
      errors.push(`Duplicate upstream item id detected: '${item.id}' in ${item.source_project}`);
    } else {
      seenUpstreamIds.add(item.id);
    }
    if (!item.hash_sha256 || item.hash_sha256.length !== 64) {
      errors.push(`Invalid sha256 hash on upstream item ${item.id}`);
    }
    if (!item.license_class) errors.push(`Missing license_class on upstream item ${item.id}`);
    if (!item.surface_family) errors.push(`Missing surface_family on upstream item ${item.id}`);
  }

  // 3. 100% Upstream Source Coverage Check
  const mappedAnalogIds = new Set<string>();
  const seenContractIds = new Set<string>();
  for (const contract of locks.contract.contracts) {
    if (!contract.canonical_id) {
      errors.push(`Missing canonical_id on contract: ${JSON.stringify(contract)}`);
    } else if (seenContractIds.has(contract.canonical_id)) {
      errors.push(`Duplicate contract canonical_id detected: '${contract.canonical_id}'`);
    } else {
      seenContractIds.add(contract.canonical_id);
    }
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
  for (const m of locks.hostCapabilities.mechanisms) {
    if (!m.mechanism_id.startsWith('cursor-')) {
      errors.push(`host-capabilities.lock.json: '${m.mechanism_id}' is not an official Cursor mechanism (must start with 'cursor-')`);
    }
  }

  const validMechanismIds = new Set<string>(
    locks.hostCapabilities.mechanisms.map((m) => m.mechanism_id)
  );

  for (const contract of locks.contract.contracts) {
    if (!contract.selected_cursor_mechanisms || contract.selected_cursor_mechanisms.length === 0) {
      errors.push(`Contract ${contract.canonical_id} has no selected Cursor mechanisms`);
    } else {
      for (const mechId of contract.selected_cursor_mechanisms) {
        if (!mechId.startsWith('cursor-')) {
          errors.push(`Contract ${contract.canonical_id} references non-Cursor mechanism '${mechId}'. Only official Cursor host mechanisms ('cursor-*') are allowed.`);
        }
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

  // Validate all disposition categories in both directions
  const dispositionKeysInLock = Object.keys(locks.contract.disposition_counts ?? {});
  const allDispositionKeys = new Set<string>([
    ...ALL_CONTRACT_DISPOSITIONS,
    ...dispositionKeysInLock,
    ...Object.keys(calculatedDispositions)
  ]);

  for (const disp of allDispositionKeys) {
    if (!ALL_CONTRACT_DISPOSITIONS.includes(disp as ContractDisposition)) {
      errors.push(`Unknown contract disposition: '${disp}'`);
      continue;
    }
    const lockCount = (locks.contract.disposition_counts as Record<string, number | undefined>)?.[disp];
    const calculatedCount = calculatedDispositions[disp] ?? 0;
    if (lockCount === undefined) {
      errors.push(`Disposition count missing in lock for '${disp}': calculated ${calculatedCount}`);
    } else if (lockCount !== calculatedCount) {
      errors.push(`Disposition count mismatch for '${disp}': lock has ${lockCount}, calculated ${calculatedCount}`);
    }
  }

  // Validate all status categories in both directions
  const statusKeysInLock = Object.keys(locks.contract.status_counts ?? {});
  const allStatusKeys = new Set<string>([
    ...ALL_CONTRACT_STATUSES,
    ...statusKeysInLock,
    ...Object.keys(calculatedStatuses)
  ]);

  for (const status of allStatusKeys) {
    if (!ALL_CONTRACT_STATUSES.includes(status as ContractStatus)) {
      errors.push(`Unknown contract status: '${status}'`);
      continue;
    }
    const lockCount = (locks.contract.status_counts as Record<string, number | undefined>)?.[status];
    const calculatedCount = calculatedStatuses[status] ?? 0;
    if (lockCount === undefined) {
      errors.push(`Status count missing in lock for '${status}': calculated ${calculatedCount}`);
    } else if (lockCount !== calculatedCount) {
      errors.push(`Status count mismatch for '${status}': lock has ${lockCount}, calculated ${calculatedCount}`);
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
 * Validates that all 12 parity reports and THIRD-PARTY-NOTICES.md exist, are non-empty,
 * and match the latest baselines, counts, mechanisms, and contracts in the lock files.
 */
export function validateParityDocs(
  baseDir: string = process.cwd(),
  locks?: ParityLocks
): { valid: boolean; errors: string[] } {
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

  // If any required doc is missing or empty, fail early
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Content freshness and lock consistency check
  let parityLocks = locks;
  if (!parityLocks) {
    try {
      const contractLockPath = path.join(baseDir, 'parity', 'omcu-contract.lock.json');
      if (fs.existsSync(contractLockPath)) {
        parityLocks = loadParityLocks(baseDir);
      }
    } catch {
      // Ignore load error if directory does not have full locks (e.g. isolated test paths)
    }
  }

  if (parityLocks) {
    const summaryPath = path.join(docsDir, 'summary.md');
    if (fs.existsSync(summaryPath)) {
      const summaryText = fs.readFileSync(summaryPath, 'utf8');

      // Verify upstream commits
      if (!summaryText.includes(parityLocks.omc.commit)) {
        errors.push(`Stale docs/parity/summary.md: missing OMC baseline commit ${parityLocks.omc.commit}`);
      }
      if (!summaryText.includes(parityLocks.omx.commit)) {
        errors.push(`Stale docs/parity/summary.md: missing OMX baseline commit ${parityLocks.omx.commit}`);
      }
      if (!summaryText.includes(parityLocks.omo.commit)) {
        errors.push(`Stale docs/parity/summary.md: missing OMO baseline commit ${parityLocks.omo.commit}`);
      }

      // Verify Cursor target baselines
      if (!summaryText.includes(parityLocks.sdk.version)) {
        errors.push(`Stale docs/parity/summary.md: missing SDK version ${parityLocks.sdk.version}`);
      }
      if (!summaryText.includes(parityLocks.plugins.commit)) {
        errors.push(`Stale docs/parity/summary.md: missing plugins commit ${parityLocks.plugins.commit}`);
      }
      if (!summaryText.includes(parityLocks.cookbook.commit)) {
        errors.push(`Stale docs/parity/summary.md: missing cookbook commit ${parityLocks.cookbook.commit}`);
      }

      // Verify total contracts and counts
      if (!summaryText.includes(`Total Normalized Contracts: **${parityLocks.contract.total_contracts}**`)) {
        errors.push(`Stale docs/parity/summary.md: total contracts mismatch with lock (${parityLocks.contract.total_contracts})`);
      }
      if (!summaryText.includes(`- **Native** (\`native\`): ${parityLocks.contract.disposition_counts.native}`)) {
        errors.push(`Stale docs/parity/summary.md: native count mismatch with lock (${parityLocks.contract.disposition_counts.native})`);
      }
      if (!summaryText.includes(`- **Composed** (\`composed\`): ${parityLocks.contract.disposition_counts.composed}`)) {
        errors.push(`Stale docs/parity/summary.md: composed count mismatch with lock (${parityLocks.contract.disposition_counts.composed})`);
      }
      if (!summaryText.includes(`- **Thin Extension** (\`thin-extension\`): ${parityLocks.contract.disposition_counts['thin-extension']}`)) {
        errors.push(`Stale docs/parity/summary.md: thin-extension count mismatch with lock (${parityLocks.contract.disposition_counts['thin-extension']})`);
      }
      if (!summaryText.includes(`- **Passing** (\`pass\`): ${parityLocks.contract.status_counts.pass}`)) {
        errors.push(`Stale docs/parity/summary.md: pass count mismatch with lock (${parityLocks.contract.status_counts.pass})`);
      }
    }

    const licensePath = path.join(docsDir, 'license-provenance.md');
    if (fs.existsSync(licensePath)) {
      const licenseText = fs.readFileSync(licensePath, 'utf8');
      const totalUpstream = parityLocks.omc.items.length + parityLocks.omx.items.length + parityLocks.omo.items.length;
      if (!licenseText.includes(`Total Upstream Items: **${totalUpstream}**`)) {
        errors.push(`Stale docs/parity/license-provenance.md: total upstream items mismatch with lock (${totalUpstream})`);
      }
      if (!licenseText.includes(`OMC (MIT): ${parityLocks.omc.items.length} items`)) {
        errors.push(`Stale docs/parity/license-provenance.md: OMC item count mismatch with lock (${parityLocks.omc.items.length})`);
      }
      if (!licenseText.includes(`OMX (MIT): ${parityLocks.omx.items.length} items`)) {
        errors.push(`Stale docs/parity/license-provenance.md: OMX item count mismatch with lock (${parityLocks.omx.items.length})`);
      }
      if (!licenseText.includes(`OMO (Clean-Room): ${parityLocks.omo.items.length} items`)) {
        errors.push(`Stale docs/parity/license-provenance.md: OMO item count mismatch with lock (${parityLocks.omo.items.length})`);
      }
    }

    const mechanismsPath = path.join(docsDir, 'cursor-mechanisms.md');
    if (fs.existsSync(mechanismsPath)) {
      const mechText = fs.readFileSync(mechanismsPath, 'utf8');
      for (const mech of parityLocks.hostCapabilities.mechanisms) {
        if (!mechText.includes(mech.mechanism_id)) {
          errors.push(`Stale docs/parity/cursor-mechanisms.md: missing mechanism '${mech.mechanism_id}'`);
        }
      }
    }

    const familyDocMap: Record<string, string> = {
      workflow: 'workflows.md',
      agent: 'agents-routing.md',
      skill: 'skills-commands.md',
      hook: 'hooks.md',
      tool: 'tools-mcp.md',
      artifact: 'artifacts.md',
      config: 'config-install.md'
    };
    for (const contract of parityLocks.contract.contracts) {
      const docName = familyDocMap[contract.surface_family];
      if (docName) {
        const docPath = path.join(docsDir, docName);
        if (fs.existsSync(docPath)) {
          const content = fs.readFileSync(docPath, 'utf8');
          if (!content.includes(contract.name) && !content.includes(contract.canonical_id)) {
            errors.push(`Stale docs/parity/${docName}: missing contract '${contract.name}' (${contract.canonical_id})`);
          }
        }
      }
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
  const docsResult = validateParityDocs(baseDir, locks);

  const errors = [...lockResult.errors, ...docsResult.errors];
  return {
    valid: errors.length === 0,
    errors,
    lockResult,
    docsResult
  };
}
