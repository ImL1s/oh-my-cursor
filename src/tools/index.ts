import { createAstTools } from './ast/tools.js';
import { createDomainTools } from './domain/tools.js';
import { createGitTools } from './git/tools.js';
import { GitWorktreeRunner, defaultGitWorktreeRunner } from './git/worktree-runner.js';
import { createHashlineTools } from './hashline/tools.js';
import { LanguageServerManager } from './lsp/manager.js';
import { createLspTools } from './lsp/tools.js';
import { createToolRegistry, ToolRegistry, DEFAULT_MAX_INLINE_BYTES } from './registry.js';
import { createResearchTools } from './research/tools.js';
import type { ToolDefinition } from './types.js';
import { createVisualTools } from './visual/tools.js';

export * from './types.js';
export * from './registry.js';

export * from './lsp/index.js';
export * from './hashline/index.js';
export * from './ast/index.js';
export * from './git/index.js';
export * from './research/index.js';
export * from './visual/index.js';
export * from './domain/index.js';

export * as lsp from './lsp/index.js';
export * as hashline from './hashline/index.js';
export * as ast from './ast/index.js';
export * as git from './git/index.js';
export * as research from './research/index.js';
export * as visual from './visual/index.js';
export * as domain from './domain/index.js';

export interface CreateDefaultToolsOptions {
  readonly lspManager?: LanguageServerManager | undefined;
  readonly gitRunner?: GitWorktreeRunner | undefined;
  readonly extraTools?: readonly ToolDefinition[] | undefined;
}

export function createDefaultToolRegistry(options?: CreateDefaultToolsOptions): ToolRegistry {
  const lspManager = options?.lspManager ?? new LanguageServerManager();
  const gitRunner = options?.gitRunner ?? defaultGitWorktreeRunner;

  const registry = createToolRegistry();

  // Register all deterministic tool families
  for (const tool of createLspTools(lspManager)) {
    registry.register(tool);
  }
  for (const tool of createHashlineTools()) {
    registry.register(tool);
  }
  for (const tool of createAstTools()) {
    registry.register(tool);
  }
  for (const tool of createGitTools(gitRunner)) {
    registry.register(tool);
  }
  for (const tool of createResearchTools()) {
    registry.register(tool);
  }
  for (const tool of createVisualTools()) {
    registry.register(tool);
  }
  for (const tool of createDomainTools()) {
    registry.register(tool);
  }

  if (options?.extraTools) {
    for (const tool of options.extraTools) {
      registry.register(tool);
    }
  }

  return registry;
}
