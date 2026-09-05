import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  clearModelCache,
  discoverCursorModels,
  isCursorModelAvailable,
  listCursorModels,
  readModelCache,
  writeModelCache,
  DEFAULT_CURSOR_MODELS_CATALOG,
} from '../../src/cursor-sdk/models/index.js';
import type { ModelCatalogCache } from '../../src/cursor-sdk/models/types.js';

describe('Cursor Model Registry & SDK Discovery (Issue #31)', () => {
  it('discovers models using live SDK client when available', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-models-test-'));
    try {
      const mockSdkClient = {
        models: {
          list: async () => [
            {
              id: 'claude-3-7-sonnet-thought',
              displayName: 'Claude 3.7 Sonnet (Thinking)',
            },
            {
              id: 'gpt-4o',
              displayName: 'GPT-4o',
            },
          ],
        },
      };

      const cache = await discoverCursorModels({
        workspace: tempDir,
        sdkClient: mockSdkClient,
      });

      expect(cache.accountVisible).toBe(true);
      expect(cache.models.some((m) => m.id === 'claude-3-7-sonnet-thought')).toBe(true);
      expect(cache.models.some((m) => m.id === 'gpt-4o')).toBe(true);
      // Auto router mode is automatically included
      expect(cache.models.some((m) => m.id === 'auto')).toBe(true);
    } finally {
      clearModelCache(tempDir);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('falls back to catalog presets when SDK client throws without crashing', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-models-fallback-'));
    try {
      const failingSdkClient = {
        models: {
          list: async () => {
            throw new Error('API key is required for cloud operations');
          },
        },
      };

      const cache = await discoverCursorModels({
        workspace: tempDir,
        sdkClient: failingSdkClient,
      });

      expect(cache.accountVisible).toBe(false);
      expect(cache.fallbackReason).toContain('API key is required');
      expect(cache.models.length).toBeGreaterThanOrEqual(5);
      expect(cache.models.some((m) => m.id === 'auto')).toBe(true);
      expect(cache.models.some((m) => m.id === 'claude-3-5-sonnet')).toBe(true);
    } finally {
      clearModelCache(tempDir);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reads cached models and supports cache invalidation', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-cache-test-'));
    try {
      const customCache: ModelCatalogCache = {
        schema_version: 1,
        sdkVersion: '1.0.31',
        cachedAt: new Date().toISOString(),
        ttlMs: 60_000,
        accountVisible: true,
        models: [
          {
            id: 'custom-account-model',
            displayName: 'Custom Account Model',
            runtime: 'cloud',
            routingTier: 'smart',
            capabilities: {
              reasoning: false,
              vision: true,
              tools: true,
              supportsAutoRouter: true,
            },
            isAccountVisible: true,
          },
        ],
      };

      writeModelCache(customCache, tempDir);

      const readBack = readModelCache(tempDir);
      expect(readBack).not.toBeNull();
      expect(readBack?.models[0]?.id).toBe('custom-account-model');

      clearModelCache(tempDir);
      const afterClear = readModelCache(tempDir);
      expect(afterClear).toBeNull();
    } finally {
      clearModelCache(tempDir);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('filters models by runtime (local vs cloud)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-filter-test-'));
    try {
      const localModels = await listCursorModels({
        workspace: tempDir,
        runtime: 'local',
      });
      expect(localModels.every((m) => m.runtime === 'local' || m.runtime === 'both')).toBe(true);

      const cloudModels = await listCursorModels({
        workspace: tempDir,
        runtime: 'cloud',
      });
      expect(cloudModels.every((m) => m.runtime === 'cloud' || m.runtime === 'both')).toBe(true);
    } finally {
      clearModelCache(tempDir);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('checks model availability including aliases', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-avail-test-'));
    try {
      expect(await isCursorModelAvailable('auto', { workspace: tempDir })).toBe(true);
      expect(await isCursorModelAvailable('claude-3-5-sonnet', { workspace: tempDir })).toBe(true);
      expect(await isCursorModelAvailable('sonnet-3.5', { workspace: tempDir })).toBe(true); // alias
      expect(await isCursorModelAvailable('non-existent-model-xyz', { workspace: tempDir })).toBe(false);
    } finally {
      clearModelCache(tempDir);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
