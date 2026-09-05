import { discoverCursorModels, listCursorModels } from '../cursor-sdk/models/index.js';
import { printJson, type CliContext } from './shared.js';

export async function handleModelsCommand(context: CliContext): Promise<number | null> {
  const { parsed } = context;
  if (parsed.command !== 'models') return null;

  if (parsed.action === 'list') {
    const runtime = parsed.options['--runtime'] as 'local' | 'cloud' | undefined;
    const forceRefresh = Boolean(parsed.options['--refresh']);
    const isJson = Boolean(parsed.options['--json']);

    try {
      const cache = await discoverCursorModels({
        workspace: context.cwd,
        forceRefresh,
      });

      let models = cache.models;
      if (runtime) {
        models = models.filter((m) => m.runtime === runtime || m.runtime === 'both');
      }

      if (isJson) {
        printJson(context.io, {
          ok: true,
          count: models.length,
          sdkVersion: cache.sdkVersion,
          cachedAt: cache.cachedAt,
          accountVisible: cache.accountVisible,
          fallbackReason: cache.fallbackReason,
          models,
        });
        return 0;
      }

      context.io.stdout(`Available Cursor Models (${models.length} models, SDK v${cache.sdkVersion}):\n`);
      if (!cache.accountVisible) {
        context.io.stdout(`[Notice: using catalog presets - ${cache.fallbackReason ?? 'live discovery not available'}]\n`);
      }
      for (const model of models) {
        const caps: string[] = [];
        if (model.capabilities.reasoning) caps.push('reasoning');
        if (model.capabilities.vision) caps.push('vision');
        if (model.capabilities.tools) caps.push('tools');
        const capStr = caps.length > 0 ? ` [${caps.join(', ')}]` : '';
        context.io.stdout(
          `  - ${model.id.padEnd(28)} tier:${model.routingTier.padEnd(10)} runtime:${model.runtime.padEnd(6)}${capStr}\n`
        );
      }

      return 0;
    } catch (err) {
      if (isJson) {
        printJson(context.io, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      } else {
        context.io.stderr(`Error listing models: ${err instanceof Error ? err.message : String(err)}\n`);
      }
      return 1;
    }
  }

  return null;
}
