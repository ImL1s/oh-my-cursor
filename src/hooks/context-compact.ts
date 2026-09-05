import fs from 'node:fs';
import path from 'node:path';
import { CompactionStore } from '../compaction/index.js';
import { openProjectStateRoot, resolveProjectStatePath, type StateRoot } from '../runtime/state-root.js';

export interface CompactionHookResult {
  readonly checkpointId: string;
  readonly generation: number;
  readonly sha256: string;
  readonly savedAt: string;
  readonly stateRoot: string;
}

export async function executeContextCompact(
  cwd: string,
  rawInput?: unknown
): Promise<CompactionHookResult | null> {
  const statePath = resolveProjectStatePath(cwd);
  if (!fs.existsSync(statePath)) {
    return null;
  }

  let root: StateRoot;
  try {
    root = openProjectStateRoot(cwd);
  } catch {
    return null;
  }

  const inputObj = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput))
    ? rawInput as Record<string, unknown>
    : {};

  const checkpointId = typeof inputObj.session_id === 'string' && inputObj.session_id.trim() !== ''
    ? inputObj.session_id.trim().replace(/[^a-zA-Z0-9._-]/g, '_')
    : typeof inputObj.sessionId === 'string' && inputObj.sessionId.trim() !== ''
      ? inputObj.sessionId.trim().replace(/[^a-zA-Z0-9._-]/g, '_')
      : 'active-session';

  // Gather active runtime state to preserve across compaction
  const activePayload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    event: 'preCompact',
    hook_input: inputObj,
  };

  // Inspect persist state if present
  const persistFile = path.join(statePath, 'persist', 'state.json');
  if (fs.existsSync(persistFile)) {
    try {
      activePayload.persist_state = JSON.parse(fs.readFileSync(persistFile, 'utf8'));
    } catch {
      // Ignore read errors
    }
  }

  // Inspect state machine if present
  const stateFile = path.join(statePath, 'state', 'state.json');
  if (fs.existsSync(stateFile)) {
    try {
      activePayload.workflow_state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      // Ignore read errors
    }
  }

  const store = new CompactionStore(root);
  const current = store.read(checkpointId);
  const expectedGeneration = current?.generation ?? 0;

  const checkpoint = await store.checkpoint(checkpointId, expectedGeneration, activePayload);

  return {
    checkpointId: checkpoint.checkpoint_id,
    generation: checkpoint.generation,
    sha256: checkpoint.sha256,
    savedAt: checkpoint.created_at,
    stateRoot: root.path,
  };
}
