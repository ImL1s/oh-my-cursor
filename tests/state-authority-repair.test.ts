import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectStateRoot } from '../src/runtime/state-root.js';
import {
  assertCliMutationAuthority,
  createCliMutationAuthority,
  quarantineInvalidCliOwnerRecord,
} from '../src/state/authority.js';

const viteNode = path.resolve('node_modules/.bin/vite-node');
const repairChild = path.resolve('tests/fixtures/authority-repair-child.ts');

function child(action: 'repair' | 'create', root: string): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const process = spawn(viteNode, [repairChild, action, root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    process.stdout.on('data', (chunk) => { stdout += String(chunk); });
    process.stderr.on('data', (chunk) => { stderr += String(chunk); });
    process.once('error', reject);
    process.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe('CLI owner authority crash recovery (#14)', () => {
  it('creates owner through the exclusive atomic primitive and preserves a valid owner', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-authority-create-'));
    try {
      const root = projectStateRoot(workspace);
      const first = createCliMutationAuthority(root);
      const second = createCliMutationAuthority(root);
      expect(second.ownerToken).toBe(first.ownerToken);
      expect(quarantineInvalidCliOwnerRecord(root)).toBeNull();
      expect(fs.statSync(root.ownerFile).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(root.path).filter((name) => name.includes('.tmp-'))).toEqual([]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('quarantines only an invalid owned regular owner record', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-authority-repair-'));
    try {
      const root = projectStateRoot(workspace);
      fs.writeFileSync(root.ownerFile, '{partial', { mode: 0o600 });
      const quarantine = quarantineInvalidCliOwnerRecord(root);
      expect(quarantine).not.toBeNull();
      expect(fs.existsSync(root.ownerFile)).toBe(false);
      expect(fs.readFileSync(quarantine as string, 'utf8')).toBe('{partial');
      const authority = createCliMutationAuthority(root);
      expect(authority.ownerToken).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('quarantines an owned empty owner record for explicit repair', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-authority-empty-repair-'));
    try {
      const root = projectStateRoot(workspace);
      fs.writeFileSync(root.ownerFile, '', { mode: 0o600 });
      const quarantine = quarantineInvalidCliOwnerRecord(root);
      expect(quarantine).not.toBeNull();
      expect(fs.existsSync(root.ownerFile)).toBe(false);
      expect(fs.readFileSync(quarantine as string)).toHaveLength(0);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('refuses to repair a symlinked owner record', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-authority-symlink-'));
    try {
      const root = projectStateRoot(workspace);
      const external = path.join(workspace, 'external.json');
      fs.writeFileSync(external, '{partial');
      fs.symlinkSync(external, root.ownerFile);
      expect(() => quarantineInvalidCliOwnerRecord(root)).toThrow('E_OWNER_RECORD_REPAIR_UNSAFE');
      expect(fs.existsSync(external)).toBe(true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rejects a symlink even when it points to a valid owner record', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-authority-valid-symlink-'));
    try {
      const root = projectStateRoot(workspace);
      const external = path.join(workspace, 'valid-owner.json');
      fs.writeFileSync(external, JSON.stringify({
        schema_version: 1,
        owner_token: 'a'.repeat(64),
        created_at: '2026-07-31T00:00:00.000Z',
      }), { mode: 0o600 });
      fs.symlinkSync(external, root.ownerFile);
      expect(() => createCliMutationAuthority(root)).toThrow('E_OWNER_RECORD_UNSAFE');
      expect(() => quarantineInvalidCliOwnerRecord(root)).toThrow('E_OWNER_RECORD_REPAIR_UNSAFE');
      expect(fs.existsSync(external)).toBe(true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('revalidates owner storage and root mode on every authority assertion', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-authority-assert-'));
    try {
      const root = projectStateRoot(workspace);
      const authority = createCliMutationAuthority(root);
      const actual = path.join(root.path, 'owner.actual.json');
      fs.renameSync(root.ownerFile, actual);
      fs.symlinkSync(actual, root.ownerFile);
      expect(() => assertCliMutationAuthority(authority)).toThrow('E_OWNER_RECORD_UNSAFE');

      fs.unlinkSync(root.ownerFile);
      fs.renameSync(actual, root.ownerFile);
      fs.chmodSync(root.path, 0o755);
      expect(() => assertCliMutationAuthority(authority)).toThrow('E_OWNER_ROOT_MODE_UNSAFE');
    } finally {
      const stateRoot = path.join(workspace, '.omcu');
      if (fs.existsSync(stateRoot)) fs.chmodSync(stateRoot, 0o700);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rejects over-wide owner file and state-root modes without changing them', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-authority-mode-'));
    try {
      const root = projectStateRoot(workspace);
      const valid = JSON.stringify({
        schema_version: 1,
        owner_token: 'b'.repeat(64),
        created_at: '2026-07-31T00:00:00.000Z',
      });
      fs.writeFileSync(root.ownerFile, valid, { mode: 0o644 });
      fs.chmodSync(root.ownerFile, 0o644);
      expect(() => createCliMutationAuthority(root)).toThrow('E_OWNER_RECORD_MODE_UNSAFE');
      expect(() => quarantineInvalidCliOwnerRecord(root)).toThrow('E_OWNER_RECORD_MODE_UNSAFE');
      expect(fs.statSync(root.ownerFile).mode & 0o777).toBe(0o644);

      fs.chmodSync(root.ownerFile, 0o600);
      fs.chmodSync(root.path, 0o755);
      expect(() => createCliMutationAuthority(root)).toThrow('E_OWNER_ROOT_MODE_UNSAFE');
      expect(() => quarantineInvalidCliOwnerRecord(root)).toThrow('E_OWNER_ROOT_MODE_UNSAFE');
      expect(fs.statSync(root.path).mode & 0o777).toBe(0o755);
    } finally {
      fs.chmodSync(path.join(workspace, '.omcu'), 0o700);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rejects oversized and non-canonical owner schemas', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-authority-schema-'));
    try {
      const root = projectStateRoot(workspace);
      fs.writeFileSync(root.ownerFile, 'x'.repeat(4 * 1024 + 1), { mode: 0o600 });
      expect(() => createCliMutationAuthority(root)).toThrow('E_OWNER_RECORD_SIZE_UNSAFE');
      expect(() => quarantineInvalidCliOwnerRecord(root)).toThrow('E_OWNER_RECORD_SIZE_UNSAFE');

      fs.writeFileSync(root.ownerFile, JSON.stringify({
        schema_version: 1,
        owner_token: 'c'.repeat(64),
        created_at: 'not-a-date',
      }), { mode: 0o600 });
      expect(() => createCliMutationAuthority(root)).toThrow('E_OWNER_RECORD_INVALID');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('revalidates inode and bytes before quarantine rename', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-authority-changed-'));
    try {
      const root = projectStateRoot(workspace);
      fs.writeFileSync(root.ownerFile, '{partial', { mode: 0o600 });
      expect(() => quarantineInvalidCliOwnerRecord(root, {
        beforeRevalidate: () => {
          const replacement = path.join(root.path, 'replacement.json');
          fs.writeFileSync(replacement, '{replacement', { mode: 0o600 });
          fs.renameSync(replacement, root.ownerFile);
        },
      })).toThrow('E_OWNER_RECORD_REPAIR_CHANGED');
      expect(fs.readFileSync(root.ownerFile, 'utf8')).toBe('{replacement');
      expect(fs.readdirSync(root.path).filter((name) => name.includes('.invalid-'))).toEqual([]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('never quarantines a valid owner that replaces the bound invalid snapshot', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-authority-valid-race-'));
    try {
      const root = projectStateRoot(workspace);
      fs.writeFileSync(root.ownerFile, '{partial', { mode: 0o600 });
      const valid = {
        schema_version: 1,
        owner_token: 'd'.repeat(64),
        created_at: '2026-07-31T00:00:00.000Z',
      };
      expect(() => quarantineInvalidCliOwnerRecord(root, {
        beforeRevalidate: () => {
          const replacement = path.join(root.path, 'valid-replacement.json');
          fs.writeFileSync(replacement, `${JSON.stringify(valid)}\n`, { mode: 0o600 });
          fs.renameSync(replacement, root.ownerFile);
        },
      })).toThrow('E_OWNER_RECORD_REPAIR_CHANGED');
      expect(JSON.parse(fs.readFileSync(root.ownerFile, 'utf8'))).toEqual(valid);
      expect(fs.readdirSync(root.path).filter((name) => name.includes('.invalid-'))).toEqual([]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('binds quarantine to the validated parent even when an identical hard link replaces it', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-authority-parent-swap-'));
    const moved = path.join(workspace, '.omcu-original');
    try {
      const root = projectStateRoot(workspace);
      fs.writeFileSync(root.ownerFile, '{partial', { mode: 0o600 });
      expect(() => quarantineInvalidCliOwnerRecord(root, {
        beforeRevalidate: () => {
          fs.renameSync(root.path, moved);
          fs.mkdirSync(root.path, { mode: 0o700 });
          fs.linkSync(path.join(moved, 'owner.json'), root.ownerFile);
        },
      })).toThrow('E_OWNER_RECORD_REPAIR_PARENT_CHANGED');
      expect(fs.existsSync(path.join(moved, 'owner.json'))).toBe(true);
      expect(fs.readdirSync(root.path).filter((name) => name.includes('.invalid-'))).toEqual([]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(moved, { recursive: true, force: true });
    }
  });

  it('serializes two repairers and a create/repair race through the same guard', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-authority-race-'));
    try {
      const root = projectStateRoot(workspace);
      fs.writeFileSync(root.ownerFile, '{partial', { mode: 0o600 });
      const repairs = await Promise.all([child('repair', root.path), child('repair', root.path)]);
      expect(repairs.map(({ code }) => code)).toEqual([0, 0]);
      const quarantines = repairs.map(({ stdout }) => (
        JSON.parse(stdout) as { quarantine: string | null }
      ).quarantine).filter((value) => value !== null);
      expect(quarantines).toHaveLength(1);
      expect(fs.existsSync(root.ownerFile)).toBe(false);

      fs.writeFileSync(root.ownerFile, '{partial-again', { mode: 0o600 });
      const raced = await Promise.all([child('repair', root.path), child('create', root.path)]);
      expect(raced.some(({ code }) => code === 0)).toBe(true);
      // Regardless of ordering, a clean retry observes or creates one valid winner.
      const authority = createCliMutationAuthority(root);
      expect(authority.ownerToken).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(fs.readFileSync(root.ownerFile, 'utf8'))).toMatchObject({
        schema_version: 1,
        owner_token: authority.ownerToken,
      });
      expect(fs.existsSync(`${root.ownerFile}.lock`)).toBe(false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }, 10_000);
});
