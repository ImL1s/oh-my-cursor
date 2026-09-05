import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BaseCliProviderAdapter } from './base.js';
import type { ProviderId } from './types.js';

export class ClaudeProviderAdapter extends BaseCliProviderAdapter {
  readonly id: ProviderId = 'claude';
  readonly displayName = 'Claude Code CLI';
  readonly isCanonical = false;
  readonly defaultBinary = 'claude';
  override readonly candidateBinaries: readonly string[] = ['claude'];
  readonly envAllowlist: readonly string[] = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_API_KEY',
  ];
  readonly supportedModels: readonly string[] = [
    'claude-3-7-sonnet',
    'claude-3-5-sonnet',
    'claude-3-5-haiku',
  ];

  buildExecutionArgs(prompt: string, model?: string): readonly string[] {
    const args = ['--print'];
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
    if (env.ANTHROPIC_API_KEY || env.CLAUDE_API_KEY) {
      return 'authenticated';
    }
    if (env.CLAUDE_CONFIG_DIR) {
      const customConfig = path.join(env.CLAUDE_CONFIG_DIR, '.claude.json');
      const customConfigAlt = path.join(env.CLAUDE_CONFIG_DIR, 'config.json');
      if (fs.existsSync(customConfig) || fs.existsSync(customConfigAlt)) {
        return 'authenticated';
      }
    }
    const claudeConfig = path.join(os.homedir(), '.claude.json');
    if (fs.existsSync(claudeConfig)) {
      return 'authenticated';
    }
    return 'unauthenticated';
  }
}
