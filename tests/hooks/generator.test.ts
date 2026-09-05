import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkHooksConfig, generateHooksConfig } from '../../src/hooks/generator.js';

describe('Hook Configuration Generator (omcu hooks generate)', () => {
  it('generates valid version 1 Cursor hook specification for plugin target', () => {
    const config = generateHooksConfig({ target: 'plugin' });

    expect(config.version).toBe(1);
    expect(config.hooks).toBeDefined();

    const events = Object.keys(config.hooks);
    expect(events).toContain('sessionStart');
    expect(events).toContain('preToolUse');
    expect(events).toContain('beforeSubmitPrompt');
    expect(events).toContain('preCompact');
    expect(events).toContain('stop');
    expect(events).toContain('subagentStop');

    expect(config.hooks.preToolUse[0]).toEqual({
      command: 'node ${CURSOR_PLUGIN_ROOT}/hooks/omcu-hook.mjs preToolUse',
      matcher: 'Shell',
    });
    expect(config.hooks.stop[0]).toMatchObject({
      command: 'node ${CURSOR_PLUGIN_ROOT}/hooks/omcu-hook.mjs stop',
      loop_limit: 500,
    });
  });

  it('generates project target configuration with local relative paths', () => {
    const config = generateHooksConfig({ target: 'project' });

    expect(config.hooks.sessionStart[0]?.command).toBe('node ./hooks/omcu-hook.mjs sessionStart');
  });

  it('checks hook configuration drift accurately', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-gen-check-'));
    try {
      const hooksFile = path.join(tempDir, 'hooks.json');

      // 1. Missing file check
      expect(checkHooksConfig(hooksFile).inSync).toBe(false);

      // 2. Accurate file check
      const validConfig = generateHooksConfig({ target: 'plugin' });
      fs.writeFileSync(hooksFile, JSON.stringify(validConfig, null, 2), 'utf8');
      expect(checkHooksConfig(hooksFile, 'plugin').inSync).toBe(true);

      // 3. Drifted file check
      const driftedConfig = { ...validConfig, version: 2 };
      fs.writeFileSync(hooksFile, JSON.stringify(driftedConfig, null, 2), 'utf8');
      const checkResult = checkHooksConfig(hooksFile, 'plugin');
      expect(checkResult.inSync).toBe(false);
      expect(checkResult.diff).toContain('drift detected');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
