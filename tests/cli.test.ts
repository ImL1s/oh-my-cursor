import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/application.js';

describe('CLI application', () => {
  it('creates and reads run state through the CLI-owned path', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-cli-'));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = { stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) };
    try {
      expect(await runCli(['run', 'create', '--id', 'r1', '--objective', 'test'], { cwd }, io)).toBe(0);
      expect(await runCli(['run', 'status', '--id', 'r1'], { cwd }, io)).toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout.join('')).toContain('"repository_id": "OMCU"');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
});
