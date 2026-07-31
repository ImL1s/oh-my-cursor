import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { digestDirectory } from '../../src/setup/digest.js';
import { installOrUpdate, readCurrentInstall, uninstall } from '../../src/setup/lifecycle.js';
import { createInstallReceipt, writeInstallReceipt } from '../../src/setup/receipt.js';
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

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
    name: '@test/omcu', version, files: ['dist', '.cursor-plugin', '.cursor/rules'],
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

describe('receipt-backed lifecycle', () => {
  it('refuses install into an existing over-wide state root without chmodding or mutating it', async () => {
    const root = temporary('omcu-lifecycle-wide-state-install-');
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    fs.mkdirSync(home);
    fs.mkdirSync(state, { mode: 0o755 });
    fs.chmodSync(state, 0o755);
    fs.writeFileSync(path.join(state, 'external.json'), '{"owner":"external"}\n');

    await expect(installOrUpdate({
      sourceRoot: packageFixture(root, '0.9.0', 'wide-state-install'),
      homeDir: home,
      stateRoot: state,
      transactionId: 'wide-state-install',
      runner: healthyCursor,
    })).rejects.toThrow('E_STATE_ROOT_MODE_UNSAFE');

    expect(fs.statSync(state).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(state)).toEqual(['external.json']);
    expect(fs.existsSync(path.join(home, '.omcu'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.local', 'bin', 'omcu'))).toBe(false);
  });

  it('refuses uninstall from an over-wide state root before removing installed artifacts', async () => {
    const root = temporary('omcu-lifecycle-wide-state-uninstall-');
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    fs.mkdirSync(home);
    const installed = await installOrUpdate({
      sourceRoot: packageFixture(root, '0.9.1', 'wide-state-uninstall'),
      homeDir: home,
      stateRoot: state,
      transactionId: 'wide-state-uninstall',
      runner: healthyCursor,
    });
    const cli = installed.receipt.installed.cli;
    const stage = installed.receipt.installed.stage;
    fs.chmodSync(state, 0o755);

    expect(() => uninstall({
      receiptPath: installed.receiptPath,
      homeDir: home,
      stateRoot: state,
    })).toThrow('E_STATE_ROOT_MODE_UNSAFE');

    expect(fs.statSync(state).mode & 0o777).toBe(0o755);
    expect(fs.lstatSync(cli).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(stage)).toBe(true);
    expect(fs.existsSync(path.join(state, 'install', 'current.json'))).toBe(true);
  });

  it('does not initialize project state when the caller explicitly disables it', async () => {
    const root = temporary('omcu-lifecycle-no-project-state-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    const result = await installOrUpdate({
      sourceRoot: packageFixture(root, '1.0.0', 'no-project-state'),
      homeDir: home,
      stateRoot: path.join(root, 'state'),
      projectRoot: project,
      transactionId: 'no-project-state',
      runner: healthyCursor,
      initializeProjectState: false,
    });
    expect(fs.existsSync(path.join(project, '.omcu'))).toBe(false);
    expect(result.receipt.owned_inventory.some((entry) => entry.kind === 'project_state')).toBe(false);
  });

  it('preserves project state concurrently created by doctor when initialization is disabled', async () => {
    const root = temporary('omcu-lifecycle-concurrent-project-state-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const state = path.join(root, 'state');
    const projectState = path.join(project, '.omcu');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    let inspectedJournal = false;
    const concurrentFailingDoctor: CommandRunner = {
      async run() {
        if (!fs.existsSync(projectState)) {
          const journal = JSON.parse(fs.readFileSync(path.join(state, 'install', 'transaction.json'), 'utf8')) as {
            project_state: unknown;
            project_state_ownership_marker: unknown;
          };
          expect(journal.project_state).toBeNull();
          expect(journal.project_state_ownership_marker).toBeNull();
          inspectedJournal = true;
          fs.mkdirSync(projectState, { mode: 0o700 });
          fs.writeFileSync(path.join(projectState, 'external.json'), '{"owner":"external"}\n');
        }
        return { code: 1, stdout: '', stderr: 'doctor failed' };
      },
    };

    await expect(installOrUpdate({
      sourceRoot: packageFixture(root, '1.0.1', 'concurrent-project-state'),
      homeDir: home, stateRoot: state, projectRoot: project,
      transactionId: 'concurrent-project-state', runner: concurrentFailingDoctor,
      initializeProjectState: false,
    })).rejects.toThrow('E_POST_INSTALL_DOCTOR_FAILED');
    expect(inspectedJournal).toBe(true);
    expect(fs.readFileSync(path.join(projectState, 'external.json'), 'utf8')).toContain('external');
  });

  it('preserves concurrent external project-state data during an opted-in rollback', async () => {
    const root = temporary('omcu-lifecycle-concurrent-opted-in-state-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const state = path.join(root, 'state');
    const projectState = path.join(project, '.omcu');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    const concurrentFailingDoctor: CommandRunner = {
      async run() {
        fs.writeFileSync(path.join(projectState, 'external.json'), '{"owner":"external"}\n');
        return { code: 1, stdout: '', stderr: 'doctor failed' };
      },
    };
    await expect(installOrUpdate({
      sourceRoot: packageFixture(root, '1.0.2', 'concurrent-opted-in-state'),
      homeDir: home, stateRoot: state, projectRoot: project,
      transactionId: 'concurrent-opted-in-state', runner: concurrentFailingDoctor,
      initializeProjectState: true,
    })).rejects.toThrow('E_POST_INSTALL_DOCTOR_FAILED');
    expect(fs.readFileSync(path.join(projectState, 'external.json'), 'utf8')).toContain('external');
    expect(fs.readdirSync(projectState)).toEqual(['external.json']);
  });

  it('validates and adopts pre-existing owner-only project state without claiming ownership', async () => {
    const root = temporary('omcu-lifecycle-adopt-project-state-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const projectState = path.join(project, '.omcu');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    fs.mkdirSync(projectState, { mode: 0o700 });
    fs.writeFileSync(path.join(projectState, 'owner.json'), `${JSON.stringify({
      schema_version: 1,
      owner_token: 'a'.repeat(64),
      created_at: '2026-07-23T00:00:00.000Z',
    })}\n`, { mode: 0o600 });
    const result = await installOrUpdate({
      sourceRoot: packageFixture(root, '1.0.3', 'adopt-project-state'),
      homeDir: home, stateRoot: path.join(root, 'state'), projectRoot: project,
      transactionId: 'adopt-project-state', runner: healthyCursor,
      initializeProjectState: true,
    });
    expect(result.receipt.owned_inventory.some((entry) => entry.kind === 'project_state')).toBe(false);
    expect(fs.existsSync(path.join(projectState, 'owner.json'))).toBe(true);
  });

  it.each(['symlink', 'file', 'wide-mode', 'corrupt-owner'] as const)(
    'fails closed when opted-in pre-existing project state is unsafe: %s',
    async (kind) => {
      const root = temporary(`omcu-lifecycle-unsafe-project-${kind}-`);
      const home = path.join(root, 'home');
      const project = path.join(root, 'project');
      const projectState = path.join(project, '.omcu');
      fs.mkdirSync(home);
      fs.mkdirSync(project);
      if (kind === 'symlink') {
        const foreign = path.join(root, 'foreign');
        fs.mkdirSync(foreign);
        fs.symlinkSync(foreign, projectState);
      } else if (kind === 'file') {
        fs.writeFileSync(projectState, 'not a directory');
      } else {
        fs.mkdirSync(projectState, { mode: kind === 'wide-mode' ? 0o755 : 0o700 });
        if (kind === 'wide-mode') fs.chmodSync(projectState, 0o755);
        if (kind === 'corrupt-owner') fs.writeFileSync(path.join(projectState, 'owner.json'), '{bad', { mode: 0o600 });
      }
      await expect(installOrUpdate({
        sourceRoot: packageFixture(root, '1.0.4', kind),
        homeDir: home, stateRoot: path.join(root, 'state'), projectRoot: project,
        transactionId: `unsafe-${kind}`, runner: healthyCursor,
        initializeProjectState: true,
      })).rejects.toThrow(/E_(STATE_ROOT|OWNER_)/);
      expect(fs.existsSync(path.join(root, 'state', 'install', 'current.json'))).toBe(false);
    },
  );

  it('stages immutable bytes, switches the CLI, creates project state, and reads back ownership', async () => {
    const root = temporary('omcu-lifecycle-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const source = packageFixture(root, '1.0.0', 'v1');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    const result = await installOrUpdate({
      sourceRoot: source, homeDir: home, stateRoot: path.join(root, 'state'),
      projectRoot: project, transactionId: 'install-v1', runner: healthyCursor,
      now: () => new Date('2026-07-23T00:00:00.000Z'),
      initializeProjectState: true,
    });
    expect(fs.lstatSync(path.join(home, '.local', 'bin', 'omcu')).isSymbolicLink()).toBe(true);
    expect(fs.statSync(result.receipt.installed.stage).mode & 0o777).toBe(0o500);
    expect(fs.statSync(result.receiptPath).mode & 0o777).toBe(0o400);
    expect(fs.statSync(path.join(project, '.omcu')).mode & 0o777).toBe(0o700);
    expect(readCurrentInstall(path.join(root, 'state')).receipt_sha256).toBe(result.receipt.receipt_sha256);
  });

  it('rolls the CLI pointer back when post-switch doctor fails', async () => {
    const root = temporary('omcu-rollback-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    const first = await installOrUpdate({
      sourceRoot: packageFixture(root, '1.0.0', 'v1'), homeDir: home,
      stateRoot: path.join(root, 'state'), projectRoot: project,
      transactionId: 'v1', runner: healthyCursor,
    });
    const cli = path.join(home, '.local', 'bin', 'omcu');
    const prior = fs.readlinkSync(cli);
    const failing: CommandRunner = { async run() { return { code: 1, stdout: '', stderr: 'no' }; } };
    await expect(installOrUpdate({
      sourceRoot: packageFixture(root, '2.0.0', 'v2'), action: 'update', homeDir: home,
      stateRoot: path.join(root, 'state'), projectRoot: project,
      transactionId: 'v2', runner: failing,
    })).rejects.toThrow('E_POST_INSTALL_DOCTOR_FAILED');
    expect(fs.readlinkSync(cli)).toBe(prior);
    expect(readCurrentInstall(path.join(root, 'state')).receipt_sha256).toBe(first.receipt.receipt_sha256);
  });

  it('uninstalls only paths whose receipt identity still matches', async () => {
    const root = temporary('omcu-uninstall-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    const installed = await installOrUpdate({
      sourceRoot: packageFixture(root, '1.0.0', 'v1'), homeDir: home,
      stateRoot: path.join(root, 'state'), projectRoot: project,
      transactionId: 'remove', runner: healthyCursor,
    });
    const cli = path.join(home, '.local', 'bin', 'omcu');
    fs.unlinkSync(cli);
    fs.symlinkSync('/foreign/omcu', cli);
    const result = uninstall({
      receiptPath: installed.receiptPath, homeDir: home, stateRoot: path.join(root, 'state'),
    });
    expect(result.status).toBe('completed_with_collisions');
    expect(result.preserved).toContain(cli);
    expect(fs.readlinkSync(cli)).toBe('/foreign/omcu');
    expect(fs.existsSync(installed.receipt.installed.stage)).toBe(true);
  });

  it('stages only package files from a built checkout and ignores development symlinks', async () => {
    const root = temporary('omcu-source-checkout-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const source = packageFixture(root, '3.0.0', 'checkout');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    fs.mkdirSync(path.join(source, '.git'));
    fs.writeFileSync(path.join(source, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(path.join(source, 'node_modules'));
    fs.symlinkSync(root, path.join(source, 'node_modules', 'linked-dependency'));
    fs.mkdirSync(path.join(source, 'tests'));
    fs.writeFileSync(path.join(source, 'tests', 'not-runtime.test.ts'), 'throw new Error("not packed")');

    const installed = await installOrUpdate({
      sourceRoot: source, homeDir: home, stateRoot: path.join(root, 'state'),
      projectRoot: project, transactionId: 'source-checkout', runner: healthyCursor,
    });
    expect(fs.existsSync(path.join(installed.receipt.installed.stage, 'dist', 'bin', 'omcu.js'))).toBe(true);
    expect(fs.existsSync(path.join(installed.receipt.installed.stage, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(installed.receipt.installed.stage, '.git'))).toBe(false);
    expect(fs.existsSync(path.join(installed.receipt.installed.stage, 'tests'))).toBe(false);
    expect(readCurrentInstall(path.join(root, 'state')).installed.sha256).toBe(installed.receipt.installed.sha256);
  });

  it('serializes competing candidates so a timed-out loser cannot split CLI and current receipt', async () => {
    const root = temporary('omcu-concurrent-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const state = path.join(root, 'state');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    let blocked = false;
    const holdingCursor: CommandRunner = {
      async run(_command, args) {
        if (!blocked) {
          blocked = true;
          enteredResolve();
          await release;
        }
        if (args[0] === '--version') return { code: 0, stdout: '2026.07.20-test\n', stderr: '' };
        if (args[0] === 'status') return { code: 0, stdout: 'authenticated\n', stderr: '' };
        return { code: 0, stdout: '--version --help status --plugin-dir\n', stderr: '' };
      },
    };
    const winnerPromise = installOrUpdate({
      sourceRoot: packageFixture(root, '4.0.0', 'winner'), homeDir: home, stateRoot: state,
      projectRoot: project, transactionId: 'winner', runner: holdingCursor,
    });
    await entered;
    const losingState = path.join(root, 'state-loser');
    await expect(installOrUpdate({
      sourceRoot: packageFixture(root, '5.0.0', 'loser'), homeDir: home, stateRoot: losingState,
      projectRoot: project, transactionId: 'loser', runner: healthyCursor,
      lock: { timeoutMs: 30, pollMs: 5 },
    })).rejects.toThrow('E_INSTALL_LOCK_TIMEOUT');
    releaseResolve();
    const winner = await winnerPromise;
    const current = readCurrentInstall(state);
    expect(current.receipt_sha256).toBe(winner.receipt.receipt_sha256);
    expect(current.version).toBe('4.0.0');
    expect(fs.readlinkSync(path.join(home, '.local', 'bin', 'omcu'))).toBe(path.join(
      winner.receipt.installed.stage, 'dist', 'bin', 'omcu.js',
    ));
    expect(fs.readdirSync(path.join(state, 'install', 'receipts'))).toEqual(['winner.json']);
    expect(fs.existsSync(path.join(losingState, 'install', 'current.json'))).toBe(false);
    expect(fs.existsSync(path.join(state, 'install', 'transaction.lock'))).toBe(false);
  });

  it('preserves a modified stage containing a symlink as an uninstall collision', async () => {
    const root = temporary('omcu-uninstall-stage-collision-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const state = path.join(root, 'state');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    const installed = await installOrUpdate({
      sourceRoot: packageFixture(root, '6.0.0', 'tampered'), homeDir: home, stateRoot: state,
      projectRoot: project, transactionId: 'tampered', runner: healthyCursor,
    });
    const entrypoint = path.join(installed.receipt.installed.stage, 'dist', 'bin', 'omcu.js');
    fs.chmodSync(path.dirname(entrypoint), 0o700);
    fs.unlinkSync(entrypoint);
    fs.symlinkSync('/foreign/omcu', entrypoint);
    const result = uninstall({ receiptPath: installed.receiptPath, homeDir: home, stateRoot: state });
    expect(result.status).toBe('completed_with_collisions');
    expect(result.preserved).toContain(installed.receipt.installed.stage);
    expect(fs.existsSync(installed.receipt.installed.stage)).toBe(true);
  });

  it('preflights a replaced project-state symlink and performs no partial purge', async () => {
    const root = temporary('omcu-uninstall-project-collision-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const state = path.join(root, 'state');
    const foreign = path.join(root, 'foreign-empty');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    fs.mkdirSync(foreign);
    const installed = await installOrUpdate({
      sourceRoot: packageFixture(root, '7.0.0', 'project-collision'), homeDir: home, stateRoot: state,
      projectRoot: project, transactionId: 'project-collision', runner: healthyCursor,
      initializeProjectState: true,
    });
    fs.rmdirSync(path.join(project, '.omcu'));
    fs.symlinkSync(foreign, path.join(project, '.omcu'));
    const result = uninstall({
      receiptPath: installed.receiptPath, homeDir: home, stateRoot: state, purgeProjectState: true,
    });
    expect(result.status).toBe('completed_with_collisions');
    expect(result.removed).toEqual([]);
    expect(result.preserved).toEqual(expect.arrayContaining([
      installed.receipt.installed.stage,
      path.join(home, '.local', 'bin', 'omcu'),
      path.join(project, '.omcu'),
      path.join(state, 'install', 'current.json'),
    ]));
    expect(fs.existsSync(installed.receipt.installed.stage)).toBe(true);
    expect(fs.lstatSync(path.join(home, '.local', 'bin', 'omcu')).isSymbolicLink()).toBe(true);
  });

  it('preserves valid non-empty project state while uninstalling package-owned paths', async () => {
    const root = temporary('omcu-uninstall-nonempty-project-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const state = path.join(root, 'state');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    const installed = await installOrUpdate({
      sourceRoot: packageFixture(root, '8.0.0', 'project-data'), homeDir: home, stateRoot: state,
      projectRoot: project, transactionId: 'project-data', runner: healthyCursor,
      initializeProjectState: true,
    });
    const projectState = path.join(project, '.omcu');
    fs.writeFileSync(path.join(projectState, 'user-state.json'), '{"keep":true}\n');
    const result = uninstall({
      receiptPath: installed.receiptPath, homeDir: home, stateRoot: state, purgeProjectState: true,
    });
    expect(result.status).toBe('uninstalled');
    expect(result.preserved).toContain(projectState);
    expect(fs.existsSync(path.join(projectState, 'user-state.json'))).toBe(true);
    expect(fs.existsSync(installed.receipt.installed.stage)).toBe(false);
    expect(fs.existsSync(path.join(home, '.local', 'bin', 'omcu'))).toBe(false);
    expect(fs.existsSync(path.join(state, 'install', 'current.json'))).toBe(false);
  });

  it.each(['install', 'update'] as const)('reconciles a SIGKILL during post-switch doctor for %s', async (action) => {
    const root = temporary(`omcu-crash-${action}-`);
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const state = path.join(root, 'custom-state');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    if (action === 'update') {
      await installOrUpdate({
        sourceRoot: packageFixture(root, '9.0.0', 'baseline'), homeDir: home, stateRoot: state,
        projectRoot: project, transactionId: 'baseline', runner: healthyCursor,
      });
    }
    const interruptedSource = packageFixture(root, '10.0.0', 'interrupted');
    const marker = path.join(root, 'doctor-entered');
    const child = spawn(path.join(process.cwd(), 'node_modules', '.bin', 'vite-node'), [
      path.join(process.cwd(), 'tests', 'fixtures', 'setup-crash-child.ts'),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OMCU_CRASH_INPUT: JSON.stringify({
          sourceRoot: interruptedSource, homeDir: home, stateRoot: state, projectRoot: project,
          transactionId: `interrupted-${action}`, action, marker, initializeProjectState: true,
        }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childStderr = '';
    child.stderr.on('data', (chunk: Buffer) => { childStderr += chunk.toString(); });
    await waitForFile(marker);
    const cli = path.join(home, '.local', 'bin', 'omcu');
    expect(fs.readlinkSync(cli)).toContain('10.0.0-');
    const journal = JSON.parse(fs.readFileSync(
      path.join(state, 'install', 'transaction.json'),
      'utf8',
    )) as { project_state_ownership_marker: string; receipt_sha256: string };
    expect(fs.readFileSync(journal.project_state_ownership_marker, 'utf8'))
      .toBe(`${journal.receipt_sha256}\n`);
    expect(fs.lstatSync(journal.project_state_ownership_marker).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.join(project, '.omcu')).some((name) => name.includes('.tmp-'))).toBe(false);
    child.kill('SIGKILL');
    await new Promise<void>((resolve, reject) => {
      child.once('close', () => resolve());
      child.once('error', reject);
    });
    expect(childStderr).toBe('');
    expect(fs.existsSync(path.join(state, 'install', 'transaction.json'))).toBe(true);

    const recovered = await installOrUpdate({
      sourceRoot: packageFixture(root, '11.0.0', 'recovered'), action: 'update',
      homeDir: home, stateRoot: state, projectRoot: project, transactionId: `recovered-${action}`,
      runner: healthyCursor, initializeProjectState: true,
    });
    expect(fs.existsSync(path.join(state, 'install', 'transaction.json'))).toBe(false);
    expect(fs.readlinkSync(cli)).toBe(path.join(recovered.receipt.installed.stage, 'dist', 'bin', 'omcu.js'));
    expect(readCurrentInstall(state).receipt_sha256).toBe(recovered.receipt.receipt_sha256);
    expect(fs.readdirSync(path.join(state, 'install', 'releases')).some((name) => name.startsWith('10.0.0-'))).toBe(false);
  }, 30_000);

  it('clears a committed transaction ownership marker during reconcile', async () => {
    const root = temporary('omcu-committed-owner-marker-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const state = path.join(root, 'state');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    const installed = await installOrUpdate({
      sourceRoot: packageFixture(root, '10.1.0', 'committed-owner-marker'),
      homeDir: home, stateRoot: state, projectRoot: project,
      transactionId: 'committed-owner-marker', runner: healthyCursor,
      initializeProjectState: true,
    });
    const projectState = path.join(project, '.omcu');
    const ownershipMarker = path.join(
      projectState,
      `.install-owner-${crypto.createHash('sha256').update(installed.receipt.transaction_id).digest('hex')}`,
    );
    const cli = path.join(home, '.local', 'bin', 'omcu');
    fs.writeFileSync(ownershipMarker, `${installed.receipt.receipt_sha256}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(state, 'install', 'transaction.json'), `${JSON.stringify({
      store_kind: 'omcu_install_transaction',
      schema_version: 1,
      cli,
      candidate_target: path.join(installed.receipt.installed.stage, 'dist', 'bin', 'omcu.js'),
      prior_cli_target: null,
      current_pointer: path.join(state, 'install', 'current.json'),
      prior_pointer_base64: null,
      receipt_path: installed.receiptPath,
      receipt_sha256: installed.receipt.receipt_sha256,
      stage: installed.receipt.installed.stage,
      stage_existed: false,
      temporary_stage: `${installed.receipt.installed.stage}.tmp-interrupted`,
      project_state: projectState,
      project_state_ownership_marker: ownershipMarker,
    })}\n`, { mode: 0o600 });

    await installOrUpdate({
      sourceRoot: packageFixture(root, '10.2.0', 'after-committed-owner-marker'),
      action: 'update', homeDir: home, stateRoot: state, projectRoot: project,
      transactionId: 'after-committed-owner-marker', runner: healthyCursor,
      initializeProjectState: false,
    });

    expect(fs.existsSync(ownershipMarker)).toBe(false);
    expect(fs.existsSync(path.join(state, 'install', 'transaction.json'))).toBe(false);
  });

  it('does not unlink a foreign same-user file named by a crafted committed journal', async () => {
    const root = temporary('omcu-crafted-owner-marker-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const state = path.join(root, 'state');
    const foreign = path.join(root, 'foreign');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    fs.mkdirSync(foreign);
    const installed = await installOrUpdate({
      sourceRoot: packageFixture(root, '10.3.0', 'crafted-owner-marker'),
      homeDir: home, stateRoot: state, projectRoot: project,
      transactionId: 'crafted-owner-marker', runner: healthyCursor,
      initializeProjectState: true,
    });
    const victim = path.join(
      foreign,
      `.install-owner-${crypto.createHash('sha256').update(installed.receipt.transaction_id).digest('hex')}`,
    );
    const cli = path.join(home, '.local', 'bin', 'omcu');
    fs.writeFileSync(victim, `${installed.receipt.receipt_sha256}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(state, 'install', 'transaction.json'), `${JSON.stringify({
      store_kind: 'omcu_install_transaction',
      schema_version: 1,
      cli,
      candidate_target: path.join(installed.receipt.installed.stage, 'dist', 'bin', 'omcu.js'),
      prior_cli_target: null,
      current_pointer: path.join(state, 'install', 'current.json'),
      prior_pointer_base64: null,
      receipt_path: installed.receiptPath,
      receipt_sha256: installed.receipt.receipt_sha256,
      stage: installed.receipt.installed.stage,
      stage_existed: false,
      temporary_stage: `${installed.receipt.installed.stage}.tmp-crafted`,
      project_state: foreign,
      project_state_ownership_marker: victim,
    })}\n`, { mode: 0o600 });

    await installOrUpdate({
      sourceRoot: packageFixture(root, '10.4.0', 'after-crafted-owner-marker'),
      action: 'update', homeDir: home, stateRoot: state, projectRoot: project,
      transactionId: 'after-crafted-owner-marker', runner: healthyCursor,
      initializeProjectState: false,
    });

    expect(fs.readFileSync(victim, 'utf8')).toBe(`${installed.receipt.receipt_sha256}\n`);
    expect(fs.existsSync(path.join(state, 'install', 'transaction.json'))).toBe(false);
  });

  it('finishes a journaled partial uninstall before the next install', async () => {
    const root = temporary('omcu-uninstall-reconcile-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const state = path.join(root, 'custom-state');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    const prior = await installOrUpdate({
      sourceRoot: packageFixture(root, '12.0.0', 'prior'), homeDir: home, stateRoot: state,
      projectRoot: project, transactionId: 'prior-uninstall', runner: healthyCursor,
    });
    fs.writeFileSync(path.join(state, 'install', 'transaction.json'), `${JSON.stringify({
      store_kind: 'omcu_uninstall_transaction',
      schema_version: 1,
      receipt_path: prior.receiptPath,
      receipt_sha256: prior.receipt.receipt_sha256,
      purge_project_state: false,
    })}\n`, { mode: 0o600 });
    fs.unlinkSync(path.join(home, '.local', 'bin', 'omcu'));

    const next = await installOrUpdate({
      sourceRoot: packageFixture(root, '13.0.0', 'next'), homeDir: home, stateRoot: state,
      projectRoot: project, transactionId: 'after-uninstall', runner: healthyCursor,
    });
    expect(fs.existsSync(prior.receipt.installed.stage)).toBe(false);
    expect(fs.existsSync(path.join(state, 'install', 'transaction.json'))).toBe(false);
    expect(readCurrentInstall(state).receipt_sha256).toBe(next.receipt.receipt_sha256);
  });

  it('rejects a crafted receipt whose owned release_stage escapes the state root before any removal', async () => {
    const root = temporary('omcu-uninstall-escape-stage-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const state = path.join(root, 'state');
    const foreignRoot = path.join(root, 'foreign-sibling');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    fs.mkdirSync(foreignRoot);
    const installed = await installOrUpdate({
      sourceRoot: packageFixture(root, '14.0.0', 'escape-stage'), homeDir: home, stateRoot: state,
      projectRoot: project, transactionId: 'escape-stage', runner: healthyCursor,
    });
    const foreignStage = path.join(foreignRoot, 'evil-stage');
    makeWritable(installed.receipt.installed.stage);
    fs.cpSync(installed.receipt.installed.stage, foreignStage, { recursive: true });
    const foreignDigest = digestDirectory(foreignStage);
    expect(foreignDigest).toBe(installed.receipt.installed.sha256);

    const cli = path.join(home, '.local', 'bin', 'omcu');
    const entrypoint = path.join(installed.receipt.installed.stage, 'dist', 'bin', 'omcu.js');
    const crafted = createInstallReceipt({
      store_kind: 'omcu_install_receipt',
      schema_version: 1,
      transaction_id: 'crafted-escape-stage',
      action: 'install',
      version: installed.receipt.version,
      source: installed.receipt.source,
      installed: installed.receipt.installed,
      previous_cli_target: null,
      owned_inventory: [
        { path: foreignStage, kind: 'release_stage', identity: foreignDigest },
        { path: cli, kind: 'cli_symlink', identity: entrypoint },
        { path: path.join(project, '.omcu'), kind: 'project_state', identity: path.resolve(project) },
      ],
      created_at: '2026-07-23T00:00:00.000Z',
    });
    const craftedPath = path.join(state, 'install', 'receipts', 'crafted-escape-stage.json');
    writeInstallReceipt(craftedPath, crafted);
    fs.writeFileSync(path.join(state, 'install', 'current.json'), `${JSON.stringify({
      schema_version: 1,
      receipt_path: craftedPath,
      receipt_sha256: crafted.receipt_sha256,
    })}\n`);

    expect(() => uninstall({ receiptPath: craftedPath, homeDir: home, stateRoot: state }))
      .toThrow('E_OWNED_INVENTORY_CONFINEMENT');
    expect(fs.existsSync(foreignStage)).toBe(true);
    expect(fs.existsSync(installed.receipt.installed.stage)).toBe(true);
    expect(fs.lstatSync(cli).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(state, 'install', 'current.json'))).toBe(true);
  });

  it('rejects a crafted receipt whose owned cli_symlink is not the product CLI pointer before any removal', async () => {
    const root = temporary('omcu-uninstall-escape-cli-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const state = path.join(root, 'state');
    const foreignRoot = path.join(root, 'foreign-sibling');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    fs.mkdirSync(foreignRoot);
    const installed = await installOrUpdate({
      sourceRoot: packageFixture(root, '15.0.0', 'escape-cli'), homeDir: home, stateRoot: state,
      projectRoot: project, transactionId: 'escape-cli', runner: healthyCursor,
    });
    const entrypoint = path.join(installed.receipt.installed.stage, 'dist', 'bin', 'omcu.js');
    const foreignCli = path.join(foreignRoot, 'omcu');
    fs.symlinkSync(entrypoint, foreignCli);
    const cli = path.join(home, '.local', 'bin', 'omcu');

    const crafted = createInstallReceipt({
      store_kind: 'omcu_install_receipt',
      schema_version: 1,
      transaction_id: 'crafted-escape-cli',
      action: 'install',
      version: installed.receipt.version,
      source: installed.receipt.source,
      installed: installed.receipt.installed,
      previous_cli_target: null,
      owned_inventory: [
        { path: installed.receipt.installed.stage, kind: 'release_stage', identity: installed.receipt.installed.sha256 },
        { path: foreignCli, kind: 'cli_symlink', identity: entrypoint },
        { path: path.join(project, '.omcu'), kind: 'project_state', identity: path.resolve(project) },
      ],
      created_at: '2026-07-23T00:00:00.000Z',
    });
    const craftedPath = path.join(state, 'install', 'receipts', 'crafted-escape-cli.json');
    writeInstallReceipt(craftedPath, crafted);
    fs.writeFileSync(path.join(state, 'install', 'current.json'), `${JSON.stringify({
      schema_version: 1,
      receipt_path: craftedPath,
      receipt_sha256: crafted.receipt_sha256,
    })}\n`);

    expect(() => uninstall({ receiptPath: craftedPath, homeDir: home, stateRoot: state }))
      .toThrow('E_OWNED_INVENTORY_CONFINEMENT');
    expect(fs.existsSync(foreignCli)).toBe(true);
    expect(fs.readlinkSync(foreignCli)).toBe(entrypoint);
    expect(fs.existsSync(installed.receipt.installed.stage)).toBe(true);
    expect(fs.lstatSync(cli).isSymbolicLink()).toBe(true);
  });

  it('refuses reconcile when prior_cli_target escapes release stages and leaves the CLI symlink untouched', async () => {
    const root = temporary('omcu-reconcile-prior-cli-');
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const state = path.join(root, 'state');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    const installed = await installOrUpdate({
      sourceRoot: packageFixture(root, '16.0.0', 'prior-cli'), homeDir: home, stateRoot: state,
      projectRoot: project, transactionId: 'prior-cli-ok', runner: healthyCursor,
    });
    const cli = path.join(home, '.local', 'bin', 'omcu');
    const originalTarget = fs.readlinkSync(cli);
    const foreignTarget = path.join(root, 'foreign-sibling', 'evil-omcu.js');
    fs.mkdirSync(path.dirname(foreignTarget), { recursive: true });
    fs.writeFileSync(foreignTarget, 'evil\n');
    const releases = path.join(state, 'install', 'releases');
    fs.writeFileSync(path.join(state, 'install', 'transaction.json'), `${JSON.stringify({
      store_kind: 'omcu_install_transaction',
      schema_version: 1,
      cli,
      candidate_target: path.join(releases, 'poison-ver', 'dist', 'bin', 'omcu.js'),
      prior_cli_target: foreignTarget,
      current_pointer: path.join(state, 'install', 'current.json'),
      prior_pointer_base64: null,
      receipt_path: path.join(state, 'install', 'receipts', 'poison.json'),
      receipt_sha256: 'a'.repeat(64),
      stage: path.join(releases, 'poison-ver'),
      stage_existed: false,
      temporary_stage: path.join(releases, 'poison-ver.tmp'),
      project_state: path.join(project, '.omcu'),
      project_state_existed: true,
    })}\n`, { mode: 0o600 });

    await expect(installOrUpdate({
      sourceRoot: packageFixture(root, '17.0.0', 'after-poison'), homeDir: home, stateRoot: state,
      projectRoot: project, transactionId: 'after-poison', runner: healthyCursor,
    })).rejects.toThrow('E_INSTALL_TRANSACTION_PRIOR_CLI_INVALID');
    expect(fs.readlinkSync(cli)).toBe(originalTarget);
    expect(fs.existsSync(path.join(state, 'install', 'transaction.json'))).toBe(true);
    expect(readCurrentInstall(state).receipt_sha256).toBe(installed.receipt.receipt_sha256);
  });
});
