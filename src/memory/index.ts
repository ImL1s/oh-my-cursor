import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, withDirectoryLockSync } from '../runtime/atomic.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';
import {
  cleanMemoryMetadata,
  cleanMemoryText,
  MAX_SEARCH_QUERY_LENGTH,
  safeMemoryId,
  validateMemoryRecord,
  validateRawImportBundle,
  validIsoDate,
  type MemoryConflictPolicy,
  type MemoryDoctorReport,
  type MemoryExport,
  type MemoryImportOptions,
  type MemoryImportPlan,
  type MemoryImportPlanItem,
  type MemoryImportReceipt,
  type MemoryIndex,
  type MemoryIndexEntry,
  type ProjectMemory,
} from './schema.js';

export * from './schema.js';

const LOCK_TIMEOUT_MS = 5_000;

function readMemoryRecordFile(file: string, expectedId: string): ProjectMemory {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('E_STATE_CORRUPT');
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('E_STATE_CORRUPT');
    }
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return validateMemoryRecord(parsed, expectedId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('E_STATE_ABSENT', { cause: error });
    }
    if ((error as Error).message === 'E_STATE_CORRUPT') {
      throw error;
    }
    throw new Error('E_STATE_CORRUPT', { cause: error });
  }
}

export class ProjectMemoryStore {
  constructor(
    private readonly root: StateRoot,
    private readonly now: () => Date = () => new Date(),
    private readonly writeJson: (file: string, value: unknown) => unknown = atomicWriteJson,
  ) {}

  private dir(): string {
    return withinStateRoot(this.root, 'memory', 'records');
  }

  private file(id: string): string {
    return path.join(this.dir(), `${safeMemoryId(id)}.json`);
  }

  private indexFile(): string {
    return withinStateRoot(this.root, 'memory', 'index.json');
  }

  private quarantineDir(): string {
    return withinStateRoot(this.root, 'memory', 'quarantine');
  }

  private withIndexLock<T>(action: () => T): T {
    return withDirectoryLockSync(this.indexFile(), action, LOCK_TIMEOUT_MS, {
      errorPrefix: 'E_MEMORY_LOCK',
    });
  }

  private rescanUnlocked(): readonly string[] {
    const records = this.listUnlocked();
    const ids = records.map(({ id }) => id);
    const entries: MemoryIndexEntry[] = records.map((record) => {
      const recordFile = this.file(record.id);
      let byteSize = 0;
      try {
        byteSize = fs.statSync(recordFile).size;
      } catch {}
      return {
        id: record.id,
        updated_at: record.updated_at,
        byte_size: byteSize,
      };
    });

    const indexData: MemoryIndex = {
      schema_version: 1,
      ids,
      entries,
      rescanned_at: this.now().toISOString(),
    };
    this.writeJson(this.indexFile(), indexData);
    return ids;
  }

  private listUnlocked(): ProjectMemory[] {
    const recordsDir = this.dir();
    if (!fs.existsSync(recordsDir)) return [];
    return fs
      .readdirSync(recordsDir)
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .sort()
      .map((name) => {
        const id = name.slice(0, -'.json'.length);
        return readMemoryRecordFile(path.join(recordsDir, name), id);
      });
  }

  show(id: string): ProjectMemory {
    const safeId = safeMemoryId(id);
    return readMemoryRecordFile(this.file(safeId), safeId);
  }

  list(): ProjectMemory[] {
    return this.listUnlocked();
  }

  async put(
    text: string,
    metadata: unknown = {},
    id: string = crypto.randomUUID(),
  ): Promise<ProjectMemory> {
    const safeId = safeMemoryId(id);
    const cleanedText = cleanMemoryText(text);
    const cleanedMetadata = cleanMemoryMetadata(metadata);

    return this.withIndexLock(() => {
      const record: ProjectMemory = {
        schema_version: 1,
        id: safeId,
        text: cleanedText,
        metadata: cleanedMetadata,
        updated_at: this.now().toISOString(),
      };
      this.writeJson(this.file(safeId), record);
      this.rescanUnlocked();
      return record;
    });
  }

  async delete(
    id: string,
    options: { readonly expectedUpdatedAt?: string | undefined } = {},
  ): Promise<boolean> {
    const safeId = safeMemoryId(id);
    return this.withIndexLock(() => {
      const targetFile = this.file(safeId);
      if (!fs.existsSync(targetFile)) {
        return false;
      }
      if (options.expectedUpdatedAt !== undefined) {
        const existing = readMemoryRecordFile(targetFile, safeId);
        if (existing.updated_at !== options.expectedUpdatedAt) {
          throw new Error('E_MEMORY_PRECONDITION_FAILED');
        }
      }
      fs.unlinkSync(targetFile);
      this.rescanUnlocked();
      return true;
    });
  }

  search(query: string, limit = 20): ProjectMemory[] {
    if (
      typeof query !== 'string' ||
      query.trim() === '' ||
      [...query].length > MAX_SEARCH_QUERY_LENGTH ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new Error('E_MEMORY_SEARCH_INVALID');
    }
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return this.list()
      .map((record) => ({
        record,
        score: terms.reduce(
          (sum, term) => sum + (record.text.toLocaleLowerCase().includes(term) ? 1 : 0),
          0,
        ),
      }))
      .filter(({ score }) => score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || b.record.updated_at.localeCompare(a.record.updated_at),
      )
      .slice(0, limit)
      .map(({ record }) => record);
  }

