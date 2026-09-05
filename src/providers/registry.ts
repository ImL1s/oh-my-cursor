import { CursorProviderAdapter } from './cursor.js';
import { ClaudeProviderAdapter } from './claude.js';
import { CodexProviderAdapter } from './codex.js';
import { GeminiProviderAdapter } from './gemini.js';
import { AntigravityProviderAdapter } from './antigravity.js';
import { GrokProviderAdapter } from './grok.js';
import { OpenCodeProviderAdapter } from './opencode.js';
import { CustomProviderAdapter } from './custom.js';
import type {
  CustomProcessRunner,
  ProviderAdapter,
  ProviderId,
  ProviderReadiness,
} from './types.js';

const adapters: Record<ProviderId, ProviderAdapter> = {
  cursor: new CursorProviderAdapter(),
  claude: new ClaudeProviderAdapter(),
  codex: new CodexProviderAdapter(),
  gemini: new GeminiProviderAdapter(),
  antigravity: new AntigravityProviderAdapter(),
  grok: new GrokProviderAdapter(),
  opencode: new OpenCodeProviderAdapter(),
  custom: new CustomProviderAdapter(),
};

export function getProviderAdapter(idOrName: string): ProviderAdapter {
  const normalized = idOrName.trim().toLowerCase();

  if (normalized === 'agy') return adapters.antigravity;
  if (normalized === 'xai') return adapters.grok;
  if (normalized === 'omo') return adapters.opencode;

  if (Object.hasOwn(adapters, normalized)) {
    return adapters[normalized as ProviderId];
  }

  throw new Error(
    `E_PROVIDER_UNKNOWN: unknown provider '${idOrName}'. Supported: ${Object.keys(adapters).join(', ')}`
  );
}

export function listProviderAdapters(): readonly ProviderAdapter[] {
  return Object.values(adapters);
}

export async function probeAllProviders(
  cwd?: string,
  runner?: CustomProcessRunner
): Promise<readonly ProviderReadiness[]> {
  const results = await Promise.all(
    Object.values(adapters).map((adapter) => adapter.probe(cwd, runner))
  );
  return results;
}
