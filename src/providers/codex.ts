import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseCliProviderAdapter } from './base.js';
import type { ProviderId } from './types.js';

export class CodexProviderAdapter extends BaseCliProviderAdapter {
  readonly id: ProviderId = 'codex';
  readonly displayName = 'Codex CLI';
  readonly isCanonical = false;
  readonly defaultBinary = 'codex';
  readonly envAllowlist: readonly string[] = [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
  ];
  readonly supportedModels: readonly string[] = [
    'o3-mini',
    'o1',
    'gpt-4o',
  ];

  buildExecutionArgs(prompt: string, model?: string): readonly string[] {
    const args = ['exec'];
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
    if (env.OPENAI_API_KEY || env.CODEX_API_KEY) {
      return 'authenticated';
    }
    const codexConfig = path.join(os.homedir(), '.codex', 'config.json');
    if (fs.existsSync(codexConfig)) {
      return 'authenticated';
    }
    return 'unauthenticated';
  }
}
