import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getHookRegistry } from '../../src/hooks/registry.js';
import { dispatchHook } from '../../src/hooks/dispatcher.js';

describe('Lifecycle Event Hooks (omcu-hook-lifecycle / omc_hooks / omx_subagent_stop)', () => {
  it('registers all canonical lifecycle handlers across tiers', () => {
    const registry = getHookRegistry();
    const handlers = registry.listHandlers();

    expect(handlers.length).toBeGreaterThanOrEqual(8);

    const ids = handlers.map((h) => h.id);
    expect(ids).toContain('omcu-hook-pre-step-gate');
    expect(ids).toContain('omcu-hook-lifecycle-pre-tool');
    expect(ids).toContain('omcu-hook-session-start');
    expect(ids).toContain('omcu-hook-before-prompt-context');
    expect(ids).toContain('omcu-hook-context-compact');
    expect(ids).toContain('omcu-hook-persist-stop');
    expect(ids).toContain('omcu-hook-subagent-stop');
    expect(ids).toContain('omcu-hook-after-agent-response');
    expect(ids).toContain('omcu-hook-post-step-audit');
  });

  it('orders handlers strictly by tier then priority then id', () => {
    const registry = getHookRegistry();
    const orderedPreTool = registry.getOrderedHandlersForEvent('preToolUse');

    expect(orderedPreTool.length).toBeGreaterThanOrEqual(2);
    // Tier 1 safety handlers must execute first
    for (let i = 0; i < orderedPreTool.length - 1; i++) {
      const a = orderedPreTool[i]!;
      const b = orderedPreTool[i + 1]!;
      if (a.tier === b.tier) {
        expect(a.priority).toBeLessThanOrEqual(b.priority);
      } else {
        expect(a.tier).toBeLessThan(b.tier);
      }
    }
  });

  it('handles sessionStart with neutral confirmation', async () => {
    const result = await dispatchHook('sessionStart', {});
    expect(result.success).toBe(true);
    expect(result.response).toEqual({});
  });

  it('handles beforeSubmitPrompt with continue: true per Cursor hook specification', async () => {
    const result = await dispatchHook('beforeSubmitPrompt', { prompt: 'implement feature X' });
    expect(result.success).toBe(true);
    expect(result.response).toEqual({ continue: true });
  });

  it('handles stop without active persist returning normal stop', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lifecycle-stop-'));
    try {
      const result = await dispatchHook('stop', { status: 'completed', loop_count: 1 }, { cwd: tempDir });
      expect(result.success).toBe(true);
      expect(result.response).toEqual({});
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('handles stop with active persist returning native followup_message', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lifecycle-active-'));
    try {
      const stateDir = path.join(tempDir, '.omcu');
      fs.mkdirSync(path.join(stateDir, 'persist'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'owner.json'), JSON.stringify({ token: 'tok', pid: process.pid }));

      const now = Date.now();
      fs.writeFileSync(path.join(stateDir, 'persist', 'state.json'), JSON.stringify({
        schema_version: 2,
        active: true,
        goal: 'reach target milestone',
        max_loops: 10,
        consumed_loops: 2,
        last_host_loop_count: null,
        revision: 1,
        deadline_ms: now + 60000,
        created_at_ms: now,
        done: false,
        last_event_id: null,
        last_decision_at_ms: null,
        last_decision_reason: null,
      }));

      const result = await dispatchHook('stop', { status: 'completed', loop_count: 2 }, { cwd: tempDir });
      expect(result.success).toBe(true);
      expect(result.response.followup_message).toBeDefined();
      expect(typeof result.response.followup_message).toBe('string');
      expect((result.response.followup_message as string)).toContain('reach target milestone');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('handles subagentStop with active persist returning native followup_message', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lifecycle-subagent-'));
    try {
      const stateDir = path.join(tempDir, '.omcu');
      fs.mkdirSync(path.join(stateDir, 'persist'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'owner.json'), JSON.stringify({ token: 'tok', pid: process.pid }));

      const now = Date.now();
      fs.writeFileSync(path.join(stateDir, 'persist', 'state.json'), JSON.stringify({
        schema_version: 2,
        active: true,
        goal: 'subagent task goal',
        max_loops: 5,
        consumed_loops: 1,
        last_host_loop_count: null,
        revision: 1,
        deadline_ms: now + 60000,
        created_at_ms: now,
        done: false,
        last_event_id: null,
        last_decision_at_ms: null,
        last_decision_reason: null,
      }));

      const result = await dispatchHook('subagentStop', { status: 'completed', loop_count: 1 }, { cwd: tempDir });
      expect(result.success).toBe(true);
      expect(result.response.followup_message).toBeDefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects attempts by non-immutable handlers to override Tier 1 safety handlers', () => {
    const registry = getHookRegistry();
    expect(() => {
      registry.register({
        id: 'fake-safety-override',
        name: 'Fake Safety',
        description: 'Trying to register into Tier 1 without immutable flag',
        event: 'preToolUse',
        tier: 1,
        priority: 1,
        timeoutMs: 1000,
        maxInputBytes: 1024,
        failurePolicy: 'fail_closed',
        sourceAnalogs: {},
        stateAccess: 'none',
        immutable: false,
        supportedRuntimes: ['local'],
        handler: () => ({ handled: true }),
      });
    }).toThrow(/E_HOOK_TIER_VIOLATION/);
  });

  it('rejects unknown or unsupported hook events with E_HOOK_UNKNOWN_EVENT', async () => {
    const result = await dispatchHook('unsupported_custom_event', {});
    expect(result.success).toBe(false);
    expect(result.denied).toBe(true);
    expect(result.errorCode).toBe('E_HOOK_UNKNOWN_EVENT');
    expect(result.reason).toContain('Unknown or unsupported hook event');
  });

  it('rejects hook input exceeding MAX_INPUT_BYTES whether string or object', async () => {
    // String exceeding 1MB
    const largeString = JSON.stringify({ data: 'x'.repeat(1024 * 1024 + 10) });
    await expect(dispatchHook('preToolUse', largeString)).rejects.toThrow('E_HOOK_INPUT_TOO_LARGE');

    // Object exceeding 1MB
    const largeObject = { data: 'x'.repeat(1024 * 1024 + 10) };
    await expect(dispatchHook('preToolUse', largeObject)).rejects.toThrow('E_HOOK_INPUT_TOO_LARGE');
  });
});
