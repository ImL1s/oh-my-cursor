import { BaseCliProviderAdapter, findBinaryInPath } from './base.js';
import type { CustomProcessRunner, ProviderId, ProviderReadiness } from './types.js';

export class OpenCodeProviderAdapter extends BaseCliProviderAdapter {
  readonly id: ProviderId = 'opencode';
  readonly displayName = 'OpenCode / OMO CLI';
  readonly isCanonical = false;
  readonly defaultBinary = 'opencode';
  override readonly candidateBinaries: readonly string[] = ['opencode', 'omo'];
  readonly envAllowlist: readonly string[] = [
    'OPENCODE_API_KEY',
  ];
  readonly supportedModels: readonly string[] = [
    'default',
  ];

  buildExecutionArgs(prompt: string, model?: string): readonly string[] {
    const args = ['run'];
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
    if (env.OPENCODE_API_KEY) {
      return 'authenticated';
    }
    return 'unknown';
  }
}
