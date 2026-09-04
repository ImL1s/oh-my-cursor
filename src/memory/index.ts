import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, withDirectoryLockSync } from '../runtime/atomic.js';
import { redact } from '../runtime/redaction.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';

export interface ProjectMemory { readonly schema_version: 1; readonly id: string; readonly text: string; readonly metadata: unknown; readonly updated_at: string }
export interface MemoryExport { readonly schema_version: 1; readonly memories: readonly ProjectMemory[] }
function safe(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('E_MEMORY_ID_INVALID'); return value; }
function cleanText(value: string): string { if (value.trim() === '' || Buffer.byteLength(value) > 64 * 1024) throw new Error('E_MEMORY_TEXT_INVALID'); return String(redact(value, { maxStringLength: 64 * 1024 })); }
const LOCK_TIMEOUT_MS = 5_000;

function readMemoryRecord(file: string, expectedId: string): ProjectMemory {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ProjectMemory> | null;
    if (parsed === null || typeof parsed !== 'object'
      || parsed.schema_version !== 1
      || typeof parsed.id !== 'string' || parsed.id !== expectedId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parsed.id)
      || typeof parsed.text !== 'string' || parsed.text.trim() === '' || Buffer.byteLength(parsed.text) > 64 * 1024
      || !Object.prototype.hasOwnProperty.call(parsed, 'metadata')
      || typeof parsed.updated_at !== 'string' || !Number.isFinite(Date.parse(parsed.updated_at))) {
      throw new Error('E_MEMORY_RECORD_INVALID');
    }
    return parsed as ProjectMemory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('E_STATE_ABSENT', { cause: error });
    throw new Error('E_STATE_CORRUPT', { cause: error });
  }
}

export class ProjectMemoryStore {
  constructor(
    private readonly root: StateRoot,
    private readonly now: () => Date = () => new Date(),
    private readonly writeJson: (file: string, value: unknown) => unknown = atomicWriteJson,
  ) {}
  private dir(): string { return withinStateRoot(this.root, 'memory', 'records'); }
  private file(id: string): string { return path.join(this.dir(), `${safe(id)}.json`); }
  private indexFile(): string { return withinStateRoot(this.root, 'memory', 'index.json'); }
  private withIndexLock<T>(action: () => T): T {
    return withDirectoryLockSync(this.indexFile(), action, LOCK_TIMEOUT_MS, {
      errorPrefix: 'E_MEMORY_LOCK',
    });
  }
  private rescanUnlocked(): readonly string[] {
    const ids = this.list().map(({ id }) => id);
    this.writeJson(this.indexFile(), { schema_version: 1, ids, rescanned_at: this.now().toISOString() });
    return ids;
  }
  private prepareRecord(text: string, metadata: unknown, id: string): ProjectMemory {
    return {
      schema_version: 1,
      id: safe(id),
      text: cleanText(text),
      metadata: redact(metadata),
      updated_at: this.now().toISOString(),
    };
  }
  private putUnlocked(record: ProjectMemory): void {
    this.writeJson(this.file(record.id), record);
  }
  show(id: string): ProjectMemory { return readMemoryRecord(this.file(id), safe(id)); }
  list(): ProjectMemory[] {
    if (!fs.existsSync(this.dir())) return [];
    return fs.readdirSync(this.dir()).filter((name) => name.endsWith('.json')).sort().map((name) => {
      const id = name.slice(0, -'.json'.length);
      return readMemoryRecord(path.join(this.dir(), name), id);
    });
  }
  async put(text: string, metadata: unknown = {}, id: string = crypto.randomUUID()): Promise<ProjectMemory> {
    const file = this.file(id);
    return this.withIndexLock(() => {
      const record = this.prepareRecord(text, metadata, id);
      this.writeJson(file, record); this.rescanUnlocked(); return record;
    });
  }
  async delete(id: string): Promise<boolean> {
    return this.withIndexLock(() => {
      const file = this.file(id);
      const existed = fs.existsSync(file);
      if (existed) fs.unlinkSync(file);
      this.rescanUnlocked();
      return existed;
    });
  }
  search(query: string, limit = 20): ProjectMemory[] {
    if (query.trim() === '' || [...query].length > 4096 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('E_MEMORY_SEARCH_INVALID');
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return this.list().map((record) => ({ record, score: terms.reduce((sum, term) => sum + (record.text.toLocaleLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || b.record.updated_at.localeCompare(a.record.updated_at)).slice(0, limit).map(({ record }) => record);
  }
  export(): MemoryExport { return { schema_version: 1, memories: this.list() }; }
  async import(bundle: unknown): Promise<number> {
    if (bundle === null || typeof bundle !== 'object' || (bundle as Partial<MemoryExport>).schema_version !== 1 || !Array.isArray((bundle as Partial<MemoryExport>).memories)) throw new Error('E_MEMORY_IMPORT_INVALID');
    const memories = (bundle as MemoryExport).memories;
    if (memories.length > 1000 || Buffer.byteLength(JSON.stringify(bundle)) > 8 * 1024 * 1024) throw new Error('E_MEMORY_IMPORT_TOO_LARGE');
    const prepared = new Map<string, ProjectMemory>();
    for (const item of memories) {
      if (item.schema_version !== 1 || typeof item.id !== 'string' || typeof item.text !== 'string') throw new Error('E_MEMORY_IMPORT_INVALID');
      const record = this.prepareRecord(item.text, item.metadata, item.id);
      // Preserve the prior last-duplicate-wins behavior without redundant writes.
      prepared.delete(record.id);
      prepared.set(record.id, record);
    }
    this.withIndexLock(() => {
      let writeError: unknown;
      try {
        for (const record of prepared.values()) this.putUnlocked(record);
      } catch (error) {
        writeError = error;
      } finally {
        try {
          this.rescanUnlocked();
        } catch (indexError) {
          if (writeError === undefined) throw indexError;
        }
      }
      if (writeError !== undefined) throw writeError;
    });
    return memories.length;
  }
  rescan(): readonly string[] {
    return this.withIndexLock(() => this.rescanUnlocked());
  }
}
