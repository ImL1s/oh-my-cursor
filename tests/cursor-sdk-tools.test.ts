import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adaptCustomTools,
  createAutoReviewHandler,
  loadCursorPermissions,
  toSdkCustomTool,
  type OmcuToolDefinition,
} from '../src/runtime/cursor-sdk/index.js';

describe('Cursor SDK Custom Tools and Auto-Review Boundary', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-sdk-tools-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('toSdkCustomTool & adaptCustomTools', () => {
    it('adapts OmcuToolDefinition to SDKCustomTool preserving schemas and hints', async () => {
      const toolDef: OmcuToolDefinition = {
        name: 'test_tool',
        description: 'A test custom tool',
        readOnly: true,
        destructive: false,
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
        execute: async (args) => {
          return `Processed: ${String(args.query)}`;
        },
      };

      const sdkTool = toSdkCustomTool(toolDef);
      expect(sdkTool.description).toBe('A test custom tool');
      expect(sdkTool.annotations?.readOnlyHint).toBe(true);
      expect(sdkTool.annotations?.destructiveHint).toBe(false);
      expect(sdkTool.inputSchema).toBeDefined();

      const result = await sdkTool.execute({ query: 'hello' }, { toolCallId: 'call-1' });
      expect(result).toBe('Processed: hello');
    });

    it('adapts a list of tools into a record keyed by tool name', () => {
      const tools: OmcuToolDefinition[] = [
        { name: 'tool_a', execute: () => 'a' },
        { name: 'tool_b', execute: () => 'b' },
      ];
      const adapted = adaptCustomTools(tools);
      expect(Object.keys(adapted).sort()).toEqual(['tool_a', 'tool_b']);
    });
  });

  describe('permissions.json & Auto-Review Enforcement', () => {
    it('loads permissions from .cursor/permissions.json', () => {
      const cursorDir = path.join(tempDir, '.cursor');
      fs.mkdirSync(cursorDir, { recursive: true });
      fs.writeFileSync(
        path.join(cursorDir, 'permissions.json'),
        JSON.stringify({
          schema_version: 1,
          allow: ['safe_read'],
          deny: ['dangerous_exec'],
          auto_review: true,
        })
      );

      const perms = loadCursorPermissions(tempDir);
      expect(perms).not.toBeNull();
      expect(perms?.allow).toContain('safe_read');
      expect(perms?.deny).toContain('dangerous_exec');
      expect(perms?.auto_review).toBe(true);
    });

    it('rejects execution and throws E_PERMISSION_DENIED when tool is denied', async () => {
      const perms = {
        allow: [],
        deny: ['dangerous_tool'],
      };
      const handler = createAutoReviewHandler(perms);

      const tool: OmcuToolDefinition = {
        name: 'dangerous_tool',
        execute: vi.fn().mockReturnValue('should not run'),
      };
      const sdkTool = toSdkCustomTool(tool, handler);

      await expect(
        sdkTool.execute({}, { toolCallId: 'call-deny' })
      ).rejects.toThrow(/E_PERMISSION_DENIED: Tool 'dangerous_tool' is explicitly denied by permissions.json/);
      expect(tool.execute).not.toHaveBeenCalled();
    });

    it('permits execution when tool is allowed by permissions or custom policy', async () => {
      const perms = {
        allow: ['safe_tool'],
        deny: [],
      };
      const customPolicy = vi.fn().mockResolvedValue({ allowed: true });
      const handler = createAutoReviewHandler(perms, customPolicy);

      const tool: OmcuToolDefinition = {
        name: 'safe_tool',
        execute: vi.fn().mockReturnValue('success'),
      };
      const sdkTool = toSdkCustomTool(tool, handler);

      const res = await sdkTool.execute({ key: 'val' }, { toolCallId: 'call-allow' });
      expect(res).toBe('success');
      expect(tool.execute).toHaveBeenCalled();
      // Since it's in allow list, custom policy doesn't even need to be called
      expect(customPolicy).not.toHaveBeenCalled();
    });

    it('invokes custom policy when tool is neither in allow nor deny lists', async () => {
      const perms = {
        allow: ['other_tool'],
        deny: [],
      };
      const customPolicy = vi.fn().mockResolvedValue({ allowed: false, reason: 'Custom block' });
      const handler = createAutoReviewHandler(perms, customPolicy);

      const tool: OmcuToolDefinition = {
        name: 'unlisted_tool',
        execute: vi.fn(),
      };
      const sdkTool = toSdkCustomTool(tool, handler);

      await expect(
        sdkTool.execute({}, { toolCallId: 'call-custom' })
      ).rejects.toThrow(/E_PERMISSION_DENIED: Custom block/);
      expect(customPolicy).toHaveBeenCalledWith(expect.objectContaining({
        toolName: 'unlisted_tool',
      }));
      expect(tool.execute).not.toHaveBeenCalled();
    });
  });
});
