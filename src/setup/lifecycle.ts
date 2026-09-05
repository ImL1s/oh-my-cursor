import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicCreateText, atomicWriteJson } from '../runtime/atomic.js';
import { ensureExternalStateRoot } from '../runtime/state-root.js';
import { openProjectStateRoot } from '../runtime/state-root.js';
import { validateExistingCliOwnerRecord } from '../state/authority.js';
import { copyPackableDirectory, digestDirectory, digestPackableDirectory, verifySha256Sums } from './digest.js';
import { createInstallReceipt, readInstallReceipt, writeInstallReceipt, type InstallReceipt, type InstallSourceInfo, type InstallSourceKind, type OwnedInstallPath } from './receipt.js';
import { runSetupDoctor, type DoctorReport } from './doctor.js';
import type { CommandRunner } from './types.js';
import { withInstallLock, withInstallLockSync, type InstallLockOptions } from './lock.js';
import { repairOwnedMcpServerSync } from '../mcp/lifecycle.js';
import { extractReleaseArchive } from './archive.js';
import { fetchGitHubRelease } from './github-release.js';

export interface InstallInput {
  readonly sourceRoot?: string;
  readonly action?: 'install' | 'update';
  readonly sourceArchive?: string;
  readonly checksumsFile?: string;
  readonly releaseTag?: string;
  readonly releaseLatest?: boolean;
  readonly homeDir?: string;
  readonly stateRoot?: string;
  readonly projectRoot?: string;
  readonly transactionId?: string;
  readonly now?: () => Date;
  readonly cursorCommand?: string;
  readonly runner?: CommandRunner;
  readonly runDoctor?: boolean;
  /** Project-local state initialization is opt-in for setup/update. */
  readonly initializeProjectState?: boolean;
  readonly lock?: InstallLockOptions;
  readonly dryRun?: boolean;
}

export interface InstallResult {
  readonly status?: 'installed' | 'updated' | 'already_current';
  readonly receiptPath: string;
  readonly receipt: InstallReceipt;
  readonly doctor: DoctorReport | null;
  readonly dry_run?: boolean;
}

export interface InstallVerificationReport {
  readonly ok: boolean;
  readonly code:
    | 'verified'
    | 'pointer_missing'
    | 'pointer_invalid'
    | 'pointer_mismatch'
    | 'receipt_missing'
    | 'receipt_invalid'
    | 'stage_missing'
    | 'stage_drifted'
    | 'shim_missing'
    | 'shim_not_symlink'
    | 'shim_target_mismatch'
    | 'entrypoint_missing';
  readonly pointer: { readonly receipt_path: string; readonly receipt_sha256: string } | null;
  readonly receipt: InstallReceipt | null;
  readonly stage: {
    readonly path: string;
    readonly exists: boolean;
    readonly digest_matches: boolean;
    readonly expected_sha256: string;
    readonly actual_sha256: string | null;
  } | null;
  readonly shim: {
    readonly path: string;
    readonly exists: boolean;
    readonly is_symlink: boolean;
    readonly target: string | null;
    readonly matches_stage: boolean;
  } | null;
  readonly errors: readonly string[];
}

export interface InstallStatusResult {
  readonly healthy: boolean;
  readonly cli: {
    readonly path: string;
    readonly exists: boolean;
    readonly is_symlink: boolean;
    readonly target: string | null;
    readonly points_to_current_stage: boolean;
    readonly version: string | null;
  };
  readonly current: {
    readonly receipt_path: string | null;
    readonly receipt_sha256: string | null;
    readonly version: string | null;
    readonly source_kind: InstallSourceKind | null;
    readonly source_realpath: string | null;
    readonly stage: string | null;
    readonly stage_exists: boolean;
    readonly stage_digest_matches: boolean;
  } | null;
  readonly rollback: {
    readonly available_count: number;
    readonly recent_targets: readonly { readonly id: string; readonly version: string; readonly created_at: string }[];
  };
  readonly active_transaction: boolean;
  readonly drift: {
    readonly stage_modified: boolean;
    readonly symlink_drifted: boolean;
    readonly pointer_mismatch: boolean;
  };
  readonly diagnostics: readonly string[];
}

export interface InstallListEntry {
  readonly id: string;
  readonly receipt_path: string;
  readonly version: string;
  readonly action: string;
  readonly source_kind: string;
  readonly created_at: string;
  readonly is_current: boolean;
  readonly is_valid_rollback_target: boolean;
  readonly stage_path: string;
  readonly stage_exists: boolean;
  readonly stage_digest_matches: boolean;
  readonly references: readonly string[];
}

export interface VerifyTargetReport {
  readonly target: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface VerifyInstallationsResult {
  readonly ok: boolean;
  readonly verified_count: number;
  readonly failed_count: number;
  readonly targets: readonly VerifyTargetReport[];
}

export interface RollbackInput {
  readonly receiptPathOrId?: string | undefined;
  readonly target?: string | undefined;
  readonly homeDir?: string | undefined;
  readonly stateRoot?: string | undefined;
  readonly projectRoot?: string | undefined;
  readonly runner?: CommandRunner | undefined;
  readonly runDoctor?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly lock?: InstallLockOptions | undefined;
  readonly now?: (() => Date) | undefined;
  readonly reason?: string | undefined;
}

export interface RollbackResult {
  readonly status: 'rolled_back' | 'already_current';
  readonly receiptPath: string;
  readonly receipt: InstallReceipt;
  readonly doctor: DoctorReport | null;
  readonly rolled_back_from: {
    readonly receipt_path: string;
    readonly receipt_sha256: string;
    readonly version: string;
  } | null;
  readonly dry_run?: boolean;
}

export interface PruneInput {
  readonly homeDir?: string;
  readonly stateRoot?: string;
  readonly projectRoot?: string;
  readonly keep?: number;
  readonly dryRun?: boolean;
  readonly lock?: InstallLockOptions;
}

export interface PrunedStageReport {
  readonly path: string;
  readonly version: string;
  readonly sha256: string;
  readonly action: 'keep' | 'prune';
  readonly reason: 'current_pointer' | 'cli_symlink' | 'retained_rollback' | 'mcp_reference' | 'active_transaction' | 'stage_modified' | 'unreferenced';
  readonly references: readonly string[];
}

export interface PruneResult {
  readonly dry_run: boolean;
  readonly keep: number;
  readonly stages_examined: number;
  readonly stages_preserved: readonly PrunedStageReport[];
  readonly stages_pruned: readonly PrunedStageReport[];
  readonly receipts_pruned: readonly string[];
  readonly message?: string;
}

export interface RepairInput {
  readonly homeDir?: string;
  readonly stateRoot?: string;
  readonly projectRoot?: string;
  readonly runner?: CommandRunner;
  readonly lock?: InstallLockOptions;
}

export interface RepairResult {
  readonly repaired: boolean;
  readonly actions: readonly string[];
  readonly doctor: DoctorReport | null;
}

export interface UninstallInput {
  readonly receiptPath: string;
  readonly homeDir?: string;
  readonly stateRoot?: string;
  readonly purgeProjectState?: boolean;
  readonly lock?: InstallLockOptions;
}

export interface UninstallResult {
  readonly status: 'uninstalled' | 'completed_with_collisions' | 'already_absent';
  readonly removed: readonly string[];
  readonly preserved: readonly string[];
}

interface InstallTransactionJournal {
  readonly store_kind: 'omcu_install_transaction';
  readonly schema_version: 1;
  readonly cli: string;
  readonly candidate_target: string;
  readonly prior_cli_target: string | null;
  readonly current_pointer: string;
  readonly prior_pointer_base64: string | null;
  readonly receipt_path: string;
  readonly receipt_sha256: string;
  readonly stage: string;
  readonly stage_existed: boolean;
  readonly temporary_stage: string;
  readonly project_state: string | null;
  readonly project_state_ownership_marker: string | null;
}

interface UninstallTransactionJournal {
  readonly store_kind: 'omcu_uninstall_transaction';
  readonly schema_version: 1;
  readonly receipt_path: string;
  readonly receipt_sha256: string;
  readonly purge_project_state: boolean;
}

function defaultStateRoot(home: string): string {
  return path.join(home, '.local', 'state', 'oh-my-cursor');
}

function releaseVersion(root: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version.trim() === '') throw new Error('E_PACKAGE_VERSION_INVALID');
  return pkg.version;
}

function sealTree(root: string): void {
  for (const name of fs.readdirSync(root)) {
    const child = path.join(root, name);
    const stat = fs.lstatSync(child);
    if (stat.isDirectory()) {
      sealTree(child);
      fs.chmodSync(child, 0o500);
    } else if (stat.isFile()) fs.chmodSync(child, 0o400);
  }
  fs.chmodSync(root, 0o500);
}

function makeWritableTree(root: string): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory()) {
    if (!stat.isSymbolicLink()) fs.chmodSync(root, 0o600);
    return;
  }
  fs.chmodSync(root, 0o700);
  for (const name of fs.readdirSync(root)) makeWritableTree(path.join(root, name));
}

