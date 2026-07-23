import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, withDirectoryLock } from '../runtime/atomic.js';
import { redact } from '../runtime/redaction.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';

export interface CompactionCheckpoint { readonly schema_version: 1; readonly checkpoint_id: string; readonly generation: number; readonly previous_sha256: string | null; readonly payload: unknown; readonly sha256: string; readonly created_at: string }
function safe(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('E_CHECKPOINT_ID_INVALID'); return value; }
function sha(value: unknown): string { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function validateCheckpoint(value: unknown, id: string, generation: number, previous: string | null): CompactionCheckpoint {
  if (value === null || typeof value !== 'object') throw new Error('E_CHECKPOINT_INVALID');
  const checkpoint = value as CompactionCheckpoint;
  if (checkpoint.schema_version !== 1 || checkpoint.checkpoint_id !== id || checkpoint.generation !== generation
    || checkpoint.previous_sha256 !== previous || typeof checkpoint.created_at !== 'string'
    || !/^[a-f0-9]{64}$/.test(checkpoint.sha256)) throw new Error('E_CHECKPOINT_INVALID');
  const { sha256, ...body } = checkpoint;
  if (sha(body) !== sha256) throw new Error('E_CHECKPOINT_DIGEST_INVALID');
  return checkpoint;
}
function sameCheckpoint(left: CompactionCheckpoint, right: CompactionCheckpoint): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class CompactionStore {
  constructor(private readonly root: StateRoot, private readonly now: () => Date = () => new Date()) {}
  private dir(id: string): string { return withinStateRoot(this.root, 'compaction', safe(id)); }
  read(id: string): CompactionCheckpoint | null {
    const current = path.join(this.dir(id), 'current.json');
    if (!fs.existsSync(current)) return null;
    const pointer = JSON.parse(fs.readFileSync(current, 'utf8')) as CompactionCheckpoint;
    if (!Number.isInteger(pointer.generation) || pointer.generation < 1) throw new Error('E_CHECKPOINT_INVALID');
    let previous: string | null = null;
    let latest: CompactionCheckpoint | null = null;
    for (let generation = 1; generation <= pointer.generation; generation += 1) {
      const immutable = path.join(this.dir(id), `generation-${generation}.json`);
      if (!fs.existsSync(immutable)) throw new Error('E_CHECKPOINT_CHAIN_BROKEN');
      latest = validateCheckpoint(JSON.parse(fs.readFileSync(immutable, 'utf8')), id, generation, previous);
      previous = latest.sha256;
    }
    if (latest === null || !sameCheckpoint(latest, validateCheckpoint(pointer, id, pointer.generation, latest.previous_sha256))) {
      throw new Error('E_CHECKPOINT_POINTER_MISMATCH');
    }
    return latest;
  }
  async checkpoint(id: string, expectedGeneration: number, payload: unknown): Promise<CompactionCheckpoint> {
    if (!Number.isInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('E_GENERATION_INVALID');
    const currentFile = path.join(this.dir(id), 'current.json');
    return withDirectoryLock(currentFile, () => {
      const current = this.read(id);
      if ((current?.generation ?? 0) !== expectedGeneration) throw new Error('E_GENERATION_CONFLICT');
      const generation = expectedGeneration + 1;
      const body = { schema_version: 1 as const, checkpoint_id: id, generation, previous_sha256: current?.sha256 ?? null, payload: redact(payload), created_at: this.now().toISOString() };
      const next: CompactionCheckpoint = { ...body, sha256: sha(body) };
      const immutable = path.join(this.dir(id), `generation-${generation}.json`);
      if (fs.existsSync(immutable)) {
        const existing = validateCheckpoint(
          JSON.parse(fs.readFileSync(immutable, 'utf8')),
          id,
          generation,
          current?.sha256 ?? null,
        );
        if (JSON.stringify(existing.payload) !== JSON.stringify(next.payload)) {
          throw new Error('E_CHECKPOINT_IMMUTABLE_CONFLICT');
        }
        atomicWriteJson(currentFile, existing);
        return existing;
      }
      atomicWriteJson(immutable, next);
      atomicWriteJson(currentFile, next);
      return next;
    });
  }
  render(id: string, expectedGeneration: number): string {
    const current = this.read(id);
    if (current === null) throw new Error('E_CHECKPOINT_NOT_FOUND');
    if (current.generation !== expectedGeneration) throw new Error('E_GENERATION_CONFLICT');
    return `${JSON.stringify(current.payload, null, 2)}\n`;
  }
}
