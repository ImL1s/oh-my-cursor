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
    await store.import(
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

    expect(store.show('internal-dup').text).toBe('newer text v1');
    expect(store.show('internal-dup').updated_at).toBe('2026-06-01T00:00:00.000Z');

    // Case 2: skip where the FIRST record appears, and a SECOND record appears with different content.
    // Under skip, the first record must be kept and the second skipped, not overwriting the first.
    await store.import(
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

    const exported1 = store1.export();

    const root2 = projectStateRoot(path.join(tempDir, 'r2'));
    const store2 = new ProjectMemoryStore(root2, now);

    const receipt = await store2.import(exported1);
    expect(receipt.imported).toBe(2);

    const exported2 = store2.export();
    expect(exported2).toEqual(exported1);
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

    // 1. Dry run via CLI
    stdout = '';
    const dryCode = await runCli(['memory', 'import', '--file', bundleFile, '--dry-run'], {
      cwd: tempDir,
    }, io);
    expect(dryCode).toBe(0);
    const dryParsed = JSON.parse(stdout);
    expect(dryParsed.dry_run).toBe(true);
    expect(dryParsed.imported).toBe(2);

    // 2. Real import via CLI
    stdout = '';
    const importCode = await runCli(['memory', 'import', '--file', bundleFile, '--conflict', 'skip'], {
      cwd: tempDir,
    }, io);
    expect(importCode).toBe(0);
    const importParsed = JSON.parse(stdout);
    expect(importParsed.dry_run).toBe(false);
    expect(importParsed.imported).toBe(2);

    // 3. Delete via CLI
    stdout = '';
    const delCode = await runCli(
      ['memory', 'delete', '--id', 'cli-rec-1', '--expected-updated-at', '2026-09-01T00:00:00.000Z'],
      { cwd: tempDir },
      io,
    );
    expect(delCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ deleted: true });

    // 4. Doctor via CLI
    stdout = '';
    const docCode = await runCli(['memory', 'doctor', '--repair'], {
      cwd: tempDir,
    }, io);
    expect(docCode).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
  });
});
