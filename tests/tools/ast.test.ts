import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAstTools,
  createToolRegistry,
  setAstGrepRunner,
  type IAstGrepRunner,
} from '../../src/tools/index.js';

describe('AST Tools and ast-grep Runner', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-ast-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('fails closed with E_AST_PARSER_UNAVAILABLE when parser is not available and forbids regex fallback', async () => {
    const unavailableRunner: IAstGrepRunner = {
      isAvailable: () => false,
      search: vi.fn(),
      rewrite: vi.fn(),
    };
    setAstGrepRunner(unavailableRunner);

    const registry = createToolRegistry(createAstTools());

    await expect(
      registry.execute(
        'ast_grep_search',
        { pattern: 'console.log($$$A)' },
        { toolCallId: 'ast-1' },
        { projectRoot: tempDir }
      )
    ).rejects.toThrow(/E_AST_PARSER_UNAVAILABLE/);
  });

  it('performs AST search and packages rewrite evidence artifact when runner is available', async () => {
    const mockRunner: IAstGrepRunner = {
      isAvailable: () => true,
      search: vi.fn().mockResolvedValue([
        {
          file: 'src/main.ts',
          text: 'console.log("hello")',
          range: {
            start: { line: 1, column: 0 },
            end: { line: 1, column: 21 },
          },
        },
      ]),
      rewrite: vi.fn().mockResolvedValue({
        matches: [],
        diff: '- console.log("hello")\n+ logger.info("hello")',
        applied: true,
      }),
    };
    setAstGrepRunner(mockRunner);

    const registry = createToolRegistry(createAstTools());

    // 1. Search
    const searchRes = await registry.execute(
      'ast_grep_search',
      { pattern: 'console.log($$$A)', language: 'typescript' },
      { toolCallId: 'ast-search' },
      { projectRoot: tempDir }
    );
    const parsedSearch = JSON.parse(searchRes as string);
    expect(parsedSearch.matchCount).toBe(1);
    expect(parsedSearch.matches[0].text).toContain('console.log');

    // 2. Rewrite
    const rewriteRes = await registry.execute(
      'ast_grep_rewrite',
      {
        pattern: 'console.log($$$A)',
        rewrite: 'logger.info($$$A)',
        language: 'typescript',
      },
      { toolCallId: 'ast-rewrite' },
      { projectRoot: tempDir }
    );
    const parsedRewrite = JSON.parse(rewriteRes as string);
    expect(parsedRewrite.applied).toBe(true);
    expect(parsedRewrite.evidenceArtifact).toBeDefined();

    // Verify evidence artifact exists on disk
    const evidencePath = path.join(tempDir, parsedRewrite.evidenceArtifact);
    expect(fs.existsSync(evidencePath)).toBe(true);
    const artifactData = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    expect(artifactData.diff).toContain('logger.info');
  });
});
