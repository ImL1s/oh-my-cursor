import { BaseCliProviderAdapter, findBinaryInPath } from './base.js';
import type { CustomProcessRunner, ProviderId, ProviderReadiness } from './types.js';

export class OpenCodeProviderAdapter extends BaseCliProviderAdapter {
  readonly id: ProviderId = 'opencode';
  readonly displayName = 'OpenCode / OMO CLI';
  readonly isCanonical = false;
  readonly defaultBinary = 'opencode';
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

  override async probe(cwd?: string, runner?: CustomProcessRunner): Promise<ProviderReadiness> {
    const primary = findBinaryInPath('opencode');
    const alias = findBinaryInPath('omo');
    const binary = primary ?? alias;

    if (!binary) {
      return {
        provider: this.id,
        available: false,
        reason: "Neither 'opencode' nor 'omo' found in PATH",
        supportedModels: this.supportedModels,
      };
    }

    return super.probe(cwd, runner);
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
