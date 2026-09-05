import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installOrUpdate,
  readCurrentInstall,
  inspectInstallStatus,
  listInstallations,
  verifyInstallations,
  rollbackInstallation,
  pruneInstallations,
  repairInstallation,
} from '../../src/setup/lifecycle.js';
import { readInstallReceipt } from '../../src/setup/receipt.js';
import type { CommandRunner } from '../../src/setup/types.js';

const roots: string[] = [];
function temporary(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), name));
  roots.push(root);
  return root;
}

function makeWritable(root: string): void {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory()) return;
  fs.chmodSync(root, 0o700);
  for (const name of fs.readdirSync(root)) makeWritable(path.join(root, name));
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    makeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function packageFixture(parent: string, version: string, marker: string): string {
  const root = path.join(parent, `package-${version}-${marker}`);
  fs.mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, '.cursor-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@iml1s/oh-my-cursor', version, files: ['dist', '.cursor-plugin', '.cursor/rules'],
  }));
  fs.writeFileSync(path.join(root, 'dist', 'bin', 'omcu.js'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(marker)});\n`);
  fs.writeFileSync(path.join(root, '.cursor', 'rules', 'oh-my-cursor.mdc'), '---\nalwaysApply: true\n---\n');
  fs.writeFileSync(path.join(root, '.cursor-plugin', 'plugin.json'), JSON.stringify({
    name: 'oh-my-cursor', version, rules: './.cursor/rules/',
  }));
  return root;
}

const healthyCursor: CommandRunner = {
  async run(_command, args) {
    if (args[0] === '--version') return { code: 0, stdout: '2026.07.20-test\n', stderr: '' };
    if (args[0] === 'status') return { code: 0, stdout: 'authenticated\n', stderr: '' };
    return { code: 0, stdout: '--version --help status --plugin-dir\n', stderr: '' };
  },
};

describe('lifecycle updates, status, rollback, prune, and repair', () => {
  it('throws E_UPDATE_SOURCE_REQUIRED when neither source nor archive nor release is provided', async () => {
    const root = temporary('omcu-test-no-source-');
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    fs.mkdirSync(home);

    await expect(installOrUpdate({
      homeDir: home,
      stateRoot: state,
      runner: healthyCursor,
    })).rejects.toThrow('E_UPDATE_SOURCE_REQUIRED');
  });

  it('supports --dry-run without mutating disk or creating stages', async () => {
    const root = temporary('omcu-test-dry-run-');
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    fs.mkdirSync(home);
    const source = packageFixture(root, '1.0.0', 'dry');

    const result = await installOrUpdate({
      sourceRoot: source,
      homeDir: home,
      stateRoot: state,
      runner: healthyCursor,
      dryRun: true,
    });

    expect(result.dry_run).toBe(true);
    expect(result.status).toBe('installed');
    expect(fs.existsSync(state)).toBe(false);
    expect(fs.existsSync(path.join(home, '.local', 'state', 'oh-my-cursor'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.local', 'bin', 'omcu'))).toBe(false);
  });

  it('detects already_current and avoids redundant stage and receipt creation', async () => {
    const root = temporary('omcu-test-already-current-');
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    fs.mkdirSync(home);
    const source = packageFixture(root, '1.0.0', 'stable');

    const first = await installOrUpdate({
      sourceRoot: source,
      homeDir: home,
      stateRoot: state,
      runner: healthyCursor,
      transactionId: 'tx-first',
    });
    expect(first.status).toBe('installed');

    const receiptsDir = path.join(state, 'install', 'receipts');
    const initialReceiptFiles = fs.readdirSync(receiptsDir);
    expect(initialReceiptFiles.length).toBe(1);

    const second = await installOrUpdate({
      sourceRoot: source,
      homeDir: home,
      stateRoot: state,
      runner: healthyCursor,
      transactionId: 'tx-second',
    });
    expect(second.status).toBe('already_current');
    expect(second.receiptPath).toBe(first.receiptPath);
    expect(fs.readdirSync(receiptsDir).length).toBe(1);
  });

  it('inspectInstallStatus detects healthy install and identifies drifts', async () => {
    const root = temporary('omcu-test-status-');
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    fs.mkdirSync(home);
    const source1 = packageFixture(root, '1.0.0', 'v1');

    await installOrUpdate({
      sourceRoot: source1,
      homeDir: home,
      stateRoot: state,
      runner: healthyCursor,
      transactionId: 'tx-1',
    });

    const status1 = await inspectInstallStatus({ homeDir: home, stateRoot: state });
    expect(status1.healthy).toBe(true);
    expect(status1.cli.points_to_current_stage).toBe(true);
    expect(status1.current?.version).toBe('1.0.0');
    expect(status1.rollback.available_count).toBe(0);

    // Update to 1.1.0
    const source2 = packageFixture(root, '1.1.0', 'v2');
    await installOrUpdate({
      sourceRoot: source2,
      homeDir: home,
      stateRoot: state,
      runner: healthyCursor,
      transactionId: 'tx-2',
    });

    const status2 = await inspectInstallStatus({ homeDir: home, stateRoot: state });
    expect(status2.healthy).toBe(true);
    expect(status2.current?.version).toBe('1.1.0');
    expect(status2.rollback.available_count).toBe(1);

    // Tamper with stage directory: should report stage_modified
    const currentStage = status2.current!.stage;
    fs.chmodSync(currentStage, 0o700);
    fs.writeFileSync(path.join(currentStage, 'tampered.txt'), 'tampered');
    const statusDriftStage = await inspectInstallStatus({ homeDir: home, stateRoot: state });
    expect(statusDriftStage.healthy).toBe(false);
    expect(statusDriftStage.drift.stage_modified).toBe(true);

    // Restore stage file
    fs.rmSync(path.join(currentStage, 'tampered.txt'));
    fs.chmodSync(currentStage, 0o500);

    // Repoint symlink: should report symlink_drifted
    const cliSymlink = path.join(home, '.local', 'bin', 'omcu');
    fs.unlinkSync(cliSymlink);
    fs.symlinkSync('/dev/null', cliSymlink);
    const statusDriftSymlink = await inspectInstallStatus({ homeDir: home, stateRoot: state });
    expect(statusDriftSymlink.healthy).toBe(false);
    expect(statusDriftSymlink.drift.symlink_drifted).toBe(true);
  });

  it('lists installations with correct reference flags', async () => {
    const root = temporary('omcu-test-list-');
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    fs.mkdirSync(home);

    const s1 = packageFixture(root, '1.0.0', 'v1');
    const s2 = packageFixture(root, '2.0.0', 'v2');

    await installOrUpdate({ sourceRoot: s1, homeDir: home, stateRoot: state, runner: healthyCursor, transactionId: 'tx-1' });
    await installOrUpdate({ sourceRoot: s2, homeDir: home, stateRoot: state, runner: healthyCursor, transactionId: 'tx-2' });

    const list = await listInstallations({ homeDir: home, stateRoot: state });
    expect(list.length).toBe(2);

    const v2Entry = list.find((e) => e.version === '2.0.0');
    const v1Entry = list.find((e) => e.version === '1.0.0');

    expect(v2Entry).toBeDefined();
    expect(v2Entry!.is_current).toBe(true);
    expect(v2Entry!.references.includes('current_pointer')).toBe(true);
    expect(v2Entry!.references.includes('cli_symlink')).toBe(true);
    expect(v2Entry!.is_valid_rollback_target).toBe(false); // Current is not rollback target

    expect(v1Entry).toBeDefined();
    expect(v1Entry!.is_current).toBe(false);
    expect(v1Entry!.references.includes('current_pointer')).toBe(false);
    expect(v1Entry!.references.includes('cli_symlink')).toBe(false);
    expect(v1Entry!.is_valid_rollback_target).toBe(true); // Prior valid install is rollback target
  });

  it('performs rollback to previous version and creates rollback receipt', async () => {
    const root = temporary('omcu-test-rollback-');
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    fs.mkdirSync(home);

    const s1 = packageFixture(root, '1.0.0', 'v1');
    const s2 = packageFixture(root, '2.0.0', 'v2');

    const res1 = await installOrUpdate({ sourceRoot: s1, homeDir: home, stateRoot: state, runner: healthyCursor, transactionId: 'tx-1' });
    const res2 = await installOrUpdate({ sourceRoot: s2, homeDir: home, stateRoot: state, runner: healthyCursor, transactionId: 'tx-2' });

    expect(readCurrentInstall(state).version).toBe('2.0.0');

    // Rollback to v1
    const rollbackRes = await rollbackInstallation({
      target: res1.receiptPath,
      homeDir: home,
      stateRoot: state,
      runner: healthyCursor,
      reason: 'manual_verification_rollback',
    });

    expect(rollbackRes.status).toBe('rolled_back');
    expect(rollbackRes.receipt.version).toBe('1.0.0');
    expect(rollbackRes.receipt.action).toBe('rollback');
    expect(rollbackRes.receipt.rollback_from_receipt_sha256).toBe(res2.receipt.receipt_sha256);
    expect(rollbackRes.receipt.rollback_reason).toBe('manual_verification_rollback');

    const currentAfter = readCurrentInstall(state);
    expect(currentAfter.version).toBe('1.0.0');

    // Rollback again to same receipt reports already_current
    const rollbackAgain = await rollbackInstallation({
      target: res1.receiptPath,
      homeDir: home,
      stateRoot: state,
      runner: healthyCursor,
    });
    expect(rollbackAgain.status).toBe('already_current');
  });

  it('pruneInstallations protects current, rollback keep count, and modified stages', async () => {
    const root = temporary('omcu-test-prune-');
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    fs.mkdirSync(home);

    // Install 3 versions: 1.0.0, 2.0.0, 3.0.0
    const s1 = packageFixture(root, '1.0.0', 'v1');
    const s2 = packageFixture(root, '2.0.0', 'v2');
    const s3 = packageFixture(root, '3.0.0', 'v3');

    await installOrUpdate({ sourceRoot: s1, homeDir: home, stateRoot: state, runner: healthyCursor, transactionId: 'tx-1' });
    await installOrUpdate({ sourceRoot: s2, homeDir: home, stateRoot: state, runner: healthyCursor, transactionId: 'tx-2' });
    await installOrUpdate({ sourceRoot: s3, homeDir: home, stateRoot: state, runner: healthyCursor, transactionId: 'tx-3' });

    // Dry run with keep=1: should prune v1.0.0, keep v3.0.0 (current) and v2.0.0 (rollback)
    const dryResult = await pruneInstallations({
      homeDir: home,
      stateRoot: state,
      keep: 1,
      dryRun: true,
    });
    expect(dryResult.dry_run).toBe(true);
    expect(dryResult.stages_pruned.length).toBe(1);
    expect(dryResult.stages_pruned[0]?.version).toBe('1.0.0');

    // The stage directory should still exist because it was dry-run
    expect(fs.existsSync(dryResult.stages_pruned[0]!.path)).toBe(true);

    // Now apply with keep=1
    const applyResult = await pruneInstallations({
      homeDir: home,
      stateRoot: state,
      keep: 1,
      dryRun: false,
    });
    expect(applyResult.dry_run).toBe(false);
    expect(applyResult.stages_pruned.length).toBe(1);
    expect(fs.existsSync(applyResult.stages_pruned[0]!.path)).toBe(false);

    // A GC receipt should have been generated
    const gcDir = path.join(state, 'install', 'gc-receipts');
    expect(fs.existsSync(gcDir)).toBe(true);
    const gcFiles = fs.readdirSync(gcDir);
    expect(gcFiles.length).toBe(1);

    // If an untracked modified stage exists, it must be kept as stage_modified
    const releasesDir = path.join(state, 'install', 'releases');
    const orphanDir = path.join(releasesDir, 'orphaned-custom');
    fs.mkdirSync(orphanDir);
    fs.writeFileSync(path.join(orphanDir, 'unknown.txt'), 'unknown');

    const pruneWithOrphan = await pruneInstallations({
      homeDir: home,
      stateRoot: state,
      keep: 1,
      dryRun: false,
    });
    const preservedOrphan = pruneWithOrphan.stages_preserved.find((p) => p.path === orphanDir);
    expect(preservedOrphan).toBeDefined();
    expect(preservedOrphan!.reason).toBe('stage_modified');
    expect(fs.existsSync(orphanDir)).toBe(true); // Untouched!
  });

  it('repairInstallation restores missing or drifted CLI symlink', async () => {
    const root = temporary('omcu-test-repair-');
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    fs.mkdirSync(home);
    const source = packageFixture(root, '1.0.0', 'v1');

    await installOrUpdate({
      sourceRoot: source,
      homeDir: home,
      stateRoot: state,
      runner: healthyCursor,
      transactionId: 'tx-1',
    });

    const cliSymlink = path.join(home, '.local', 'bin', 'omcu');
    expect(fs.existsSync(cliSymlink)).toBe(true);

    // Delete CLI symlink
    fs.unlinkSync(cliSymlink);
    expect(fs.existsSync(cliSymlink)).toBe(false);

    // Repair should recreate it
    const rep1 = await repairInstallation({
      homeDir: home,
      stateRoot: state,
      runner: healthyCursor,
    });
    expect(rep1.repaired).toBe(true);
    expect(fs.lstatSync(cliSymlink).isSymbolicLink()).toBe(true);

    // If cli is a regular non-symlink file, repair must fail with E_CLI_PATH_COLLISION
    fs.unlinkSync(cliSymlink);
    fs.writeFileSync(cliSymlink, 'regular file');

    await expect(repairInstallation({
      homeDir: home,
      stateRoot: state,
      runner: healthyCursor,
    })).rejects.toThrow('E_CLI_PATH_COLLISION');
  });
});
