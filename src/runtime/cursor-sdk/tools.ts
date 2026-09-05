import fs from 'node:fs';
import path from 'node:path';
import type {
  SDKCustomTool,
  SDKCustomToolContext,
  SDKCustomToolResult,
  SDKJsonValue,
} from '@cursor/sdk';
import { CursorRuntimeError } from './errors.js';
import type { AutoReviewHandler } from './types.js';

export interface OmcuToolDefinition {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: Record<string, SDKJsonValue> | undefined;
  readonly outputSchema?: Record<string, SDKJsonValue> | undefined;
  readonly readOnly?: boolean | undefined;
  readonly destructive?: boolean | undefined;
  readonly execute: (
    args: Record<string, SDKJsonValue>,
    context: SDKCustomToolContext
  ) => Promise<SDKCustomToolResult> | SDKCustomToolResult;
}

export interface CursorPermissionsConfig {
  readonly schema_version?: number | undefined;
  readonly allow?: readonly string[] | undefined;
  readonly deny?: readonly string[] | undefined;
  readonly auto_review?: boolean | undefined;
}

export function loadCursorPermissions(baseDir: string): CursorPermissionsConfig | null {
  const candidates = [
    path.join(baseDir, '.cursor', 'permissions.json'),
    path.join(baseDir, 'permissions.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf8');
        return JSON.parse(raw) as CursorPermissionsConfig;
      } catch {
        // Fallthrough if unreadable
      }
    }
  }
  return null;
}

export function createAutoReviewHandler(
  permissions: CursorPermissionsConfig | null,
  customPolicy?: AutoReviewHandler | undefined
): AutoReviewHandler {
  return async (args) => {
    if (permissions) {
      if (permissions.deny && permissions.deny.includes(args.toolName)) {
        return {
          allowed: false,
          reason: `Tool '${args.toolName}' is explicitly denied by permissions.json`,
        };
      }
      if (permissions.allow && permissions.allow.includes(args.toolName)) {
        return { allowed: true };
      }
    }
    if (customPolicy) {
      return await customPolicy(args);
    }
    return { allowed: true };
  };
}

export function toSdkCustomTool(
  tool: OmcuToolDefinition,
  autoReviewHandler?: AutoReviewHandler | undefined
): SDKCustomTool {
  const sdkTool: SDKCustomTool = {
    annotations: {
      readOnlyHint: tool.readOnly ?? false,
      destructiveHint: tool.destructive ?? false,
    },
    execute: async (
      args: Record<string, SDKJsonValue>,
      context: SDKCustomToolContext
    ): Promise<SDKCustomToolResult> => {
      if (autoReviewHandler) {
        const decision = await autoReviewHandler({
          toolName: tool.name,
          toolArgs: args,
          toolCallId: context.toolCallId,
        });
        if (!decision.allowed) {
          throw new CursorRuntimeError(
            'E_PERMISSION_DENIED',
            decision.reason ?? `Execution of tool '${tool.name}' denied by review policy`
          );
        }
      }
      return await tool.execute(args, context);
    },
  };

  if (tool.description !== undefined) {
    sdkTool.description = tool.description;
  }
  if (tool.inputSchema !== undefined) {
    sdkTool.inputSchema = tool.inputSchema;
  }
  if (tool.outputSchema !== undefined) {
    sdkTool.outputSchema = tool.outputSchema;
  }

  return sdkTool;
}

export function adaptCustomTools(
  tools: readonly OmcuToolDefinition[],
  autoReviewHandler?: AutoReviewHandler | undefined
): Record<string, SDKCustomTool> {
  const result: Record<string, SDKCustomTool> = {};
  for (const tool of tools) {
    result[tool.name] = toSdkCustomTool(tool, autoReviewHandler);
  }
  return result;
}
