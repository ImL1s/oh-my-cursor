import { BaseCliProviderAdapter, findBinaryInPath } from './base.js';
import type { CustomProcessRunner, ProviderId, ProviderReadiness } from './types.js';

export class AntigravityProviderAdapter extends BaseCliProviderAdapter {
  readonly id: ProviderId = 'antigravity';
  readonly displayName = 'Antigravity CLI (agy)';
  readonly isCanonical = false;
  readonly defaultBinary = 'antigravity';
  readonly envAllowlist: readonly string[] = [
    'ANTIGRAVITY_API_KEY',
    'GEMINI_API_KEY',
  ];
  readonly supportedModels: readonly string[] = [
    'gemini-2.0-pro',
    'claude-3-7-sonnet',
  ];

  buildExecutionArgs(prompt: string, model?: string): readonly string[] {
    const args = ['prompt'];
    if (model) {
      args.push('--model', model);
    }
    args.push(prompt);
    return args;
  }

  override async probe(cwd?: string, runner?: CustomProcessRunner): Promise<ProviderReadiness> {
    const primary = findBinaryInPath('antigravity');
    const alias = findBinaryInPath('agy');
    const binary = primary ?? alias;

    if (!binary) {
      return {
        provider: this.id,
        available: false,
        reason: "Neither 'antigravity' nor 'agy' found in PATH",
        supportedModels: this.supportedModels,
      };
    }

    return super.probe(cwd, runner);
  }

  protected override checkAuthStatus(
    env: NodeJS.ProcessEnv,
    _binaryPath: string
  ): 'authenticated' | 'unauthenticated' | 'unknown' {
    if (env.ANTIGRAVITY_API_KEY || env.GEMINI_API_KEY) {
      return 'authenticated';
    }
    return 'unauthenticated';
  }
}