  export(): MemoryExport {
    return { schema_version: 1, memories: this.list() };
  }

  planImport(bundle: unknown, options: MemoryImportOptions = {}): MemoryImportPlan {
    const validatedBundle = validateRawImportBundle(bundle);
    const conflictPolicy: MemoryConflictPolicy = options.conflict ?? 'reject';

    // 1. Validate each record in bundle
    const validatedIncoming: ProjectMemory[] = [];
    for (const rawItem of validatedBundle.memories) {
      if (rawItem === null || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        throw new Error('E_MEMORY_IMPORT_INVALID');
      }
      const itemObj = rawItem as Record<string, unknown>;
      if (itemObj.schema_version !== 1) {
        throw new Error('E_MEMORY_IMPORT_INVALID');
      }
      const id = safeMemoryId(itemObj.id);
      const text = cleanMemoryText(itemObj.text);
      const metadata = cleanMemoryMetadata(itemObj.metadata);
      const updatedAt = validIsoDate(itemObj.updated_at)
        ? (itemObj.updated_at as string)
        : this.now().toISOString();

      validatedIncoming.push({
        schema_version: 1,
        id,
        text,
        metadata,
        updated_at: updatedAt,
      });
    }

    // 2. Read local records to discover conflicts
    const localMap = new Map<string, ProjectMemory>();
    for (const record of this.listUnlocked()) {
      localMap.set(record.id, record);
    }

    // 3. Detect bundle-internal duplicates and plan actions
    const seenInBundle = new Map<string, ProjectMemory>();
    const conflicts: { readonly id: string; readonly reason: string }[] = [];
    const items: MemoryImportPlanItem[] = [];

    for (const incoming of validatedIncoming) {
      const priorInBundle = seenInBundle.get(incoming.id);

      if (priorInBundle !== undefined) {
        if (conflictPolicy === 'reject') {
          conflicts.push({
            id: incoming.id,
            reason: `Duplicate ID in import bundle: ${incoming.id}`,
          });
          continue;
        } else if (conflictPolicy === 'skip') {
          items.push({
            id: incoming.id,
            action: 'skip',
            reason: 'Duplicate ID in bundle skipped',
            incoming_updated_at: incoming.updated_at,
          });
          continue;
        } else if (conflictPolicy === 'replace') {
          seenInBundle.set(incoming.id, incoming);
          continue;
        } else if (conflictPolicy === 'newer-wins') {
          const priorTime = Date.parse(priorInBundle.updated_at);
          const incomingTime = Date.parse(incoming.updated_at);
          if (incomingTime > priorTime) {
            seenInBundle.set(incoming.id, incoming);
          }
          continue;
        }
      }

      seenInBundle.set(incoming.id, incoming);
    }

    const toCreate: string[] = [];
    const toReplace: string[] = [];
    const toSkip: string[] = [];

    for (const incoming of seenInBundle.values()) {
      const existing = localMap.get(incoming.id);
      if (existing === undefined) {
        toCreate.push(incoming.id);
        items.push({
          id: incoming.id,
          action: 'create',
          incoming_updated_at: incoming.updated_at,
        });
      } else {
        if (conflictPolicy === 'reject') {
          conflicts.push({
            id: incoming.id,
            reason: `ID already exists in memory store: ${incoming.id}`,
          });
        } else if (conflictPolicy === 'skip') {
          toSkip.push(incoming.id);
          items.push({
            id: incoming.id,
            action: 'skip',
            reason: 'Existing ID skipped',
            incoming_updated_at: incoming.updated_at,
            existing_updated_at: existing.updated_at,
          });
        } else if (conflictPolicy === 'replace') {
          toReplace.push(incoming.id);
          items.push({
            id: incoming.id,
            action: 'replace',
            incoming_updated_at: incoming.updated_at,
            existing_updated_at: existing.updated_at,
          });
        } else if (conflictPolicy === 'newer-wins') {
          const incomingTime = Date.parse(incoming.updated_at);
          const existingTime = Date.parse(existing.updated_at);
          if (incomingTime > existingTime) {
            toReplace.push(incoming.id);
            items.push({
              id: incoming.id,
              action: 'replace',
              reason: `Incoming timestamp (${incoming.updated_at}) is newer than local (${existing.updated_at})`,
              incoming_updated_at: incoming.updated_at,
              existing_updated_at: existing.updated_at,
            });
          } else {
            toSkip.push(incoming.id);
            items.push({
              id: incoming.id,
              action: 'skip',
              reason: `Local timestamp (${existing.updated_at}) is newer or equal to incoming (${incoming.updated_at})`,
              incoming_updated_at: incoming.updated_at,
              existing_updated_at: existing.updated_at,
            });
          }
        }
      }
    }

    return {
      schema_version: 1,
      conflict_policy: conflictPolicy,
      total_incoming: validatedIncoming.length,
      to_create: toCreate,
      to_replace: toReplace,
      to_skip: toSkip,
      conflicts,
      items,
    };
  }

