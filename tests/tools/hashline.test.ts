import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyHashlineEdit,
  computeLineHash,
  createHashlineTools,
  createToolRegistry,
  formatHashlines,
  formatHashlineText,
} from '../../src/tools/index.js';

describe('Hashline Precision Editing Tools', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-hashline-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const sampleFileContent = [
    'import fs from "node:fs";',
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
  ].join('\n');

  it('computes deterministic line hashes and formats lines', () => {
    const hash1 = computeLineHash('import fs from "node:fs";');
    const hash2 = computeLineHash('import fs from "node:fs";\r');
    expect(hash1).toHaveLength(8);
    expect(hash1).toBe(hash2); // Carriage return normalized

    const lines = formatHashlines(sampleFileContent);
    expect(lines).toHaveLength(4);
    expect(lines[0].line).toBe(1);
    expect(lines[0].hash).toBe(hash1);

    const text = formatHashlineText(sampleFileContent);
    expect(text).toContain(`1 #${hash1}: import fs from "node:fs";`);
  });

  it('applies hashline edits when expected hashes match', () => {
    const lines = formatHashlines(sampleFileContent);
    const line3Hash = lines[2].hash; // return a + b;

    const result = applyHashlineEdit(sampleFileContent, [
      {
        startLine: 3,
        endLine: 3,
        expectedHashes: [line3Hash],
        newText: '  // modified return\n  return (a + b) * 2;',
      },
    ]);

    expect(result.success).toBe(true);
    expect(result.modifiedContent).toContain('return (a + b) * 2;');
    expect(result.diffPreview).toContain('-   return a + b;');
    expect(result.diffPreview).toContain('+   return (a + b) * 2;');
  });

  it('fails closed with E_STALE_EDIT when expected line hash does not match current content', () => {
    expect(() =>
      applyHashlineEdit(sampleFileContent, [
        {
          startLine: 3,
          endLine: 3,
          expectedHashes: ['00000000'], // Deliberately wrong hash
          newText: 'return 0;',
        },
      ])
    ).toThrow(/E_STALE_EDIT/);
  });

  it('dispatches hashline_read and hashline_edit tools through ToolRegistry', async () => {
    const filePath = path.join(tempDir, 'math.ts');
    fs.writeFileSync(filePath, sampleFileContent, 'utf8');

    const registry = createToolRegistry(createHashlineTools());

    // 1. Read hashline
    const readOutput = await registry.execute(
      'hashline_read',
      { filePath },
      { toolCallId: 'r1' },
      { projectRoot: tempDir }
    );
    expect(typeof readOutput).toBe('string');
    expect(readOutput as string).toContain('1 #');

    // 2. Extract hash of line 1
    const line1 = formatHashlines(sampleFileContent)[0];

    // 3. Apply edit previewOnly
    const previewOutput = await registry.execute(
      'hashline_edit',
      {
        filePath,
        edits: [
          {
            startLine: 1,
            endLine: 1,
            expectedHashes: [line1.hash],
            newText: 'import path from "node:path";',
          },
        ],
        previewOnly: true,
      },
      { toolCallId: 'e1' },
      { projectRoot: tempDir }
    );
    const parsedPreview = JSON.parse(previewOutput as string);
    expect(parsedPreview.applied).toBe(false);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(sampleFileContent); // Not modified yet

    // 4. Apply actual edit
    const editOutput = await registry.execute(
      'hashline_edit',
      {
        filePath,
        edits: [
          {
            startLine: 1,
            endLine: 1,
            expectedHashes: [line1.hash],
            newText: 'import path from "node:path";',
          },
        ],
      },
      { toolCallId: 'e2' },
      { projectRoot: tempDir }
    );
    const parsedEdit = JSON.parse(editOutput as string);
    expect(parsedEdit.applied).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('import path from "node:path";');
  });
});
