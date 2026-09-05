import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchGitHubRelease } from '../../src/setup/github-release.js';

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

function createMockTarGz(destFile: string, files: Record<string, string>): void {
  const tmpDir = temporary('mock-tar-');
  const pkgDir = path.join(tmpDir, 'package');
  fs.mkdirSync(pkgDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(pkgDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  execFileSync('tar', ['-czf', destFile, '-C', tmpDir, 'package']);
}

describe('fetchGitHubRelease', () => {
  it('downloads release archive and verifies sha256 against SHA256SUMS from mock server', async () => {
    const root = temporary('gh-release-test-');
    const version = '1.2.3';
    const tag = 'v1.2.3';
    const archiveName = `iml1s-oh-my-cursor-${version}.tgz`;
    const archivePath = path.join(root, archiveName);
    createMockTarGz(archivePath, {
      'package.json': JSON.stringify({ name: '@iml1s/oh-my-cursor', version: '1.2.3' }),
      'dist/bin/omcu.js': '#!/usr/bin/env node\nconsole.log("v1.2.3");\n',
    });
    const archiveBytes = fs.readFileSync(archivePath);
    const archiveSha = crypto.createHash('sha256').update(archiveBytes).digest('hex');
    const checksumsContent = `${archiveSha}  ${archiveName}\n`;

    const server = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (url === `/download/${tag}/${archiveName}`) {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(archiveBytes);
      } else if (url === `/download/${tag}/SHA256SUMS`) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(checksumsContent);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;

    const originalBase = process.env.OMCU_BASE_URL;
    const originalInsecure = process.env.OMCU_ALLOW_INSECURE_PROTO;
    try {
      process.env.OMCU_BASE_URL = `http://127.0.0.1:${port}/download/${tag}`;
      process.env.OMCU_ALLOW_INSECURE_PROTO = '1';

      const fetched = await fetchGitHubRelease({ tag });
      expect(fetched.tag).toBe('v1.2.3');
      expect(fetched.version).toBe('1.2.3');
      expect(fetched.archiveSha256).toBe(archiveSha);
      expect(fs.existsSync(path.join(fetched.extractedRoot, 'package.json'))).toBe(true);

      fetched.cleanup();
      expect(fs.existsSync(fetched.extractedRoot)).toBe(false);
    } finally {
      server.close();
      if (originalBase !== undefined) process.env.OMCU_BASE_URL = originalBase;
      else delete process.env.OMCU_BASE_URL;
      if (originalInsecure !== undefined) process.env.OMCU_ALLOW_INSECURE_PROTO = originalInsecure;
      else delete process.env.OMCU_ALLOW_INSECURE_PROTO;
    }
  });

  it('resolves latest release when requested', async () => {
    const root = temporary('gh-release-latest-');
    const version = '2.0.0';
    const tag = 'v2.0.0';
    const archiveName = `iml1s-oh-my-cursor-${version}.tgz`;
    const archivePath = path.join(root, archiveName);
    createMockTarGz(archivePath, {
      'package.json': JSON.stringify({ name: '@iml1s/oh-my-cursor', version: '2.0.0' }),
      'dist/bin/omcu.js': '#!/usr/bin/env node\nconsole.log("v2.0.0");\n',
    });
    const archiveBytes = fs.readFileSync(archivePath);
    const archiveSha = crypto.createHash('sha256').update(archiveBytes).digest('hex');
    const checksumsContent = `${archiveSha}  ${archiveName}\n`;

    const server = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (url === '/api/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tag_name: tag }));
      } else if (url === `/download/${tag}/${archiveName}`) {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(archiveBytes);
      } else if (url === `/download/${tag}/SHA256SUMS`) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(checksumsContent);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;

    const originalApi = process.env.OMCU_API_URL;
    const originalBase = process.env.OMCU_BASE_URL;
    const originalInsecure = process.env.OMCU_ALLOW_INSECURE_PROTO;
    try {
      process.env.OMCU_API_URL = `http://127.0.0.1:${port}/api`;
      process.env.OMCU_BASE_URL = `http://127.0.0.1:${port}/download/${tag}`;
      process.env.OMCU_ALLOW_INSECURE_PROTO = '1';

      const fetched = await fetchGitHubRelease({ latest: true });
      expect(fetched.tag).toBe('v2.0.0');
      expect(fetched.version).toBe('2.0.0');
      fetched.cleanup();
    } finally {
      server.close();
      if (originalApi !== undefined) process.env.OMCU_API_URL = originalApi;
      else delete process.env.OMCU_API_URL;
      if (originalBase !== undefined) process.env.OMCU_BASE_URL = originalBase;
      else delete process.env.OMCU_BASE_URL;
      if (originalInsecure !== undefined) process.env.OMCU_ALLOW_INSECURE_PROTO = originalInsecure;
      else delete process.env.OMCU_ALLOW_INSECURE_PROTO;
    }
  });

  it('rejects tampered archive when sha256 does not match SHA256SUMS', async () => {
    const root = temporary('gh-release-tampered-');
    const version = '1.0.0';
    const tag = 'v1.0.0';
    const archiveName = `iml1s-oh-my-cursor-${version}.tgz`;
    const archivePath = path.join(root, archiveName);
    createMockTarGz(archivePath, {
      'package.json': JSON.stringify({ name: '@iml1s/oh-my-cursor', version: '1.0.0' }),
    });
    const archiveBytes = fs.readFileSync(archivePath);
    const checksumsContent = `0000000000000000000000000000000000000000000000000000000000000000  ${archiveName}\n`;

    const server = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (url === `/download/${tag}/${archiveName}`) {
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        res.end(archiveBytes);
      } else if (url === `/download/${tag}/SHA256SUMS`) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(checksumsContent);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;

    const originalBase = process.env.OMCU_BASE_URL;
    const originalInsecure = process.env.OMCU_ALLOW_INSECURE_PROTO;
    try {
      process.env.OMCU_BASE_URL = `http://127.0.0.1:${port}/download/${tag}`;
      process.env.OMCU_ALLOW_INSECURE_PROTO = '1';

      await expect(fetchGitHubRelease({ tag })).rejects.toThrow('E_RELEASE_CHECKSUM_MISMATCH');
    } finally {
      server.close();
      if (originalBase !== undefined) process.env.OMCU_BASE_URL = originalBase;
      else delete process.env.OMCU_BASE_URL;
      if (originalInsecure !== undefined) process.env.OMCU_ALLOW_INSECURE_PROTO = originalInsecure;
      else delete process.env.OMCU_ALLOW_INSECURE_PROTO;
    }
  });

  it('rejects insecure http protocol by default', async () => {
    const originalBase = process.env.OMCU_BASE_URL;
    const originalInsecure = process.env.OMCU_ALLOW_INSECURE_PROTO;
    try {
      process.env.OMCU_BASE_URL = 'http://127.0.0.1:9999/download';
      delete process.env.OMCU_ALLOW_INSECURE_PROTO;

      await expect(fetchGitHubRelease({ tag: 'v1.0.0' })).rejects.toThrow('E_INSECURE_PROTOCOL');
    } finally {
      if (originalBase !== undefined) process.env.OMCU_BASE_URL = originalBase;
      else delete process.env.OMCU_BASE_URL;
      if (originalInsecure !== undefined) process.env.OMCU_ALLOW_INSECURE_PROTO = originalInsecure;
      else delete process.env.OMCU_ALLOW_INSECURE_PROTO;
    }
  });
});
