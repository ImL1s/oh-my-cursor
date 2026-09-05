import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ToolError, type ToolDefinition } from '../types.js';
import { getAstGrepRunner } from './ast-grep.js';

export function createAstTools(): ToolDefinition[] {
  const searchTool: ToolDefinition = {
    name: 'ast_grep_search',
    aliases: ['ast_search', 'sg_search'],
    description: 'Search source code using ast-grep structural patterns. Never falls back to regex.',
    provider: 'sdk-custom',
    sideEffect: 'readOnly',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ast-grep structural pattern (e.g. "console.log($$$A)")' },
        language: { type: 'string', description: 'Target programming language' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths or globs to search within',
        },
      },
      required: ['pattern'],
    },
    execute: async (args, _context, env) => {
      const runner = getAstGrepRunner();
      const pattern = String(args.pattern);
      const language = args.language !== undefined ? String(args.language) : undefined;
      const paths = args.paths !== undefined ? (args.paths as string[]) : undefined;
      const rootDir = env?.projectRoot ?? process.cwd();

      const available = await runner.isAvailable(language);
      if (!available) {
        throw new ToolError(
          'E_AST_PARSER_UNAVAILABLE',
          `ast-grep parser is not available for language '${language ?? 'auto'}'. Regex fallback is prohibited for AST operations.`
        );
      }

      const matches = await runner.search({
        pattern,
        language,
        paths,
        rootDir,
      });

      return JSON.stringify({ pattern, language, matchCount: matches.length, matches }, null, 2);
    },
  };

  const rewriteTool: ToolDefinition = {
    name: 'ast_grep_rewrite',
    aliases: ['ast_rewrite', 'sg_rewrite'],
    description: 'Rewrite code using ast-grep structural patterns with diff preview and evidence artifact packaging.',
    provider: 'sdk-custom',
    sideEffect: 'destructive',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'ast-grep structural pattern to match' },
        rewrite: { type: 'string', description: 'Replacement pattern with metavariables' },
        language: { type: 'string', description: 'Target programming language' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths to rewrite',
        },
        dryRun: { type: 'boolean', description: 'Generate preview diff without modifying files' },
      },
      required: ['pattern', 'rewrite'],
    },
    execute: async (args, _context, env) => {
      const runner = getAstGrepRunner();
      const pattern = String(args.pattern);
      const rewrite = String(args.rewrite);
      const language = args.language !== undefined ? String(args.language) : undefined;
      const paths = args.paths !== undefined ? (args.paths as string[]) : undefined;
      const dryRun = Boolean(args.dryRun);
      const rootDir = env?.projectRoot ?? process.cwd();

      const available = await runner.isAvailable(language);
      if (!available) {
        throw new ToolError(
          'E_AST_PARSER_UNAVAILABLE',
          `ast-grep parser is not available for language '${language ?? 'auto'}'. Regex fallback is prohibited for AST operations.`
        );
      }

      const result = await runner.rewrite({
        pattern,
        rewrite,
        language,
        paths,
        rootDir,
        dryRun,
      });

      // Package evidence artifact under .omcu/artifacts/ast/
      const artifactsDir = path.join(rootDir, '.omcu', 'artifacts', 'ast');
      fs.mkdirSync(artifactsDir, { recursive: true });
      const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      const artifactPath = path.join(artifactsDir, `rewrite-${id}.json`);

      const artifactContent = {
        pattern,
        rewrite,
        language,
        paths,
        dryRun,
        applied: result.applied,
        diff: result.diff,
        timestamp: new Date().toISOString(),
      };
      fs.writeFileSync(artifactPath, JSON.stringify(artifactContent, null, 2), 'utf8');

      return JSON.stringify(
        {
          applied: result.applied,
          diff: result.diff,
          evidenceArtifact: path.relative(rootDir, artifactPath),
        },
        null,
        2
      );
    },
  };

  return [searchTool, rewriteTool];
}
