import type { ToolDefinition } from '../types.js';
import type { LanguageServerManager } from './manager.js';

export function createLspTools(manager: LanguageServerManager): ToolDefinition[] {
  const diagnosticsTool: ToolDefinition = {
    name: 'lsp_diagnostics',
    aliases: ['diagnostics', 'omcu_lsp_diagnostics'],
    description: 'Query file diagnostics (errors, warnings, lints) from language server.',
    provider: 'sdk-custom',
    sideEffect: 'readOnly',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Relative or absolute file path to check' },
      },
      required: ['filePath'],
    },
    execute: async (args, _context, env) => {
      const filePath = String(args.filePath);
      const rootDir = env?.projectRoot ?? process.cwd();
      const diagnostics = await manager.getDiagnostics(filePath, rootDir);
      return JSON.stringify({ filePath, diagnostics }, null, 2);
    },
  };

  const hoverTool: ToolDefinition = {
    name: 'lsp_hover',
    aliases: ['hover', 'omcu_lsp_hover'],
    description: 'Get hover information (type documentation, signatures) at line and character.',
    provider: 'sdk-custom',
    sideEffect: 'readOnly',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Zero-based line index' },
        character: { type: 'number', description: 'Zero-based character index' },
      },
      required: ['filePath', 'line', 'character'],
    },
    execute: async (args, _context, env) => {
      const filePath = String(args.filePath);
      const line = Number(args.line);
      const character = Number(args.character);
      const rootDir = env?.projectRoot ?? process.cwd();
      const hover = await manager.getHover(filePath, { line, character }, rootDir);
      return JSON.stringify({ filePath, line, character, hover }, null, 2);
    },
  };

  const definitionTool: ToolDefinition = {
    name: 'lsp_definition',
    aliases: ['definition', 'omcu_lsp_definition'],
    description: 'Find definition locations for the symbol at line and character.',
    provider: 'sdk-custom',
    sideEffect: 'readOnly',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Zero-based line index' },
        character: { type: 'number', description: 'Zero-based character index' },
      },
      required: ['filePath', 'line', 'character'],
    },
    execute: async (args, _context, env) => {
      const filePath = String(args.filePath);
      const line = Number(args.line);
      const character = Number(args.character);
      const rootDir = env?.projectRoot ?? process.cwd();
      const locations = await manager.getDefinition(filePath, { line, character }, rootDir);
      return JSON.stringify({ filePath, line, character, locations }, null, 2);
    },
  };

  const referencesTool: ToolDefinition = {
    name: 'lsp_references',
    aliases: ['references', 'omcu_lsp_references'],
    description: 'Find all references for the symbol at line and character.',
    provider: 'sdk-custom',
    sideEffect: 'readOnly',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Zero-based line index' },
        character: { type: 'number', description: 'Zero-based character index' },
        includeDeclaration: { type: 'boolean', description: 'Include definition/declaration in results' },
      },
      required: ['filePath', 'line', 'character'],
    },
    execute: async (args, _context, env) => {
      const filePath = String(args.filePath);
      const line = Number(args.line);
      const character = Number(args.character);
      const includeDeclaration = args.includeDeclaration !== false;
      const rootDir = env?.projectRoot ?? process.cwd();
      const references = await manager.getReferences(filePath, { line, character }, rootDir, includeDeclaration);
      return JSON.stringify({ filePath, line, character, references }, null, 2);
    },
  };

  const symbolsTool: ToolDefinition = {
    name: 'lsp_symbols',
    aliases: ['symbols', 'omcu_lsp_symbols'],
    description: 'List symbols in document or workspace matching query.',
    provider: 'sdk-custom',
    sideEffect: 'readOnly',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'File path' },
        query: { type: 'string', description: 'Optional search query' },
      },
      required: ['filePath'],
    },
    execute: async (args, _context, env) => {
      const filePath = String(args.filePath);
      const query = args.query !== undefined ? String(args.query) : undefined;
      const rootDir = env?.projectRoot ?? process.cwd();
      const symbols = await manager.getSymbols(filePath, rootDir, query);
      return JSON.stringify({ filePath, symbols }, null, 2);
    },
  };

  const renameTool: ToolDefinition = {
    name: 'lsp_rename',
    aliases: ['rename', 'omcu_lsp_rename'],
    description: 'Preview or prepare symbol rename edits across files.',
    provider: 'sdk-custom',
    sideEffect: 'idempotent',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'File path' },
        line: { type: 'number', description: 'Zero-based line index' },
        character: { type: 'number', description: 'Zero-based character index' },
        newName: { type: 'string', description: 'New identifier name' },
      },
      required: ['filePath', 'line', 'character', 'newName'],
    },
    execute: async (args, _context, env) => {
      const filePath = String(args.filePath);
      const line = Number(args.line);
      const character = Number(args.character);
      const newName = String(args.newName);
      const rootDir = env?.projectRoot ?? process.cwd();
      const workspaceEdit = await manager.getRename(filePath, { line, character }, newName, rootDir);
      return JSON.stringify({ filePath, newName, workspaceEdit }, null, 2);
    },
  };

  return [
    diagnosticsTool,
    hoverTool,
    definitionTool,
    referencesTool,
    symbolsTool,
    renameTool,
  ];
}
