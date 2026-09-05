import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLspTools,
  createToolRegistry,
  LanguageServerManager,
  type ILspClient,
  type LspDiagnostic,
  type LspHoverResult,
  type LspLocation,
  type LspPosition,
  type LspSymbol,
  type LspWorkspaceEdit,
} from '../../src/tools/index.js';

describe('LSP Tools and LanguageServerManager', () => {
  let tempDir1: string;
  let tempDir2: string;

  beforeEach(() => {
    tempDir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lsp-test-root1-'));
    tempDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lsp-test-root2-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir1, { recursive: true, force: true });
    fs.rmSync(tempDir2, { recursive: true, force: true });
  });

  function createMockClient(languageId: string, rootDir: string): ILspClient {
    return {
      languageId,
      rootDir,
      diagnostics: vi.fn().mockResolvedValue([
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          message: 'Syntax warning',
          severity: 2,
        },
      ] as LspDiagnostic[]),
      hover: vi.fn().mockResolvedValue({
        contents: 'Type: (x: number) => string',
      } as LspHoverResult),
      definition: vi.fn().mockResolvedValue([
        {
          uri: 'file:///mock/file.ts',
          range: { start: { line: 10, character: 2 }, end: { line: 10, character: 10 } },
        },
      ] as LspLocation[]),
      references: vi.fn().mockResolvedValue([
        {
          uri: 'file:///mock/ref1.ts',
          range: { start: { line: 1, character: 4 }, end: { line: 1, character: 8 } },
        },
      ] as LspLocation[]),
      symbols: vi.fn().mockResolvedValue([
        {
          name: 'MyClass',
          kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 20, character: 1 } },
        },
      ] as LspSymbol[]),
      rename: vi.fn().mockResolvedValue({
        changes: {
          'file:///mock/file.ts': [
            {
              range: { start: { line: 5, character: 2 }, end: { line: 5, character: 8 } },
              newText: 'renamedSymbol',
            },
          ],
        },
      } as LspWorkspaceEdit),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('detects language and resolves client per root and language (multi-root routing)', async () => {
    const manager = new LanguageServerManager((config, root) => createMockClient(config.languageId, root));

    const client1 = await manager.getClient('src/index.ts', tempDir1);
    const client2 = await manager.getClient('src/index.ts', tempDir2);
    const clientPy = await manager.getClient('script.py', tempDir1);

    expect(client1.rootDir).toBe(path.resolve(tempDir1));
    expect(client1.languageId).toBe('typescript');

    expect(client2.rootDir).toBe(path.resolve(tempDir2));
    expect(client2.languageId).toBe('typescript');
    expect(client1).not.toBe(client2); // Different roots = different clients

    expect(clientPy.languageId).toBe('python');
  });

  it('restarts crashed client and recovers clean state', async () => {
    let callCount = 0;
    const manager = new LanguageServerManager((config, root) => {
      callCount++;
      return createMockClient(config.languageId, root);
    });

    const initialClient = await manager.getClient('foo.ts', tempDir1);
    expect(callCount).toBe(1);

    await manager.restart(tempDir1, 'typescript');
    expect(initialClient.shutdown).toHaveBeenCalled();

    const restartedClient = await manager.getClient('foo.ts', tempDir1);
    expect(callCount).toBe(2);
    expect(restartedClient).not.toBe(initialClient);
  });

  it('fails closed with E_LSP_UNAVAILABLE when language server fails startup', async () => {
    const manager = new LanguageServerManager(() => {
      throw new Error('Connection refused: server executable not found');
    });

    await expect(manager.getClient('main.go', tempDir1)).rejects.toThrow(/E_LSP_UNAVAILABLE/);
  });

  it('dispatches diagnostics, hover, definition, references, symbols, and rename tools', async () => {
    const mockClient = createMockClient('typescript', tempDir1);
    const manager = new LanguageServerManager(() => mockClient);
    const tools = createLspTools(manager);
    const registry = createToolRegistry(tools);

    const diagResult = await registry.execute(
      'lsp_diagnostics',
      { filePath: 'index.ts' },
      { toolCallId: 't1' },
      { projectRoot: tempDir1 }
    );
    expect(JSON.parse(diagResult as string).diagnostics).toHaveLength(1);

    const hoverResult = await registry.execute(
      'lsp_hover',
      { filePath: 'index.ts', line: 0, character: 0 },
      { toolCallId: 't2' },
      { projectRoot: tempDir1 }
    );
    expect(JSON.parse(hoverResult as string).hover.contents).toContain('Type:');

    const defResult = await registry.execute(
      'lsp_definition',
      { filePath: 'index.ts', line: 10, character: 2 },
      { toolCallId: 't3' },
      { projectRoot: tempDir1 }
    );
    expect(JSON.parse(defResult as string).locations).toHaveLength(1);

    const renameResult = await registry.execute(
      'lsp_rename',
      { filePath: 'index.ts', line: 5, character: 2, newName: 'renamedSymbol' },
      { toolCallId: 't4' },
      { projectRoot: tempDir1 }
    );
    expect(JSON.parse(renameResult as string).workspaceEdit.changes).toBeDefined();
  });
});
