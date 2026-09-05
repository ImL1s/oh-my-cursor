import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '../types.js';
import { applyHashlineEdit, formatHashlineText } from './hashline.js';
import type { HashlineEditChunk } from './types.js';

export function createHashlineTools(): ToolDefinition[] {
  const readTool: ToolDefinition = {
    name: 'hashline_read',
    aliases: ['hashline_view', 'read_hashline'],
    description: 'Read file lines annotated with 1-based line numbers and 8-hex-character stable line hashes.',
    provider: 'sdk-custom',
    sideEffect: 'readOnly',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Relative or absolute file path' },
      },
      required: ['filePath'],
    },
    execute: async (args, _context, env) => {
      const filePath = String(args.filePath);
      const rootDir = env?.projectRoot ?? process.cwd();
      const resolved = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
      const content = fs.readFileSync(resolved, 'utf8');
      const formatted = formatHashlineText(content);
      return formatted;
    },
  };

  const editTool: ToolDefinition = {
    name: 'hashline_edit',
    aliases: ['edit_hashline', 'apply_hashline_edit'],
    description: 'Apply precision edits to a file anchored by line numbers and verified with expected line hashes to fail closed on stale edits.',
    provider: 'sdk-custom',
    sideEffect: 'destructive',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Target file path' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              startLine: { type: 'number', description: '1-based starting line' },
              endLine: { type: 'number', description: '1-based ending line' },
              expectedHashes: {
                type: 'array',
                items: { type: 'string' },
                description: 'Expected 8-character line hashes for the replaced lines',
              },
              newText: { type: 'string', description: 'Replacement content' },
            },
            required: ['startLine', 'endLine', 'newText'],
          },
          description: 'List of edit chunks to apply',
        },
        previewOnly: { type: 'boolean', description: 'If true, returns diff preview without writing to disk' },
      },
      required: ['filePath', 'edits'],
    },
    execute: async (args, _context, env) => {
      const filePath = String(args.filePath);
      const rootDir = env?.projectRoot ?? process.cwd();
      const resolved = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
      const content = fs.readFileSync(resolved, 'utf8');
      const rawEdits = (args.edits as unknown as HashlineEditChunk[]) ?? [];
      const previewOnly = Boolean(args.previewOnly);

      const result = applyHashlineEdit(content, rawEdits);

      if (!previewOnly) {
        fs.writeFileSync(resolved, result.modifiedContent, 'utf8');
      }

      return JSON.stringify(
        {
          filePath,
          applied: !previewOnly,
          modifiedLines: result.modifiedLines,
          diffPreview: result.diffPreview,
        },
        null,
        2
      );
    },
  };

  return [readTool, editTool];
}
