import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, secureFilePath, withDirectoryLockSync } from '../runtime/atomic.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';
import {
  cleanMemoryMetadata,
  cleanMemoryText,
  MAX_INDEX_FILE_BYTES,
  MAX_RECORD_FILE_BYTES,
  MAX_SEARCH_QUERY_LENGTH,
  safeMemoryId,
  validateConflictPolicy,
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
    if (stat.size > MAX_RECORD_FILE_BYTES) {
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

function safeQuarantineFilename(originalName: string, nonce: string, timestamp: number): string {
  const suffix = `.corrupt-${timestamp}-${nonce}`;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const maxTotalBytes = 200;
  const maxBaseBytes = maxTotalBytes - suffixBytes;

  if (Buffer.byteLength(originalName, 'utf8') <= maxBaseBytes) {
    return `${originalName}${suffix}`;
  }

  const hash = crypto.createHash('sha256').update(originalName).digest('hex').slice(0, 16);
  const hashSuffix = `-${hash}`;
  const hashSuffixBytes = Buffer.byteLength(hashSuffix, 'utf8');
  const allowedPrefixBytes = maxBaseBytes - hashSuffixBytes;

  const buf = Buffer.from(originalName, 'utf8');
  let prefix = buf.subarray(0, allowedPrefixBytes).toString('utf8');
  while (Buffer.byteLength(prefix, 'utf8') > allowedPrefixBytes || prefix.endsWith('\uFFFD')) {
    prefix = prefix.slice(0, -1);
  }

  const base = `${prefix}${hashSuffix}`;
  return `${base}${suffix}`;
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
          b.score - a.score ||
          Date.parse(b.record.updated_at) - Date.parse(a.record.updated_at) ||
          b.record.updated_at.localeCompare(a.record.updated_at) ||
          a.record.id.localeCompare(b.record.id),
      )
      .slice(0, limit)
      .map(({ record }) => record);
  }

  export(): MemoryExport {
    return { schema_version: 1, memories: this.list() };
  }

  private computeImportPlan(
    bundle: unknown,
    options: MemoryImportOptions = {},
  ): {
    readonly plan: MemoryImportPlan;
    readonly resolvedRecords: Map<string, ProjectMemory>;
  } {
    const validatedBundle = validateRawImportBundle(bundle);
    const conflictPolicy: MemoryConflictPolicy = validateConflictPolicy(options.conflict);

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
    const toCreate: string[] = [];
    const toReplace: string[] = [];
    const toSkip: string[] = [];

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
          toSkip.push(incoming.id);
          items.push({
            id: incoming.id,
            action: 'skip',
            reason: 'Duplicate ID in bundle skipped',
            incoming_updated_at: incoming.updated_at,
          });
          continue;
        } else if (conflictPolicy === 'replace') {
          toSkip.push(priorInBundle.id);
          items.push({
            id: priorInBundle.id,
            action: 'skip',
            reason: 'Prior duplicate ID in bundle replaced by later record',
            incoming_updated_at: priorInBundle.updated_at,
          });
          seenInBundle.set(incoming.id, incoming);
          continue;
        } else if (conflictPolicy === 'newer-wins') {
          const priorTime = Date.parse(priorInBundle.updated_at);
          const incomingTime = Date.parse(incoming.updated_at);
          if (incomingTime > priorTime) {
            toSkip.push(priorInBundle.id);
            items.push({
              id: priorInBundle.id,
              action: 'skip',
              reason: `Older duplicate ID in bundle (${priorInBundle.updated_at}) superseded by newer (${incoming.updated_at})`,
              incoming_updated_at: priorInBundle.updated_at,
            });
            seenInBundle.set(incoming.id, incoming);
          } else {
            toSkip.push(incoming.id);
            items.push({
              id: incoming.id,
              action: 'skip',
              reason: `Older duplicate ID in bundle (${incoming.updated_at}) skipped in favor of (${priorInBundle.updated_at})`,
              incoming_updated_at: incoming.updated_at,
            });
          }
          continue;
        }
      }

      seenInBundle.set(incoming.id, incoming);
    }

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

    const plan: MemoryImportPlan = {
      schema_version: 1,
      conflict_policy: conflictPolicy,
      total_incoming: validatedIncoming.length,
      to_create: toCreate,
      to_replace: toReplace,
      to_skip: toSkip,
      conflicts,
      items,
    };

    return {
      plan,
      resolvedRecords: seenInBundle,
    };
  }

  planImport(
    bundle: unknown,
    options: MemoryImportOptions = {},
  ): MemoryImportPlan {
    return this.computeImportPlan(bundle, options).plan;
  }

  async import(
    bundle: unknown,
    options: MemoryImportOptions = {},
  ): Promise<MemoryImportReceipt> {
    const { plan, resolvedRecords } = this.computeImportPlan(bundle, options);

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

    // Only commit records that were selected to create or replace
    const recordsToCommit = new Map<string, ProjectMemory>();
    for (const id of [...plan.to_create, ...plan.to_replace]) {
      const record = resolvedRecords.get(id);
      if (record !== undefined) {
        recordsToCommit.set(id, record);
      }
    }

    return this.withIndexLock(() => {
      const recordsDir = this.dir();
      if (fs.existsSync(recordsDir)) {
        const stat = fs.lstatSync(recordsDir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error('E_MEMORY_PARENT_INVALID: records directory cannot be a symlink');
        }
      } else {
        fs.mkdirSync(recordsDir, { recursive: true, mode: 0o700 });
      }

      // Transactional commit using a temporary staging directory
      const stagingDir = path.join(
        withinStateRoot(this.root, 'memory'),
        `.staging-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
      );
      fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

      try {
        // Stage all incoming writes
        const stagedFiles: { readonly stagingPath: string; readonly targetPath: string }[] = [];
        for (const record of recordsToCommit.values()) {
          const stagingPath = path.join(stagingDir, `${record.id}.json`);
          const targetPath = this.file(record.id);
          this.writeJson(stagingPath, record);
          stagedFiles.push({ stagingPath, targetPath });
        }

        // Validate all target paths against symlinks before any rename occurs
        for (const { targetPath } of stagedFiles) {
          secureFilePath(targetPath, 'E_MEMORY');
          if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isSymbolicLink()) {
            throw new Error('E_MEMORY_TARGET_INVALID: target record cannot be a symlink');
          }
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
      const validRecordIds: string[] = [];

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
            validRecordIds.push(recordId);
          } catch (err) {
            const reason = (err as Error).message;
            let quarantinedTo: string | undefined;

            if (options.repair === true) {
              const qDir = this.quarantineDir();
              fs.mkdirSync(qDir, { recursive: true, mode: 0o700 });
              const nonce = crypto.randomBytes(6).toString('hex');
              const qFile = path.join(qDir, safeQuarantineFilename(entry, nonce, Date.now()));
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

      const indexFile = this.indexFile();
      let indexIssue: string | undefined;
      let indexStat: fs.Stats | undefined;

      try {
        indexStat = fs.lstatSync(indexFile);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          indexIssue = `Index file stat failed: ${(err as Error).message}`;
        }
      }

      if (!indexStat) {
        if (validRecordIds.length > 0) {
          indexIssue = 'Index file is missing';
        }
      } else {
        try {
          if (!indexStat.isFile() || indexStat.isSymbolicLink()) {
            indexIssue = 'Index file is not a regular file';
          } else if (typeof process.getuid === 'function' && indexStat.uid !== process.getuid()) {
            indexIssue = 'Index file is not owned by current user';
          } else if (indexStat.size > MAX_INDEX_FILE_BYTES) {
            indexIssue = `Index file exceeds maximum allowed size (${indexStat.size} bytes > ${MAX_INDEX_FILE_BYTES} bytes)`;
          } else {
            const rawIndex = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
            if (
              rawIndex === null ||
              typeof rawIndex !== 'object' ||
              rawIndex.schema_version !== 1 ||
              !Array.isArray(rawIndex.ids) ||
              !rawIndex.ids.every((id: unknown) => typeof id === 'string')
            ) {
              indexIssue = 'Index file is malformed';
            } else {
              const indexIds = [...(rawIndex.ids as string[])].sort();
              const sortedValidIds = [...validRecordIds].sort();
              if (
                indexIds.length !== sortedValidIds.length ||
                indexIds.some((id, idx) => id !== sortedValidIds[idx])
              ) {
                indexIssue = `Index IDs [${indexIds.join(', ')}] do not match scanned records [${sortedValidIds.join(', ')}]`;
              }
            }
          }
        } catch (err) {
          indexIssue = `Index file is unreadable: ${(err as Error).message}`;
        }
      }

      if (indexIssue !== undefined) {
        let quarantinedTo: string | undefined;
        let indexStillExists = false;
        try {
          fs.lstatSync(indexFile);
          indexStillExists = true;
        } catch {}

        if (options.repair === true && indexStillExists) {
          const qDir = this.quarantineDir();
          fs.mkdirSync(qDir, { recursive: true, mode: 0o700 });
          const nonce = crypto.randomBytes(6).toString('hex');
          const qFile = path.join(qDir, safeQuarantineFilename('index.json', nonce, Date.now()));
          fs.renameSync(indexFile, qFile);
          quarantinedTo = qFile;
        }

        corruptRecords.push({
          file: 'index.json',
          reason: indexIssue,
          quarantined_to: quarantinedTo,
        });
      }

      let indexRebuilt = false;
      let indexFileExists = false;
      try {
        fs.lstatSync(indexFile);
        indexFileExists = true;
      } catch {}

      if (options.repair === true && (corruptRecords.length > 0 || !indexFileExists)) {
        this.rescanUnlocked();
        indexRebuilt = true;
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
