import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../../runtime/atomic.js';
import { resolveProjectStatePath } from '../../runtime/state-root.js';
import type { ModelCatalogCache } from './types.js';

export const MODELS_CACHE_FILE = 'models-cache.json';
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const memoryCache = new Map<string, ModelCatalogCache>();

export function getModelsCachePath(workspace: string): string {
  const stateDir = resolveProjectStatePath(workspace);
  return path.join(stateDir, MODELS_CACHE_FILE);
}

function isValidDiscoveredModel(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false;
  const m = item as Record<string, unknown>;
  if (typeof m.id !== 'string' || m.id.trim().length === 0) return false;
  if (m.runtime !== undefined && m.runtime !== 'local' && m.runtime !== 'cloud' && m.runtime !== 'both') {
    return false;
  }
  return true;
}

export function isValidModelCatalogCache(parsed: unknown): parsed is ModelCatalogCache {
  if (!parsed || typeof parsed !== 'object') return false;
  const p = parsed as Partial<ModelCatalogCache>;
  if (p.schema_version !== 1) return false;
  if (typeof p.cachedAt !== 'string' || typeof p.ttlMs !== 'number' || isNaN(p.ttlMs) || p.ttlMs <= 0) {
    return false;
  }
  const cachedAtMs = new Date(p.cachedAt).getTime();
  if (isNaN(cachedAtMs)) return false;
  if (!Array.isArray(p.models) || p.models.length === 0) return false;
  for (const m of p.models) {
    if (!isValidDiscoveredModel(m)) return false;
  }
  return true;
}

/**
 * Reads model cache for a workspace from .omcu/models-cache.json or in-memory fallback.
 * Returns null if missing, corrupted, or expired.
 */
export function readModelCache(
  workspace: string = process.cwd(),
  options?: { readonly ignoreExpiry?: boolean }
): ModelCatalogCache | null {
  const cachePath = getModelsCachePath(workspace);

  // Check file on disk
  if (fs.existsSync(cachePath)) {
    try {
      const content = fs.readFileSync(cachePath, 'utf8');
      const parsed = JSON.parse(content);
      if (isValidModelCatalogCache(parsed)) {
        if (options?.ignoreExpiry) {
          return parsed;
        }
        const cachedAtMs = new Date(parsed.cachedAt).getTime();
        if (Date.now() - cachedAtMs < parsed.ttlMs) {
          return parsed;
        }
      }
    } catch {
      // Corrupt or unreadable cache file; ignore and fallback
    }
  }

  // Check memory cache
  const mem = memoryCache.get(path.resolve(workspace));
  if (mem && isValidModelCatalogCache(mem)) {
    if (options?.ignoreExpiry) {
      return mem;
    }
    const cachedAtMs = new Date(mem.cachedAt).getTime();
    if (Date.now() - cachedAtMs < mem.ttlMs) {
      return mem;
    }
  }

  return null;
}

/**
 * Writes model cache atomically to disk if .omcu exists, and stores in memory.
 */
export function writeModelCache(
  cache: ModelCatalogCache,
  workspace: string = process.cwd()
): void {
  const resolvedWorkspace = path.resolve(workspace);
  memoryCache.set(resolvedWorkspace, cache);

  const stateDir = resolveProjectStatePath(resolvedWorkspace);
  if (fs.existsSync(stateDir)) {
    const cachePath = path.join(stateDir, MODELS_CACHE_FILE);
    try {
      atomicWriteJson(cachePath, cache, { mode: 0o600 });
    } catch {
      // Disk write failure shouldn't crash if state root has permission constraints;
      // in-memory cache remains active.
    }
  }
}

/**
 * Clears model cache for a workspace both from disk and memory.
 */
export function clearModelCache(workspace: string = process.cwd()): void {
  const resolvedWorkspace = path.resolve(workspace);
  memoryCache.delete(resolvedWorkspace);

  const cachePath = getModelsCachePath(resolvedWorkspace);
  if (fs.existsSync(cachePath)) {
    try {
      fs.unlinkSync(cachePath);
    } catch {
      // Ignore if already deleted
    }
  }
}
