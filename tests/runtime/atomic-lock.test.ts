import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withDirectoryLock } from '../../src/runtime/atomic.js';

function waitForLine(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => resolve());
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => child.once('close', () => resolve()));
}

describe('generic project-state directory lock', () => {
  it('reclaims an owner-only lock after its writer is killed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-killed-'));
    const target = path.join(root, 'state.json');
    const lock = `${target}.lock`;
    try {
      const script = `
        const fs=require('fs'), path=require('path'), crypto=require('crypto');
        const lock=process.argv[1];
        fs.mkdirSync(lock,{recursive:true,mode:0o700});
        fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({
          schema_version:1,pid:process.pid,token:crypto.randomBytes(16).toString('hex'),created_at_ms:Date.now()
        }),{mode:0o600});
        process.stdout.write('ready\\n');
        setInterval(()=>{},1000);
      `;
      const child = spawn(process.execPath, ['-e', script, lock], { stdio: ['ignore', 'pipe', 'pipe'] });
      await waitForLine(child);
      child.kill('SIGKILL');
      await waitForExit(child);
      await expect(withDirectoryLock(target, () => 'recovered', 200)).resolves.toBe('recovered');
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not steal a live owner and releases only the acquiring token', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-contention-'));
    const target = path.join(root, 'events.jsonl');
    let enteredResolve!: () => void;
    let releaseResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    try {
      const holder = withDirectoryLock(target, async () => {
        enteredResolve();
        await release;
        return 'holder';
      }, 500, { staleMs: 0, pollMs: 2 });
      await entered;
      await expect(withDirectoryLock(target, () => 'contender', 25, {
        staleMs: 0, pollMs: 2,
      })).rejects.toThrow('E_LOCK_TIMEOUT');
      releaseResolve();
      await expect(holder).resolves.toBe('holder');
      expect(fs.existsSync(`${target}.lock`)).toBe(false);
      await expect(withDirectoryLock(target, () => 'next', 100)).resolves.toBe('next');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses token-mismatched release instead of deleting a foreign lock', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-token-'));
    const target = path.join(root, 'memory.json');
    const lock = `${target}.lock`;
    try {
      await expect(withDirectoryLock(target, () => {
        const ownerFile = path.join(lock, 'owner.json');
        const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, token: 'f'.repeat(32) }), { mode: 0o600 });
      }, 100)).rejects.toThrow('E_LOCK_OWNERSHIP_LOST');
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
