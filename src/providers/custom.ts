import { BaseCliProviderAdapter, findBinaryInPath } from './base.js';
import type { CustomProcessRunner, ProviderId, ProviderReadiness } from './types.js';

export class CustomProviderAdapter extends BaseCliProviderAdapter {
  readonly id: ProviderId = 'custom';
  readonly displayName = 'Custom User-Defined CLI';
  readonly isCanonical = false;
  readonly defaultBinary: string;
  override readonly candidateBinaries: readonly string[];
  readonly envAllowlist: readonly string[];
  readonly supportedModels: readonly string[] = ['custom-default'];

  constructor(binary = 'custom-ai', envAllowlist: readonly string[] = []) {
    super();
    this.defaultBinary = binary;
    this.candidateBinaries = [binary];
    this.envAllowlist = envAllowlist;
  }

  buildExecutionArgs(prompt: string, model?: string): readonly string[] {
    const args: string[] = [];
    if (model) {
      args.push('--model', model);
    }
    args.push(prompt);
    return args;
  }
}
