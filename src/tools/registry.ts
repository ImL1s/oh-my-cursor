import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  SDKCustomTool,
  SDKCustomToolContext,
  SDKCustomToolResult,
  SDKJsonValue,
} from '@cursor/sdk';
import type { AutoReviewHandler } from '../runtime/cursor-sdk/types.js';
import {
  ToolError,
  type SpilledArtifactReference,
  type ToolDefinition,
  type ToolExecutionContext,
} from './types.js';

export const DEFAULT_MAX_INLINE_BYTES = 32768; // 32 KiB

export class ToolRegistry {
  private readonly toolsByName = new Map<string, ToolDefinition>();
  private readonly aliasMap = new Map<string, string>();

  constructor(initialTools?: readonly ToolDefinition[]) {
    if (initialTools) {
      for (const tool of initialTools) {
        this.register(tool);
      }
    }
  }

  register(tool: ToolDefinition): void {
    if (this.toolsByName.has(tool.name)) {
      throw new ToolError(
        'E_TOOL_ALREADY_REGISTERED',
        `Tool '${tool.name}' is already registered`
      );
    }
    if (this.aliasMap.has(tool.name)) {
      throw new ToolError(
        'E_TOOL_ALREADY_REGISTERED',
        `Tool name '${tool.name}' conflicts with existing alias`
      );
    }

    if (tool.aliases) {
      for (const alias of tool.aliases) {
        if (this.toolsByName.has(alias) || this.aliasMap.has(alias)) {
          throw new ToolError(
            'E_TOOL_ALREADY_REGISTERED',
            `Alias '${alias}' for tool '${tool.name}' conflicts with an existing tool or alias`
          );
        }
      }
    }

    this.toolsByName.set(tool.name, tool);
    if (tool.aliases) {
      for (const alias of tool.aliases) {
        this.aliasMap.set(alias, tool.name);
      }
    }
  }

  get(nameOrAlias: string): ToolDefinition | undefined {
    const canonical = this.aliasMap.get(nameOrAlias) ?? nameOrAlias;
    return this.toolsByName.get(canonical);
  }

  has(nameOrAlias: string): boolean {
    const canonical = this.aliasMap.get(nameOrAlias) ?? nameOrAlias;
    return this.toolsByName.has(canonical);
  }

  list(): readonly ToolDefinition[] {
    return Array.from(this.toolsByName.values());
  }

  unregister(name: string): boolean {
    const tool = this.toolsByName.get(name);
    if (!tool) return false;
    this.toolsByName.delete(name);
    if (tool.aliases) {
      for (const alias of tool.aliases) {
        this.aliasMap.delete(alias);
      }
    }
    return true;
  }

  async execute(
    nameOrAlias: string,
    args: Record<string, SDKJsonValue>,
    context: SDKCustomToolContext,
    env?: ToolExecutionContext
  ): Promise<SDKCustomToolResult> {
    const tool = this.get(nameOrAlias);
    if (!tool) {
      throw new ToolError(
        'E_TOOL_NOT_FOUND',
        `Tool '${nameOrAlias}' was not found in registry`
      );
    }

    const timeoutMs = tool.timeoutMs ?? 30000;
    const maxInlineBytes = tool.maxInlineBytes ?? DEFAULT_MAX_INLINE_BYTES;

    const executePromise = Promise.resolve(tool.execute(args, context, env));

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new ToolError(
            'E_TOOL_TIMEOUT',
            `Tool '${tool.name}' timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);
    });

    try {
      const rawResult = await Promise.race([executePromise, timeoutPromise]);
      return this.handleSpill(rawResult, tool.name, maxInlineBytes, env?.projectRoot);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private handleSpill(
    result: SDKCustomToolResult,
    toolName: string,
    maxInlineBytes: number,
    projectRoot?: string
  ): SDKCustomToolResult {
    const serialized = typeof result === 'string' ? result : JSON.stringify(result);
    const sizeBytes = Buffer.byteLength(serialized, 'utf8');

    if (sizeBytes <= maxInlineBytes) {
      return result;
    }

    // Output exceeds threshold; spill to artifact directory
    const root = projectRoot ?? process.cwd();
    const artifactsDir = path.join(root, '.omcu', 'artifacts', 'tools');
    fs.mkdirSync(artifactsDir, { recursive: true });

    const timestamp = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    const isText = typeof result === 'string';
    const filename = `${toolName}-${timestamp}-${rand}.${isText ? 'txt' : 'json'}`;
    const artifactPath = path.join(artifactsDir, filename);

    fs.writeFileSync(artifactPath, serialized, 'utf8');

    const previewLength = Math.min(1000, serialized.length);
    const preview = serialized.slice(0, previewLength) + (serialized.length > previewLength ? '...' : '');

    const spillRef: SpilledArtifactReference = {
      spilled: true,
      artifactPath: path.relative(root, artifactPath),
      sizeBytes,
      preview,
      mimeType: isText ? 'text/plain' : 'application/json',
    };

    return JSON.stringify(spillRef, null, 2);
  }

  adaptToSdkCustomTools(options?: {
    autoReviewHandler?: AutoReviewHandler | undefined;
    projectRoot?: string | undefined;
  }): Record<string, SDKCustomTool> {
    const result: Record<string, SDKCustomTool> = {};

    for (const tool of this.toolsByName.values()) {
      const sdkTool: SDKCustomTool = {
        annotations: {
          readOnlyHint: tool.sideEffect === 'readOnly',
          destructiveHint: tool.sideEffect === 'destructive',
        },
        execute: async (
          args: Record<string, SDKJsonValue>,
          context: SDKCustomToolContext
        ): Promise<SDKCustomToolResult> => {
          if (options?.autoReviewHandler) {
            const decision = await options.autoReviewHandler({
              toolName: tool.name,
              toolArgs: args,
              toolCallId: context.toolCallId,
            });
            if (!decision.allowed) {
              throw new ToolError(
                'E_TOOL_PERMISSION_DENIED',
                decision.reason ?? `Execution of tool '${tool.name}' denied by review policy`
              );
            }
          }

          return await this.execute(tool.name, args, context, {
            projectRoot: options?.projectRoot,
          });
        },
      };

      if (tool.description) {
        sdkTool.description = tool.description;
      }
      if (tool.inputSchema) {
        sdkTool.inputSchema = tool.inputSchema;
      }
      if (tool.outputSchema) {
        sdkTool.outputSchema = tool.outputSchema;
      }

      result[tool.name] = sdkTool;

      // Also register aliases so they can be invoked under alias names
      if (tool.aliases) {
        for (const alias of tool.aliases) {
          result[alias] = {
            ...sdkTool,
            description: `[Alias for ${tool.name}] ${tool.description}`,
          };
        }
      }
    }

    return result;
  }
}

export function createToolRegistry(initialTools?: readonly ToolDefinition[]): ToolRegistry {
  return new ToolRegistry(initialTools);
}
