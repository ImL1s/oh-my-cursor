import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../runtime/atomic.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';
import type { TeamManifest } from './types.js';

export interface TeamManifestRepository {
  write(manifest: TeamManifest): void;
  read(teamId: string): TeamManifest;
  exists(teamId: string): boolean;
  remove?(teamId: string): void;
}

export class TeamManifestStore implements TeamManifestRepository {
  constructor(private readonly root: StateRoot) {}
  private file(teamId: string): string { return withinStateRoot(this.root, 'teams', safe(teamId), 'manifest.json'); }
  write(manifest: TeamManifest): void {
    validateManifest(manifest, manifest.team_id);
    atomicWriteJson(this.file(manifest.team_id), manifest);
  }
  read(teamId: string): TeamManifest {
    const file = this.file(teamId);
    try {
      const manifest = normalizeManifest(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>);
      validateManifest(manifest, teamId);
      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('E_TEAM_MANIFEST_ABSENT');
      throw new Error('E_TEAM_MANIFEST_CORRUPT');
    }
  }
  exists(teamId: string): boolean { return fs.existsSync(this.file(teamId)); }
  remove(teamId: string): void {
    const file = this.file(teamId);
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
      const dir = path.dirname(file);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {
      // best-effort removal
    }
  }
}

function normalizeManifest(raw: Record<string, unknown>): TeamManifest {
  if (raw.schema_version !== 1 && raw.schema_version !== 2) throw new Error('E_TEAM_MANIFEST_INVALID');
  const workers = Array.isArray(raw.workers)
    ? raw.workers.map((value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('E_TEAM_MANIFEST_INVALID');
      const worker = value as Record<string, unknown>;
      const panePid = worker.pane_pid;
      return {
        ...worker,
        pane_start_identity: worker.pane_start_identity ?? `legacy-unproven:${String(panePid)}`,
        pane_start_identity_proven: worker.pane_start_identity_proven ?? false,
      };
    })
    : raw.workers;
  return {
    ...raw,
    schema_version: 2,
    workers,
    stopping_at: raw.stopping_at ?? null,
    stopping_worker_ids: raw.stopping_worker_ids ?? null,
    stopped_at: raw.stopped_at ?? null,
  } as unknown as TeamManifest;
}

function validateManifest(manifest: TeamManifest, teamId: string): void {
  if (manifest === null || typeof manifest !== 'object' || manifest.schema_version !== 2 || manifest.team_id !== teamId || manifest.capability_tier !== 'experimental-local' || manifest.native_cursor_team !== false || manifest.tmux_session !== `omcu-${teamId}` || !Array.isArray(manifest.workers) || manifest.workers.length < 1 || manifest.workers.length > 8 || !isTimestamp(manifest.created_at) || !nullableTimestamp(manifest.stopping_at) || !nullableTimestamp(manifest.stopped_at)) throw new Error('E_TEAM_MANIFEST_INVALID');
  const ids = new Set<string>();
  for (const worker of manifest.workers) {
    if (worker === null || typeof worker !== 'object' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(worker.id) || ids.has(worker.id) || typeof worker.cwd !== 'string' || !path.isAbsolute(worker.cwd) || !Array.isArray(worker.owned_paths) || worker.owned_paths.length < 1 || worker.owned_paths.some((value: unknown) => typeof value !== 'string' || value.length < 1) || !/^%\d+$/.test(worker.pane_target) || !Number.isSafeInteger(worker.pane_pid) || worker.pane_pid <= 1 || typeof worker.pane_start_identity !== 'string' || worker.pane_start_identity.length < 1 || worker.pane_start_identity.length > 512 || typeof worker.pane_start_identity_proven !== 'boolean' || !Number.isSafeInteger(worker.process_group_id) || worker.process_group_id <= 1 || !Array.isArray(worker.argv) || worker.argv.some((value: unknown) => typeof value !== 'string')) throw new Error('E_TEAM_MANIFEST_INVALID');
    ids.add(worker.id);
  }
  if (manifest.stopping_worker_ids !== null && (!Array.isArray(manifest.stopping_worker_ids) || new Set(manifest.stopping_worker_ids).size !== manifest.stopping_worker_ids.length || manifest.stopping_worker_ids.some((id) => typeof id !== 'string' || !ids.has(id)))) throw new Error('E_TEAM_MANIFEST_INVALID');
  if ((manifest.stopping_at === null) !== (manifest.stopping_worker_ids === null) || (manifest.stopped_at !== null && manifest.stopping_at === null)) throw new Error('E_TEAM_MANIFEST_INVALID');
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function nullableTimestamp(value: unknown): value is string | null { return value === null || isTimestamp(value); }

function safe(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || path.basename(value) !== value) throw new Error('E_TEAM_ID_INVALID'); return value; }
