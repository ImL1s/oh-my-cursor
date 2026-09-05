import { describe, expect, it } from 'vitest';
import {
  getProviderAdapter,
  listProviderAdapters,
  probeAllProviders,
} from '../../src/providers/registry.js';
import type { CustomProcessRunner, ProviderId } from '../../src/providers/types.js';

describe('External Compatibility Adapters (Issue #31)', () => {
  const EXPECTED_PROVIDERS: readonly ProviderId[] = [
    'cursor',
    'claude',
    'codex',
    'gemini',
    'antigravity',
    'grok',
    'opencode',
    'custom',
  ];

  it('registers all 8 required provider adapters', () => {
    const list = listProviderAdapters();
    expect(list.length).toBe(8);

    for (const id of EXPECTED_PROVIDERS) {
      const adapter = getProviderAdapter(id);
      expect(adapter).toBeDefined();
      expect(adapter.id).toBe(id);
      expect(adapter.defaultBinary).toBeDefined();
      expect(adapter.supportedModels.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('marks Cursor as the only canonical provider', () => {
    const cursor = getProviderAdapter('cursor');
    expect(cursor.isCanonical).toBe(true);

    const nonCanonical = EXPECTED_PROVIDERS.filter((id) => id !== 'cursor');
    for (const id of nonCanonical) {
      expect(getProviderAdapter(id).isCanonical).toBe(false);
    }
  });

  it('supports alias resolution for providers (agy, xai, omo)', () => {
    expect(getProviderAdapter('agy').id).toBe('antigravity');
    expect(getProviderAdapter('xai').id).toBe('grok');
    expect(getProviderAdapter('omo').id).toBe('opencode');
  });

  it('probes readiness via mock process runner and extracts version', async () => {
    const mockRunner: CustomProcessRunner = async (executable, args) => {
      if (args.includes('--version')) {
        return { code: 0, stdout: 'claude-cli 1.2.3', stderr: '' };
      }
      return { code: 0, stdout: 'ok', stderr: '' };
    };

    const claude = getProviderAdapter('claude');
    const readiness = await claude.probe(undefined, mockRunner);

    expect(readiness.provider).toBe('claude');
    expect(readiness.supportedModels).toContain('claude-3-7-sonnet');
  });

  it('executes external adapter with exact provider and model identity', async () => {
    let capturedArgs: readonly string[] = [];
    const mockRunner: CustomProcessRunner = async (executable, args) => {
      capturedArgs = args;
      return { code: 0, stdout: 'Mocked Claude Analysis', stderr: '' };
    };

    const claude = getProviderAdapter('claude');
    const result = await claude.execute({
      prompt: 'Analyze performance',
      model: 'claude-3-7-sonnet',
      runner: mockRunner,
      customBinary: '/usr/local/bin/claude',
    });

    expect(result.provider).toBe('claude');
    expect(result.model).toBe('claude-3-7-sonnet');
    expect(result.runtime).toBe('external');
    expect(result.exitCode).toBe(0);
    expect(result.text).toBe('Mocked Claude Analysis');
    expect(capturedArgs).toContain('Analyze performance');
    expect(capturedArgs).toContain('--model');
    expect(capturedArgs).toContain('claude-3-7-sonnet');
  });

  it('enforces environment allowlist isolation and rejects secret leakage', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const mockRunner: CustomProcessRunner = async (executable, args, options) => {
      capturedEnv = options.env;
      return { code: 0, stdout: 'Success', stderr: '' };
    };

    const originalEnv = process.env;
    try {
      process.env.PATH = '/bin:/usr/bin';
      process.env.ANTHROPIC_API_KEY = 'valid-anthropic-key';
      // Arbitrary ambient secrets that MUST NOT leak to external processes
      process.env.AWS_SECRET_ACCESS_KEY = 'super-secret-aws-key';
      process.env.GITHUB_TOKEN = 'secret-github-token';
      process.env.CURSOR_API_KEY = 'cursor-token';

      const claude = getProviderAdapter('claude');
      await claude.execute({
        prompt: 'test prompt',
        runner: mockRunner,
        customBinary: '/usr/local/bin/claude',
      });

      expect(capturedEnv).toBeDefined();
      expect(capturedEnv?.PATH).toBe('/bin:/usr/bin');
      expect(capturedEnv?.ANTHROPIC_API_KEY).toBe('valid-anthropic-key');

      // Sensitive un-allowlisted variables must be isolated
      expect(capturedEnv?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(capturedEnv?.GITHUB_TOKEN).toBeUndefined();
      expect(capturedEnv?.CURSOR_API_KEY).toBeUndefined();
    } finally {
      process.env = originalEnv;
    }
  });

  it('rejects dangerous flags such as --madmax, --yolo, and --dangerously-skip-permissions', async () => {
    const claude = getProviderAdapter('claude');

    await expect(
      claude.execute({
        prompt: 'test',
        customBinary: '/usr/local/bin/claude',
        customArgs: ['--madmax', 'run'],
      })
    ).rejects.toThrow('E_DANGEROUS_FLAG_REJECTED');

    await expect(
      claude.execute({
        prompt: 'test',
        customBinary: '/usr/local/bin/claude',
        customArgs: ['--dangerously-skip-permissions'],
      })
    ).rejects.toThrow('E_DANGEROUS_FLAG_REJECTED');
  });

  it('handles execution cancellation via AbortSignal', async () => {
    const controller = new AbortController();
    const mockRunner: CustomProcessRunner = async (_exe, _args, options) => {
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(new Error('E_ABORTED: execution cancelled by signal'));
        });
      });
    };

    const claude = getProviderAdapter('claude');
    const execPromise = claude.execute({
      prompt: 'long task',
      runner: mockRunner,
      customBinary: '/usr/local/bin/claude',
      signal: controller.signal,
    });

    controller.abort();
    const result = await execPromise;
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain('E_ABORTED');
  });
});
