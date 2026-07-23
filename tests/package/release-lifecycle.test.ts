import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { readCurrentInstall } from '../../src/setup/lifecycle.js';

const roots: string[] = [];

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

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, [...args], { cwd, env, encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) throw new Error(`command failed (${result.status}): ${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function expectPackagedDocumentationLinks(root: string): void {
  const pending = ['README.md'];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const relative = pending.shift()!;
    if (visited.has(relative)) continue;
    visited.add(relative);
    const source = path.join(root, relative);
    expect(fs.existsSync(source), `missing packaged document: ${relative}`).toBe(true);
    const markdown = fs.readFileSync(source, 'utf8');
    for (const match of markdown.matchAll(/\[[^\]]*]\(([^)]+)\)/g)) {
      const rawTarget = match[1]!.split('#')[0]!;
      if (rawTarget === '' || /^[a-z]+:/i.test(rawTarget)) continue;
      const target = path.resolve(path.dirname(source), decodeURIComponent(rawTarget));
      expect(target === root || target.startsWith(`${root}${path.sep}`), `packaged link escapes root: ${relative} -> ${rawTarget}`).toBe(true);
      expect(fs.existsSync(target), `broken packaged link: ${relative} -> ${rawTarget}`).toBe(true);
      if (target.endsWith('.md')) pending.push(path.relative(root, target));
    }
  }
}

describe('release archive lifecycle', () => {
  it('generates basename-only SHA256SUMS and installs, reads back, and uninstalls the exact archive', () => {
    const repository = path.resolve('.');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-release-lifecycle-'));
    roots.push(root);
    const release = path.join(root, 'release');
    const home = path.join(root, 'home');
    const state = path.join(root, 'state');
    const project = path.join(root, 'project');
    fs.mkdirSync(home);
    fs.mkdirSync(project);

    const generated = JSON.parse(run(process.execPath, ['scripts/release-archive.mjs', '--output-dir', release], repository)) as {
      archive: string; checksums: string; filename: string; sha256: string;
    };
    expect(path.dirname(generated.archive)).toBe(release);
    expect(path.dirname(generated.checksums)).toBe(release);
    expect(fs.readFileSync(generated.checksums, 'utf8')).toBe(`${generated.sha256}  ${generated.filename}\n`);
    expect(generated.filename).toBe(path.basename(generated.archive));
    expect(fs.readFileSync(generated.checksums, 'utf8')).not.toContain('release/');

    const installOutput = run('bash', [
      'scripts/install.sh',
      '--archive', generated.archive,
      '--checksums', generated.checksums,
      '--home', home,
      '--state-root', state,
      '--project', project,
      '--no-doctor',
    ], repository, { ...process.env, HOME: home });
    const installed = JSON.parse(installOutput) as { receiptPath: string; receipt: { receipt_sha256: string; installed: { stage: string } } };

    const readback = readCurrentInstall(state);
    expect(readback.receipt_sha256).toBe(installed.receipt.receipt_sha256);
    expect(readback.source.realpath).toBe(generated.archive);
    expect(readback.source.sha256).toBe(generated.sha256);
    expect(fs.realpathSync(path.join(home, '.local', 'bin', 'omcu'))).toBe(fs.realpathSync(path.join(installed.receipt.installed.stage, 'dist', 'bin', 'omcu.js')));
    expect(run(path.join(home, '.local', 'bin', 'omcu'), ['--version'], project, { ...process.env, HOME: home }).trim()).toBe('0.2.1');
    expectPackagedDocumentationLinks(installed.receipt.installed.stage);

    const uninstallOutput = run('bash', [
      'scripts/uninstall.sh',
      '--receipt', installed.receiptPath,
      '--home', home,
      '--state-root', state,
      '--purge-project-state',
    ], repository, { ...process.env, HOME: home });
    const removed = JSON.parse(uninstallOutput) as { status: string; removed: string[] };
    expect(removed.status).toBe('uninstalled');
    expect(removed.removed).toContain(path.join(home, '.local', 'bin', 'omcu'));
    expect(fs.existsSync(path.join(home, '.local', 'bin', 'omcu'))).toBe(false);
    expect(fs.existsSync(installed.receipt.installed.stage)).toBe(false);
  }, 180_000);
});
