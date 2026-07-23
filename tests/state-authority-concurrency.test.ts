import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

function run(command: string, args: readonly string[], cwd: string, home: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env: { ...process.env, HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stderr }));
  });
}

describe('parallel first-use CLI authority', () => {
  it('elects one exclusive owner and all parallel commands use the winner token', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-owner-race-'));
    const home = path.join(cwd, 'home');
    fs.mkdirSync(home);
    try {
      const cli = path.resolve('dist/bin/omcu.js');
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (
        run(process.execPath, [cli, 'state', 'create', '--id', `run-${index}`, '--objective', 'race'], cwd, home)
      )));
      expect(results).toEqual(results.map(() => ({ code: 0, stderr: '' })));
      const owner = JSON.parse(fs.readFileSync(path.join(cwd, '.omcu', 'owner.json'), 'utf8')) as { owner_token: string };
      const digest = crypto.createHash('sha256').update(owner.owner_token).digest('hex');
      for (let index = 0; index < results.length; index += 1) {
        const state = JSON.parse(fs.readFileSync(path.join(cwd, '.omcu', 'runs', `run-${index}`, 'state.json'), 'utf8')) as {
          last_mutation: { owner_token_sha256: string };
        };
        expect(state.last_mutation.owner_token_sha256).toBe(digest);
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
