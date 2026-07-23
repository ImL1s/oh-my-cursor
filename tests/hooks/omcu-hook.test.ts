import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseHookInput, redactHookValue, responseForEvent, SUPPORTED_EVENTS } from '../../hooks/omcu-hook.mjs';

const root = path.resolve(import.meta.dirname, '../..');

describe('Cursor lifecycle hooks', () => {
  it('registers only supported Cursor camelCase events requested by the plugin', () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8')) as {
      version: number;
      hooks: Record<string, Array<{ command: string; matcher?: string }>>;
    };
    expect(config.version).toBe(1);
    expect(Object.keys(config.hooks)).toEqual([
      'sessionStart', 'preToolUse', 'beforeSubmitPrompt', 'preCompact', 'stop', 'subagentStop',
    ]);
    expect(new Set(Object.keys(config.hooks))).toEqual(SUPPORTED_EVENTS);
    expect(config.hooks.preToolUse).toEqual([
      { command: 'node ${CURSOR_PLUGIN_ROOT}/hooks/omcu-hook.mjs preToolUse', matcher: 'Shell' },
    ]);
  });

  it('redacts hook input without persisting or returning it', () => {
    expect(redactHookValue({ token: 'secret', nested: { authorization: 'Bearer abc' }, prompt: 'password=hunter2 hello' })).toEqual({
      token: '<redacted>', nested: { authorization: '<redacted>' }, prompt: 'password=<redacted> hello',
    });
    expect(parseHookInput('{"apiKey":"secret","prompt":"safe"}')).toEqual({ apiKey: '<redacted>', prompt: 'safe' });
    expect(responseForEvent('preToolUse')).toEqual({});
    expect(responseForEvent('stop')).toEqual({});
    expect(responseForEvent('beforeSubmitPrompt')).toEqual({ continue: true });
  });

  it('fails with a bounded diagnostic and never echoes malformed or secret input', () => {
    const result = spawnSync(process.execPath, [path.join(root, 'hooks/omcu-hook.mjs'), 'preToolUse'], {
      input: '{"token":"TOP_SECRET",', encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('E_HOOK_INPUT_INVALID');
    expect(result.stderr).not.toContain('TOP_SECRET');
  });

  it('returns neutral JSON and does not claim permission, sandbox, pass, or verification authority', () => {
    const output = execFileSync(process.execPath, [path.join(root, 'hooks/omcu-hook.mjs'), 'preToolUse'], {
      input: '{"tool_name":"Shell","tool_input":{"command":"npm test"}}', encoding: 'utf8',
    });
    expect(JSON.parse(output)).toEqual({});
    const source = fs.readFileSync(path.join(root, 'hooks/omcu-hook.mjs'), 'utf8');
    expect(source).not.toMatch(/writeFile|appendFile|mkdir|verification\s*[:=]|passes\s*[:=]/);
    expect(source).not.toMatch(/permission\s*:\s*['"]allow|sandbox(?:ed)?\s*:\s*true/i);
  });
});
