import { BaseCliProviderAdapter } from './base.js';
import type { ProviderId } from './types.js';

export class GeminiProviderAdapter extends BaseCliProviderAdapter {
  readonly id: ProviderId = 'gemini';
  readonly displayName = 'Gemini CLI';
  readonly isCanonical = false;
  readonly defaultBinary = 'gemini';
  override readonly candidateBinaries: readonly string[] = ['gemini'];
  readonly envAllowlist: readonly string[] = [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
  ];
  readonly supportedModels: readonly string[] = [
    'gemini-2.0-pro',
    'gemini-2.0-flash',
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
    if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) {
      return 'authenticated';
    }
    return 'unauthenticated';
  }
}
