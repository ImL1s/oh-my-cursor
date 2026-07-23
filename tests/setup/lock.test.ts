import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withInstallLock } from '../../src/setup/lock.js';

describe('install transaction lock', () => {
  it('immediately reclaims a recent owner lock whose parsed PID is no longer alive', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-stale-lock-'));
    try {
      const lock = path.join(root, 'install', 'transaction.lock');
      fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
        schema_version: 1,
        pid: 999_999_999,
        token: 'a'.repeat(32),
        created_at_ms: Date.now(),
      }), { mode: 0o600 });
      await expect(withInstallLock(root, () => 'reclaimed')).resolves.toBe('reclaimed');
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not steal a live owner lock and fails within the configured bound', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-live-lock-'));
    try {
      const lock = path.join(root, 'install', 'transaction.lock');
      fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        token: 'b'.repeat(32),
        created_at_ms: Date.now() - 120_000,
      }), { mode: 0o600 });
      await expect(withInstallLock(root, () => 'stolen', {
        timeoutMs: 20, staleMs: 1, pollMs: 2,
      })).rejects.toThrow('E_INSTALL_LOCK_TIMEOUT');
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
