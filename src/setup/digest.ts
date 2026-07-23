import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function sha256File(file: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('E_RELEASE_ASSET_INVALID');
  return sha256(fs.readFileSync(file));
}

export function verifySha256Sums(asset: string, manifest: string): string {
  const assetName = path.basename(asset);
  const rows = fs.readFileSync(manifest, 'utf8').split(/\r?\n/).filter(Boolean);
  const matches = rows.flatMap((row) => {
    const match = row.match(/^([a-fA-F0-9]{64}) [ *](.+)$/);
    return match !== null && match[2] === assetName ? [match[1]!.toLowerCase()] : [];
  });
  if (matches.length !== 1) throw new Error('E_SHA256SUMS_ASSET_CARDINALITY');
  const observed = sha256File(asset);
  if (observed !== matches[0]) throw new Error('E_RELEASE_CHECKSUM_MISMATCH');
  return observed;
}

function walk(root: string, relative: string, rows: string[]): void {
  const directory = path.join(root, relative);
  for (const name of fs.readdirSync(directory).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const childRelative = path.join(relative, name);
    const child = path.join(root, childRelative);
    const stat = fs.lstatSync(child);
    if (stat.isSymbolicLink()) throw new Error('E_SOURCE_SYMLINK_UNSUPPORTED');
    if (stat.isDirectory()) walk(root, childRelative, rows);
    else if (stat.isFile()) rows.push(`${childRelative.split(path.sep).join('/')}\0${sha256File(child)}`);
  }
}

export function digestDirectory(root: string): string {
  const resolved = path.resolve(root);
  if (!fs.statSync(resolved).isDirectory()) throw new Error('E_SOURCE_NOT_DIRECTORY');
  const rows: string[] = [];
  walk(resolved, '', rows);
  rows.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return sha256(rows.join('\n'));
}

function confinedRelative(value: string): string {
  if (value.includes('\0') || path.isAbsolute(value) || /[*?[\]{}]/.test(value)) {
    throw new Error('E_PACKAGE_FILE_PATH_INVALID');
  }
  const normalized = path.normalize(value.replace(/^\.\//, ''));
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error('E_PACKAGE_FILE_PATH_INVALID');
  }
  return normalized;
}

function collectFiles(root: string, relative: string, output: Set<string>): void {
  const target = path.join(root, relative);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error('E_PACKABLE_SYMLINK_UNSUPPORTED');
  if (stat.isFile()) {
    output.add(relative);
    return;
  }
  if (!stat.isDirectory()) throw new Error('E_PACKAGE_FILE_TYPE_INVALID');
  for (const name of fs.readdirSync(target).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    collectFiles(root, path.join(relative, name), output);
  }
}

function manifestPaths(root: string): string[] {
  const manifestFile = path.join(root, '.cursor-plugin', 'plugin.json');
  const parsed = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
  const paths: string[] = [];
  for (const field of ['commands', 'agents', 'skills', 'rules', 'hooks', 'mcpServers']) {
    const value = parsed[field];
    const values = typeof value === 'string'
      ? [value]
      : Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value as string[] : [];
    paths.push(...values.map(confinedRelative));
  }
  return paths;
}

/**
 * Returns the deterministic install payload described by package.json#files.
 * Development-only trees such as node_modules and .git are never traversed.
 */
export function listPackableFiles(root: string): string[] {
  const resolved = path.resolve(root);
  const packageFile = path.join(resolved, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { files?: unknown };
  if (!Array.isArray(pkg.files) || !pkg.files.every((entry) => typeof entry === 'string')) {
    throw new Error('E_PACKAGE_FILES_INVALID');
  }
  const output = new Set<string>(['package.json']);
  for (const declared of pkg.files) {
    const relative = confinedRelative(declared);
    const target = path.join(resolved, relative);
    if (!fs.existsSync(target)) throw new Error(`E_PACKABLE_ASSET_MISSING: ${declared}`);
    collectFiles(resolved, relative, output);
  }
  const files = [...output].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const required = ['dist/bin/omcu.js', '.cursor-plugin/plugin.json', ...manifestPaths(resolved)];
  for (const relative of required) {
    const exact = files.includes(relative);
    const directoryPrefix = `${relative.replace(/[\\/]$/, '')}${path.sep}`;
    if (!exact && !files.some((file) => file.startsWith(directoryPrefix))) {
      throw new Error(`E_RUNTIME_ASSET_NOT_PACKED: ${relative}`);
    }
  }
  return files;
}

export function digestPackableDirectory(root: string): string {
  const resolved = path.resolve(root);
  const rows = listPackableFiles(resolved).map((relative) => (
    `${relative.split(path.sep).join('/')}\0${sha256File(path.join(resolved, relative))}`
  ));
  return sha256(rows.join('\n'));
}

export function copyPackableDirectory(sourceRoot: string, destinationRoot: string): void {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const relative of listPackableFiles(source)) {
    const sourceFile = path.join(source, relative);
    const targetFile = path.join(destination, relative);
    const realSource = fs.realpathSync(sourceFile);
    const realRoot = fs.realpathSync(source);
    if (realSource !== realRoot && !realSource.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error('E_PACKABLE_PATH_ESCAPE');
    }
    fs.mkdirSync(path.dirname(targetFile), { recursive: true, mode: 0o700 });
    fs.copyFileSync(sourceFile, targetFile, fs.constants.COPYFILE_EXCL);
  }
}
