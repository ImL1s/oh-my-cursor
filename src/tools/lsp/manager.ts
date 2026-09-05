import path from 'node:path';
import { ToolError } from '../types.js';
import type {
  ILspClient,
  LspDiagnostic,
  LspHoverResult,
  LspLocation,
  LspPosition,
  LspServerConfig,
  LspSymbol,
  LspWorkspaceEdit,
} from './types.js';

export type LspClientFactory = (
  config: LspServerConfig,
  rootDir: string
) => Promise<ILspClient> | ILspClient;

export const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.json': 'json',
  '.md': 'markdown',
  '.css': 'css',
  '.html': 'html',
};

export class LanguageServerManager {
  private readonly clients = new Map<string, ILspClient>();
  private readonly customConfigs = new Map<string, LspServerConfig>();
  private clientFactory?: LspClientFactory | undefined;

  constructor(clientFactory?: LspClientFactory | undefined) {
    this.clientFactory = clientFactory;
  }

  setClientFactory(factory: LspClientFactory): void {
    this.clientFactory = factory;
  }

  registerServerConfig(config: LspServerConfig): void {
    this.customConfigs.set(config.languageId, config);
  }

  detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const lang = EXTENSION_LANGUAGE_MAP[ext];
    if (!lang) {
      throw new ToolError(
        'E_LSP_UNAVAILABLE',
        `No language server mapping registered for file extension '${ext}' (${filePath})`
      );
    }
    return lang;
  }

  resolveClientKey(rootDir: string, languageId: string): string {
    return `${path.resolve(rootDir)}::${languageId}`;
  }

  async getClient(filePath: string, rootDir: string): Promise<ILspClient> {
    const languageId = this.detectLanguage(filePath);
    const resolvedRoot = path.resolve(rootDir);
    const key = this.resolveClientKey(resolvedRoot, languageId);

    const existing = this.clients.get(key);
    if (existing) {
      return existing;
    }

    if (!this.clientFactory) {
      throw new ToolError(
        'E_LSP_UNAVAILABLE',
        `LSP client factory is not configured, and language server for '${languageId}' is not running`
      );
    }

    const config: LspServerConfig = this.customConfigs.get(languageId) ?? {
      languageId,
      command: `${languageId}-language-server`,
      rootDir: resolvedRoot,
    };

    try {
      const client = await this.clientFactory(config, resolvedRoot);
      this.clients.set(key, client);
      return client;
    } catch (err) {
      throw new ToolError(
        'E_LSP_UNAVAILABLE',
        `Failed to initialize language server for '${languageId}' at '${resolvedRoot}': ${
          err instanceof Error ? err.message : String(err)
        }`,
        err
      );
    }
  }

  async restart(rootDir: string, languageId: string): Promise<void> {
    const resolvedRoot = path.resolve(rootDir);
    const key = this.resolveClientKey(resolvedRoot, languageId);
    const existing = this.clients.get(key);
    if (existing) {
      this.clients.delete(key);
      try {
        await existing.shutdown();
      } catch {
        // Suppress errors on dead client cleanup
      }
    }
  }

  async shutdown(): Promise<void> {
    const all = Array.from(this.clients.values());
    this.clients.clear();
    await Promise.allSettled(all.map((c) => c.shutdown()));
  }

  // High-level operations with bounded execution
  async getDiagnostics(filePath: string, rootDir: string): Promise<readonly LspDiagnostic[]> {
    const client = await this.getClient(filePath, rootDir);
    return await client.diagnostics(filePath);
  }

  async getHover(
    filePath: string,
    position: LspPosition,
    rootDir: string
  ): Promise<LspHoverResult | null> {
    const client = await this.getClient(filePath, rootDir);
    return await client.hover(filePath, position);
  }

  async getDefinition(
    filePath: string,
    position: LspPosition,
    rootDir: string
  ): Promise<readonly LspLocation[]> {
    const client = await this.getClient(filePath, rootDir);
    return await client.definition(filePath, position);
  }

  async getReferences(
    filePath: string,
    position: LspPosition,
    rootDir: string,
    includeDeclaration = true
  ): Promise<readonly LspLocation[]> {
    const client = await this.getClient(filePath, rootDir);
    return await client.references(filePath, position, includeDeclaration);
  }

  async getSymbols(
    filePath: string,
    rootDir: string,
    query?: string
  ): Promise<readonly LspSymbol[]> {
    const client = await this.getClient(filePath, rootDir);
    return await client.symbols(filePath, query);
  }

  async getRename(
    filePath: string,
    position: LspPosition,
    newName: string,
    rootDir: string
  ): Promise<LspWorkspaceEdit> {
    const client = await this.getClient(filePath, rootDir);
    return await client.rename(filePath, position, newName);
  }
}
