import { compareProviders } from '../providers/compare.js';
import { getProviderAdapter, probeAllProviders } from '../providers/registry.js';
import type { ProviderId } from '../providers/types.js';
import { printJson, type CliContext } from './shared.js';

export async function handleProvidersCommand(context: CliContext): Promise<number | null> {
  const { parsed } = context;
  if (parsed.command !== 'providers') return null;

  if (parsed.action === 'status') {
    const isJson = Boolean(parsed.options['--json']);
    const targetProvider = parsed.positionals[0];

    try {
      if (targetProvider) {
        const adapter = getProviderAdapter(targetProvider);
        const readiness = await adapter.probe(context.cwd);
        if (isJson) {
          printJson(context.io, { ok: true, provider: readiness });
        } else {
          context.io.stdout(
            `Provider: ${readiness.provider}\n  Available: ${readiness.available ? 'yes' : 'no'}\n  Binary: ${readiness.binaryPath ?? 'not found'}\n  Version: ${readiness.version ?? 'unknown'}\n  Auth: ${readiness.authStatus ?? 'unknown'}\n`
          );
          if (readiness.reason) {
            context.io.stdout(`  Reason: ${readiness.reason}\n`);
          }
        }
        return readiness.available ? 0 : 1;
      }

      const all = await probeAllProviders(context.cwd);
      if (isJson) {
        printJson(context.io, { ok: true, count: all.length, providers: all });
      } else {
        context.io.stdout('External Compatibility Providers Status:\n');
        for (const p of all) {
          const avail = p.available ? 'ONLINE ' : 'OFFLINE';
          const bin = p.binaryPath ? `(${p.binaryPath})` : '(missing)';
          context.io.stdout(
            `  - [${avail}] ${p.provider.padEnd(12)} version:${(p.version ?? 'unknown').padEnd(14)} auth:${(p.authStatus ?? 'unknown').padEnd(15)} ${bin}\n`
          );
        }
      }
      return 0;
    } catch (err) {
      if (isJson) {
        printJson(context.io, { ok: false, error: err instanceof Error ? err.message : String(err) });
      } else {
        context.io.stderr(`Error probing providers: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      return 1;
    }
  }

  return null;
}

export async function handleAskCommand(context: CliContext): Promise<number | null> {
  const { parsed } = context;
  if (parsed.command !== 'ask') return null;

  const isJson = Boolean(parsed.options['--json']) || parsed.options['--format'] === 'json' || parsed.options['--format'] === 'stream-json';
  const prompt =
    (parsed.options['--prompt'] as string | undefined) ??
    (parsed.options['--objective'] as string | undefined) ??
    (parsed.positionals[1] ? parsed.positionals.slice(1).join(' ') : undefined) ??
    (parsed.positionals[0] && !isKnownProvider(parsed.positionals[0]) ? parsed.positionals[0] : undefined);

  if (!prompt) {
    const errorMsg = 'E_PROMPT_REQUIRED: a prompt or objective is required for ask';
    if (isJson) {
      printJson(context.io, { ok: false, error: errorMsg });
    } else {
      context.io.stderr(`${errorMsg}\n`);
    }
    return 1;
  }

  // Check compare mode
  const compareList = parsed.options['--compare'] as string | undefined;
  if (compareList) {
    const providerNames = compareList.split(',').map((s) => s.trim()).filter(Boolean);
    try {
      const artifact = await compareProviders({
        providers: providerNames,
        prompt,
        cwd: context.cwd,
        saveArtifact: true,
        workspace: context.cwd,
      });

      if (isJson) {
        printJson(context.io, { ok: true, comparison: artifact });
      } else {
        context.io.stdout(`Provider Comparison (${artifact.id}) - Verdict: ${artifact.verdict}\n`);
        context.io.stdout(`Prompt: "${artifact.prompt}"\n`);
        context.io.stdout(`Synthesis: ${artifact.synthesis}\n\n`);
        for (const res of artifact.results) {
          const status = res.success ? 'SUCCESS' : 'FAILED';
          context.io.stdout(`[${status}] Provider: ${res.provider} (model: ${res.model}, ${res.durationMs}ms)\n`);
          if (res.text) {
            context.io.stdout(`  Response: ${res.text.slice(0, 200)}${res.text.length > 200 ? '...' : ''}\n`);
          }
          if (res.error) {
            context.io.stdout(`  Error: ${res.error}\n`);
          }
        }
        context.io.stdout(`\nNotice: ${artifact.advisoryNote}\n`);
      }
      return artifact.successCount > 0 ? 0 : 1;
    } catch (err) {
      if (isJson) {
        printJson(context.io, { ok: false, error: err instanceof Error ? err.message : String(err) });
      } else {
        context.io.stderr(`Error executing compare: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      return 1;
    }
  }

  // Single provider execution
  let targetProvider = 'cursor';
  if (parsed.positionals[0] && isKnownProvider(parsed.positionals[0])) {
    targetProvider = parsed.positionals[0];
  }

  const model = parsed.options['--model'] as string | undefined;
  const timeoutMs = parsed.options['--timeout'] as number | undefined;

  try {
    const adapter = getProviderAdapter(targetProvider);
    const result = await adapter.execute({
      prompt,
      model,
      cwd: context.cwd,
      timeoutMs,
    });

    if (isJson) {
      printJson(context.io, {
        ok: result.exitCode === 0 && !result.error,
        result,
      });
    } else {
      if (result.error && result.exitCode !== 0) {
        context.io.stderr(`Provider ${result.provider} failed: ${result.error}\n`);
      } else {
        context.io.stdout(`${result.text}\n`);
      }
    }
    return result.exitCode;
  } catch (err) {
    if (isJson) {
      printJson(context.io, { ok: false, error: err instanceof Error ? err.message : String(err) });
    } else {
      context.io.stderr(`Error executing ask: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return 1;
  }
}

function isKnownProvider(token: string): boolean {
  const p = token.trim().toLowerCase();
  return ['cursor', 'claude', 'codex', 'gemini', 'antigravity', 'agy', 'grok', 'xai', 'opencode', 'omo', 'custom'].includes(p);
}
