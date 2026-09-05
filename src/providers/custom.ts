import { BaseCliProviderAdapter, findBinaryInPath } from './base.js';
import type { CustomProcessRunner, ProviderId, ProviderReadiness } from './types.js';

export class CustomProviderAdapter extends BaseCliProviderAdapter {
  readonly id: ProviderId = 'custom';
  readonly displayName = 'Custom User-Defined CLI';
  readonly isCanonical = false;
  readonly defaultBinary: string;
  readonly envAllowlist: readonly string[] = [];
  readonly supportedModels: readonly string[] = ['custom-default'];

  constructor(binary = 'custom-ai') {
    super();
    this.defaultBinary = binary;
  }

  buildExecutionArgs(prompt: string, model?: string): readonly string[] {
    const args: string[] = [];
    if (model) {
      args.push('--model', model);
    }
    args.push(prompt);
    return args;
  }

  override async probe(cwd?: string, runner?: CustomProcessRunner): Promise<ProviderReadiness> {
    const binary = findBinaryInPath(this.defaultBinary);
    if (!binary) {
      return {
        provider: this.id,
        available: false,
        reason: `Custom binary '${this.defaultBinary}' not found in PATH`,
        supportedModels: this.supportedModels,
      };
    }
    return super.probe(cwd, runner);
  }
}
