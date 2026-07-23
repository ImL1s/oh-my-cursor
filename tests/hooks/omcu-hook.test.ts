import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isMainEntry,
  parseHookInput,
  persistFollowup,
  redactHookValue,
  resolveOmcuEntrypoint,
  responseForEvent,
  runHook,
  SUPPORTED_EVENTS,
} from '../../hooks/omcu-hook.mjs';

const root = path.resolve(import.meta.dirname, '../..');

function fakeRunner(stdout, status = 0) {
  return () => ({ status, stdout, stderr: '' });
}

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
    // stop/subagentStop carry loop_limit as the outermost persist safety cap.
    expect(config.hooks.stop[0]).toMatchObject({ loop_limit: 500 });
    expect(config.hooks.subagentStop[0]).toMatchObject({ loop_limit: 500 });
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

describe('persist follow-up wiring (anti idle-stop)', () => {
  it('resolves the installed omcu entrypoint only under CURSOR_PLUGIN_ROOT/dist', () => {
    expect(resolveOmcuEntrypoint({})).toBeNull();
    expect(resolveOmcuEntrypoint({ CURSOR_PLUGIN_ROOT: '/no/such/root' })).toBeNull();
    expect(resolveOmcuEntrypoint({ CURSOR_PLUGIN_ROOT: root })).toBe(path.join(root, 'dist', 'bin', 'omcu.js'));
  });

  it('returns the CLI follow-up verbatim when the oracle says continue', () => {
    const decision = JSON.stringify({ continue: true, followup_message: 'keep going', reason: 'persist_active' });
    expect(persistFollowup('{"status":"completed"}', { CURSOR_PLUGIN_ROOT: root }, fakeRunner(decision)))
      .toEqual({ followup_message: 'keep going' });
  });

  it('fails open to a normal stop on every declined or broken path', () => {
    const env = { CURSOR_PLUGIN_ROOT: root };
    expect(persistFollowup('{}', {}, fakeRunner('{"continue":true,"followup_message":"x"}'))).toEqual({});
    expect(persistFollowup('{}', env, fakeRunner(JSON.stringify({ continue: false, reason: 'status_aborted' })))).toEqual({});
    expect(persistFollowup('{}', env, fakeRunner('not json'))).toEqual({});
    expect(persistFollowup('{}', env, fakeRunner('{}', 2))).toEqual({});
    expect(persistFollowup('{}', env, () => { throw new Error('spawn failed'); })).toEqual({});
    expect(persistFollowup('{}', env, fakeRunner(JSON.stringify({ continue: true, followup_message: '' })))).toEqual({});
  });

  it('runHook continues stop/subagentStop turns and leaves other events passive', async () => {
    const env = { CURSOR_PLUGIN_ROOT: root };
    const cont = fakeRunner(JSON.stringify({ continue: true, followup_message: 'boulder', reason: 'persist_active' }));
    expect(await runHook('stop', '{"status":"completed"}', env, cont)).toEqual({ followup_message: 'boulder' });
    expect(await runHook('subagentStop', '{"status":"completed"}', env, cont)).toEqual({ followup_message: 'boulder' });
    expect(await runHook('preToolUse', '{"tool_name":"Shell"}', env, cont)).toEqual({});
    expect(await runHook('beforeSubmitPrompt', '{}', env, cont)).toEqual({ continue: true });
    const declined = fakeRunner(JSON.stringify({ continue: false, reason: 'goal_marked_done' }));
    expect(await runHook('stop', '{"status":"completed"}', env, declined)).toEqual({});
  });

  it('detects the process entrypoint through a symlinked invocation path', () => {
    const hookFile = path.join(root, 'hooks', 'omcu-hook.mjs');
    const metaUrl = pathToFileURL(hookFile).href;
    expect(isMainEntry(metaUrl, hookFile)).toBe(true);
    expect(isMainEntry(metaUrl, '')).toBe(false);
    expect(isMainEntry(metaUrl, path.join(root, 'package.json'))).toBe(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-hook-symlink-'));
    try {
      const link = path.join(dir, 'linked-hook.mjs');
      fs.symlinkSync(hookFile, link);
      // A symlinked argv[1] must still resolve as the entrypoint (macOS
      // /tmp -> /private/tmp is itself a symlink), or the hook is dead on install.
      expect(isMainEntry(metaUrl, link)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the installed hook fires through a symlinked plugin path and continues persist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-hook-symrun-'));
    try {
      const omcu = path.join(root, 'dist', 'bin', 'omcu.js');
      execFileSync(process.execPath, [omcu, 'persist', 'start', '--goal', 'symlink run', '--max-loops', '4'], { cwd: dir });
      const link = path.join(dir, 'hook.mjs');
      fs.symlinkSync(path.join(root, 'hooks', 'omcu-hook.mjs'), link);
      const output = execFileSync(process.execPath, [link, 'stop'], {
        cwd: dir, env: { ...process.env, CURSOR_PLUGIN_ROOT: root }, input: '{"status":"completed","loop_count":1}', encoding: 'utf8',
      });
      expect(JSON.parse(output).followup_message).toContain('boulder never stops');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('end-to-end through the real CLI: active persist continues, done halts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-hook-e2e-'));
    try {
      const omcu = path.join(root, 'dist', 'bin', 'omcu.js');
      execFileSync(process.execPath, [omcu, 'persist', 'start', '--goal', 'ship it', '--max-loops', '5'], { cwd: dir });
      const active = execFileSync(process.execPath, [path.join(root, 'hooks/omcu-hook.mjs'), 'stop'], {
        cwd: dir, env: { ...process.env, CURSOR_PLUGIN_ROOT: root }, input: '{"status":"completed","loop_count":1}', encoding: 'utf8',
      });
      expect(JSON.parse(active).followup_message).toContain('boulder never stops');
      execFileSync(process.execPath, [omcu, 'persist', 'done'], { cwd: dir });
      const halted = execFileSync(process.execPath, [path.join(root, 'hooks/omcu-hook.mjs'), 'stop'], {
        cwd: dir, env: { ...process.env, CURSOR_PLUGIN_ROOT: root }, input: '{"status":"completed","loop_count":1}', encoding: 'utf8',
      });
      expect(JSON.parse(halted)).toEqual({});
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
