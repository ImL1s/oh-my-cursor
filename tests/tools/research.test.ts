import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSafeUrl,
  createResearchTools,
  createToolRegistry,
  isPrimarySource,
  packageResearchEvidence,
} from '../../src/tools/index.js';

describe('Research and Evidence Tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-research-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('validates URLs and rejects unsafe protocols and private networks', () => {
    expect(() => assertSafeUrl('https://docs.cursor.com/agent')).not.toThrow();
    expect(() => assertSafeUrl('http://github.com/ImL1s')).not.toThrow();

    // Invalid protocol
    expect(() => assertSafeUrl('file:///etc/passwd')).toThrow(/E_UNSAFE_URL/);
    expect(() => assertSafeUrl('ftp://example.com/file')).toThrow(/E_UNSAFE_URL/);

    // SSRF / Private IPs
    expect(() => assertSafeUrl('http://localhost:8080')).toThrow(/E_UNSAFE_URL/);
    expect(() => assertSafeUrl('http://127.0.0.1:3000')).toThrow(/E_UNSAFE_URL/);
    expect(() => assertSafeUrl('http://192.168.1.1/admin')).toThrow(/E_UNSAFE_URL/);
    expect(() => assertSafeUrl('http://10.0.0.5')).toThrow(/E_UNSAFE_URL/);
  });

  it('detects official primary sources', () => {
    expect(isPrimarySource('cursor.com')).toBe(true);
    expect(isPrimarySource('docs.cursor.com')).toBe(true);
    expect(isPrimarySource('github.com')).toBe(true);
    expect(isPrimarySource('random-blog.net')).toBe(false);
  });

  it('packages research findings into evidence artifact file', () => {
    const artifact = packageResearchEvidence(
      'Cursor Custom Tools Spec',
      [
        {
          url: 'https://docs.cursor.com/agent/custom-tools',
          domain: 'cursor.com',
          retrievedAt: new Date().toISOString(),
          primarySource: true,
          snippet: 'Cursor SDK custom tools use local.customTools...',
        },
      ],
      'Documented local custom tools configuration.',
      undefined,
      tempDir
    );

    expect(artifact.id).toBeDefined();
    expect(artifact.artifactPath).toContain('.omcu/artifacts/research/research-');
    expect(fs.existsSync(path.join(tempDir, artifact.artifactPath))).toBe(true);
  });

  it('dispatches research_evidence_package via ToolRegistry', async () => {
    const registry = createToolRegistry(createResearchTools());

    const result = await registry.execute(
      'research_evidence_package',
      {
        topic: 'LSP Multi-root',
        citations: [
          {
            url: 'https://microsoft.github.io/language-server-protocol/',
            domain: 'microsoft.github.io',
            retrievedAt: new Date().toISOString(),
            primarySource: true,
          },
        ],
        summary: 'LSP specification for multi-root workspace support.',
      },
      { toolCallId: 'res-1' },
      { projectRoot: tempDir }
    );

    const parsed = JSON.parse(result as string);
    expect(parsed.artifactPath).toBeDefined();
    expect(fs.existsSync(path.join(tempDir, parsed.artifactPath))).toBe(true);
  });
});
