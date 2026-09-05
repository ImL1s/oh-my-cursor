import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseCliProviderAdapter } from './base.js';
import type {
  CustomProcessRunner,
  ProviderExecutionOptions,
  ProviderExecutionResult,
  ProviderId,
  ProviderReadiness,
} from './types.js';

export class CursorProviderAdapter extends BaseCliProviderAdapter {
  readonly id: ProviderId = 'cursor';
  readonly displayName = 'Cursor (Canonical)';
  readonly isCanonical = true;
  readonly defaultBinary = 'cursor-agent';
  readonly envAllowlist: readonly string[] = [
    'CURSOR_API_KEY',
    'CURSOR_AUTH_PATH',
  ];
  readonly supportedModels: readonly string[] = [
    'auto',
    'claude-3-7-sonnet-thought',
    'claude-3-5-sonnet',
    'claude-3-5-haiku',
    'gpt-4o',
    'gpt-4o-mini',
    'o3-mini',
    'o1',
    'gemini-2.0-flash',
    'gemini-2.0-pro',
    'cursor-small',
  ];

  buildExecutionArgs(prompt: string, model?: string): readonly string[] {
    const args = ['--print', '--output-format', 'json', '--mode', 'ask'];
    if (model) {
      args.push('--model', model);
    }
    args.push(prompt);
    return args;
  }

  protected override checkAuthStatus(
    env: NodeJS.ProcessEnv,
    _binaryPath: string
  ): 'authenticated' | 'unauthenticated' | 'unknown' {
    if (env.CURSOR_API_KEY) return 'authenticated';
    const authPaths = [
      path.join(os.homedir(), '.cursor', 'sdk', 'auth.json'),
      path.join(os.homedir(), '.cursor', 'auth.json'),
    ];
    for (const p of authPaths) {
      if (fs.existsSync(p)) return 'authenticated';
    }
    return 'unauthenticated';
  }

  override async execute(options: ProviderExecutionOptions): Promise<ProviderExecutionResult> {
    const res = await super.execute(options);
    const model = options.model ?? 'auto';
    const runtime = model === 'cursor-small' ? 'local' : 'cloud';

    // Parse JSON if possible to extract response text
    let text = res.text;
    if (res.exitCode === 0 && text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text) as { response?: string; text?: string; result?: string };
        text = parsed.response ?? parsed.text ?? parsed.result ?? text;
      } catch {
        // Keep raw text
      }
    }

    return {
      ...res,
      model,
      runtime,
      text,
    };
  }
}
