import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteJson } from '../runtime/atomic.js';
import { ensureExternalStateRoot } from '../runtime/state-root.js';
import { copyPackableDirectory, digestDirectory, digestPackableDirectory, verifySha256Sums } from './digest.js';
import { createInstallReceipt, readInstallReceipt, writeInstallReceipt, type InstallReceipt, type OwnedInstallPath } from './receipt.js';
import { runSetupDoctor, type DoctorReport } from './doctor.js';
import type { CommandRunner } from './types.js';
import { withInstallLock, withInstallLockSync, type InstallLockOptions } from './lock.js';

export interface InstallInput {
  readonly sourceRoot: string;
  readonly action?: 'install' | 'update';
  readonly sourceArchive?: string;
  readonly checksumsFile?: string;
  readonly homeDir?: string;
  readonly stateRoot?: string;
  readonly projectRoot?: string;
  readonly transactionId?: string;
  readonly now?: () => Date;
  readonly cursorCommand?: string;
  readonly runner?: CommandRunner;
  readonly runDoctor?: boolean;
  readonly lock?: InstallLockOptions;
}

export interface InstallResult {
  readonly receiptPath: string;
  readonly receipt: InstallReceipt;
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
  readonly project_state: string;
  readonly project_state_existed: boolean;
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

function readJournal(file: string): InstallTransactionJournal {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<InstallTransactionJournal>;
  if (parsed.store_kind !== 'omcu_install_transaction' || parsed.schema_version !== 1
    || typeof parsed.cli !== 'string' || typeof parsed.candidate_target !== 'string'
    || !(typeof parsed.prior_cli_target === 'string' || parsed.prior_cli_target === null)
    || typeof parsed.current_pointer !== 'string'
    || !(typeof parsed.prior_pointer_base64 === 'string' || parsed.prior_pointer_base64 === null)
    || typeof parsed.receipt_path !== 'string' || typeof parsed.receipt_sha256 !== 'string'
    || typeof parsed.stage !== 'string' || typeof parsed.stage_existed !== 'boolean'
    || typeof parsed.temporary_stage !== 'string' || typeof parsed.project_state !== 'string'
    || typeof parsed.project_state_existed !== 'boolean') throw new Error('E_INSTALL_TRANSACTION_INVALID');
  return parsed as InstallTransactionJournal;
}

function reconcileInstallTransaction(stateRoot: string, home: string): void {
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
    removeWritable(journal.receipt_path);
    if (!journal.stage_existed) removeWritable(journal.stage);
    if (!journal.project_state_existed && fs.existsSync(journal.project_state)
      && fs.lstatSync(journal.project_state).isDirectory()
      && !fs.lstatSync(journal.project_state).isSymbolicLink()
      && fs.readdirSync(journal.project_state).length === 0) fs.rmdirSync(journal.project_state);
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
  const sourceRoot = path.resolve(input.sourceRoot);
  const home = path.resolve(input.homeDir ?? os.homedir());
  const state = ensureExternalStateRoot(path.resolve(input.stateRoot ?? defaultStateRoot(home)));
  reconcileInstallTransaction(state.path, home);
  const project = path.resolve(input.projectRoot ?? process.cwd());
  const transactionId = input.transactionId ?? `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const sourceDigest = input.sourceArchive === undefined
    ? digestPackableDirectory(sourceRoot)
    : input.checksumsFile === undefined
      ? (() => { throw new Error('E_SHA256SUMS_REQUIRED'); })()
      : verifySha256Sums(path.resolve(input.sourceArchive), path.resolve(input.checksumsFile));
  const installedDigest = digestPackableDirectory(sourceRoot);
  const version = releaseVersion(sourceRoot);
  const stage = path.join(state.path, 'install', 'releases', `${version}-${installedDigest.slice(0, 16)}`);
  const temporaryStage = `${stage}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const cli = path.join(home, '.local', 'bin', 'omcu');
  const priorTarget = currentTarget(cli);
  const priorPointer = path.join(state.path, 'install', 'current.json');
  const priorPointerBytes = fs.existsSync(priorPointer) ? fs.readFileSync(priorPointer) : null;
  const projectState = path.join(project, '.omcu');
  const projectStateExisted = fs.existsSync(projectState);
  const stageExisted = fs.existsSync(stage);
  const entrypoint = path.join(stage, 'dist', 'bin', 'omcu.js');
  const receipt = createInstallReceipt({
    store_kind: 'omcu_install_receipt',
    schema_version: 1,
    transaction_id: transactionId,
    action: input.action ?? (priorTarget === null ? 'install' : 'update'),
    version,
    source: {
      kind: input.sourceArchive === undefined ? 'source' : 'archive',
      realpath: path.resolve(input.sourceArchive ?? sourceRoot),
      sha256: sourceDigest,
    },
    installed: { stage, sha256: installedDigest, cli },
    previous_cli_target: priorTarget,
    owned_inventory: [
      { path: stage, kind: 'release_stage', identity: installedDigest },
      { path: cli, kind: 'cli_symlink', identity: entrypoint },
      { path: projectState, kind: 'project_state', identity: path.resolve(project) },
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
    project_state_existed: projectStateExisted,
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

    fs.mkdirSync(projectState, { recursive: true, mode: 0o700 });
    fs.chmodSync(projectState, 0o700);

    const doctor = input.runDoctor === false ? null : await runSetupDoctor({
      packageRoot: stage, projectRoot: project, homeDir: home,
      ...(input.cursorCommand === undefined ? {} : { cursorCommand: input.cursorCommand }),
      ...(input.runner === undefined ? {} : { runner: input.runner }),
    });
    if (doctor !== null && !doctor.ok) throw new Error('E_POST_INSTALL_DOCTOR_FAILED');

    atomicWriteJson(priorPointer, { schema_version: 1, receipt_path: receiptPath, receipt_sha256: receipt.receipt_sha256 });
    fs.rmSync(journalPath, { force: true });
    return { receiptPath, receipt, doctor };
  } catch (error) {
    reconcileInstallTransaction(state.path, home);
    throw error;
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
  if (!fs.lstatSync(receipt.installed.cli).isSymbolicLink()
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
