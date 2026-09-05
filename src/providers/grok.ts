import { BaseCliProviderAdapter, findBinaryInPath } from './base.js';
import type { CustomProcessRunner, ProviderId, ProviderReadiness } from './types.js';

export class GrokProviderAdapter extends BaseCliProviderAdapter {
  readonly id: ProviderId = 'grok';
  readonly displayName = 'Grok / xAI CLI';
  readonly isCanonical = false;
  readonly defaultBinary = 'grok';
  override readonly candidateBinaries: readonly string[] = ['grok', 'xai'];
  readonly envAllowlist: readonly string[] = [
    'XAI_API_KEY',
    'GROK_API_KEY',
  ];
  readonly supportedModels: readonly string[] = [
    'grok-3',
    'grok-2',
  ];

  buildExecutionArgs(prompt: string, model?: string): readonly string[] {
    const args = ['prompt'];
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
    if (env.XAI_API_KEY || env.GROK_API_KEY) {
      return 'authenticated';
    }
    return 'unauthenticated';
  }
}
