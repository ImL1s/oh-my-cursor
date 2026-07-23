import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../runtime/atomic.js';
import { redact } from '../runtime/redaction.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';

export interface ProjectMemory { readonly schema_version: 1; readonly id: string; readonly text: string; readonly metadata: unknown; readonly updated_at: string }
export interface MemoryExport { readonly schema_version: 1; readonly memories: readonly ProjectMemory[] }
function safe(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('E_MEMORY_ID_INVALID'); return value; }
function cleanText(value: string): string { if (value.trim() === '' || Buffer.byteLength(value) > 64 * 1024) throw new Error('E_MEMORY_TEXT_INVALID'); return String(redact(value, { maxStringLength: 64 * 1024 })); }
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 60_000;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export class ProjectMemoryStore {
  constructor(private readonly root: StateRoot, private readonly now: () => Date = () => new Date()) {}
  private dir(): string { return withinStateRoot(this.root, 'memory', 'records'); }
  private file(id: string): string { return path.join(this.dir(), `${safe(id)}.json`); }
  private indexFile(): string { return withinStateRoot(this.root, 'memory', 'index.json'); }
  private withIndexLock<T>(action: () => T): T {
    const lock = `${this.indexFile()}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    const token = crypto.randomBytes(16).toString('hex');
    while (true) {
      try {
        fs.mkdirSync(lock, { mode: 0o700 });
        atomicWriteJson(path.join(lock, 'owner.json'), {
          schema_version: 1, pid: process.pid, token, created_at_ms: Date.now(),
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let reclaim = false;
        try {
          const stat = fs.lstatSync(lock);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('E_MEMORY_LOCK_INVALID');
          if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('E_MEMORY_LOCK_NOT_OWNED');
          try {
            const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')) as { pid?: unknown; created_at_ms?: unknown };
            if (typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0) reclaim = !processAlive(owner.pid);
            else reclaim = Date.now() - stat.mtimeMs > LOCK_STALE_MS;
          } catch {
            reclaim = Date.now() - stat.mtimeMs > LOCK_STALE_MS;
          }
          if (reclaim) {
            const stale = `${lock}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
            fs.renameSync(lock, stale);
            fs.rmSync(stale, { recursive: true, force: true });
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw lockError;
        }
        if (Date.now() >= deadline) throw new Error('E_MEMORY_LOCK_TIMEOUT');
        Atomics.wait(waitBuffer, 0, 0, 10);
      }
    }
    try {
      return action();
    } finally {
      const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')) as { pid?: unknown; token?: unknown };
      if (owner.pid !== process.pid || owner.token !== token) throw new Error('E_MEMORY_LOCK_OWNERSHIP_LOST');
      fs.rmSync(lock, { recursive: true });
    }
  }
  private rescanUnlocked(): readonly string[] {
    const ids = this.list().map(({ id }) => id);
    atomicWriteJson(this.indexFile(), { schema_version: 1, ids, rescanned_at: this.now().toISOString() });
    return ids;
  }
  show(id: string): ProjectMemory { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as ProjectMemory; }
  list(): ProjectMemory[] {
    if (!fs.existsSync(this.dir())) return [];
    return fs.readdirSync(this.dir()).filter((name) => name.endsWith('.json')).sort().map((name) => JSON.parse(fs.readFileSync(path.join(this.dir(), name), 'utf8')) as ProjectMemory);
  }
  async put(text: string, metadata: unknown = {}, id: string = crypto.randomUUID()): Promise<ProjectMemory> {
    const file = this.file(id);
    return this.withIndexLock(() => {
      const record: ProjectMemory = { schema_version: 1, id: safe(id), text: cleanText(text), metadata: redact(metadata), updated_at: this.now().toISOString() };
      atomicWriteJson(file, record); this.rescanUnlocked(); return record;
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
    if (query.trim() === '' || query.length > 1024 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('E_MEMORY_SEARCH_INVALID');
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return this.list().map((record) => ({ record, score: terms.reduce((sum, term) => sum + (record.text.toLocaleLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || b.record.updated_at.localeCompare(a.record.updated_at)).slice(0, limit).map(({ record }) => record);
  }
  export(): MemoryExport { return { schema_version: 1, memories: this.list() }; }
  async import(bundle: unknown): Promise<number> {
    if (bundle === null || typeof bundle !== 'object' || (bundle as Partial<MemoryExport>).schema_version !== 1 || !Array.isArray((bundle as Partial<MemoryExport>).memories)) throw new Error('E_MEMORY_IMPORT_INVALID');
    const memories = (bundle as MemoryExport).memories;
    if (memories.length > 1000 || Buffer.byteLength(JSON.stringify(bundle)) > 8 * 1024 * 1024) throw new Error('E_MEMORY_IMPORT_TOO_LARGE');
    for (const item of memories) {
      if (item.schema_version !== 1 || typeof item.id !== 'string' || typeof item.text !== 'string') throw new Error('E_MEMORY_IMPORT_INVALID');
      await this.put(item.text, item.metadata, item.id);
    }
    return memories.length;
  }
  rescan(): readonly string[] {
    return this.withIndexLock(() => this.rescanUnlocked());
  }
}