  async import(
    bundle: unknown,
    options: MemoryImportOptions = {},
  ): Promise<MemoryImportReceipt> {
    const plan = this.planImport(bundle, options);

    if (plan.conflicts.length > 0) {
      const conflictIds = plan.conflicts.map((c) => c.id).join(', ');
      throw new Error(`E_MEMORY_CONFLICT: Conflicting IDs: ${conflictIds}`);
    }

    const importedCount = plan.to_create.length + plan.to_replace.length;
    const receipt: MemoryImportReceipt = {
      schema_version: 1,
      dry_run: options.dryRun === true,
      conflict_policy: plan.conflict_policy,
      imported: importedCount,
      created: plan.to_create,
      replaced: plan.to_replace,
      skipped: plan.to_skip,
    };

    if (options.dryRun === true) {
      return receipt;
    }

    // Build the resolved map of records to commit
    const validatedBundle = validateRawImportBundle(bundle);
    const resolvedRecords = new Map<string, ProjectMemory>();
    for (const rawItem of validatedBundle.memories) {
      const itemObj = rawItem as Record<string, unknown>;
      const id = safeMemoryId(itemObj.id);
      if (!plan.to_create.includes(id) && !plan.to_replace.includes(id)) {
        continue;
      }
      const text = cleanMemoryText(itemObj.text);
      const metadata = cleanMemoryMetadata(itemObj.metadata);
      const updatedAt = validIsoDate(itemObj.updated_at)
        ? (itemObj.updated_at as string)
        : this.now().toISOString();
      resolvedRecords.set(id, {
        schema_version: 1,
        id,
        text,
        metadata,
        updated_at: updatedAt,
      });
    }

    return this.withIndexLock(() => {
      const recordsDir = this.dir();
      fs.mkdirSync(recordsDir, { recursive: true });

      // Transactional commit using a temporary staging directory
      const stagingDir = path.join(
        withinStateRoot(this.root, 'memory'),
        `.staging-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
      );
      fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

      try {
        // Stage all incoming writes
        const stagedFiles: { readonly stagingPath: string; readonly targetPath: string }[] = [];
        for (const record of resolvedRecords.values()) {
          const stagingPath = path.join(stagingDir, `${record.id}.json`);
          const targetPath = this.file(record.id);
          this.writeJson(stagingPath, record);
          stagedFiles.push({ stagingPath, targetPath });
        }

        // Atomically commit all staged files into records/
        for (const { stagingPath, targetPath } of stagedFiles) {
          fs.renameSync(stagingPath, targetPath);
        }

        // Rebuild index once
        this.rescanUnlocked();

        return receipt;
      } finally {
        try {
          if (fs.existsSync(stagingDir)) {
            fs.rmSync(stagingDir, { recursive: true, force: true });
          }
        } catch {}
      }
    });
  }

  async doctor(options: { readonly repair?: boolean | undefined } = {}): Promise<MemoryDoctorReport> {
    return this.withIndexLock(() => {
      const recordsDir = this.dir();
      const corruptRecords: {
        file: string;
        id?: string | undefined;
        reason: string;
        quarantined_to?: string | undefined;
      }[] = [];

      let totalRecords = 0;
      let validRecords = 0;

      if (fs.existsSync(recordsDir)) {
        const entries = fs.readdirSync(recordsDir).sort();
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          totalRecords++;
          const filePath = path.join(recordsDir, entry);
          let isValid = false;
          let recordId: string | undefined;

          try {
            if (!entry.endsWith('.json')) {
              throw new Error('Filename does not end with .json');
            }
            recordId = entry.slice(0, -'.json'.length);
            readMemoryRecordFile(filePath, recordId);
            isValid = true;
            validRecords++;
          } catch (err) {
            const reason = (err as Error).message;
            let quarantinedTo: string | undefined;

            if (options.repair === true) {
              const qDir = this.quarantineDir();
              fs.mkdirSync(qDir, { recursive: true, mode: 0o700 });
              const nonce = crypto.randomBytes(6).toString('hex');
              const qFile = path.join(qDir, `${entry}.corrupt-${Date.now()}-${nonce}`);
              fs.renameSync(filePath, qFile);
              quarantinedTo = qFile;
            }

            corruptRecords.push({
              file: entry,
              id: recordId,
              reason,
              quarantined_to: quarantinedTo,
            });
          }
        }
      }

      let indexRebuilt = false;
      const indexFile = this.indexFile();

      if (options.repair === true || corruptRecords.length > 0 || !fs.existsSync(indexFile)) {
        if (options.repair === true) {
          this.rescanUnlocked();
          indexRebuilt = true;
        }
      }

      return {
        ok: corruptRecords.length === 0,
        total_records: totalRecords,
        valid_records: validRecords,
        corrupt_records: corruptRecords,
        index_rebuilt: indexRebuilt,
      };
    });
  }

  rescan(): readonly string[] {
    return this.withIndexLock(() => this.rescanUnlocked());
  }
}
