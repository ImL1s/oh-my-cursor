import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/application.js';

function harness(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => stdout.push(text),
      stderr: (text: string) => stderr.push(text),
    },
    dependencies: {
      cwd,
      homeDir: path.join(cwd, 'home'),
      packageRoot: path.resolve('.'),
    },
  };
}

describe('CLI models, routing explain, providers status, and ask (Issue #31)', () => {
  it('lists models with catalog discovery and JSON formatting', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-cli-models-'));
    const h = harness(cwd);
    try {
      const code = await runCli(['models', 'list', '--json'], h.dependencies, h.io);
      expect(code).toBe(0);
      expect(h.stderr).toEqual([]);

      const parsed = JSON.parse(h.stdout.join(''));
      expect(parsed.ok).toBe(true);
      expect(parsed.count).toBeGreaterThan(0);
      expect(Array.isArray(parsed.models)).toBe(true);
      expect(parsed.models.some((m: { id: string }) => m.id === 'auto')).toBe(true);
      expect(parsed.models.some((m: { id: string }) => m.id === 'cursor-small')).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('filters models list by runtime', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-cli-models-filter-'));
    const h = harness(cwd);
    try {
      const code = await runCli(['models', 'list', '--runtime', 'local', '--json'], h.dependencies, h.io);
      expect(code).toBe(0);

      const parsed = JSON.parse(h.stdout.join(''));
      expect(parsed.ok).toBe(true);
      expect(parsed.models.every((m: { runtime: string }) => m.runtime === 'local' || m.runtime === 'both')).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('explains routing with semantic category preset', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-cli-route-explain-'));
    const h = harness(cwd);
    try {
      const code = await runCli(
        ['route', 'explain', '--agent', 'architect', '--category', 'visual-engineering'],
        h.dependencies,
        h.io
      );
      expect(code).toBe(0);

      const parsed = JSON.parse(h.stdout.join(''));
      expect(parsed.ok).toBe(true);
      expect(parsed.explanation.category).toBe('visual-engineering');
      expect(parsed.explanation.selectedProvider).toBe('cursor');
      expect(parsed.explanation.selectedModel).toBe('claude-3-5-sonnet');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('checks providers status and individual provider inspection', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-cli-providers-'));
    const h = harness(cwd);
    try {
      const code = await runCli(['providers', 'status', '--json'], h.dependencies, h.io);
      expect(code).toBe(0);

      const parsed = JSON.parse(h.stdout.join(''));
      expect(parsed.ok).toBe(true);
      expect(parsed.count).toBe(8);
      expect(parsed.providers.some((p: { provider: string }) => p.provider === 'cursor')).toBe(true);
      expect(parsed.providers.some((p: { provider: string }) => p.provider === 'claude')).toBe(true);
      expect(parsed.providers.some((p: { provider: string }) => p.provider === 'codex')).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('requires a prompt for omcu ask', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-cli-ask-fail-'));
    const h = harness(cwd);
    try {
      const code = await runCli(['ask', 'cursor', '--json'], h.dependencies, h.io);
      expect(code).toBe(1);

      const parsed = JSON.parse(h.stdout.join(''));
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('E_PROMPT_REQUIRED');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
