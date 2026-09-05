import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createToolRegistry,
  ToolRegistry,
  type ToolDefinition,
} from '../../src/tools/index.js';

describe('ToolRegistry', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-tools-registry-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers tools with canonical names and aliases', () => {
    const registry = createToolRegistry();
    const tool: ToolDefinition = {
      name: 'canonical_tool',
      aliases: ['tool_alias_1', 'tool_alias_2'],
      description: 'A test tool',
      provider: 'sdk-custom',
      sideEffect: 'readOnly',
      execute: async () => 'ok',
    };

    registry.register(tool);
    expect(registry.has('canonical_tool')).toBe(true);
    expect(registry.has('tool_alias_1')).toBe(true);
    expect(registry.has('tool_alias_2')).toBe(true);
    expect(registry.get('tool_alias_1')?.name).toBe('canonical_tool');
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects duplicate registration and alias collisions', () => {
    const registry = createToolRegistry();
    const tool1: ToolDefinition = {
      name: 'tool_one',
      aliases: ['shared_alias'],
      description: 'First',
      provider: 'sdk-custom',
      sideEffect: 'readOnly',
      execute: async () => '1',
    };
    const tool2: ToolDefinition = {
      name: 'tool_two',
      aliases: ['shared_alias'],
      description: 'Second',
      provider: 'sdk-custom',
      sideEffect: 'readOnly',
      execute: async () => '2',
    };

    registry.register(tool1);
    expect(() => registry.register(tool1)).toThrow(/E_TOOL_ALREADY_REGISTERED/);
    expect(() => registry.register(tool2)).toThrow(/E_TOOL_ALREADY_REGISTERED/);
  });

  it('executes tool within timeout and unregisters properly', async () => {
    const registry = createToolRegistry();
    const tool: ToolDefinition = {
      name: 'quick_tool',
      description: 'Fast',
      provider: 'sdk-custom',
      sideEffect: 'idempotent',
      timeoutMs: 1000,
      execute: async (args) => `Echo: ${String(args.val)}`,
    };

    registry.register(tool);
    const result = await registry.execute('quick_tool', { val: 'hello' }, { toolCallId: 'c1' });
    expect(result).toBe('Echo: hello');

    expect(registry.unregister('quick_tool')).toBe(true);
    expect(registry.has('quick_tool')).toBe(false);
  });

  it('times out and throws E_TOOL_TIMEOUT when tool execution exceeds timeoutMs', async () => {
    const registry = createToolRegistry();
    const slowTool: ToolDefinition = {
      name: 'slow_tool',
      description: 'Hangs',
      provider: 'sdk-custom',
      sideEffect: 'readOnly',
      timeoutMs: 50,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return 'too late';
      },
    };

    registry.register(slowTool);
    await expect(
      registry.execute('slow_tool', {}, { toolCallId: 'c-slow' })
    ).rejects.toThrow(/E_TOOL_TIMEOUT/);
  });

  it('spills large results exceeding maxInlineBytes to .omcu/artifacts/tools/', async () => {
    const registry = createToolRegistry();
    const largeContent = 'A'.repeat(5000);

    const spillTool: ToolDefinition = {
      name: 'spill_tool',
      description: 'Produces large output',
      provider: 'sdk-custom',
      sideEffect: 'readOnly',
      maxInlineBytes: 500, // Small threshold for test
      execute: async () => largeContent,
    };

    registry.register(spillTool);
    const result = await registry.execute(
      'spill_tool',
      {},
      { toolCallId: 'c-spill' },
      { projectRoot: tempDir }
    );

    const parsed = JSON.parse(result as string);
    expect(parsed.spilled).toBe(true);
    expect(parsed.sizeBytes).toBe(5000);
    expect(parsed.artifactPath).toContain('.omcu/artifacts/tools/spill_tool-');
    expect(fs.existsSync(path.join(tempDir, parsed.artifactPath))).toBe(true);
  });

  it('adapts tools to SDKCustomTool record respecting autoReview policy', async () => {
    const registry = createToolRegistry();
    const tool: ToolDefinition = {
      name: 'guarded_tool',
      description: 'Permission guarded',
      provider: 'sdk-custom',
      sideEffect: 'destructive',
      execute: async () => 'executed',
    };
    registry.register(tool);

    const autoReviewPolicy = vi.fn().mockImplementation(async (args) => {
      if (args.toolName === 'guarded_tool') {
        return { allowed: false, reason: 'Manual review required' };
      }
      return { allowed: true };
    });

    const adapted = registry.adaptToSdkCustomTools({
      autoReviewHandler: autoReviewPolicy,
      projectRoot: tempDir,
    });

    expect(adapted.guarded_tool).toBeDefined();
    expect(adapted.guarded_tool.annotations?.destructiveHint).toBe(true);
    expect(adapted.guarded_tool.annotations?.readOnlyHint).toBe(false);

    await expect(
      adapted.guarded_tool.execute({}, { toolCallId: 'call-guard' })
    ).rejects.toThrow(/E_TOOL_PERMISSION_DENIED: Manual review required/);
  });
});
