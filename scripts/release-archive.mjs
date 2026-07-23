import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`E_OPTION_REQUIRED: ${name}`);
  return value;
}

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.resolve(packageRoot, option(process.argv.slice(2), '--output-dir') ?? 'release');
fs.mkdirSync(outputDirectory, { recursive: true });

const result = spawnSync('npm', ['pack', '--json', '--pack-destination', outputDirectory], {
  cwd: packageRoot,
  encoding: 'utf8',
});
if (result.status !== 0) throw new Error(result.stderr || 'npm pack failed');

let packed;
try {
  const report = JSON.parse(result.stdout);
  if (!Array.isArray(report) || report.length !== 1 || typeof report[0]?.filename !== 'string') throw new Error();
  packed = report[0];
} catch {
  throw new Error('E_NPM_PACK_REPORT_INVALID');
}

const archiveName = path.basename(packed.filename);
if (archiveName !== packed.filename || !archiveName.endsWith('.tgz')) throw new Error('E_RELEASE_ARCHIVE_NAME_INVALID');
const archivePath = path.join(outputDirectory, archiveName);
const digest = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
const checksumsPath = path.join(outputDirectory, 'SHA256SUMS');

// The verifier deliberately matches the exact asset basename. Never emit a
// directory-prefixed path or normalize arbitrary manifest input.
fs.writeFileSync(checksumsPath, `${digest}  ${archiveName}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ archive: archivePath, checksums: checksumsPath, sha256: digest, filename: archiveName }, null, 2)}\n`);
