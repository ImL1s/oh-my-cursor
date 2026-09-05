import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { ProjectMemoryStore } from '../../src/memory/index.js';
import { projectStateRoot } from '../../src/runtime/state-root.js';
import { atomicWriteJson } from '../../src/runtime/atomic.js';
import { runCli } from '../../src/cli/application.js';

describe('ProjectMemoryStore transactional, conflict-aware, and schema-validated behavior', () => {
  let tempDir: string;
  const fixedDate = new Date('2026-09-05T10:00:00.000Z');
  const now = () => fixedDate;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-memory-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('validates schema, enforces text and metadata bounds, and redacts sensitive data', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now);

    // 1. Valid record creation with redaction
    const record = await store.put(
      'Server token=sk-live-1234567890abcdef config',
      { secret_key: 'topsecret', port: 8080 },
      'server-config',
    );
    expect(record.schema_version).toBe(1);
    expect(record.id).toBe('server-config');
    expect(record.text).toContain('token=<redacted>');
    expect(record.metadata).toEqual({ secret_key: '<redacted>', port: 8080 });
    expect(record.updated_at).toBe(fixedDate.toISOString());

    // 2. Reject empty or oversized text
    await expect(store.put('   ', {}, 'blank')).rejects.toThrow('E_MEMORY_TEXT_INVALID');
    await expect(store.put('a'.repeat(65 * 1024), {}, 'too-large')).rejects.toThrow('E_MEMORY_TEXT_INVALID');

    // 3. Reject invalid ID
    await expect(store.put('valid text', {}, '../path-traversal')).rejects.toThrow('E_MEMORY_ID_INVALID');
    await expect(store.put('valid text', {}, '-invalid-start')).rejects.toThrow('E_MEMORY_ID_INVALID');

    // 4. Reject oversized metadata
    const hugeMetadata: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) hugeMetadata[`key_${i}`] = 'val_' + 'x'.repeat(40);
    await expect(store.put('valid text', hugeMetadata, 'huge-meta')).rejects.toThrow('E_MEMORY_METADATA_INVALID');

    // 5. Reject metadata that expands beyond 64 KiB after redaction
    const expandingMeta: Record<string, boolean> = {};
    for (let i = 0; i < 80; i++) {
      expandingMeta['secret_' + String(i).padStart(2, '0') + '_' + 'a'.repeat(800)] = false;
    }
    expect(Buffer.byteLength(JSON.stringify(expandingMeta))).toBeLessThan(64 * 1024);
    await expect(store.put('valid text', expandingMeta, 'expanding-meta')).rejects.toThrow('E_MEMORY_METADATA_INVALID');
    expect(() => store.show('expanding-meta')).toThrow();
    expect(store.list()).toHaveLength(1);
  });

  it('detects duplicate IDs and existing conflicts with default reject policy', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now);

    await store.put('existing content', {}, 'existing-id');

    // 1. Duplicate ID within bundle
    await expect(
      store.import({
        schema_version: 1,
        memories: [
          { schema_version: 1, id: 'dup-id', text: 'first', metadata: {}, updated_at: '2026-09-01T00:00:00.000Z' },
          { schema_version: 1, id: 'dup-id', text: 'second', metadata: {}, updated_at: '2026-09-01T00:00:00.000Z' },
        ],
      }),
    ).rejects.toThrow('E_MEMORY_CONFLICT');

    // 2. Conflict with existing local record
    await expect(
      store.import({
        schema_version: 1,
        memories: [
          { schema_version: 1, id: 'existing-id', text: 'new text', metadata: {}, updated_at: '2026-09-01T00:00:00.000Z' },
        ],
      }),
    ).rejects.toThrow('E_MEMORY_CONFLICT');

    // Existing record was not modified
    expect(store.show('existing-id').text).toBe('existing content');
  });

  it('supports skip, replace, and newer-wins conflict resolution policies', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now);

    await store.put('initial v1', {}, 'rec-a'); // updated_at: 2026-09-05T10:00:00.000Z

    // Case 1: Policy 'skip' ignores existing ID and keeps local
    const skipReceipt = await store.import(
      {
        schema_version: 1,
        memories: [
          { schema_version: 1, id: 'rec-a', text: 'ignored incoming', metadata: {}, updated_at: '2026-09-06T00:00:00.000Z' },
          { schema_version: 1, id: 'rec-b', text: 'new record', metadata: {}, updated_at: '2026-09-01T00:00:00.000Z' },
        ],
      },
      { conflict: 'skip' },
    );
    expect(skipReceipt.created).toEqual(['rec-b']);
    expect(skipReceipt.skipped).toEqual(['rec-a']);
    expect(store.show('rec-a').text).toBe('initial v1');
    expect(store.show('rec-b').text).toBe('new record');

    // Case 2: Policy 'replace' overwrites local record unconditionally
    const replaceReceipt = await store.import(
      {
        schema_version: 1,
        memories: [
          { schema_version: 1, id: 'rec-a', text: 'overwritten v2', metadata: {}, updated_at: '2026-09-02T00:00:00.000Z' },
        ],
      },
      { conflict: 'replace' },
    );
    expect(replaceReceipt.replaced).toEqual(['rec-a']);
    expect(store.show('rec-a').text).toBe('overwritten v2');

    // Case 3: Policy 'newer-wins' compares timestamps
    // Local rec-a is updated_at: 2026-09-02T00:00:00.000Z
    // 3a. Older incoming -> skipped
    const newerReceipt1 = await store.import(
      {
        schema_version: 1,
        memories: [
          { schema_version: 1, id: 'rec-a', text: 'older text', metadata: {}, updated_at: '2026-09-01T00:00:00.000Z' },
        ],
      },
      { conflict: 'newer-wins' },
    );
    expect(newerReceipt1.skipped).toEqual(['rec-a']);
    expect(store.show('rec-a').text).toBe('overwritten v2');

    // 3b. Newer incoming -> replaces
    const newerReceipt2 = await store.import(
      {
        schema_version: 1,
        memories: [
          { schema_version: 1, id: 'rec-a', text: 'newest text v3', metadata: {}, updated_at: '2026-09-10T00:00:00.000Z' },
        ],
      },
      { conflict: 'newer-wins' },
    );
    expect(newerReceipt2.replaced).toEqual(['rec-a']);
    expect(store.show('rec-a').text).toBe('newest text v3');
  });

  it('correctly commits the selected duplicate when bundle contains internal duplicate IDs', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now);

    // Case 1: newer-wins where the NEWER record appears FIRST, and OLDER appears SECOND in bundle.
    // The newer record must NOT be overwritten by the later older record.
    const newerFirstPlan = store.planImport(
      {
        schema_version: 1,
        memories: [
          {
            schema_version: 1,
            id: 'internal-dup',
            text: 'newer text v1',
            metadata: {},
            updated_at: '2026-06-01T00:00:00.000Z',
          },
          {
            schema_version: 1,
            id: 'internal-dup',
            text: 'older text v2',
            metadata: {},
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      { conflict: 'newer-wins' },
    );
    expect(newerFirstPlan.to_create).toEqual(['internal-dup']);
    expect(newerFirstPlan.to_skip).toEqual(['internal-dup']);

    const newerReceipt = await store.import(
      {
        schema_version: 1,
        memories: [
          {
            schema_version: 1,
            id: 'internal-dup',
            text: 'newer text v1',
            metadata: {},
            updated_at: '2026-06-01T00:00:00.000Z',
          },
          {
            schema_version: 1,
            id: 'internal-dup',
            text: 'older text v2',
            metadata: {},
            updated_at: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
      { conflict: 'newer-wins' },
    );

    expect(newerReceipt.created).toEqual(['internal-dup']);
    expect(newerReceipt.skipped).toEqual(['internal-dup']);
    expect(store.show('internal-dup').text).toBe('newer text v1');
    expect(store.show('internal-dup').updated_at).toBe('2026-06-01T00:00:00.000Z');

    // Case 2: skip where the FIRST record appears, and a SECOND record appears with different content.
    // Under skip, the first record must be kept and the second skipped, not overwriting the first.
    // Both plan.to_skip and receipt.skipped must include the duplicate skipped record.
    const skipPlan = store.planImport(
      {
        schema_version: 1,
        memories: [
          {
            schema_version: 1,
            id: 'internal-skip-dup',
            text: 'first text',
            metadata: {},
            updated_at: '2026-01-01T00:00:00.000Z',
          },
          {
            schema_version: 1,
            id: 'internal-skip-dup',
            text: 'second text (should be skipped)',
            metadata: {},
            updated_at: '2026-02-01T00:00:00.000Z',
          },
        ],
      },
      { conflict: 'skip' },
    );
    expect(skipPlan.to_create).toEqual(['internal-skip-dup']);
    expect(skipPlan.to_skip).toEqual(['internal-skip-dup']);

    const skipReceipt = await store.import(
      {
        schema_version: 1,
        memories: [
          {
            schema_version: 1,
            id: 'internal-skip-dup',
            text: 'first text',
            metadata: {},
            updated_at: '2026-01-01T00:00:00.000Z',
          },
          {
            schema_version: 1,
            id: 'internal-skip-dup',
            text: 'second text (should be skipped)',
            metadata: {},
            updated_at: '2026-02-01T00:00:00.000Z',
          },
        ],
      },
      { conflict: 'skip' },
    );

    expect(skipReceipt.created).toEqual(['internal-skip-dup']);
    expect(skipReceipt.skipped).toEqual(['internal-skip-dup']);
    expect(store.show('internal-skip-dup').text).toBe('first text');
  });

  it('provides dry-run planning without writing any files', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now);

    const receipt = await store.import(
      {
        schema_version: 1,
        memories: [
          { schema_version: 1, id: 'dry-1', text: 'dry run content 1', metadata: {}, updated_at: '2026-09-01T00:00:00.000Z' },
          { schema_version: 1, id: 'dry-2', text: 'dry run content 2', metadata: {}, updated_at: '2026-09-01T00:00:00.000Z' },
        ],
      },
      { dryRun: true },
    );

    expect(receipt.dry_run).toBe(true);
    expect(receipt.imported).toBe(2);
    expect(receipt.created).toEqual(['dry-1', 'dry-2']);

    // Zero files on disk
    expect(store.list()).toEqual([]);
  });

  it('guarantees all-or-nothing rollback when write failure occurs during import', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now, (file, value) => {
      if (file.includes('fail-item.json')) {
        throw new Error('E_SIMULATED_DISK_FAILURE');
      }
      return atomicWriteJson(file, value);
    });

    await expect(
      store.import({
        schema_version: 1,
        memories: [
          { schema_version: 1, id: 'item-1', text: 'content 1', metadata: {}, updated_at: '2026-09-01T00:00:00.000Z' },
          { schema_version: 1, id: 'fail-item', text: 'content 2', metadata: {}, updated_at: '2026-09-01T00:00:00.000Z' },
        ],
      }),
    ).rejects.toThrow('E_SIMULATED_DISK_FAILURE');

    // Both item-1 and fail-item must NOT exist
    expect(store.list()).toEqual([]);
    const recordsDir = path.join(root.path, 'memory', 'records');
    if (fs.existsSync(recordsDir)) {
      expect(fs.readdirSync(recordsDir)).toEqual([]);
    }
  });

  it('preserves exact export -> import -> export round trip timestamps and fidelity', async () => {
    const root1 = projectStateRoot(path.join(tempDir, 'r1'));
    const store1 = new ProjectMemoryStore(root1, now);

    await store1.put('first memory', { tags: ['alpha'] }, 'mem-1');
    await store1.put('second memory', { tags: ['beta'] }, 'mem-2');

    // Also import a record with a non-UTC timezone offset
    await store1.import({
      schema_version: 1,
      memories: [
        {
          schema_version: 1,
          id: 'mem-offset',
          text: 'offset memory',
          metadata: {},
          updated_at: '2026-09-10T00:00:00-10:00',
        },
      ],
    });

    const exported1 = store1.export();

    const root2 = projectStateRoot(path.join(tempDir, 'r2'));
    const store2 = new ProjectMemoryStore(root2, now);

    const receipt = await store2.import(exported1);
    expect(receipt.imported).toBe(3);

    const exported2 = store2.export();
    expect(exported2).toEqual(exported1);
    expect(store2.show('mem-offset').updated_at).toBe('2026-09-10T00:00:00-10:00');
  });

  it('supports delete with expectedUpdatedAt precondition check', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now);

    const record = await store.put('deletable memory', {}, 'del-1');

    // Precondition failure with mismatching timestamp
    await expect(
      store.delete('del-1', { expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }),
    ).rejects.toThrow('E_MEMORY_PRECONDITION_FAILED');
    expect(store.show('del-1').text).toBe('deletable memory');

    // Precondition success
    expect(await store.delete('del-1', { expectedUpdatedAt: record.updated_at })).toBe(true);
    expect(store.list()).toEqual([]);
    expect(await store.delete('del-1')).toBe(false);

    // If an unlink occurred but index write failed, retrying delete reconciles index and returns false
    await store.put('record 2', {}, 'del-2');
    const rec2File = path.join(root.path, 'memory', 'records', 'del-2.json');
    const indexFile = path.join(root.path, 'memory', 'index.json');
    fs.unlinkSync(rec2File);
    const rawIndex = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    expect(rawIndex.ids).toContain('del-2');

    expect(await store.delete('del-2')).toBe(false);
    const updatedIndex = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    expect(updatedIndex.ids).not.toContain('del-2');
  });

  it('detects corrupt records in doctor and repairs cleanly into quarantine without data loss', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now);

    await store.put('valid record 1', {}, 'rec-1');
    await store.put('valid record 2', {}, 'rec-2');

    const recordsDir = path.join(root.path, 'memory', 'records');
    // Inject corrupt record (invalid JSON and mismatched ID)
    fs.writeFileSync(path.join(recordsDir, 'corrupt-bad.json'), 'not-valid-json\n');
    fs.writeFileSync(path.join(recordsDir, 'mismatch.json'), JSON.stringify({
      schema_version: 1,
      id: 'other-id',
      text: 'mismatch id',
      metadata: {},
      updated_at: fixedDate.toISOString(),
    }));

    // Doctor audit without repair
    const report1 = await store.doctor();
    expect(report1.ok).toBe(false);
    expect(report1.corrupt_records).toHaveLength(2);
    expect(report1.index_rebuilt).toBe(false);

    // Doctor audit with repair
    const report2 = await store.doctor({ repair: true });
    expect(report2.ok).toBe(false);
    expect(report2.corrupt_records).toHaveLength(2);
    expect(report2.index_rebuilt).toBe(true);

    // Corrupt records were moved to quarantine/
    const quarantineDir = path.join(root.path, 'memory', 'quarantine');
    expect(fs.existsSync(quarantineDir)).toBe(true);
    const quarantined = fs.readdirSync(quarantineDir);
    expect(quarantined).toHaveLength(2);

    // Valid records remain intact and readable
    expect(store.list().map((r) => r.id)).toEqual(['rec-1', 'rec-2']);

    // Doctor is now healthy
    const report3 = await store.doctor();
    expect(report3.ok).toBe(true);
    expect(report3.corrupt_records).toHaveLength(0);
  });

  it('supports CLI memory commands: import with conflict/dry-run, delete with precondition, and doctor', async () => {
    const bundleFile = path.join(tempDir, 'import-bundle.json');
    fs.writeFileSync(
      bundleFile,
      JSON.stringify({
        schema_version: 1,
        memories: [
          { schema_version: 1, id: 'cli-rec-1', text: 'cli content 1', metadata: { k: 1 }, updated_at: '2026-09-01T00:00:00.000Z' },
          { schema_version: 1, id: 'cli-rec-2', text: 'cli content 2', metadata: { k: 2 }, updated_at: '2026-09-02T00:00:00.000Z' },
        ],
      }),
    );

    let stdout = '';
    let stderr = '';
    const io = {
      stdout: (msg: string) => { stdout += msg; },
      stderr: (msg: string) => { stderr += msg; },
    };

    // 1. Dry run on absent workspace fails closed without creating .omcu
    const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-memory-dry-absent-'));
    try {
      stdout = '';
      stderr = '';
      const dryAbsentCode = await runCli(['memory', 'import', '--file', bundleFile, '--dry-run'], {
        cwd: freshDir,
      }, io);
      expect(dryAbsentCode).toBe(1);
      expect(stderr).toContain('E_STATE_ROOT_ABSENT');
      expect(fs.existsSync(path.join(freshDir, '.omcu'))).toBe(false);
    } finally {
      fs.rmSync(freshDir, { recursive: true, force: true });
    }

    // 2. Real import via CLI ensures project state and imports
    stdout = '';
    const importCode = await runCli(['memory', 'import', '--file', bundleFile, '--conflict', 'skip'], {
      cwd: tempDir,
    }, io);
    expect(importCode).toBe(0);
    const importParsed = JSON.parse(stdout);
    expect(importParsed.dry_run).toBe(false);
    expect(importParsed.imported).toBe(2);

    // 3. Dry run on existing workspace succeeds and does not mutate
    stdout = '';
    const dryExistingCode = await runCli(['memory', 'import', '--file', bundleFile, '--conflict', 'skip', '--dry-run'], {
      cwd: tempDir,
    }, io);
    expect(dryExistingCode).toBe(0);
    const dryExistingParsed = JSON.parse(stdout);
    expect(dryExistingParsed.dry_run).toBe(true);

    // 4. Delete via CLI
    stdout = '';
    const delCode = await runCli(
      ['memory', 'delete', '--id', 'cli-rec-1', '--expected-updated-at', '2026-09-01T00:00:00.000Z'],
      { cwd: tempDir },
      io,
    );
    expect(delCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ deleted: true });

    // 5. Doctor via CLI
    stdout = '';
    const docCode = await runCli(['memory', 'doctor', '--repair'], {
      cwd: tempDir,
    }, io);
    expect(docCode).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
  });

  it('rejects publication when records directory or target file is a symlink', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now);

    // 1. Symlinked records directory
    const realRecordsDir = path.join(tempDir, 'external-records');
    fs.mkdirSync(realRecordsDir, { recursive: true });
    const memoryDir = path.join(root.path, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.symlinkSync(realRecordsDir, path.join(memoryDir, 'records'), 'dir');

    await expect(
      store.import({
        schema_version: 1,
        memories: [
          { schema_version: 1, id: 'symlink-attack', text: 'payload', metadata: {}, updated_at: '2026-09-01T00:00:00.000Z' },
        ],
      }),
    ).rejects.toThrow('E_MEMORY_PARENT_INVALID');

    // Clean up symlinked directory
    fs.unlinkSync(path.join(memoryDir, 'records'));

    // 2. Symlinked target file inside real records directory
    fs.mkdirSync(path.join(memoryDir, 'records'), { recursive: true });
    const externalTargetFile = path.join(tempDir, 'external-file.json');
    fs.writeFileSync(
      externalTargetFile,
      JSON.stringify({
        schema_version: 1,
        id: 'target-symlink',
        text: 'original external payload',
        metadata: {},
        updated_at: '2026-09-01T00:00:00.000Z',
      }),
    );
    fs.symlinkSync(externalTargetFile, path.join(memoryDir, 'records', 'target-symlink.json'));

    await expect(
      store.import({
        schema_version: 1,
        memories: [
          { schema_version: 1, id: 'target-symlink', text: 'overwrite-attempt', metadata: {}, updated_at: '2026-09-01T00:00:00.000Z' },
        ],
      }, { conflict: 'replace' }),
    ).rejects.toThrow(/E_STATE_CORRUPT|E_MEMORY_TARGET_INVALID/);

    // External file remained intact
    expect(fs.readFileSync(externalTargetFile, 'utf8')).toContain('original external payload');
  });

  it('breaks equal-score search ties chronologically rather than lexicographically with timezone offsets', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now);

    // rec-offset: 2026-09-10T00:00:00-10:00 = 2026-09-10T10:00:00.000Z (newer)
    // rec-utc: 2026-09-10T05:00:00Z (older)
    // Lexicographically: "2026-09-10T00:00:00-10:00" < "2026-09-10T05:00:00Z"
    // Chronologically: rec-offset is 5 hours newer than rec-utc!
    await store.import({
      schema_version: 1,
      memories: [
        {
          schema_version: 1,
          id: 'rec-offset',
          text: 'common search term target',
          metadata: {},
          updated_at: '2026-09-10T00:00:00-10:00',
        },
        {
          schema_version: 1,
          id: 'rec-utc',
          text: 'common search term target',
          metadata: {},
          updated_at: '2026-09-10T05:00:00.000Z',
        },
      ],
    });

    const results = store.search('target');
    expect(results).toHaveLength(2);
    expect(results[0]?.id).toBe('rec-offset');
    expect(results[1]?.id).toBe('rec-utc');
  });

  it('reports missing or inconsistent memory index in doctor and repairs cleanly', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now);

    await store.put('valid record 1', {}, 'rec-1');
    await store.put('valid record 2', {}, 'rec-2');

    const indexFile = path.join(root.path, 'memory', 'index.json');
    expect(fs.existsSync(indexFile)).toBe(true);

    // 1. Missing index file
    fs.unlinkSync(indexFile);
    const reportMissing = await store.doctor();
    expect(reportMissing.ok).toBe(false);
    expect(reportMissing.corrupt_records).toEqual([
      expect.objectContaining({ file: 'index.json', reason: 'Index file is missing' }),
    ]);
    expect(reportMissing.index_rebuilt).toBe(false);

    // Repair missing index
    const repairMissing = await store.doctor({ repair: true });
    expect(repairMissing.index_rebuilt).toBe(true);
    expect(fs.existsSync(indexFile)).toBe(true);
    expect((await store.doctor()).ok).toBe(true);

    // 2. Inconsistent index IDs (e.g. index only lists rec-1 but disk has rec-1 and rec-2)
    fs.writeFileSync(
      indexFile,
      JSON.stringify({
        schema_version: 1,
        ids: ['rec-1'],
        rescanned_at: new Date().toISOString(),
      }),
    );
    const reportMismatched = await store.doctor();
    expect(reportMismatched.ok).toBe(false);
    expect(reportMismatched.corrupt_records).toEqual([
      expect.objectContaining({
        file: 'index.json',
        reason: expect.stringContaining('Index IDs [rec-1] do not match scanned records [rec-1, rec-2]'),
      }),
    ]);

    // Repair mismatched index
    const repairMismatched = await store.doctor({ repair: true });
    expect(repairMismatched.index_rebuilt).toBe(true);
    expect((await store.doctor()).ok).toBe(true);

    // 3. Malformed index file
    fs.writeFileSync(indexFile, 'not-valid-json\n');
    const reportMalformed = await store.doctor();
    expect(reportMalformed.ok).toBe(false);
    expect(reportMalformed.corrupt_records).toEqual([
      expect.objectContaining({
        file: 'index.json',
        reason: expect.stringContaining('Index file is unreadable'),
      }),
    ]);

    // Repair malformed index (must quarantine corrupt index.json)
    const repairMalformed = await store.doctor({ repair: true });
    expect(repairMalformed.index_rebuilt).toBe(true);
    expect(repairMalformed.corrupt_records[0]?.quarantined_to).toBeDefined();
    expect((await store.doctor()).ok).toBe(true);
  });

  it('bounds quarantine filenames for corrupt entries near NAME_MAX without ENAMETOOLONG', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now);

    const recordsDir = path.join(root.path, 'memory', 'records');
    fs.mkdirSync(recordsDir, { recursive: true });

    // Long filename of 240 bytes (near NAME_MAX of 255)
    const longFileName = `${'x'.repeat(235)}.json`;
    const longFilePath = path.join(recordsDir, longFileName);
    fs.writeFileSync(longFilePath, 'corrupt-content\n');

    const report = await store.doctor({ repair: true });
    expect(report.ok).toBe(false);
    expect(report.corrupt_records).toHaveLength(1);
    expect(report.corrupt_records[0]?.file).toBe(longFileName);

    const quarantinedTo = report.corrupt_records[0]?.quarantined_to;
    expect(quarantinedTo).toBeDefined();
    expect(fs.existsSync(quarantinedTo!)).toBe(true);
    expect(Buffer.byteLength(path.basename(quarantinedTo!), 'utf8')).toBeLessThanOrEqual(200);

    // Corrupt file was successfully moved out of records/
    expect(fs.existsSync(longFilePath)).toBe(false);

    // Multibyte CJK filename (80 Chinese characters = 240 bytes near NAME_MAX)
    const cjkFileName = `${'繁'.repeat(78)}.json`;
    expect(Buffer.byteLength(cjkFileName, 'utf8')).toBeGreaterThan(230);
    const cjkFilePath = path.join(recordsDir, cjkFileName);
    fs.writeFileSync(cjkFilePath, 'cjk-corrupt\n');

    const cjkReport = await store.doctor({ repair: true });
    expect(cjkReport.ok).toBe(false);
    expect(cjkReport.corrupt_records).toHaveLength(1);
    expect(cjkReport.corrupt_records[0]?.file).toBe(cjkFileName);

    const cjkQuarantinedTo = cjkReport.corrupt_records[0]?.quarantined_to;
    expect(cjkQuarantinedTo).toBeDefined();
    expect(fs.existsSync(cjkQuarantinedTo!)).toBe(true);
    expect(Buffer.byteLength(path.basename(cjkQuarantinedTo!), 'utf8')).toBeLessThanOrEqual(200);
    expect(fs.existsSync(cjkFilePath)).toBe(false);
  });

  it('rejects unsupported conflict policy with E_MEMORY_CONFLICT_POLICY_INVALID', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now);

    const validBundle = {
      schema_version: 1,
      memories: [
        {
          schema_version: 1,
          id: 'test-rec',
          text: 'sample',
          metadata: {},
          updated_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    };

    expect(() => store.planImport(validBundle, { conflict: 'unsupported' as any })).toThrow(
      'E_MEMORY_CONFLICT_POLICY_INVALID',
    );
    await expect(store.import(validBundle, { conflict: 'unsupported' as any })).rejects.toThrow(
      'E_MEMORY_CONFLICT_POLICY_INVALID',
    );
  });

  it('safely handles non-regular index symlinks in doctor', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now);

    await store.put('some valid content', {}, 'valid-record');
    const indexFile = path.join(root.path, 'memory', 'index.json');

    fs.unlinkSync(indexFile);
    fs.symlinkSync('/dev/null', indexFile);

    const symlinkReport = await store.doctor();
    expect(symlinkReport.ok).toBe(false);
    expect(symlinkReport.corrupt_records).toEqual([
      expect.objectContaining({
        file: 'index.json',
        reason: 'Index file is not a regular file',
      }),
    ]);

    const repairSymlink = await store.doctor({ repair: true });
    expect(repairSymlink.index_rebuilt).toBe(true);
    expect(repairSymlink.corrupt_records[0]?.quarantined_to).toBeDefined();
    expect((await store.doctor()).ok).toBe(true);
  }, 10_000);

  it('safely handles oversized index files in doctor without memory exhaustion', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now);

    await store.put('some valid content', {}, 'valid-record');
    const indexFile = path.join(root.path, 'memory', 'index.json');

    const fd = fs.openSync(indexFile, 'w');
    fs.writeSync(fd, 'x', 8 * 1024 * 1024 + 1024);
    fs.closeSync(fd);

    const oversizedReport = await store.doctor();
    expect(oversizedReport.ok).toBe(false);
    expect(oversizedReport.corrupt_records).toEqual([
      expect.objectContaining({
        file: 'index.json',
        reason: expect.stringContaining('Index file exceeds maximum allowed size'),
      }),
    ]);

    const repairOversized = await store.doctor({ repair: true });
    expect(repairOversized.index_rebuilt).toBe(true);
    expect(repairOversized.corrupt_records[0]?.quarantined_to).toBeDefined();
    expect((await store.doctor()).ok).toBe(true);
  }, 10_000);

  it('safely handles oversized record files in doctor without memory exhaustion', async () => {
    const root = projectStateRoot(tempDir);
    const store = new ProjectMemoryStore(root, now);

    const recordsDir = path.join(root.path, 'memory', 'records');
    fs.mkdirSync(recordsDir, { recursive: true });
    const oversizedRecordPath = path.join(recordsDir, 'huge.json');
    const rfd = fs.openSync(oversizedRecordPath, 'w');
    fs.writeSync(rfd, 'y', 512 * 1024 + 1024);
    fs.closeSync(rfd);

    const recordReport = await store.doctor();
    expect(recordReport.ok).toBe(false);
    expect(recordReport.corrupt_records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'huge.json',
          reason: 'E_STATE_CORRUPT',
        }),
      ]),
    );

    const repairRecord = await store.doctor({ repair: true });
    expect(repairRecord.corrupt_records.some((c) => c.file === 'huge.json' && c.quarantined_to)).toBe(true);
    expect(fs.existsSync(oversizedRecordPath)).toBe(false);
    expect((await store.doctor()).ok).toBe(true);
  }, 10_000);
});
