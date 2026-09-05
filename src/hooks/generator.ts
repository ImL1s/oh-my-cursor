import fs from 'node:fs';

export interface HookEntryConfig {
  readonly command: string;
  readonly matcher?: string | undefined;
  readonly loop_limit?: number | undefined;
}

export interface GeneratedHooksConfig {
  readonly version: 1;
  readonly hooks: Record<string, HookEntryConfig[]>;
}

export function generateHooksConfig(options?: {
  target?: 'plugin' | 'project';
}): GeneratedHooksConfig {
  const target = options?.target ?? 'plugin';
  const prefix = target === 'plugin' ? '${CURSOR_PLUGIN_ROOT}' : '.';

  const config: GeneratedHooksConfig = {
    version: 1,
    hooks: {
      sessionStart: [
        { command: `node ${prefix}/hooks/omcu-hook.mjs sessionStart` },
      ],
      preToolUse: [
        { command: `node ${prefix}/hooks/omcu-hook.mjs preToolUse`, matcher: 'Shell' },
      ],
      beforeSubmitPrompt: [
        { command: `node ${prefix}/hooks/omcu-hook.mjs beforeSubmitPrompt` },
      ],
      preCompact: [
        { command: `node ${prefix}/hooks/omcu-hook.mjs preCompact` },
      ],
      stop: [
        { command: `node ${prefix}/hooks/omcu-hook.mjs stop`, loop_limit: 500 },
      ],
      subagentStop: [
        { command: `node ${prefix}/hooks/omcu-hook.mjs subagentStop`, loop_limit: 500 },
      ],
    },
  };

  return config;
}

export function checkHooksConfig(
  filePath: string,
  target: 'plugin' | 'project' = 'plugin'
): { inSync: boolean; diff?: string } {
  if (!fs.existsSync(filePath)) {
    return { inSync: false, diff: `File not found: ${filePath}` };
  }

  try {
    const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const generated = generateHooksConfig({ target });

    const existingStr = JSON.stringify(existing, null, 2);
    const generatedStr = JSON.stringify(generated, null, 2);

    if (existingStr === generatedStr) {
      return { inSync: true };
    }

    return {
      inSync: false,
      diff: `Configuration drift detected in ${filePath}`,
    };
  } catch (err) {
    return {
      inSync: false,
      diff: `Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
