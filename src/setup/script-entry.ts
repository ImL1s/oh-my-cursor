import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installOrUpdate, readCurrentInstall, uninstall } from './lifecycle.js';
import { runSetupDoctor } from './doctor.js';
import { verifySha256Sums } from './digest.js';
import { extractReleaseArchive } from './archive.js';

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function required(argv: readonly string[], name: string): string {
  const value = option(argv, name);
  if (value === undefined || value.startsWith('--')) throw new Error(`E_OPTION_REQUIRED: ${name}`);
  return value;
}

function extractArchive(archive: string, checksums: string): { root: string; cleanup: () => void } {
  return extractReleaseArchive(path.resolve(archive), path.resolve(checksums));
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (command === 'doctor') {
    const report = await runSetupDoctor({
      packageRoot: path.resolve(option(argv, '--package-root') ?? process.cwd()),
      ...(option(argv, '--project') === undefined ? {} : { projectRoot: option(argv, '--project')! }),
      ...(option(argv, '--home') === undefined ? {} : { homeDir: option(argv, '--home')! }),
      ...(option(argv, '--cursor-command') === undefined ? {} : { cursorCommand: option(argv, '--cursor-command')! }),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.exit_code;
  }
  if (command === 'uninstall') {
    const result = uninstall({
      receiptPath: required(argv, '--receipt'),
      ...(option(argv, '--home') === undefined ? {} : { homeDir: option(argv, '--home')! }),
      ...(option(argv, '--state-root') === undefined ? {} : { stateRoot: option(argv, '--state-root')! }),
      purgeProjectState: argv.includes('--purge-project-state'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.status === 'completed_with_collisions' ? 2 : 0;
  }
  if (command !== 'install' && command !== 'update') throw new Error('E_SETUP_COMMAND_INVALID');
  const archive = option(argv, '--archive');
  const checksums = option(argv, '--checksums');
  let sourceRoot = path.resolve(option(argv, '--source') ?? process.cwd());
  let cleanup = (): void => {};
  if (archive !== undefined) {
    if (checksums === undefined) throw new Error('E_SHA256SUMS_REQUIRED');
    const extracted = extractArchive(path.resolve(archive), path.resolve(checksums));
    sourceRoot = extracted.root;
    cleanup = extracted.cleanup;
  }
  try {
    const result = await installOrUpdate({
      sourceRoot,
      action: command,
      ...(archive === undefined ? {} : { sourceArchive: archive }),
      ...(checksums === undefined ? {} : { checksumsFile: checksums }),
      ...(option(argv, '--home') === undefined ? {} : { homeDir: option(argv, '--home')! }),
      ...(option(argv, '--state-root') === undefined ? {} : { stateRoot: option(argv, '--state-root')! }),
      ...(option(argv, '--project') === undefined ? {} : { projectRoot: option(argv, '--project')! }),
      ...(option(argv, '--cursor-command') === undefined ? {} : { cursorCommand: option(argv, '--cursor-command')! }),
      runDoctor: !argv.includes('--no-doctor'),
      initializeProjectState: argv.includes('--init-project-state'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    const doctor = result.doctor;
    if (doctor !== null && doctor.exit_code === 2) {
      process.stderr.write(
        'omcu install: completed with doctor warnings (CLI is ready; run `omcu doctor` for details)\n',
      );
    }
    // Exit 0 on soft doctor warnings so bootstrap (`curl | bash`) and automation
    // treat a written receipt as success. Hard doctor failures already throw
    // E_POST_INSTALL_DOCTOR_FAILED before this point.
    return doctor !== null && !doctor.ok ? 1 : 0;
  } finally {
    cleanup();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
