import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifySha256Sums } from './digest.js';

export const MAX_ARCHIVE_ENTRIES = 10_000;
export const MAX_ARCHIVE_TOTAL_BYTES = 256 * 1024 * 1024; // 256 MB
export const MAX_ARCHIVE_FILE_BYTES = 64 * 1024 * 1024;  // 64 MB

export interface ArchiveSafetyReport {
  readonly entryCount: number;
  readonly totalSize: number;
  readonly packageRoot: string;
}

export interface ExtractedArchive {
  readonly root: string;
  readonly cleanup: () => void;
}

export function validateArchiveListing(archive: string): ArchiveSafetyReport {
  const archivePath = path.resolve(archive);
  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
    throw new Error('E_RELEASE_ARCHIVE_MISSING');
  }

  const tz = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8', timeout: 30_000 });
  if (tz.status !== 0) throw new Error('E_RELEASE_ARCHIVE_LIST_FAILED');

  const tv = spawnSync('tar', ['-tvzf', archivePath], { encoding: 'utf8', timeout: 30_000 });
  if (tv.status !== 0) throw new Error('E_RELEASE_ARCHIVE_LIST_FAILED');

  const tzEntries = tz.stdout.split(/\r?\n/).filter(Boolean);
  const tvEntries = tv.stdout.split(/\r?\n/).filter(Boolean);

  if (tzEntries.length === 0) {
    throw new Error('E_RELEASE_ARCHIVE_UNSAFE: archive is empty');
  }
  if (tzEntries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('E_RELEASE_ARCHIVE_UNSAFE: entry count exceeds limit');
  }
  if (tzEntries.length !== tvEntries.length) {
    throw new Error('E_RELEASE_ARCHIVE_UNSAFE: archive listing entry count mismatch');
  }

  let totalSize = 0;
  const seen = new Map<string, 'dir' | 'file' | 'symlink'>();

  for (let i = 0; i < tzEntries.length; i++) {
    const entry = tzEntries[i]!;
    const tvLine = tvEntries[i]!;

    if (entry.includes('\0')) {
      throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: NUL byte in path: ${JSON.stringify(entry)}`);
    }
    if (entry.startsWith('/') || entry.startsWith('\\') || path.isAbsolute(entry)) {
      throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: absolute path forbidden: ${entry}`);
    }
    if (/^[A-Za-z]:/.test(entry)) {
      throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: drive prefix forbidden: ${entry}`);
    }
    if (entry.split('/').includes('..') || entry.split('\\').includes('..')) {
      throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: path traversal forbidden: ${entry}`);
    }
    if (entry.split('/').includes('.')) {
      throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: non-canonical dot segment forbidden: ${entry}`);
    }
    if (entry.includes('\\')) {
      throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: non-canonical path with backslash: ${entry}`);
    }
    if (entry.includes('//')) {
      throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: non-canonical path with //: ${entry}`);
    }

    const norm = entry.replace(/\/+$/, '');
    if (norm !== 'package' && !norm.startsWith('package/')) {
      throw new Error(`E_RELEASE_ARCHIVE_ROOT_INVALID: entry outside package/ root: ${entry}`);
    }

    const typeChar = tvLine[0];
    if (tvLine.includes(' link to ') || typeChar === 'h') {
      throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: hardlinks forbidden: ${entry}`);
    }
    if (typeChar !== '-' && typeChar !== 'd' && typeChar !== 'l') {
      throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: forbidden entry type (${typeChar}): ${entry}`);
    }

    let type: 'dir' | 'file' | 'symlink' = 'file';
    if (typeChar === 'd') {
      type = 'dir';
    } else if (typeChar === 'l') {
      type = 'symlink';
      const arrow = tvLine.lastIndexOf(' -> ');
      if (arrow === -1) {
        throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: malformed symlink entry: ${entry}`);
      }
      const target = tvLine.slice(arrow + 4).trim();
      if (!target || target.includes('\0')) {
        throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: invalid symlink target: ${entry}`);
      }
      if (target.startsWith('/') || target.startsWith('\\') || /^[A-Za-z]:/.test(target)) {
        throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: absolute symlink forbidden: ${entry} -> ${target}`);
      }
      const resolved = path.posix.resolve('/', path.posix.dirname(entry), target);
      if (resolved !== '/package' && !resolved.startsWith('/package/')) {
        throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: symlink escapes package root: ${entry} -> ${target}`);
      }
    } else if (typeChar === '-') {
      if (entry.endsWith('/')) {
        throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: regular file cannot have trailing slash: ${entry}`);
      }
      const sizeMatch = tvLine.match(/\s+(\d+)\s+(?:[A-Za-z]{3}\s+\d+|\d{4}-\d{2}-\d{2})\s+/);
      if (sizeMatch) {
        const sz = parseInt(sizeMatch[1]!, 10);
        if (sz > MAX_ARCHIVE_FILE_BYTES) {
          throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: entry exceeds size limit: ${entry}`);
        }
        totalSize += sz;
        if (totalSize > MAX_ARCHIVE_TOTAL_BYTES) {
          throw new Error('E_RELEASE_ARCHIVE_UNSAFE: archive exceeds total size limit');
        }
      }
    }

    if (seen.has(norm)) {
      throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: duplicate entry: ${norm}`);
    }
    seen.set(norm, type);

    const parts = norm.split('/');
    for (let p = 1; p < parts.length; p++) {
      const parent = parts.slice(0, p).join('/');
      if (seen.has(parent) && seen.get(parent) !== 'dir') {
        throw new Error(`E_RELEASE_ARCHIVE_UNSAFE: path conflict with non-directory parent: ${norm}`);
      }
    }
  }

  if (!seen.has('package/package.json')) {
    throw new Error('E_RELEASE_ARCHIVE_ROOT_INVALID: missing package/package.json');
  }

  return {
    entryCount: tzEntries.length,
    totalSize,
    packageRoot: 'package',
  };
}

export function extractReleaseArchive(archive: string, checksums: string): ExtractedArchive {
  verifySha256Sums(archive, checksums);
  validateArchiveListing(archive);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-release-'));
  fs.chmodSync(temporary, 0o700);

  const extracted = spawnSync('tar', ['-xzf', archive, '-C', temporary], { encoding: 'utf8', timeout: 60_000 });
  if (extracted.status !== 0) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw new Error('E_RELEASE_ARCHIVE_EXTRACT_FAILED');
  }

  const packageDir = path.join(temporary, 'package');
  if (!fs.existsSync(packageDir) || !fs.existsSync(path.join(packageDir, 'package.json'))) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw new Error('E_RELEASE_ARCHIVE_ROOT_INVALID');
  }

  return {
    root: packageDir,
    cleanup: () => fs.rmSync(temporary, { recursive: true, force: true }),
  };
}
