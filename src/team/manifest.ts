import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../runtime/atomic.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';
import type { TeamManifest } from './types.js';

export interface TeamManifestRepository {
  write(manifest: TeamManifest): void;
  read(teamId: string): TeamManifest;
  exists(teamId: string): boolean;
}

export class TeamManifestStore implements TeamManifestRepository {
  constructor(private readonly root: StateRoot) {}
  private file(teamId: string): string { return withinStateRoot(this.root, 'teams', safe(teamId), 'manifest.json'); }
  write(manifest: TeamManifest): void { atomicWriteJson(this.file(manifest.team_id), manifest); }
  read(teamId: string): TeamManifest {
    const manifest = JSON.parse(fs.readFileSync(this.file(teamId), 'utf8')) as TeamManifest;
    if (manifest.schema_version !== 1 || manifest.team_id !== teamId || manifest.capability_tier !== 'experimental-local' || manifest.native_cursor_team !== false
      || !('stopping_at' in manifest) || !('stopping_worker_ids' in manifest)) throw new Error('E_TEAM_MANIFEST_INVALID');
    return manifest;
  }
  exists(teamId: string): boolean { return fs.existsSync(this.file(teamId)); }
}

function safe(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || path.basename(value) !== value) throw new Error('E_TEAM_ID_INVALID'); return value; }