function replaceSymlink(link: string, target: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
  const temporary = `${link}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.symlinkSync(target, temporary);
  fs.renameSync(temporary, link);
}

function pathEntryExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Lexical confinement only — never follows symlinks (no realpath). */
function lexicallyInside(candidate: string, root: string): boolean {
  const resolved = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function lexicallyStrictlyInside(candidate: string, root: string): boolean {
  const resolved = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function canonicalCliPath(home: string): string {
  return path.join(path.resolve(home), '.local', 'bin', 'omcu');
}

function assertPriorCliTargetAllowed(prior: string | null, stateRoot: string): void {
  if (prior === null) return;
  const releases = path.join(path.resolve(stateRoot), 'install', 'releases');
  if (!lexicallyStrictlyInside(prior, releases)) {
    throw new Error('E_INSTALL_TRANSACTION_PRIOR_CLI_INVALID');
  }
}

/**
 * Fail-closed confinement for receipt-owned removal. Aborts before any deletion when an
 * inventory entry escapes the product-owned locations (lexical, no symlink indirection).
 */
function assertOwnedInventoryConfined(receipt: InstallReceipt, expectedState: string, home: string): void {
  const stateRoot = path.resolve(expectedState);
  const canonicalCli = canonicalCliPath(home);
  const releasesRoot = path.join(stateRoot, 'install', 'releases');
  const receiptStage = path.resolve(receipt.installed.stage);
  for (const owned of receipt.owned_inventory) {
    if (owned.kind === 'release_stage') {
      if (!lexicallyStrictlyInside(owned.path, stateRoot)) {
        throw new Error('E_OWNED_INVENTORY_CONFINEMENT');
      }
    } else if (owned.kind === 'cli_symlink') {
      if (owned.path !== canonicalCli) throw new Error('E_OWNED_INVENTORY_CONFINEMENT');
      if (!pathEntryExists(owned.path)) continue;
      if (!fs.lstatSync(owned.path).isSymbolicLink()) {
        throw new Error('E_OWNED_INVENTORY_CONFINEMENT');
      }
      const target = path.resolve(path.dirname(owned.path), fs.readlinkSync(owned.path));
      if (!lexicallyInside(target, receiptStage) && !lexicallyStrictlyInside(target, releasesRoot)) {
        throw new Error('E_OWNED_INVENTORY_CONFINEMENT');
      }
    }
  }
}

function currentTarget(link: string): string | null {
  if (!pathEntryExists(link)) return null;
  const stat = fs.lstatSync(link);
  if (!stat.isSymbolicLink()) throw new Error('E_CLI_PATH_COLLISION');
  return fs.readlinkSync(link);
}

function transactionJournal(stateRoot: string): string {
  return path.join(stateRoot, 'install', 'transaction.json');
}

function removeWritable(target: string): void {
  if (!pathEntryExists(target)) return;
  makeWritableTree(target);
  fs.rmSync(target, { recursive: true, force: true });
}

function createTransactionOwnedProjectState(projectState: string, marker: string, proof: string): void {
  try {
    fs.mkdirSync(projectState, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('E_PROJECT_STATE_RACE', { cause: error });
    throw error;
  }
  atomicCreateText(marker, `${proof}\n`, { maxBytes: 128, mode: 0o600 });
}

function ownsProjectState(journal: InstallTransactionJournal): boolean {
  if (journal.project_state === null || journal.project_state_ownership_marker === null) return false;
  if (path.dirname(journal.project_state_ownership_marker) !== journal.project_state) return false;
  try {
    const receipt = readInstallReceipt(journal.receipt_path);
    const projectStateInventory = receipt.owned_inventory.filter((owned) => owned.kind === 'project_state');
    const expectedMarker = path.join(
      journal.project_state,
      `.install-owner-${crypto.createHash('sha256').update(receipt.transaction_id).digest('hex')}`,
    );
    if (receipt.receipt_sha256 !== journal.receipt_sha256
      || receipt.installed.stage !== journal.stage
      || receipt.installed.cli !== journal.cli
      || journal.candidate_target !== path.join(receipt.installed.stage, 'dist', 'bin', 'omcu.js')
      || path.basename(journal.receipt_path) !== `${receipt.transaction_id}.json`
      || projectStateInventory.length !== 1
      || projectStateInventory[0]?.path !== journal.project_state
      || projectStateInventory[0]?.identity !== path.resolve(path.dirname(journal.project_state))
      || journal.project_state_ownership_marker !== expectedMarker) return false;
    const directory = fs.lstatSync(journal.project_state);
    const marker = fs.lstatSync(journal.project_state_ownership_marker);
    return directory.isDirectory() && !directory.isSymbolicLink()
      && marker.isFile() && !marker.isSymbolicLink()
      && fs.readFileSync(journal.project_state_ownership_marker, 'utf8') === `${journal.receipt_sha256}\n`;
  } catch {
    return false;
  }
}

function removeTransactionOwnedProjectState(journal: InstallTransactionJournal): void {
  if (!ownsProjectState(journal) || journal.project_state === null || journal.project_state_ownership_marker === null) return;
  const entries = fs.readdirSync(journal.project_state);
  fs.unlinkSync(journal.project_state_ownership_marker);
  if (entries.length === 1 && entries[0] === path.basename(journal.project_state_ownership_marker)) {
    fs.rmdirSync(journal.project_state);
  }
}

function clearProjectStateOwnershipMarker(journal: InstallTransactionJournal): void {
  if (!ownsProjectState(journal) || journal.project_state_ownership_marker === null) return;
  fs.unlinkSync(journal.project_state_ownership_marker);
}

function readJournal(file: string): InstallTransactionJournal {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<InstallTransactionJournal>;
  if (parsed.store_kind !== 'omcu_install_transaction' || parsed.schema_version !== 1
    || typeof parsed.cli !== 'string' || typeof parsed.candidate_target !== 'string'
    || !(typeof parsed.prior_cli_target === 'string' || parsed.prior_cli_target === null)
    || typeof parsed.current_pointer !== 'string'
    || !(typeof parsed.prior_pointer_base64 === 'string' || parsed.prior_pointer_base64 === null)
    || typeof parsed.receipt_path !== 'string' || typeof parsed.receipt_sha256 !== 'string'
    || typeof parsed.stage !== 'string' || typeof parsed.stage_existed !== 'boolean'
    || typeof parsed.temporary_stage !== 'string'
    || !(typeof parsed.project_state === 'string' || parsed.project_state === null)
    || !(typeof parsed.project_state_ownership_marker === 'string'
      || parsed.project_state_ownership_marker === null
      || parsed.project_state_ownership_marker === undefined)) {
    throw new Error('E_INSTALL_TRANSACTION_INVALID');
  }
  return { ...parsed, project_state_ownership_marker: parsed.project_state_ownership_marker ?? null } as InstallTransactionJournal;
}

function reconcileInstallTransaction(stateRoot: string, home: string, allowProjectStateCleanup = true): void {
  const journalPath = transactionJournal(stateRoot);
  if (!fs.existsSync(journalPath)) return;
  const material = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { store_kind?: unknown };
  if (material.store_kind === 'omcu_uninstall_transaction') {
    const journal = material as Partial<UninstallTransactionJournal>;
    if (journal.schema_version !== 1 || typeof journal.receipt_path !== 'string'
      || typeof journal.receipt_sha256 !== 'string' || typeof journal.purge_project_state !== 'boolean'
      || !journal.receipt_path.startsWith(`${path.join(stateRoot, 'install', 'receipts')}${path.sep}`)) {
      throw new Error('E_UNINSTALL_TRANSACTION_INVALID');
    }
    const receipt = readInstallReceipt(journal.receipt_path);
    if (receipt.receipt_sha256 !== journal.receipt_sha256) throw new Error('E_UNINSTALL_TRANSACTION_MISMATCH');
    removeReceiptOwned(receipt, stateRoot, home, journal.purge_project_state);
    fs.rmSync(journalPath, { force: true });
    return;
  }
  const journal = readJournal(journalPath);
  const expectedInstallRoot = path.join(stateRoot, 'install');
  const expectedCli = path.join(home, '.local', 'bin', 'omcu');
  if (journal.cli !== expectedCli
    || !journal.stage.startsWith(`${path.join(expectedInstallRoot, 'releases')}${path.sep}`)
    || !journal.temporary_stage.startsWith(`${path.join(expectedInstallRoot, 'releases')}${path.sep}`)
    || !journal.receipt_path.startsWith(`${path.join(expectedInstallRoot, 'receipts')}${path.sep}`)
    || journal.current_pointer !== path.join(expectedInstallRoot, 'current.json')) {
    throw new Error('E_INSTALL_TRANSACTION_PATH_INVALID');
  }
  assertPriorCliTargetAllowed(journal.prior_cli_target, stateRoot);

  let pointerCommitted = false;
  try {
    const pointer = JSON.parse(fs.readFileSync(journal.current_pointer, 'utf8')) as {
      receipt_path?: unknown;
      receipt_sha256?: unknown;
    };
    pointerCommitted = pointer.receipt_path === journal.receipt_path
      && pointer.receipt_sha256 === journal.receipt_sha256
      && currentTarget(journal.cli) === journal.candidate_target;
  } catch {
    pointerCommitted = false;
  }

  removeWritable(journal.temporary_stage);
  if (!pointerCommitted) {
    if (journal.prior_cli_target === null) fs.rmSync(journal.cli, { force: true });
    else replaceSymlink(journal.cli, journal.prior_cli_target);
    if (journal.prior_pointer_base64 === null) fs.rmSync(journal.current_pointer, { force: true });
    else {
      const previousPointer = JSON.parse(Buffer.from(journal.prior_pointer_base64, 'base64').toString('utf8')) as unknown;
      atomicWriteJson(journal.current_pointer, previousPointer);
    }
    if (allowProjectStateCleanup) removeTransactionOwnedProjectState(journal);
    removeWritable(journal.receipt_path);
    if (!journal.stage_existed) removeWritable(journal.stage);
  } else {
    clearProjectStateOwnershipMarker(journal);
  }
  fs.rmSync(journalPath, { force: true });
}

export async function installOrUpdate(input: InstallInput): Promise<InstallResult> {
  const home = path.resolve(input.homeDir ?? os.homedir());
  const state = ensureExternalStateRoot(path.resolve(input.stateRoot ?? defaultStateRoot(home)));
  const coordinator = ensureExternalStateRoot(defaultStateRoot(home));
  if (coordinator.path === state.path) {
    return withInstallLock(state.path, () => installOrUpdateUnlocked(input), input.lock ?? {});
  }
  return withInstallLock(coordinator.path, () => (
    withInstallLock(state.path, () => installOrUpdateUnlocked(input), input.lock ?? {})
  ), input.lock ?? {});
}

async function installOrUpdateUnlocked(input: InstallInput): Promise<InstallResult> {
  const home = path.resolve(input.homeDir ?? os.homedir());
  const state = ensureExternalStateRoot(path.resolve(input.stateRoot ?? defaultStateRoot(home)));
  const project = path.resolve(input.projectRoot ?? process.cwd());
  const initializeProjectState = input.initializeProjectState ?? false;
  reconcileInstallTransaction(state.path, home, initializeProjectState);
  const transactionId = input.transactionId ?? `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const resolvedProjectState = path.join(project, '.omcu');
  const projectStatePreexisting = initializeProjectState && pathEntryExists(resolvedProjectState);
  if (projectStatePreexisting) validateExistingCliOwnerRecord(openProjectStateRoot(project));

  let sourceRoot: string;
  let sourceKind: InstallSourceKind = 'source';
  let sourceDigest: string;
  let cleanupArchive = (): void => {};
  let releaseTag: string | undefined = input.releaseTag;
  let releaseVersionStr: string | undefined;
  let archiveSha256: string | undefined;

  if (input.releaseTag !== undefined || input.releaseLatest === true) {
    sourceKind = 'github_release';
    const fetched = await fetchGitHubRelease({
      tag: input.releaseTag,
      latest: input.releaseLatest,
    });
    sourceRoot = fetched.extractedRoot;
    cleanupArchive = fetched.cleanup;
    sourceDigest = fetched.archiveSha256;
    archiveSha256 = fetched.archiveSha256;
    releaseTag = fetched.tag;
    releaseVersionStr = fetched.version;
  } else if (input.sourceArchive !== undefined) {
    if (input.checksumsFile === undefined) throw new Error('E_SHA256SUMS_REQUIRED');
    sourceKind = 'verified_archive';
    const extracted = extractReleaseArchive(path.resolve(input.sourceArchive), path.resolve(input.checksumsFile));
    sourceRoot = extracted.root;
    cleanupArchive = extracted.cleanup;
    sourceDigest = verifySha256Sums(path.resolve(input.sourceArchive), path.resolve(input.checksumsFile));
    archiveSha256 = sourceDigest;
  } else if (input.sourceRoot !== undefined) {
    sourceRoot = path.resolve(input.sourceRoot);
    sourceKind = 'source';
    sourceDigest = digestPackableDirectory(sourceRoot);
  } else {
    throw new Error('E_UPDATE_SOURCE_REQUIRED: specify --source, --archive, --tag, or --latest');
  }

  try {
    const installedDigest = digestPackableDirectory(sourceRoot);
    const version = releaseVersionStr ?? releaseVersion(sourceRoot);
    const stage = path.join(state.path, 'install', 'releases', `${version}-${installedDigest.slice(0, 16)}`);
    const temporaryStage = `${stage}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const cli = path.join(home, '.local', 'bin', 'omcu');
    const priorTarget = currentTarget(cli);
    const priorPointer = path.join(state.path, 'install', 'current.json');

    // Check already_current before modifying anything
    if (fs.existsSync(priorPointer)) {
      try {
        const cur = readCurrentInstallUnlocked(state.path);
        if (cur.version === version && cur.installed.sha256 === installedDigest) {
          const pointerData = JSON.parse(fs.readFileSync(priorPointer, 'utf8')) as { receipt_path: string };
          return {
            status: 'already_current',
            receiptPath: pointerData.receipt_path,
            receipt: cur,
            doctor: null,
            dry_run: input.dryRun ?? false,
          };
        }
      } catch {
        // Current install drifted, damaged, or unparseable; proceed with normal installation/update
      }
    }

    if (input.dryRun === true) {
      const stageExisted = fs.existsSync(stage);
      const receiptPath = path.join(state.path, 'install', 'receipts', `${transactionId}.json`);
      const simReceipt = createInstallReceipt({
        store_kind: 'omcu_install_receipt',
        schema_version: 1,
        transaction_id: transactionId,
        action: input.action ?? (priorTarget === null ? 'install' : 'update'),
        version,
        source: {
          kind: sourceKind,
          realpath: path.resolve(input.sourceArchive ?? sourceRoot),
          sha256: sourceDigest,
          ...(releaseTag ? { tag: releaseTag } : {}),
          ...(archiveSha256 ? { archive_sha256: archiveSha256 } : {}),
          version,
        },
        installed: { stage, sha256: installedDigest, cli },
        previous_cli_target: priorTarget,
        owned_inventory: [
          { path: stage, kind: 'release_stage', identity: installedDigest },
          { path: cli, kind: 'cli_symlink', identity: path.join(stage, 'dist', 'bin', 'omcu.js') },
        ],
        created_at: (input.now ?? (() => new Date()))().toISOString(),
      });
      return {
        status: (input.action === 'install' || priorTarget === null) ? 'installed' : 'updated',
        receiptPath,
        receipt: simReceipt,
        doctor: null,
        dry_run: true,
      };
    }

    const priorPointerBytes = fs.existsSync(priorPointer) ? fs.readFileSync(priorPointer) : null;
    const projectState = initializeProjectState ? resolvedProjectState : null;
    const projectStateOwnershipMarker = projectState === null || projectStatePreexisting
      ? null
      : path.join(projectState, `.install-owner-${crypto.createHash('sha256').update(transactionId).digest('hex')}`);
    const stageExisted = fs.existsSync(stage);
    const entrypoint = path.join(stage, 'dist', 'bin', 'omcu.js');
    const receipt = createInstallReceipt({
      store_kind: 'omcu_install_receipt',
      schema_version: 1,
      transaction_id: transactionId,
      action: input.action ?? (priorTarget === null ? 'install' : 'update'),
      version,
      source: {
        kind: sourceKind,
        realpath: path.resolve(input.sourceArchive ?? sourceRoot),
        sha256: sourceDigest,
        ...(releaseTag ? { tag: releaseTag } : {}),
        ...(archiveSha256 ? { archive_sha256: archiveSha256 } : {}),
        version,
      },
      installed: { stage, sha256: installedDigest, cli },
      previous_cli_target: priorTarget,
      owned_inventory: [
        { path: stage, kind: 'release_stage', identity: installedDigest },
        { path: cli, kind: 'cli_symlink', identity: entrypoint },
        ...(projectState === null || projectStatePreexisting ? [] : [{ path: projectState, kind: 'project_state' as const, identity: path.resolve(project) }]),
      ],
      created_at: (input.now ?? (() => new Date()))().toISOString(),
    });
    const receiptPath = path.join(state.path, 'install', 'receipts', `${transactionId}.json`);
    const journalPath = transactionJournal(state.path);
    atomicWriteJson(journalPath, {
      store_kind: 'omcu_install_transaction',
      schema_version: 1,
      cli,
      candidate_target: entrypoint,
      prior_cli_target: priorTarget,
      current_pointer: priorPointer,
      prior_pointer_base64: priorPointerBytes?.toString('base64') ?? null,
      receipt_path: receiptPath,
      receipt_sha256: receipt.receipt_sha256,
      stage,
      stage_existed: stageExisted,
      temporary_stage: temporaryStage,
      project_state: projectState,
      project_state_ownership_marker: projectStateOwnershipMarker,
    } satisfies InstallTransactionJournal);

    try {
      if (!stageExisted) {
        fs.mkdirSync(path.dirname(stage), { recursive: true, mode: 0o700 });
        copyPackableDirectory(sourceRoot, temporaryStage);
        if (digestDirectory(temporaryStage) !== installedDigest) throw new Error('E_RELEASE_STAGE_COPY_MISMATCH');
        sealTree(temporaryStage);
        fs.renameSync(temporaryStage, stage);
      } else if (digestDirectory(stage) !== installedDigest) throw new Error('E_RELEASE_STAGE_COLLISION');

      if (!fs.existsSync(entrypoint)) throw new Error('E_CLI_ENTRYPOINT_MISSING');
      fs.chmodSync(entrypoint, 0o500);
      writeInstallReceipt(receiptPath, receipt);
      replaceSymlink(cli, entrypoint);

      if (projectState !== null && projectStateOwnershipMarker !== null) {
        createTransactionOwnedProjectState(projectState, projectStateOwnershipMarker, receipt.receipt_sha256);
      }

      const doctor = input.runDoctor === false ? null : await runSetupDoctor({
        packageRoot: stage, projectRoot: project, homeDir: home,
        ...(input.cursorCommand === undefined ? {} : { cursorCommand: input.cursorCommand }),
        ...(input.runner === undefined ? {} : { runner: input.runner }),
        inspectProjectState: initializeProjectState,
      });
      if (doctor !== null && !doctor.ok) throw new Error('E_POST_INSTALL_DOCTOR_FAILED');

      atomicWriteJson(priorPointer, { schema_version: 1, receipt_path: receiptPath, receipt_sha256: receipt.receipt_sha256 });
      clearProjectStateOwnershipMarker({
        store_kind: 'omcu_install_transaction', schema_version: 1, cli, candidate_target: entrypoint,
        prior_cli_target: priorTarget, current_pointer: priorPointer,
        prior_pointer_base64: priorPointerBytes?.toString('base64') ?? null,
        receipt_path: receiptPath, receipt_sha256: receipt.receipt_sha256, stage,
        stage_existed: stageExisted, temporary_stage: temporaryStage,
        project_state: projectState, project_state_ownership_marker: projectStateOwnershipMarker,
      });
      fs.rmSync(journalPath, { force: true });
      try {
        repairOwnedMcpServerSync({ projectRoot: project, homeDir: home, packageRoot: stage });
      } catch {
        // Advisory repair
      }
      return {
        status: (input.action === 'install' || priorTarget === null) ? 'installed' : 'updated',
        receiptPath,
        receipt,
        doctor,
      };
    } catch (error) {
      reconcileInstallTransaction(state.path, home, initializeProjectState);
      throw error;
    }
  } finally {
    cleanupArchive();
  }
}

export function readCurrentInstall(stateRoot: string): InstallReceipt {
  return withInstallLockSync(stateRoot, () => readCurrentInstallUnlocked(stateRoot));
}

function readCurrentInstallUnlocked(stateRoot: string): InstallReceipt {
  const resolvedState = path.resolve(stateRoot);
  const pointer = JSON.parse(fs.readFileSync(path.join(resolvedState, 'install', 'current.json'), 'utf8')) as { receipt_path?: unknown; receipt_sha256?: unknown };
  if (typeof pointer.receipt_path !== 'string' || typeof pointer.receipt_sha256 !== 'string') throw new Error('E_INSTALL_POINTER_INVALID');
  const receipt = readInstallReceipt(pointer.receipt_path);
  if (receipt.receipt_sha256 !== pointer.receipt_sha256) throw new Error('E_INSTALL_POINTER_MISMATCH');
  if (digestDirectory(receipt.installed.stage) !== receipt.installed.sha256) throw new Error('E_INSTALLED_BYTES_DRIFTED');
  if (!pathEntryExists(receipt.installed.cli)
    || !fs.lstatSync(receipt.installed.cli).isSymbolicLink()
    || fs.readlinkSync(receipt.installed.cli) !== path.join(receipt.installed.stage, 'dist', 'bin', 'omcu.js')) {
    throw new Error('E_CLI_READBACK_MISMATCH');
  }
  return receipt;
}

export function uninstall(input: UninstallInput): UninstallResult {
  const home = path.resolve(input.homeDir ?? os.homedir());
  const expectedState = path.resolve(input.stateRoot ?? defaultStateRoot(home));
  ensureExternalStateRoot(expectedState);
  const coordinator = ensureExternalStateRoot(defaultStateRoot(home));
  if (coordinator.path === expectedState) {
    return withInstallLockSync(expectedState, () => uninstallUnlocked(input), input.lock ?? {});
  }
  return withInstallLockSync(coordinator.path, () => (
    withInstallLockSync(expectedState, () => uninstallUnlocked(input), input.lock ?? {})
  ), input.lock ?? {});
}

function uninstallUnlocked(input: UninstallInput): UninstallResult {
  const home = path.resolve(input.homeDir ?? os.homedir());
  const expectedState = path.resolve(input.stateRoot ?? defaultStateRoot(home));
  reconcileInstallTransaction(expectedState, home);
  const receipt = readInstallReceipt(path.resolve(input.receiptPath));
  if (!receipt.installed.stage.startsWith(`${expectedState}${path.sep}`)) throw new Error('E_RECEIPT_STATE_ROOT_MISMATCH');
  const removed: string[] = [];
  const preserved: string[] = [];
  const current = path.join(expectedState, 'install', 'current.json');
  const collisions: string[] = [];

  for (const owned of receipt.owned_inventory) {
    if (!pathEntryExists(owned.path)) continue;
    if (owned.kind === 'cli_symlink') {
      if (!fs.lstatSync(owned.path).isSymbolicLink() || fs.readlinkSync(owned.path) !== owned.identity) collisions.push(owned.path);
    } else if (owned.kind === 'release_stage') {
      try {
        if (digestDirectory(owned.path) !== owned.identity) collisions.push(owned.path);
      } catch {
        collisions.push(owned.path);
      }
    } else if (input.purgeProjectState === true) {
      const stat = fs.lstatSync(owned.path);
      if (!stat.isDirectory() || stat.isSymbolicLink()
        || path.resolve(path.dirname(owned.path)) !== owned.identity) collisions.push(owned.path);
    }
  }
  if (fs.existsSync(current)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(current, 'utf8')) as { receipt_sha256?: unknown };
      if (parsed.receipt_sha256 !== receipt.receipt_sha256) collisions.push(current);
    } catch {
      collisions.push(current);
    }
  }
  if (collisions.length > 0) {
    return {
      status: 'completed_with_collisions',
      removed: [],
      preserved: [...new Set([
        ...receipt.owned_inventory.filter((owned) => pathEntryExists(owned.path)).map((owned) => owned.path),
        ...(fs.existsSync(current) ? [current] : []),
      ])],
    };
  }

  assertOwnedInventoryConfined(receipt, expectedState, home);

  atomicWriteJson(transactionJournal(expectedState), {
    store_kind: 'omcu_uninstall_transaction',
    schema_version: 1,
    receipt_path: path.resolve(input.receiptPath),
    receipt_sha256: receipt.receipt_sha256,
    purge_project_state: input.purgeProjectState === true,
  } satisfies UninstallTransactionJournal);
  const result = removeReceiptOwned(receipt, expectedState, home, input.purgeProjectState === true);
  fs.rmSync(transactionJournal(expectedState), { force: true });
  return result;
}

function removeReceiptOwned(
  receipt: InstallReceipt,
  expectedState: string,
  home: string,
  purgeProjectState: boolean,
): UninstallResult {
  assertOwnedInventoryConfined(receipt, expectedState, home);
  const removed: string[] = [];
  const preserved: string[] = [];
  const current = path.join(expectedState, 'install', 'current.json');
  for (const owned of receipt.owned_inventory) {
    if (!pathEntryExists(owned.path)) continue;
    if (owned.kind === 'cli_symlink') {
      if (fs.lstatSync(owned.path).isSymbolicLink() && fs.readlinkSync(owned.path) === owned.identity) {
        fs.unlinkSync(owned.path); removed.push(owned.path);
      } else preserved.push(owned.path);
    } else if (owned.kind === 'release_stage') {
      let matches = false;
      try {
        matches = digestDirectory(owned.path) === owned.identity;
      } catch {
        matches = false;
      }
      if (matches) {
        makeWritableTree(owned.path);
        fs.rmSync(owned.path, { recursive: true }); removed.push(owned.path);
      } else preserved.push(owned.path);
    } else if (purgeProjectState && fs.lstatSync(owned.path).isDirectory()
      && !fs.lstatSync(owned.path).isSymbolicLink()
      && path.resolve(path.dirname(owned.path)) === owned.identity
      && fs.readdirSync(owned.path).length === 0) {
      fs.rmdirSync(owned.path); removed.push(owned.path);
    } else preserved.push(owned.path);
  }
  if (fs.existsSync(current)) {
    const parsed = JSON.parse(fs.readFileSync(current, 'utf8')) as { receipt_sha256?: unknown };
    if (parsed.receipt_sha256 === receipt.receipt_sha256) {
      fs.unlinkSync(current);
      removed.push(current);
    } else preserved.push(current);
  }
  return { status: removed.length > 0 ? 'uninstalled' : 'already_absent', removed, preserved };
}

export function verifyCurrentInstall(stateRoot: string, homeDir?: string): InstallVerificationReport {
  const resolvedState = path.resolve(stateRoot);
  const home = path.resolve(homeDir ?? os.homedir());
  const pointerFile = path.join(resolvedState, 'install', 'current.json');
  let cliPath = canonicalCliPath(home);

  if (!fs.existsSync(pointerFile)) {
    return {
      ok: false,
      code: 'pointer_missing',
      pointer: null,
      receipt: null,
      stage: null,
      shim: inspectShim(cliPath, null),
      errors: ['current.json does not exist'],
    };
  }

  let pointer: { receipt_path?: unknown; receipt_sha256?: unknown };
  try {
    pointer = JSON.parse(fs.readFileSync(pointerFile, 'utf8')) as { receipt_path?: unknown; receipt_sha256?: unknown };
  } catch (error) {
    return {
      ok: false,
      code: 'pointer_invalid',
      pointer: null,
      receipt: null,
      stage: null,
      shim: inspectShim(cliPath, null),
      errors: [`current.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  if (typeof pointer.receipt_path !== 'string' || typeof pointer.receipt_sha256 !== 'string') {
    return {
      ok: false,
      code: 'pointer_invalid',
      pointer: null,
      receipt: null,
      stage: null,
      shim: inspectShim(cliPath, null),
      errors: ['current.json missing receipt_path or receipt_sha256'],
    };
  }

  const pointerData = { receipt_path: pointer.receipt_path, receipt_sha256: pointer.receipt_sha256 };

  if (!fs.existsSync(pointer.receipt_path)) {
    return {
      ok: false,
      code: 'receipt_missing',
      pointer: pointerData,
      receipt: null,
      stage: null,
      shim: inspectShim(cliPath, null),
      errors: [`receipt file does not exist: ${pointer.receipt_path}`],
    };
  }

  let receipt: InstallReceipt;
  try {
    receipt = readInstallReceipt(pointer.receipt_path);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: 'receipt_invalid',
      pointer: pointerData,
      receipt: null,
      stage: null,
      shim: inspectShim(cliPath, null),
      errors: [msg],
    };
  }

  if (homeDir === undefined && receipt.installed?.cli) {
    cliPath = receipt.installed.cli;
  }

  if (receipt.receipt_sha256 !== pointer.receipt_sha256) {
    return {
      ok: false,
      code: 'pointer_mismatch',
      pointer: pointerData,
      receipt,
      stage: null,
      shim: inspectShim(cliPath, receipt.installed.stage),
      errors: ['pointer receipt_sha256 does not match receipt contents'],
    };
  }

  const stagePath = path.resolve(receipt.installed.stage);
  if (!fs.existsSync(stagePath)) {
    return {
      ok: false,
      code: 'stage_missing',
      pointer: pointerData,
      receipt,
      stage: {
        path: stagePath,
        exists: false,
        digest_matches: false,
        expected_sha256: receipt.installed.sha256,
        actual_sha256: null,
      },
      shim: inspectShim(cliPath, stagePath),
      errors: [`stage directory does not exist: ${stagePath}`],
    };
  }

  let actualStageDigest: string | null = null;
  try {
    actualStageDigest = digestDirectory(stagePath);
  } catch (error) {
    return {
      ok: false,
      code: 'stage_drifted',
      pointer: pointerData,
      receipt,
      stage: {
        path: stagePath,
        exists: true,
        digest_matches: false,
        expected_sha256: receipt.installed.sha256,
        actual_sha256: null,
      },
      shim: inspectShim(cliPath, stagePath),
      errors: [`failed to digest stage directory: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  if (actualStageDigest !== receipt.installed.sha256) {
    return {
      ok: false,
      code: 'stage_drifted',
      pointer: pointerData,
      receipt,
      stage: {
        path: stagePath,
        exists: true,
        digest_matches: false,
        expected_sha256: receipt.installed.sha256,
        actual_sha256: actualStageDigest,
      },
      shim: inspectShim(cliPath, stagePath),
      errors: [`stage directory sha256 mismatch: expected ${receipt.installed.sha256}, got ${actualStageDigest}`],
    };
  }

  const stageData = {
    path: stagePath,
    exists: true,
    digest_matches: true,
    expected_sha256: receipt.installed.sha256,
    actual_sha256: actualStageDigest,
  };

  const expectedEntrypoint = path.join(stagePath, 'dist', 'bin', 'omcu.js');
  if (!fs.existsSync(expectedEntrypoint)) {
    return {
      ok: false,
      code: 'entrypoint_missing',
      pointer: pointerData,
      receipt,
      stage: stageData,
      shim: inspectShim(cliPath, stagePath),
      errors: [`entrypoint missing: ${expectedEntrypoint}`],
    };
  }

  const shimReport = inspectShim(cliPath, stagePath);
  if (!shimReport.exists) {
    return {
      ok: false,
      code: 'shim_missing',
      pointer: pointerData,
      receipt,
      stage: stageData,
      shim: shimReport,
      errors: [`stable shim missing: ${cliPath}`],
    };
  }
  if (!shimReport.is_symlink) {
    return {
      ok: false,
      code: 'shim_not_symlink',
      pointer: pointerData,
      receipt,
      stage: stageData,
      shim: shimReport,
      errors: [`stable shim is not a symlink: ${cliPath}`],
    };
  }
  if (!shimReport.matches_stage) {
    return {
      ok: false,
      code: 'shim_target_mismatch',
      pointer: pointerData,
      receipt,
      stage: stageData,
      shim: shimReport,
      errors: [`stable shim target does not match stage entrypoint: ${shimReport.target} !== ${expectedEntrypoint}`],
    };
  }

  return {
    ok: true,
    code: 'verified',
    pointer: pointerData,
    receipt,
    stage: stageData,
    shim: shimReport,
    errors: [],
  };
}

function inspectShim(cliPath: string, stagePath: string | null): {
  readonly path: string;
  readonly exists: boolean;
  readonly is_symlink: boolean;
  readonly target: string | null;
  readonly matches_stage: boolean;
} {
  if (!pathEntryExists(cliPath)) {
    return { path: cliPath, exists: false, is_symlink: false, target: null, matches_stage: false };
  }
  const stat = fs.lstatSync(cliPath);
  if (!stat.isSymbolicLink()) {
    return { path: cliPath, exists: true, is_symlink: false, target: null, matches_stage: false };
  }
  const target = fs.readlinkSync(cliPath);
  const resolvedTarget = path.resolve(path.dirname(cliPath), target);
  const expectedEntrypoint = stagePath ? path.join(stagePath, 'dist', 'bin', 'omcu.js') : null;
  return {
    path: cliPath,
    exists: true,
    is_symlink: true,
    target,
    matches_stage: expectedEntrypoint ? resolvedTarget === path.resolve(expectedEntrypoint) : false,
  };
}

function scanMcpStageReferences(homeDir: string, projectRoot: string): Set<string> {
  const referencedStages = new Set<string>();
  const candidates = [
    path.join(projectRoot, '.omcu', 'mcp-install-receipt.json'),
    path.join(projectRoot, '.cursor', 'mcp.json'),
    path.join(homeDir, '.cursor', 'mcp.json'),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const content = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (typeof parsed.package_root === 'string') {
        referencedStages.add(path.resolve(parsed.package_root));
      }
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        for (const server of Object.values(parsed.mcpServers as Record<string, unknown>)) {
          if (server && typeof server === 'object') {
            const s = server as { command?: unknown; args?: unknown };
            if (Array.isArray(s.args)) {
              for (const arg of s.args) {
                if (typeof arg === 'string' && arg.includes('releases')) {
                  const match = /(.*[/\\]install[/\\]releases[/\\][^/\\]+)/.exec(arg);
                  if (match && match[1]) referencedStages.add(path.resolve(match[1]));
                }
              }
            }
          }
        }
      }
    } catch {
      // Best effort
    }
  }
  return referencedStages;
}

export async function inspectInstallStatus(options: {
  readonly homeDir?: string;
  readonly stateRoot?: string;
  readonly projectRoot?: string;
}): Promise<InstallStatusResult> {
  const home = path.resolve(options.homeDir ?? os.homedir());
  const stateRoot = path.resolve(options.stateRoot ?? defaultStateRoot(home));
  const verification = verifyCurrentInstall(stateRoot, home);
  const cliPath = canonicalCliPath(home);

  const journalPath = transactionJournal(stateRoot);
  const activeTx = fs.existsSync(journalPath);

  const receiptsDir = path.join(stateRoot, 'install', 'receipts');
  let rollbackAvailableCount = 0;
  const recentTargets: { id: string; version: string; created_at: string }[] = [];

  if (fs.existsSync(receiptsDir)) {
    try {
      const files = fs.readdirSync(receiptsDir).filter((f) => f.endsWith('.json'));
      const candidates: { id: string; version: string; created_at: string; receipt_sha256: string }[] = [];
      for (const file of files) {
        try {
          const r = readInstallReceipt(path.join(receiptsDir, file));
          if (verification.receipt && r.receipt_sha256 === verification.receipt.receipt_sha256) continue;
          if (fs.existsSync(r.installed.stage) && digestDirectory(r.installed.stage) === r.installed.sha256) {
            candidates.push({
              id: path.basename(file, '.json'),
              version: r.version,
              created_at: r.created_at,
              receipt_sha256: r.receipt_sha256,
            });
          }
        } catch { /* skip invalid */ }
      }
      candidates.sort((a, b) => b.created_at.localeCompare(a.created_at));
      rollbackAvailableCount = candidates.length;
      recentTargets.push(...candidates.slice(0, 5).map(({ id, version, created_at }) => ({ id, version, created_at })));
    } catch { /* best effort */ }
  }

  let cliVersion: string | null = null;
  if (verification.shim?.is_symlink && verification.shim.matches_stage && verification.receipt) {
    cliVersion = verification.receipt.version;
  } else if (verification.shim?.target) {
    try {
      const resolvedEntrypoint = path.resolve(path.dirname(cliPath), verification.shim.target);
      const stageDir = path.dirname(path.dirname(path.dirname(resolvedEntrypoint)));
      const pkgJson = path.join(stageDir, 'package.json');
      if (fs.existsSync(pkgJson)) {
        cliVersion = (JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as { version?: string }).version ?? null;
      }
    } catch { /* ignore */ }
  }

  const diagnostics: string[] = [...verification.errors];
  if (activeTx) diagnostics.push('active transaction journal present (needs reconciliation)');

  return {
    healthy: verification.ok && !activeTx,
    cli: {
      path: cliPath,
      exists: verification.shim?.exists ?? false,
      is_symlink: verification.shim?.is_symlink ?? false,
      target: verification.shim?.target ?? null,
      points_to_current_stage: verification.shim?.matches_stage ?? false,
      version: cliVersion,
    },
    current: verification.receipt ? {
      receipt_path: verification.pointer?.receipt_path ?? null,
      receipt_sha256: verification.receipt.receipt_sha256,
      version: verification.receipt.version,
      source_kind: verification.receipt.source.kind,
      source_realpath: verification.receipt.source.realpath,
      stage: verification.receipt.installed.stage,
      stage_exists: verification.stage?.exists ?? false,
      stage_digest_matches: verification.stage?.digest_matches ?? false,
    } : null,
    rollback: {
      available_count: rollbackAvailableCount,
      recent_targets: recentTargets,
    },
    active_transaction: activeTx,
    drift: {
      stage_modified: verification.stage ? !verification.stage.digest_matches : false,
      symlink_drifted: verification.shim ? !verification.shim.matches_stage : false,
      pointer_mismatch: verification.code === 'pointer_mismatch',
    },
    diagnostics,
  };
}

export async function listInstallations(options: {
  readonly stateRoot?: string;
  readonly homeDir?: string;
  readonly projectRoot?: string;
}): Promise<readonly InstallListEntry[]> {
  const home = path.resolve(options.homeDir ?? os.homedir());
  const stateRoot = path.resolve(options.stateRoot ?? defaultStateRoot(home));
  const receiptsDir = path.join(stateRoot, 'install', 'receipts');
  const pointerFile = path.join(stateRoot, 'install', 'current.json');
  const cliPath = canonicalCliPath(home);
  const mcpRefs = scanMcpStageReferences(home, path.resolve(options.projectRoot ?? process.cwd()));

  let currentReceiptSha: string | null = null;
  if (fs.existsSync(pointerFile)) {
    try {
      const p = JSON.parse(fs.readFileSync(pointerFile, 'utf8')) as { receipt_sha256?: unknown };
      if (typeof p.receipt_sha256 === 'string') currentReceiptSha = p.receipt_sha256;
    } catch { /* ignore */ }
  }

  let resolvedCliEntrypoint: string | null = null;
  if (pathEntryExists(cliPath) && fs.lstatSync(cliPath).isSymbolicLink()) {
    try {
      const target = fs.readlinkSync(cliPath);
      resolvedCliEntrypoint = path.resolve(path.dirname(cliPath), target);
    } catch { /* ignore */ }
  }

  if (!fs.existsSync(receiptsDir)) return [];

  const files = fs.readdirSync(receiptsDir).filter((f) => f.endsWith('.json'));
  const entries: InstallListEntry[] = [];

  for (const file of files) {
    const receiptPath = path.join(receiptsDir, file);
    const id = path.basename(file, '.json');
    try {
      const receipt = readInstallReceipt(receiptPath);
      const isCurrent = receipt.receipt_sha256 === currentReceiptSha;
      const stageExists = fs.existsSync(receipt.installed.stage);
      let stageDigestMatches = false;
      if (stageExists) {
        try {
          stageDigestMatches = digestDirectory(receipt.installed.stage) === receipt.installed.sha256;
        } catch { stageDigestMatches = false; }
      }
      const references: string[] = [];
      if (isCurrent) references.push('current_pointer');
      if (resolvedCliEntrypoint && path.resolve(receipt.installed.stage, 'dist', 'bin', 'omcu.js') === resolvedCliEntrypoint) {
        references.push('cli_symlink');
      }
      if (mcpRefs.has(path.resolve(receipt.installed.stage))) {
        references.push('mcp_reference');
      }

      entries.push({
        id,
        receipt_path: receiptPath,
        version: receipt.version,
        action: receipt.action,
        source_kind: receipt.source.kind,
        created_at: receipt.created_at,
        is_current: isCurrent,
        is_valid_rollback_target: !isCurrent && stageExists && stageDigestMatches,
        stage_path: receipt.installed.stage,
        stage_exists: stageExists,
        stage_digest_matches: stageDigestMatches,
        references,
      });
    } catch {
      entries.push({
        id,
        receipt_path: receiptPath,
        version: 'corrupt',
        action: 'unknown',
        source_kind: 'unknown_legacy',
        created_at: '',
        is_current: false,
        is_valid_rollback_target: false,
        stage_path: '',
        stage_exists: false,
        stage_digest_matches: false,
        references: [],
      });
    }
  }

  entries.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return entries;
}

export async function verifyInstallations(options: {
  readonly stateRoot?: string;
  readonly homeDir?: string;
  readonly all?: boolean;
}): Promise<VerifyInstallationsResult> {
  const home = path.resolve(options.homeDir ?? os.homedir());
  const stateRoot = path.resolve(options.stateRoot ?? defaultStateRoot(home));

  const targets: VerifyTargetReport[] = [];
  const currentReport = verifyCurrentInstall(stateRoot, home);
  targets.push({
    target: 'current_install',
    ok: currentReport.ok,
    ...(currentReport.ok ? {} : { error: currentReport.errors.join('; ') }),
  });

  if (options.all === true) {
    const list = await listInstallations({ stateRoot, homeDir: home });
    for (const entry of list) {
      if (entry.is_current) continue;
      const ok = entry.stage_exists && entry.stage_digest_matches;
      targets.push({
        target: `receipt:${entry.id}`,
        ok,
        ...(ok ? {} : { error: !entry.stage_exists ? 'stage missing' : 'stage digest drifted' }),
      });
    }
  }

  const failedCount = targets.filter((t) => !t.ok).length;
  const verifiedCount = targets.filter((t) => t.ok).length;

  return {
    ok: failedCount === 0,
    verified_count: verifiedCount,
    failed_count: failedCount,
    targets,
  };
}

export async function rollbackInstallation(input: RollbackInput): Promise<RollbackResult> {
  const home = path.resolve(input.homeDir ?? os.homedir());
  const state = ensureExternalStateRoot(path.resolve(input.stateRoot ?? defaultStateRoot(home)));
  const coordinator = ensureExternalStateRoot(defaultStateRoot(home));
  if (coordinator.path === state.path) {
    return withInstallLock(state.path, () => rollbackInstallationUnlocked(input), input.lock ?? {});
  }
  return withInstallLock(coordinator.path, () => (
    withInstallLock(state.path, () => rollbackInstallationUnlocked(input), input.lock ?? {})
  ), input.lock ?? {});
}

async function rollbackInstallationUnlocked(input: RollbackInput): Promise<RollbackResult> {
  const home = path.resolve(input.homeDir ?? os.homedir());
  const state = ensureExternalStateRoot(path.resolve(input.stateRoot ?? defaultStateRoot(home)));
  reconcileInstallTransaction(state.path, home, false);

  const receiptsDir = path.join(state.path, 'install', 'receipts');
  const specifiedTarget = input.receiptPathOrId ?? input.target;
  let targetReceiptPath: string;

  if (specifiedTarget !== undefined && specifiedTarget.trim() !== '') {
    targetReceiptPath = path.resolve(specifiedTarget);
    if (!fs.existsSync(targetReceiptPath)) {
      const candidateName = specifiedTarget.endsWith('.json') ? specifiedTarget : `${specifiedTarget}.json`;
      const candidatePath = path.join(receiptsDir, candidateName);
      if (fs.existsSync(candidatePath)) {
        targetReceiptPath = candidatePath;
      } else {
        throw new Error(`E_ROLLBACK_RECEIPT_NOT_FOUND: receipt not found for '${specifiedTarget}'`);
      }
    }
  } else {
    const currentPointerPath = path.join(state.path, 'install', 'current.json');
    let currentReceiptSha: string | null = null;
    if (fs.existsSync(currentPointerPath)) {
      try {
        currentReceiptSha = (JSON.parse(fs.readFileSync(currentPointerPath, 'utf8')) as { receipt_sha256?: string }).receipt_sha256 ?? null;
      } catch { /* ignore */ }
    }
    const candidates: { file: string; created_at: string }[] = [];
    if (fs.existsSync(receiptsDir)) {
      for (const f of fs.readdirSync(receiptsDir).filter((x) => x.endsWith('.json'))) {
        try {
          const r = readInstallReceipt(path.join(receiptsDir, f));
          if (currentReceiptSha !== null && r.receipt_sha256 === currentReceiptSha) continue;
          if (fs.existsSync(r.installed.stage) && digestDirectory(r.installed.stage) === r.installed.sha256) {
            candidates.push({ file: path.join(receiptsDir, f), created_at: r.created_at });
          }
        } catch { /* skip */ }
      }
    }
    if (candidates.length === 0) {
      throw new Error('E_NO_ROLLBACK_TARGETS: no valid rollback candidates available');
    }
    candidates.sort((a, b) => b.created_at.localeCompare(a.created_at));
    targetReceiptPath = candidates[0]!.file;
  }

  const targetReceipt = readInstallReceipt(targetReceiptPath);
  const targetStage = path.resolve(targetReceipt.installed.stage);
  if (!fs.existsSync(targetStage)) {
    throw new Error(`E_ROLLBACK_STAGE_MISSING: target stage does not exist: ${targetStage}`);
  }
  if (digestDirectory(targetStage) !== targetReceipt.installed.sha256) {
    throw new Error('E_INSTALLED_BYTES_DRIFTED');
  }
  const targetEntrypoint = path.join(targetStage, 'dist', 'bin', 'omcu.js');
  if (!fs.existsSync(targetEntrypoint)) {
    throw new Error('E_CLI_ENTRYPOINT_MISSING');
  }

  const currentPointerPath = path.join(state.path, 'install', 'current.json');
  let currentPointer: { receipt_path?: string; receipt_sha256?: string } | null = null;
  if (fs.existsSync(currentPointerPath)) {
    try {
      currentPointer = JSON.parse(fs.readFileSync(currentPointerPath, 'utf8')) as { receipt_path?: string; receipt_sha256?: string };
    } catch {
      currentPointer = null;
    }
  }

  if (currentPointer !== null) {
    if (currentPointer.receipt_sha256 === targetReceipt.receipt_sha256) {
      return {
        status: 'already_current',
        receiptPath: targetReceiptPath,
        receipt: targetReceipt,
        doctor: null,
        rolled_back_from: null,
        dry_run: input.dryRun ?? false,
      };
    }
    if (currentPointer.receipt_path && fs.existsSync(currentPointer.receipt_path)) {
      try {
        const curR = readInstallReceipt(currentPointer.receipt_path);
        if (path.resolve(curR.installed.stage) === targetStage && curR.installed.sha256 === targetReceipt.installed.sha256) {
          return {
            status: 'already_current',
            receiptPath: targetReceiptPath,
            receipt: targetReceipt,
            doctor: null,
            rolled_back_from: null,
            dry_run: input.dryRun ?? false,
          };
        }
      } catch { /* ignore */ }
    }
  }

  if (input.dryRun === true) {
    return {
      status: 'rolled_back',
      receiptPath: targetReceiptPath,
      receipt: targetReceipt,
      doctor: null,
      rolled_back_from: currentPointer ? {
        receipt_path: currentPointer.receipt_path ?? '',
        receipt_sha256: currentPointer.receipt_sha256 ?? '',
        version: '',
      } : null,
      dry_run: true,
    };
  }

  assertOwnedInventoryConfined(targetReceipt, state.path, home);

  const transactionId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const newReceiptPath = path.join(receiptsDir, `${transactionId}.json`);
  const cli = canonicalCliPath(home);
  const priorTarget = currentTarget(cli);
  const priorPointerBytes = fs.existsSync(currentPointerPath) ? fs.readFileSync(currentPointerPath) : null;
  const journalPath = transactionJournal(state.path);

  let rollbackFromVersion = 'unknown';
  let rollbackFromReceiptSha: string | null = null;
  if (currentPointer?.receipt_path && fs.existsSync(currentPointer.receipt_path)) {
    try {
      const curR = readInstallReceipt(currentPointer.receipt_path);
      rollbackFromVersion = curR.version;
      rollbackFromReceiptSha = curR.receipt_sha256;
    } catch { /* best effort */ }
  }

  const rollbackReceipt = createInstallReceipt({
    store_kind: 'omcu_install_receipt',
    schema_version: 1,
    transaction_id: transactionId,
    action: 'rollback',
    version: targetReceipt.version,
    source: targetReceipt.source,
    installed: { stage: targetStage, sha256: targetReceipt.installed.sha256, cli },
    previous_cli_target: priorTarget,
    owned_inventory: [
      { path: targetStage, kind: 'release_stage', identity: targetReceipt.installed.sha256 },
      { path: cli, kind: 'cli_symlink', identity: targetEntrypoint },
    ],
    rollback_from_receipt_sha256: rollbackFromReceiptSha,
    rollback_reason: input.reason ?? 'operator_rollback',
    created_at: (input.now ?? (() => new Date()))().toISOString(),
  });

  atomicWriteJson(journalPath, {
    store_kind: 'omcu_install_transaction',
    schema_version: 1,
    cli,
    candidate_target: targetEntrypoint,
    prior_cli_target: priorTarget,
    current_pointer: currentPointerPath,
    prior_pointer_base64: priorPointerBytes?.toString('base64') ?? null,
    receipt_path: newReceiptPath,
    receipt_sha256: rollbackReceipt.receipt_sha256,
    stage: targetStage,
    stage_existed: true,
    temporary_stage: `${targetStage}.tmp-dummy`,
    project_state: null,
    project_state_ownership_marker: null,
  } satisfies InstallTransactionJournal);

  try {
    fs.chmodSync(targetEntrypoint, 0o500);
    writeInstallReceipt(newReceiptPath, rollbackReceipt);
    replaceSymlink(cli, targetEntrypoint);

    const project = path.resolve(input.projectRoot ?? process.cwd());
    const doctor = input.runDoctor === false ? null : await runSetupDoctor({
      packageRoot: targetStage,
      projectRoot: project,
      homeDir: home,
      ...(input.runner === undefined ? {} : { runner: input.runner }),
      inspectProjectState: false,
    });
    if (doctor !== null && !doctor.ok) throw new Error('E_POST_ROLLBACK_DOCTOR_FAILED');

    atomicWriteJson(currentPointerPath, {
      schema_version: 1,
      receipt_path: newReceiptPath,
      receipt_sha256: rollbackReceipt.receipt_sha256,
    });
    fs.rmSync(journalPath, { force: true });
    try {
      repairOwnedMcpServerSync({ projectRoot: project, homeDir: home, packageRoot: targetStage });
    } catch { /* advisory */ }

    return {
      status: 'rolled_back',
      receiptPath: newReceiptPath,
      receipt: rollbackReceipt,
      doctor,
      rolled_back_from: rollbackFromReceiptSha ? {
        receipt_path: currentPointer?.receipt_path ?? '',
        receipt_sha256: rollbackFromReceiptSha,
        version: rollbackFromVersion,
      } : null,
    };
  } catch (error) {
    reconcileInstallTransaction(state.path, home, false);
    throw error;
  }
}

export async function pruneInstallations(options: PruneInput): Promise<PruneResult> {
  const home = path.resolve(options.homeDir ?? os.homedir());
  const state = ensureExternalStateRoot(path.resolve(options.stateRoot ?? defaultStateRoot(home)));
  const coordinator = ensureExternalStateRoot(defaultStateRoot(home));
  if (coordinator.path === state.path) {
    return withInstallLock(state.path, () => pruneInstallationsUnlocked(options), options.lock ?? {});
  }
  return withInstallLock(coordinator.path, () => (
    withInstallLock(state.path, () => pruneInstallationsUnlocked(options), options.lock ?? {})
  ), options.lock ?? {});
}

async function pruneInstallationsUnlocked(options: PruneInput): Promise<PruneResult> {
  const home = path.resolve(options.homeDir ?? os.homedir());
  const state = ensureExternalStateRoot(path.resolve(options.stateRoot ?? defaultStateRoot(home)));
  reconcileInstallTransaction(state.path, home, false);

  const keep = options.keep ?? 2;
  const dryRun = options.dryRun ?? true;
  const releasesDir = path.join(state.path, 'install', 'releases');
  const receiptsDir = path.join(state.path, 'install', 'receipts');
  const journalPath = transactionJournal(state.path);
  const mcpRefs = scanMcpStageReferences(home, path.resolve(options.projectRoot ?? process.cwd()));

  if (!fs.existsSync(releasesDir)) {
    return {
      dry_run: dryRun,
      keep,
      stages_examined: 0,
      stages_preserved: [],
      stages_pruned: [],
      receipts_pruned: [],
    };
  }

  const stageReferences = new Map<string, Set<string>>();
  const getRefs = (stagePath: string): Set<string> => {
    const norm = path.resolve(stagePath);
    let s = stageReferences.get(norm);
    if (!s) { s = new Set(); stageReferences.set(norm, s); }
    return s;
  };

  const pointerFile = path.join(state.path, 'install', 'current.json');
  let currentStagePath: string | null = null;
  if (fs.existsSync(pointerFile)) {
    try {
      const p = JSON.parse(fs.readFileSync(pointerFile, 'utf8')) as { receipt_path?: string; receipt_sha256?: string };
      if (typeof p.receipt_path === 'string' && fs.existsSync(p.receipt_path)) {
        const curReceipt = readInstallReceipt(p.receipt_path);
        currentStagePath = path.resolve(curReceipt.installed.stage);
        getRefs(currentStagePath).add('current_pointer');
      }
    } catch { /* ignore */ }
  }

  const cliPath = canonicalCliPath(home);
  if (pathEntryExists(cliPath) && fs.lstatSync(cliPath).isSymbolicLink()) {
    try {
      const target = fs.readlinkSync(cliPath);
      const stageDir = path.dirname(path.dirname(path.resolve(path.dirname(cliPath), target)));
      getRefs(stageDir).add('cli_symlink');
    } catch { /* ignore */ }
  }

  if (fs.existsSync(journalPath)) {
    try {
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { stage?: string; temporary_stage?: string };
      if (typeof journal.stage === 'string') getRefs(journal.stage).add('active_transaction');
      if (typeof journal.temporary_stage === 'string') getRefs(journal.temporary_stage).add('active_transaction');
    } catch { /* ignore */ }
  }

  for (const ref of mcpRefs) {
    getRefs(ref).add('mcp_reference');
  }

  const validReceipts: { receipt: InstallReceipt; file: string }[] = [];
  if (fs.existsSync(receiptsDir)) {
    const files = fs.readdirSync(receiptsDir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const receiptFile = path.join(receiptsDir, f);
      try {
        const r = readInstallReceipt(receiptFile);
        if (fs.existsSync(r.installed.stage) && digestDirectory(r.installed.stage) === r.installed.sha256) {
          validReceipts.push({ receipt: r, file: receiptFile });
        }
      } catch { /* skip invalid */ }
    }
  }

  const nonCurrentValid = validReceipts.filter((item) => (
    currentStagePath === null || path.resolve(item.receipt.installed.stage) !== currentStagePath
  ));
  nonCurrentValid.sort((a, b) => b.receipt.created_at.localeCompare(a.receipt.created_at));

  const retainedRollback = nonCurrentValid.slice(0, keep);
  for (const item of retainedRollback) {
    getRefs(item.receipt.installed.stage).add('retained_rollback');
  }

  const releaseDirs = fs.readdirSync(releasesDir);
  const preserved: PrunedStageReport[] = [];
  const prunable: PrunedStageReport[] = [];
  const stagesToPrune: { path: string; receipts: string[] }[] = [];

  for (const dirName of releaseDirs) {
    const stagePath = path.join(releasesDir, dirName);
    const resolvedStage = path.resolve(stagePath);
    const refs = stageReferences.get(resolvedStage) ?? new Set();

    const owningReceipts = validReceipts.filter((v) => path.resolve(v.receipt.installed.stage) === resolvedStage);
    const version = owningReceipts[0]?.receipt.version ?? dirName.split('-')[0] ?? 'unknown';
    const sha = owningReceipts[0]?.receipt.installed.sha256 ?? '';

    if (refs.size > 0) {
      const reason = refs.has('current_pointer') ? 'current_pointer'
        : refs.has('cli_symlink') ? 'cli_symlink'
        : refs.has('retained_rollback') ? 'retained_rollback'
        : refs.has('mcp_reference') ? 'mcp_reference'
        : refs.has('active_transaction') ? 'active_transaction'
        : 'current_pointer';

      preserved.push({
        path: stagePath,
        version,
        sha256: sha,
        action: 'keep',
        reason,
        references: [...refs],
      });
      continue;
    }

    if (dirName.includes('.tmp-')) {
      prunable.push({
        path: stagePath,
        version,
        sha256: sha,
        action: 'prune',
        reason: 'unreferenced',
        references: [],
      });
      stagesToPrune.push({ path: stagePath, receipts: [] });
      continue;
    }

    let isModified = false;
    if (owningReceipts.length === 0) {
      isModified = true;
    } else {
      try {
        const actualDigest = digestDirectory(stagePath);
        if (actualDigest !== sha) isModified = true;
      } catch {
        isModified = true;
      }
    }

    if (isModified) {
      preserved.push({
        path: stagePath,
        version,
        sha256: sha,
        action: 'keep',
        reason: 'stage_modified',
        references: [],
      });
    } else {
      prunable.push({
        path: stagePath,
        version,
        sha256: sha,
        action: 'prune',
        reason: 'unreferenced',
        references: [],
      });
      stagesToPrune.push({
        path: stagePath,
        receipts: owningReceipts.map((o) => o.file),
      });
    }
  }

  const receiptsPruned: string[] = [];
  if (!dryRun) {
    for (const item of stagesToPrune) {
      removeWritable(item.path);
      for (const receiptFile of item.receipts) {
        if (fs.existsSync(receiptFile)) {
          try {
            fs.chmodSync(receiptFile, 0o600);
            fs.rmSync(receiptFile, { force: true });
            receiptsPruned.push(receiptFile);
          } catch { /* best effort */ }
        }
      }
    }

    const gcReceiptsDir = path.join(state.path, 'install', 'gc-receipts');
    fs.mkdirSync(gcReceiptsDir, { recursive: true, mode: 0o700 });
    const gcReceiptPath = path.join(gcReceiptsDir, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.json`);
    atomicWriteJson(gcReceiptPath, {
      store_kind: 'omcu_gc_receipt',
      schema_version: 1,
      pruned_stages: prunable.map((p) => p.path),
      preserved_stages: preserved.map((p) => p.path),
      pruned_receipts: receiptsPruned,
      keep,
      created_at: new Date().toISOString(),
    });
  }

  return {
    dry_run: dryRun,
    keep,
    stages_examined: releaseDirs.length,
    stages_preserved: preserved,
    stages_pruned: prunable,
    receipts_pruned: receiptsPruned,
  };
}

export async function repairInstallation(options: RepairInput): Promise<RepairResult> {
  const home = path.resolve(options.homeDir ?? os.homedir());
  const state = ensureExternalStateRoot(path.resolve(options.stateRoot ?? defaultStateRoot(home)));
  return withInstallLock(state.path, () => repairInstallationUnlocked(options), options.lock ?? {});
}

async function repairInstallationUnlocked(options: RepairInput): Promise<RepairResult> {
  const home = path.resolve(options.homeDir ?? os.homedir());
  const state = ensureExternalStateRoot(path.resolve(options.stateRoot ?? defaultStateRoot(home)));
  reconcileInstallTransaction(state.path, home, false);

  const pointerFile = path.join(state.path, 'install', 'current.json');
  if (!fs.existsSync(pointerFile)) {
    throw new Error('E_REPAIR_CANNOT_PROVE_OWNERSHIP: current.json is missing');
  }

  let pointer: { receipt_path?: unknown; receipt_sha256?: unknown };
  try {
    pointer = JSON.parse(fs.readFileSync(pointerFile, 'utf8')) as { receipt_path?: unknown; receipt_sha256?: unknown };
  } catch (error) {
    throw new Error(`E_REPAIR_CANNOT_PROVE_OWNERSHIP: current.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof pointer.receipt_path !== 'string' || typeof pointer.receipt_sha256 !== 'string') {
    throw new Error('E_REPAIR_CANNOT_PROVE_OWNERSHIP: current.json is missing receipt properties');
  }

  if (!fs.existsSync(pointer.receipt_path)) {
    throw new Error(`E_REPAIR_CANNOT_PROVE_OWNERSHIP: receipt file is missing: ${pointer.receipt_path}`);
  }

  const receipt = readInstallReceipt(pointer.receipt_path);
  if (receipt.receipt_sha256 !== pointer.receipt_sha256) {
    throw new Error('E_REPAIR_CANNOT_PROVE_OWNERSHIP: receipt_sha256 mismatch in current pointer');
  }

  const stage = path.resolve(receipt.installed.stage);
  if (!fs.existsSync(stage)) {
    throw new Error(`E_STAGE_MISSING: stage directory does not exist: ${stage}`);
  }

  if (digestDirectory(stage) !== receipt.installed.sha256) {
    throw new Error('E_INSTALLED_BYTES_DRIFTED');
  }

  const entrypoint = path.join(stage, 'dist', 'bin', 'omcu.js');
  if (!fs.existsSync(entrypoint)) {
    throw new Error('E_CLI_ENTRYPOINT_MISSING');
  }

  const cli = canonicalCliPath(home);
  const actions: string[] = [];

  if (pathEntryExists(cli)) {
    const stat = fs.lstatSync(cli);
    if (!stat.isSymbolicLink()) {
      throw new Error(`E_CLI_PATH_COLLISION: cannot repair because ${cli} is not a symlink`);
    }
    const target = fs.readlinkSync(cli);
    const resolvedTarget = path.resolve(path.dirname(cli), target);
    if (resolvedTarget !== path.resolve(entrypoint)) {
      replaceSymlink(cli, entrypoint);
      actions.push(`repointed ${cli} to ${entrypoint}`);
    }
  } else {
    replaceSymlink(cli, entrypoint);
    actions.push(`recreated ${cli} pointing to ${entrypoint}`);
  }

  fs.chmodSync(entrypoint, 0o500);

  const project = path.resolve(options.projectRoot ?? process.cwd());
  const doctor = await runSetupDoctor({
    packageRoot: stage,
    projectRoot: project,
    homeDir: home,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    inspectProjectState: false,
  });

  return {
    repaired: actions.length > 0,
    actions,
    doctor,
  };
}
