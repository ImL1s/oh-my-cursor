import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractReleaseArchive,
  validateArchiveListing,
  MAX_ARCHIVE_ENTRIES,
} from '../../src/setup/archive.js';
import { sha256File } from '../../src/setup/digest.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTarGz(sourceDir: string, outputFile: string, entries: string[]): void {
  const result = spawnSync('tar', ['-czf', outputFile, '-C', sourceDir, ...entries], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`tar creation failed: ${result.stderr}`);
  }
}

describe('archive safety validation', () => {
  it('accepts a well-formed package archive with package.json', () => {
    const work = makeTempDir('omcu-archive-ok-');
    const pkg = path.join(work, 'package');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }));
    fs.writeFileSync(path.join(pkg, 'index.js'), 'console.log("hello");');
    fs.mkdirSync(path.join(pkg, 'dist'));
    fs.writeFileSync(path.join(pkg, 'dist', 'bundle.js'), 'export {};');

    const archive = path.join(work, 'release.tgz');
    createTarGz(work, archive, ['package']);

    const report = validateArchiveListing(archive);
    expect(report.packageRoot).toBe('package');
    expect(report.entryCount).toBeGreaterThanOrEqual(4);
    expect(report.totalSize).toBeGreaterThan(0);
  });

  it('allows safe symlinks confined within package root', () => {
    const work = makeTempDir('omcu-archive-symlink-ok-');
    const pkg = path.join(work, 'package');
    fs.mkdirSync(path.join(pkg, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    fs.writeFileSync(path.join(pkg, 'target.txt'), 'hello target');
    fs.symlinkSync('target.txt', path.join(pkg, 'link.txt'));
    fs.symlinkSync('../target.txt', path.join(pkg, 'sub', 'link2.txt'));

    const archive = path.join(work, 'release.tgz');
    createTarGz(work, archive, ['package']);

    const report = validateArchiveListing(archive);
    expect(report.entryCount).toBeGreaterThanOrEqual(5);
  });

  it('rejects an archive that is missing on disk', () => {
    expect(() => validateArchiveListing('/nonexistent/path/archive.tgz')).toThrow(
      'E_RELEASE_ARCHIVE_MISSING',
    );
  });

  it('rejects a corrupt or non-tar file', () => {
    const work = makeTempDir('omcu-archive-corrupt-');
    const badFile = path.join(work, 'corrupt.tgz');
    fs.writeFileSync(badFile, 'this is not a gzip or tar file');
    expect(() => validateArchiveListing(badFile)).toThrow('E_RELEASE_ARCHIVE_LIST_FAILED');
  });

  it('rejects an empty archive', () => {
    const work = makeTempDir('omcu-archive-empty-');
    const archive = path.join(work, 'empty.tgz');
    // Create an empty tarball
    const emptyDir = path.join(work, 'empty');
    fs.mkdirSync(emptyDir);
    // tar -czf with no files except empty directory that we delete
    const result = spawnSync('tar', ['-czf', archive, '-T', '/dev/null'], { encoding: 'utf8' });
    if (result.status === 0) {
      expect(() => validateArchiveListing(archive)).toThrow('E_RELEASE_ARCHIVE_UNSAFE');
    }
  });

  it('rejects entries with path traversal ..', () => {
    const work = makeTempDir('omcu-archive-traversal-');
    const pkg = path.join(work, 'package');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    fs.writeFileSync(path.join(work, 'outside.txt'), 'escape');

    const archive = path.join(work, 'traversal.tgz');
    // Tar with relative path containing ..
    const result = spawnSync('tar', ['-czf', archive, '-C', pkg, 'package.json', '../outside.txt'], {
      encoding: 'utf8',
    });
    if (result.status === 0) {
      expect(() => validateArchiveListing(archive)).toThrow(/E_RELEASE_ARCHIVE/);
    }
  });

  it('rejects symlinks pointing to absolute paths', () => {
    const work = makeTempDir('omcu-archive-abs-symlink-');
    const pkg = path.join(work, 'package');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    fs.symlinkSync('/etc/passwd', path.join(pkg, 'evil-link'));

    const archive = path.join(work, 'abs-symlink.tgz');
    createTarGz(work, archive, ['package']);

    expect(() => validateArchiveListing(archive)).toThrow(
      /E_RELEASE_ARCHIVE_UNSAFE.*absolute symlink/,
    );
  });

  it('rejects symlinks escaping the package root', () => {
    const work = makeTempDir('omcu-archive-esc-symlink-');
    const pkg = path.join(work, 'package');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    fs.symlinkSync('../../etc/shadow', path.join(pkg, 'escaping-link'));

    const archive = path.join(work, 'esc-symlink.tgz');
    createTarGz(work, archive, ['package']);

    expect(() => validateArchiveListing(archive)).toThrow(
      /E_RELEASE_ARCHIVE_UNSAFE.*symlink escapes/,
    );
  });

  it('rejects archives containing hard links', () => {
    const work = makeTempDir('omcu-archive-hardlink-');
    const pkg = path.join(work, 'package');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    fs.writeFileSync(path.join(pkg, 'orig.txt'), 'content');
    fs.linkSync(path.join(pkg, 'orig.txt'), path.join(pkg, 'hard.txt'));

    const archive = path.join(work, 'hardlink.tgz');
    createTarGz(work, archive, ['package']);

    expect(() => validateArchiveListing(archive)).toThrow(
      /E_RELEASE_ARCHIVE_UNSAFE.*hardlink/,
    );
  });

  it('rejects entries outside the package/ root', () => {
    const work = makeTempDir('omcu-archive-wrong-root-');
    const other = path.join(work, 'other-dir');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'package.json'), '{}');

    const archive = path.join(work, 'wrong-root.tgz');
    createTarGz(work, archive, ['other-dir']);

    expect(() => validateArchiveListing(archive)).toThrow('E_RELEASE_ARCHIVE_ROOT_INVALID');
  });

  it('rejects archive missing package/package.json', () => {
    const work = makeTempDir('omcu-archive-no-pkgjson-');
    const pkg = path.join(work, 'package');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'file.txt'), 'no package.json here');

    const archive = path.join(work, 'no-pkgjson.tgz');
    createTarGz(work, archive, ['package']);

    expect(() => validateArchiveListing(archive)).toThrow(
      /E_RELEASE_ARCHIVE_ROOT_INVALID.*package\.json/,
    );
  });

  it('extractReleaseArchive verifies checksum, extracts safely, and cleans up', () => {
    const work = makeTempDir('omcu-extract-test-');
    const pkg = path.join(work, 'package');
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"test"}');
    fs.writeFileSync(path.join(pkg, 'hello.txt'), 'world');

    const archive = path.join(work, 'test.tgz');
    createTarGz(work, archive, ['package']);

    const digest = sha256File(archive);
    const checksums = path.join(work, 'SHA256SUMS');
    fs.writeFileSync(checksums, `${digest}  test.tgz\n`);

    const extracted = extractReleaseArchive(archive, checksums);
    expect(fs.existsSync(path.join(extracted.root, 'package.json'))).toBe(true);
    expect(fs.readFileSync(path.join(extracted.root, 'hello.txt'), 'utf8')).toBe('world');

    extracted.cleanup();
    expect(fs.existsSync(extracted.root)).toBe(false);
  });
});
