import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installOrUpdate, readCurrentInstall, uninstall } from './lifecycle.js';
import { runSetupDoctor } from './doctor.js';
import { verifySha256Sums } from './digest.js';

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
  verifySha256Sums(archive, checksums);
  const listed = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 30_000 });
  if (listed.status !== 0) throw new Error('E_RELEASE_ARCHIVE_LIST_FAILED');
  const entries = listed.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => path.isAbsolute(entry) || entry.split('/').includes('..'))) {
    throw new Error('E_RELEASE_ARCHIVE_UNSAFE');
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-release-'));
  const extracted = spawnSync('tar', ['-xzf', archive, '-C', temporary], { encoding: 'utf8', timeout: 60_000 });
  if (extracted.status !== 0) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw new Error('E_RELEASE_ARCHIVE_EXTRACT_FAILED');
  }
  const candidates = [temporary, ...fs.readdirSync(temporary).map((name) => path.join(temporary, name))]
    .filter((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
  if (candidates.length !== 1) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw new Error('E_RELEASE_ARCHIVE_ROOT_INVALID');
  }
  return { root: candidates[0]!, cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }) };
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
