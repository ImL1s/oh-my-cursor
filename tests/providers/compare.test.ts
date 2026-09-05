import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareProviders } from '../../src/providers/compare.js';
import type { CustomProcessRunner } from '../../src/providers/types.js';

describe('Provider Compare & Consensus (Issue #31)', () => {
  it('runs independent compare across multiple providers and preserves real identity', async () => {
    const mockRunner: CustomProcessRunner = async (executable) => {
      if (executable.includes('cursor')) {
        return { code: 0, stdout: 'Function debounce delays invocation until wait time has elapsed.', stderr: '' };
      }
      if (executable.includes('codex')) {
        return { code: 0, stdout: 'Debounce function postpones calling until wait milliseconds elapse.', stderr: '' };
      }
      if (executable.includes('gemini')) {
        return { code: 0, stdout: 'Debounce cancels earlier calls and runs after wait interval.', stderr: '' };
      }
      return { code: 0, stdout: 'generic response', stderr: '' };
    };

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-compare-test-'));
    try {
      const artifact = await compareProviders({
        providers: ['cursor', 'codex', 'gemini'],
        prompt: 'Explain debounce function',
        runner: mockRunner,
        workspace: tempDir,
      });

      expect(artifact.artifact_type).toBe('provider_consensus');
      expect(artifact.id).toMatch(/^consensus-[a-f0-9]{8}$/);
      expect(artifact.totalProviders).toBe(3);
      expect(artifact.successCount).toBe(3);
      expect(artifact.failureCount).toBe(0);
      expect(artifact.results.length).toBe(3);

      const cursorRes = artifact.results.find((r) => r.provider === 'cursor');
      expect(cursorRes?.runtime).toBe('cloud');
      expect(cursorRes?.success).toBe(true);

      const codexRes = artifact.results.find((r) => r.provider === 'codex');
      expect(codexRes?.runtime).toBe('external');
      expect(codexRes?.success).toBe(true);

      const geminiRes = artifact.results.find((r) => r.provider === 'gemini');
      expect(geminiRes?.runtime).toBe('external');
      expect(geminiRes?.success).toBe(true);

      expect(artifact.verdict).toBe('full_consensus');
      expect(artifact.agreementScore).toBeGreaterThanOrEqual(0.15);
      expect(artifact.synthesis).toContain('3 of 3 provider(s) succeeded');
      expect(artifact.advisoryNote).toContain('advisory evidence');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps partial failures visible when one provider fails', async () => {
    const mockRunner: CustomProcessRunner = async (executable) => {
      if (executable.includes('codex')) {
        return { code: 1, stdout: '', stderr: 'E_AUTH_EXPIRED: token expired' };
      }
      return { code: 0, stdout: 'Success answer', stderr: '' };
    };

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-partial-fail-'));
    try {
      const artifact = await compareProviders({
        providers: ['cursor', 'codex'],
        prompt: 'Refactor module',
        runner: mockRunner,
        workspace: tempDir,
      });

      expect(artifact.totalProviders).toBe(2);
      expect(artifact.successCount).toBe(1);
      expect(artifact.failureCount).toBe(1);
      expect(artifact.verdict).toBe('partial_consensus');

      const codexRes = artifact.results.find((r) => r.provider === 'codex');
      expect(codexRes?.success).toBe(false);
      expect(codexRes?.error).toContain('E_AUTH_EXPIRED');

      const cursorRes = artifact.results.find((r) => r.provider === 'cursor');
      expect(cursorRes?.success).toBe(true);

      expect(artifact.synthesis).toContain('1 of 2 provider(s) succeeded');
      expect(artifact.synthesis).toContain('Failures encountered on: codex');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('persists typed consensus artifact in .omcu/artifacts without mutating code', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-artifact-test-'));
    const stateDir = path.join(tempDir, '.omcu');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

    const mockRunner: CustomProcessRunner = async () => ({
      code: 0,
      stdout: 'Valid advice text',
      stderr: '',
    });

    try {
      const artifact = await compareProviders({
        providers: ['claude'],
        prompt: 'Check architecture',
        runner: mockRunner,
        saveArtifact: true,
        workspace: tempDir,
      });

      const artifactPath = path.join(stateDir, 'artifacts', `${artifact.id}.json`);
      expect(fs.existsSync(artifactPath)).toBe(true);

      const readBack = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      expect(readBack.id).toBe(artifact.id);
      expect(readBack.artifact_type).toBe('provider_consensus');
      expect(readBack.results[0].provider).toBe('claude');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
