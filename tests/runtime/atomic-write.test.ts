import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  AtomicWriteError,
  ATOMIC_STAGE_MARKER_FILE,
  DirectoryLockError,
  DirectoryLockDualFailureError,
  atomicPublishDirectory,
  atomicCreateJson,
  atomicWriteJson,
  atomicWriteText,
  cleanupAtomicStagingDirectories,
  type AtomicStagingDirectoryMarker,
  type AtomicStagingDirectoryProof,
  withDirectoryLock,
  withDirectoryLockSync,
  type AtomicWriteFaultPoint,
} from '../../src/runtime/atomic.js';
import { currentProcessIdentity } from '../../src/runtime/process-identity.js';

describe('atomic write integrity (#14)', () => {
  function stageProof(stage: string, target: string, creator = currentProcessIdentity()): AtomicStagingDirectoryProof {
    const stat = fs.lstatSync(stage);
    const marker: AtomicStagingDirectoryMarker = {
      schema_version: 1,
      target: path.basename(target),
      token: 'a'.repeat(64),
      stage_dev: stat.dev,
      stage_ino: stat.ino,
      creator: {
        pid: creator.pid,
        start_identity: creator.start_identity,
        start_identity_proven: creator.start_identity_proven,
      },
    };
    fs.writeFileSync(path.join(stage, ATOMIC_STAGE_MARKER_FILE), `${JSON.stringify(marker)}\n`, { mode: 0o600 });
    return { dev: stat.dev, ino: stat.ino, marker };
  }

  function deadLockOwner() {
    const exited = spawnSync(process.execPath, ['-e', '']);
    expect(exited.pid).toBeTypeOf('number');
    const now = Date.now();
    return {
      schema_version: 1,
      pid: exited.pid!,
      start_identity: 'dead-test-process',
      start_identity_proven: true,
      token: 'c'.repeat(32),
      created_at_ms: now,
      renewed_at_ms: now,
    } as const;
  }

  it('fences directory publication by caller-captured stage identity and marker', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-stage-fence-'));
    const stage = path.join(root, '.team.init-stage');
    const moved = path.join(root, '.team.init-original');
    const target = path.join(root, 'team');
    try {
      fs.mkdirSync(stage, { mode: 0o700 });
      const proof = stageProof(stage, target);
      fs.renameSync(stage, moved);
      fs.mkdirSync(stage, { mode: 0o700 });
      fs.copyFileSync(path.join(moved, ATOMIC_STAGE_MARKER_FILE), path.join(stage, ATOMIC_STAGE_MARKER_FILE));
      expect(() => atomicPublishDirectory(stage, target, proof)).toThrowError(expect.objectContaining({ phase: 'not_committed' }));
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleans only valid dead-creator stages and preserves active or forged prefix matches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-stage-cleanup-'));
    const target = path.join(root, 'team');
    const prefix = '.team.init-';
    const active = path.join(root, `${prefix}active`);
    const abandoned = path.join(root, `${prefix}abandoned`);
    const forged = path.join(root, `${prefix}forged`);
    try {
      fs.mkdirSync(active, { mode: 0o700 });
      stageProof(active, target);
      fs.mkdirSync(abandoned, { mode: 0o700 });
      const exited = spawnSync(process.execPath, ['-e', '']);
      expect(exited.pid).toBeTypeOf('number');
      stageProof(abandoned, target, {
        pid: exited.pid!,
        start_identity: 'dead-test-process',
        start_identity_proven: true,
        nonce: 'b'.repeat(64),
      });
      fs.mkdirSync(forged, { mode: 0o700 });
      fs.writeFileSync(path.join(forged, ATOMIC_STAGE_MARKER_FILE), '{}\n');

      cleanupAtomicStagingDirectories(target, prefix);
      expect(fs.existsSync(abandoned)).toBe(false);
      expect(fs.existsSync(active)).toBe(true);
      expect(fs.existsSync(forged)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['json', '{\n  "after": true\n}\n'],
    ['create', '{\n  "created": true\n}\n'],
    ['text', 'after\n'],
  ] as const)('classifies a real %s helper crash after commit as durability unknown', (kind, content) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `omcu-atomic-crash-${kind}-`));
    try {
      const child = spawnSync(
        path.resolve('node_modules/.bin/vite-node'),
        [path.resolve('tests/fixtures/atomic-commit-crash-child.ts'), kind, root],
        { encoding: 'utf8' },
      );
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({
        phase: 'commit_durability_unknown',
        exists: true,
        content,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes plain text without JSON encoding and applies the shared bounds', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-text-'));
    const file = path.join(root, 'state.txt');
    try {
      expect(atomicWriteText(file, '# inbox\n')).toEqual({ phase: 'committed', bytes: 8 });
      expect(fs.readFileSync(file, 'utf8')).toBe('# inbox\n');
      expect(() => atomicWriteText(file, 'too long', { maxBytes: 4 }))
        .toThrowError(expect.objectContaining({ phase: 'not_committed' }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves no durable temp debris when serialization fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-ser-'));
    const file = path.join(root, 'state.json');
    try {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => atomicWriteJson(file, cyclic)).toThrow(AtomicWriteError);
      const leftovers = fs.readdirSync(root).filter((name) => name.includes('.tmp-'));
      expect(leftovers).toEqual([]);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([undefined, () => 'value', Symbol('value')])(
    'rejects non-JSON top-level value %s before creating directories or temps',
    (value) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-undefined-'));
      const directory = path.join(root, 'not-created');
      try {
        expect(() => atomicWriteJson(path.join(directory, 'state.json'), value))
          .toThrowError(expect.objectContaining({ phase: 'not_committed' }));
        expect(fs.existsSync(directory)).toBe(false);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('writes valid JSON atomically and is readable after success', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-ok-'));
    const file = path.join(root, 'record.json');
    try {
      atomicWriteJson(file, { ok: true, n: 1 });
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ok: true, n: 1 });
      const leftovers = fs.readdirSync(root).filter((name) => name.includes('.tmp-'));
      expect(leftovers).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each<AtomicWriteFaultPoint>([
    'temp_open',
    'write',
    'file_chmod',
    'file_fsync',
    'file_close',
    'rename',
  ])('reports %s failure as not committed without temp debris', (point) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `omcu-atomic-${point}-`));
    const file = path.join(root, 'state.json');
    try {
      expect(() => atomicWriteJson(file, { point }, {
        helperFaults: [point],
      })).toThrowError(expect.objectContaining({ phase: 'not_committed' }));
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a partial temp as a recovery artifact when write and cleanup both fail', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-partial-'));
    const file = path.join(root, 'state.json');
    try {
      let captured: AtomicWriteError | null = null;
      try {
        atomicWriteJson(file, { payload: 'x'.repeat(200) }, {
          helperFaults: ['write', 'temp_unlink'],
        });
      } catch (error) {
        captured = error as AtomicWriteError;
      }
      expect(captured).toMatchObject({ phase: 'not_committed' });
      expect(captured?.recoveryArtifact).toBeTruthy();
      const partial = fs.readFileSync(captured?.recoveryArtifact ?? '');
      expect(partial.byteLength).toBeGreaterThan(0);
      expect(partial.byteLength).toBeLessThan(Buffer.byteLength(`${JSON.stringify({ payload: 'x'.repeat(200) }, null, 2)}\n`));
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('classifies an unsupported helper that never starts as not committed', () => {
    const child = spawnSync(
      path.resolve('node_modules/.bin/vite-node'),
      [path.resolve('tests/fixtures/atomic-unsupported-child.ts')],
      { encoding: 'utf8' },
    );
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ phase: 'not_committed', exists: false });
  });

  it.each<AtomicWriteFaultPoint>([
    'directory_open',
    'directory_fsync',
    'directory_close',
  ])('reports %s failure as durability unknown after content is visible', (point) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `omcu-atomic-${point}-`));
    const file = path.join(root, 'state.json');
    try {
      expect(() => atomicWriteJson(file, { point }, {
        helperFaults: [point],
      })).toThrowError(expect.objectContaining({ phase: 'commit_durability_unknown' }));
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ point });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves mode on replacement, bounds bytes, and supports exclusive create', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-policy-'));
    const file = path.join(root, 'config.json');
    try {
      fs.writeFileSync(file, '{}\n', { mode: 0o640 });
      fs.chmodSync(file, 0o640);
      expect(atomicWriteJson(file, { ok: true })).toEqual({ phase: 'committed', bytes: 17 });
      expect(fs.statSync(file).mode & 0o777).toBe(0o640);
      expect(() => atomicWriteJson(file, { oversized: 'abcdef' }, { maxBytes: 8 }))
        .toThrowError(expect.objectContaining({ phase: 'not_committed' }));
      expect(() => atomicCreateJson(file, { replacement: true }))
        .toThrowError(expect.objectContaining({ phase: 'not_committed' }));
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ok: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes the exclusive-create temp when unlink fails after the target link commits', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-create-unlink-'));
    const file = path.join(root, 'created.json');
    try {
      expect(() => atomicCreateJson(file, { committed: true }, {
        helperFaults: ['exclusive_temp_unlink'],
      })).toThrowError(expect.objectContaining({ phase: 'commit_durability_unknown' }));
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ committed: true });
      expect(fs.readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a symlink target and performs bounded cleanup of abandoned temps', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-symlink-'));
    const external = path.join(root, 'external.json');
    const file = path.join(root, 'state.json');
    try {
      fs.writeFileSync(external, '{"external":true}\n');
      fs.symlinkSync(external, file);
      expect(() => atomicWriteJson(file, { replaced: true })).toThrow('E_ATOMIC_TARGET_INVALID');
      expect(JSON.parse(fs.readFileSync(external, 'utf8'))).toEqual({ external: true });
      fs.unlinkSync(file);
      const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
      for (let index = 0; index < 40; index += 1) {
        const artifact = `${file}.tmp-old-${index}`;
        fs.writeFileSync(artifact, 'abandoned');
        fs.utimesSync(artifact, old, old);
      }
      atomicWriteJson(file, { cleaned: true });
      const abandoned = fs.readdirSync(root).filter((name) => name.startsWith('state.json.tmp-old-'));
      expect(abandoned.length).toBeLessThanOrEqual(8);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not let young candidates starve eligible abandoned-temp cleanup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-cleanup-fair-'));
    const file = path.join(root, 'state.json');
    try {
      for (let index = 0; index < 32; index += 1) {
        fs.writeFileSync(`${file}.tmp-aaa-young-${String(index).padStart(3, '0')}`, 'young');
      }
      const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
      for (let index = 0; index < 40; index += 1) {
        const artifact = `${file}.tmp-zzz-old-${String(index).padStart(3, '0')}`;
        fs.writeFileSync(artifact, 'old');
        fs.utimesSync(artifact, old, old);
      }
      atomicWriteJson(file, { cleaned: true });
      expect(fs.readdirSync(root).filter((name) => name.includes('zzz-old'))).toHaveLength(8);
      expect(fs.readdirSync(root).filter((name) => name.includes('aaa-young'))).toHaveLength(32);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked parent traversal for atomic writes and locks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-parent-link-'));
    const actual = path.join(root, 'actual');
    const linked = path.join(root, 'linked');
    fs.mkdirSync(path.join(actual, 'nested'), { recursive: true });
    fs.symlinkSync(actual, linked, 'dir');
    try {
      const atomicTarget = path.join(linked, 'nested', 'state.json');
      expect(() => atomicWriteJson(atomicTarget, { unsafe: true }))
        .toThrowError(expect.objectContaining({ phase: 'not_committed' }));
      expect(fs.existsSync(path.join(actual, 'nested', 'state.json'))).toBe(false);
      await expect(withDirectoryLock(path.join(linked, 'nested', 'payload'), () => 'unsafe'))
        .rejects.toThrow('E_LOCK_PARENT_INVALID');
      expect(fs.existsSync(path.join(actual, 'nested', 'payload.lock'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects a parent swapped after validation before canonicalization', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-parent-race-'));
    const atomicParent = path.join(root, 'atomic-parent');
    const atomicMoved = path.join(root, 'atomic-original');
    const lockParent = path.join(root, 'lock-parent');
    const lockMoved = path.join(root, 'lock-original');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(atomicParent);
    fs.mkdirSync(lockParent);
    fs.mkdirSync(outside);
    try {
      let atomicSwapped = false;
      expect(() => atomicWriteJson(path.join(atomicParent, 'state.json'), { unsafe: true }, {
        faultInjector: (point) => {
          if (point !== 'parent_revalidate' || atomicSwapped) return;
          atomicSwapped = true;
          fs.renameSync(atomicParent, atomicMoved);
          fs.symlinkSync(outside, atomicParent, 'dir');
        },
      })).toThrowError(expect.objectContaining({ phase: 'not_committed' }));
      expect(fs.existsSync(path.join(outside, 'state.json'))).toBe(false);

      let lockSwapped = false;
      await expect(withDirectoryLock(path.join(lockParent, 'payload'), () => 'unsafe', 100, {
        faultInjector: (point) => {
          if (point !== 'parent_revalidate' || lockSwapped) return;
          lockSwapped = true;
          fs.renameSync(lockParent, lockMoved);
          fs.symlinkSync(outside, lockParent, 'dir');
        },
      })).rejects.toThrow('E_LOCK_PARENT_CHANGED');
      expect(fs.existsSync(path.join(outside, 'payload.lock'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('revalidates each newly created parent segment before use', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-new-parent-race-'));
    const created = path.join(root, 'new-parent');
    const moved = path.join(root, 'new-parent-original');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    try {
      let swapped = false;
      expect(() => atomicWriteJson(path.join(created, 'state.json'), { unsafe: true }, {
        faultInjector: (point) => {
          if (point !== 'segment_revalidate' || swapped) return;
          swapped = true;
          fs.renameSync(created, moved);
          fs.symlinkSync(outside, created, 'dir');
        },
      })).toThrowError(expect.objectContaining({ phase: 'not_committed' }));
      expect(fs.existsSync(path.join(outside, 'state.json'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds atomic create to the validated directory when temp_open swaps the parent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-bound-open-'));
    const parent = path.join(root, 'parent');
    const moved = path.join(root, 'original');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(parent); fs.mkdirSync(outside);
    try {
      expect(() => atomicCreateJson(path.join(parent, 'state.json'), { unsafe: true }, {
        faultInjector: (point) => {
          if (point !== 'temp_open' || fs.existsSync(moved)) return;
          fs.renameSync(parent, moved);
          fs.symlinkSync(outside, parent, 'dir');
        },
      })).toThrowError(expect.objectContaining({ phase: 'not_committed' }));
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.existsSync(path.join(moved, 'state.json'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not redirect commit or cleanup when rename swaps the validated parent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-bound-rename-'));
    const parent = path.join(root, 'parent');
    const moved = path.join(root, 'original');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(parent); fs.mkdirSync(outside);
    try {
      expect(() => atomicWriteJson(path.join(parent, 'state.json'), { unsafe: true }, {
        faultInjector: (point) => {
          if (point !== 'rename' || fs.existsSync(moved)) return;
          fs.renameSync(parent, moved);
          fs.symlinkSync(outside, parent, 'dir');
        },
      })).toThrowError(expect.objectContaining({ phase: 'not_committed' }));
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.existsSync(path.join(moved, 'state.json'))).toBe(false);
      expect(fs.readdirSync(moved).some((name) => name.includes('.tmp-'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds lock mkdir, reclaim, and release to the validated parent', async () => {
    const makePaths = (suffix: string) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `omcu-lock-bound-${suffix}-`));
      const parent = path.join(root, 'parent');
      const moved = path.join(root, 'original');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(parent); fs.mkdirSync(outside);
      return { root, parent, moved, outside, target: path.join(parent, 'state.json') };
    };

    const acquire = makePaths('mkdir');
    try {
      await expect(withDirectoryLock(acquire.target, () => 'unsafe', 50, {
        faultInjector: (point) => {
          if (point !== 'lock_mkdir' || fs.existsSync(acquire.moved)) return;
          fs.renameSync(acquire.parent, acquire.moved);
          fs.symlinkSync(acquire.outside, acquire.parent, 'dir');
        },
      })).rejects.toThrow('E_LOCK_PARENT_CHANGED');
      expect(fs.readdirSync(acquire.outside)).toEqual([]);
    } finally { fs.rmSync(acquire.root, { recursive: true, force: true }); }

    const reclaim = makePaths('reclaim');
    try {
      const lock = `${reclaim.target}.lock`;
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(deadLockOwner()), { mode: 0o600 });
      const old = new Date(Date.now() - 120_000);
      fs.utimesSync(lock, old, old);
      await expect(withDirectoryLock(reclaim.target, () => 'unsafe', 50, {
        staleMs: 0,
        faultInjector: (point) => {
          if (point !== 'reclaim_rename' || fs.existsSync(reclaim.moved)) return;
          fs.renameSync(reclaim.parent, reclaim.moved);
          fs.symlinkSync(reclaim.outside, reclaim.parent, 'dir');
        },
      })).rejects.toThrow('E_LOCK_PARENT_CHANGED');
      expect(fs.readdirSync(reclaim.outside)).toEqual([]);
      expect(fs.existsSync(path.join(reclaim.moved, 'state.json.lock'))).toBe(true);
    } finally { fs.rmSync(reclaim.root, { recursive: true, force: true }); }

    const release = makePaths('release');
    try {
      await expect(withDirectoryLock(release.target, () => 'done', 50, {
        faultInjector: (point) => {
          if (point !== 'release_remove' || fs.existsSync(release.moved)) return;
          fs.renameSync(release.parent, release.moved);
          fs.symlinkSync(release.outside, release.parent, 'dir');
        },
      })).rejects.toMatchObject({ phase: 'post_action_cleanup_failed', actionCompleted: true });
      expect(fs.readdirSync(release.outside)).toEqual([]);
      expect(fs.existsSync(path.join(release.moved, 'state.json.lock'))).toBe(true);
    } finally { fs.rmSync(release.root, { recursive: true, force: true }); }
  });

  it('quarantines a temp and exposes cleanup failure without masking the write failure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-cleanup-fault-'));
    const file = path.join(root, 'state.json');
    try {
      let captured: AtomicWriteError | null = null;
      try {
        atomicWriteJson(file, { ok: false }, {
          helperFaults: ['rename', 'temp_unlink'],
        });
      } catch (error) {
        captured = error as AtomicWriteError;
      }
      expect(captured).toMatchObject({ phase: 'not_committed' });
      expect(captured?.causeError).toMatchObject({ message: expect.stringContaining('FAULT_RENAME') });
      expect(captured?.cleanupError).toMatchObject({ message: expect.stringContaining('FAULT_TEMP_UNLINK') });
      expect(captured?.recoveryArtifact).toBeTruthy();
      expect(fs.existsSync(captured?.recoveryArtifact ?? '')).toBe(true);
      expect(fs.readdirSync(root).filter((name) => name.endsWith('.json.tmp-'))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('attaches cleanup evidence to a primary durability-unknown error', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-crash-cleanup-'));
    const file = path.join(root, 'state.json');
    try {
      let captured: AtomicWriteError | null = null;
      try {
        atomicWriteJson(file, { committed: true }, {
          helperFaults: ['after_commit_crash', 'temp_unlink'],
        });
      } catch (error) {
        captured = error as AtomicWriteError;
      }
      expect(captured).toMatchObject({
        phase: 'commit_durability_unknown',
        message: expect.stringContaining('E_ATOMIC_HELPER_EXIT_FAILED'),
      });
      expect(captured?.causeError).toBeUndefined();
      expect(captured?.cleanupError).toBeInstanceOf(Error);
      expect(captured?.recoveryArtifact).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ committed: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('merges cleanup errors and attaches the quarantined recovery artifact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-cleanup-merge-'));
    const file = path.join(root, 'state.json');
    const primaryCause = new Error('E_PRIMARY_CAUSE');
    const priorCleanup = new Error('E_PRIOR_CLEANUP');
    try {
      let captured: AtomicWriteError | null = null;
      try {
        atomicWriteJson(file, { committed: false }, {
          helperFaults: ['temp_unlink'],
          faultInjector: (point) => {
            if (point === 'rename') {
              throw new AtomicWriteError('E_PRIMARY', 'not_committed', primaryCause, priorCleanup);
            }
          },
        });
      } catch (error) {
        captured = error as AtomicWriteError;
      }
      expect(captured).toMatchObject({ phase: 'not_committed', message: 'E_PRIMARY' });
      expect(captured?.causeError).toBe(primaryCause);
      expect(captured?.cleanupError).toBeInstanceOf(AggregateError);
      expect((captured?.cleanupError as AggregateError).errors[0]).toBe(priorCleanup);
      expect((captured?.cleanupError as AggregateError).errors[1])
        .toMatchObject({ message: expect.stringContaining('FAULT_TEMP_UNLINK') });
      expect(captured?.recoveryArtifact).toBeTruthy();
      expect(fs.existsSync(captured?.recoveryArtifact ?? '')).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the original action error when lock cleanup also fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-cleanup-'));
    const target = path.join(root, 'payload.json');
    const lock = `${target}.lock`;
    try {
      await expect(withDirectoryLock(target, () => {
        const ownerFile = path.join(lock, 'owner.json');
        const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, token: 'a'.repeat(32) }), { mode: 0o600 });
        throw new Error('E_DOMAIN_FAILURE');
      }, 100)).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('E_DOMAIN_FAILURE');
        expect((error as Error & { cause?: unknown }).cause).toBeDefined();
        return true;
      });
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('distinguishes post-action release failure and preserves dual failures', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lock-release-fault-'));
    const successTarget = path.join(root, 'success.json');
    const failureTarget = path.join(root, 'failure.json');
    try {
      await expect(withDirectoryLock(successTarget, () => 'done', 100, {
        helperFaults: ['release_remove'],
      })).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(DirectoryLockError);
        expect(error).toMatchObject({
          phase: 'post_action_cleanup_failed',
          actionCompleted: true,
        });
        expect((error as DirectoryLockError).cleanupError)
          .toMatchObject({ message: expect.stringContaining('FAULT_RELEASE_REMOVE') });
        return true;
      });
      const domain = new Error('E_DOMAIN_PRIMARY');
      await expect(withDirectoryLock(failureTarget, () => { throw domain; }, 100, {
        helperFaults: ['release_remove'],
      })).rejects.toSatisfy((error: unknown) => {
        expect(error).toBe(domain);
        expect((error as Error & { cleanupError?: unknown }).cleanupError)
          .toMatchObject({ message: expect.stringContaining('FAULT_RELEASE_REMOVE') });
        return true;
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves primitive action failures when async and sync lock release also fail', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lock-primitive-dual-failure-'));
    try {
      const assertDualFailure = (error: unknown): boolean => {
        expect(error).toBeInstanceOf(DirectoryLockDualFailureError);
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as DirectoryLockDualFailureError).primaryError).toBeUndefined();
        expect((error as DirectoryLockDualFailureError).cleanupError)
          .toMatchObject({ message: expect.stringContaining('FAULT_RELEASE_REMOVE') });
        expect((error as AggregateError).errors[0]).toBeUndefined();
        return true;
      };

      await expect(withDirectoryLock(
        path.join(root, 'async.json'),
        () => { throw undefined; },
        100,
        { helperFaults: ['release_remove'] },
      )).rejects.toSatisfy(assertDualFailure);

      expect(() => withDirectoryLockSync(
        path.join(root, 'sync.json'),
        () => { throw undefined; },
        100,
        { helperFaults: ['release_remove'] },
      )).toThrowError(expect.objectContaining({
        name: 'DirectoryLockDualFailureError',
        primaryError: undefined,
        cleanupError: expect.objectContaining({ message: expect.stringContaining('FAULT_RELEASE_REMOVE') }),
      }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns typed post-action cleanup failure from the synchronous lock API', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lock-sync-release-'));
    const target = path.join(root, 'state.json');
    try {
      expect(() => withDirectoryLockSync(target, () => 'done', 100, {
        helperFaults: ['release_remove'],
      })).toThrowError(expect.objectContaining({
        phase: 'post_action_cleanup_failed',
        actionCompleted: true,
      }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves an action that throws undefined in async and synchronous lock APIs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lock-undefined-'));
    try {
      const asyncTarget = path.join(root, 'async.json');
      await expect(withDirectoryLock(asyncTarget, () => { throw undefined; }, 100)).rejects.toBeUndefined();
      expect(fs.existsSync(`${asyncTarget}.lock`)).toBe(false);

      const syncTarget = path.join(root, 'sync.json');
      let caught = false;
      try {
        withDirectoryLockSync(syncTarget, () => { throw undefined; }, 100);
      } catch (error) {
        caught = true;
        expect(error).toBeUndefined();
      }
      expect(caught).toBe(true);
      expect(fs.existsSync(`${syncTarget}.lock`)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not reclaim a live owner solely because the lock is old', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-age-'));
    const target = path.join(root, 'events.jsonl');
    try {
      let release!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const holder = withDirectoryLock(target, async () => {
        await hold;
        return 'held';
      }, 5_000, { staleMs: 0, pollMs: 5 });
      // Allow holder to acquire
      await new Promise((r) => setTimeout(r, 20));
      await expect(withDirectoryLock(target, () => 'stolen', 40, {
        staleMs: 0,
        pollMs: 5,
      })).rejects.toThrow('E_LOCK_TIMEOUT');
      release();
      await expect(holder).resolves.toBe('held');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('adopts its exact lock when the helper crashes after publishing owner metadata', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lock-acquire-crash-'));
    const target = path.join(root, 'state.json');
    let actions = 0;
    try {
      await expect(withDirectoryLock(target, () => {
        actions += 1;
        return 'recovered';
      }, 100, { helperFaults: ['after_owner_publish_crash'] })).resolves.toBe('recovered');
      expect(actions).toBe(1);
      expect(fs.existsSync(`${target}.lock`)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['extra-key', 'future-time', 'unsafe-mode', 'oversize', 'symlink'] as const)(
    'fails closed on %s lock owner metadata',
    async (kind) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `omcu-lock-owner-${kind}-`));
      const target = path.join(root, 'state.json');
      const lock = `${target}.lock`;
      const ownerFile = path.join(lock, 'owner.json');
      try {
        fs.mkdirSync(lock, { mode: 0o700 });
        const owner = deadLockOwner();
        if (kind === 'symlink') {
          const outside = path.join(root, 'outside-owner.json');
          fs.writeFileSync(outside, JSON.stringify(owner), { mode: 0o600 });
          fs.symlinkSync(outside, ownerFile);
        } else if (kind === 'oversize') {
          fs.writeFileSync(ownerFile, JSON.stringify({ ...owner, padding: 'x'.repeat(17 * 1024) }), { mode: 0o600 });
        } else {
          let value = owner;
          if (kind === 'extra-key') {
            value = { ...owner, unexpected: true };
          } else if (kind === 'future-time') {
            value = { ...owner, renewed_at_ms: Date.now() + 120_000 };
          }
          fs.writeFileSync(ownerFile, JSON.stringify(value), { mode: 0o600 });
          if (kind === 'unsafe-mode' && process.platform !== 'win32') fs.chmodSync(ownerFile, 0o666);
        }
        await expect(withDirectoryLock(target, () => 'stolen', 25, { staleMs: 0, pollMs: 2 }))
          .rejects.toThrow('E_LOCK_TIMEOUT');
        expect(fs.existsSync(lock)).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('keeps the event loop responsive while async acquisition waits', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lock-async-wait-'));
    const target = path.join(root, 'state.json');
    let entered!: () => void;
    let release!: () => void;
    const acquired = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    try {
      const holder = withDirectoryLock(target, async () => {
        entered();
        await held;
        return 'holder';
      }, 500);
      await acquired;
      // Release only on a later event-loop turn. A blocking acquisition cannot
      // observe this release and times out; the async poller yields and succeeds.
      setImmediate(release);
      const contender = withDirectoryLock(target, () => 'contender', 500, { pollMs: 2 });
      await expect(holder).resolves.toBe('holder');
      await expect(contender).resolves.toBe('contender');
    } finally {
      release?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets only one concurrent reclaimer win for a valid provably dead owner', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lock-reclaim-race-'));
    const target = path.join(root, 'state.json');
    const lock = `${target}.lock`;
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(deadLockOwner()), { mode: 0o600 });
      const order: string[] = [];
      const first = withDirectoryLock(target, async () => {
        order.push('first');
        await new Promise((resolve) => setTimeout(resolve, 15));
        return 'first';
      }, 2_000, { staleMs: 0, pollMs: 2 });
      const second = withDirectoryLock(target, () => { order.push('second'); return 'second'; }, 2_000, {
        staleMs: 0,
        pollMs: 2,
      });
      await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
      expect(order).toEqual(['first', 'second']);
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.readdirSync(root).filter((name) => name.includes('.stale-'))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'malformed', 'unreadable'] as const)(
    'never age-reclaims %s owner evidence',
    async (kind) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `omcu-lock-owner-${kind}-`));
      const target = path.join(root, 'state.json');
      const lock = `${target}.lock`;
      try {
        fs.mkdirSync(lock, { mode: 0o700 });
        if (kind === 'malformed') fs.writeFileSync(path.join(lock, 'owner.json'), '{bad', { mode: 0o600 });
        if (kind === 'unreadable') fs.mkdirSync(path.join(lock, 'owner.json'));
        const old = new Date(Date.now() - 120_000);
        fs.utimesSync(lock, old, old);
        await expect(withDirectoryLock(target, () => 'stolen', 30, {
          staleMs: 0,
          pollMs: 2,
        })).rejects.toThrow('E_LOCK_TIMEOUT');
        expect(fs.existsSync(lock)).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('restores a reclaimed pathname when helper-side owner revalidation becomes malformed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lock-owner-race-'));
    const target = path.join(root, 'state.json');
    const lock = `${target}.lock`;
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(deadLockOwner()), { mode: 0o600 });
      await expect(withDirectoryLock(target, () => 'stolen', 50, {
        staleMs: 0,
        faultInjector: (point) => {
          if (point === 'reclaim_rename') fs.writeFileSync(path.join(lock, 'owner.json'), '{bad');
        },
      })).rejects.toThrow();
      expect(fs.existsSync(lock)).toBe(true);
      expect(fs.readdirSync(root).filter((name) => name.includes('.stale-'))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes stable process identity and renews long-running lock heartbeats', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-heartbeat-'));
    const target = path.join(root, 'events.jsonl');
    const lock = `${target}.lock`;
    try {
      let initialRenewed = 0;
      await withDirectoryLock(target, async () => {
        const initial = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')) as {
          start_identity?: unknown; renewed_at_ms: number;
        };
        expect(typeof initial.start_identity).toBe('string');
        initialRenewed = initial.renewed_at_ms;
        await new Promise((resolve) => setTimeout(resolve, 35));
        const renewed = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')) as {
          renewed_at_ms: number;
        };
        expect(renewed.renewed_at_ms).toBeGreaterThan(initialRenewed);
      }, 100, { heartbeatMs: 5 });
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports heartbeat failure after a successful action as typed post-action cleanup failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-lock-heartbeat-fault-'));
    const target = path.join(root, 'state.json');
    try {
      await expect(withDirectoryLock(target, async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return 'completed';
      }, 100, {
        heartbeatMs: 5,
        helperFaults: ['heartbeat_write'],
      })).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(DirectoryLockError);
        expect(error).toMatchObject({ phase: 'post_action_cleanup_failed', actionCompleted: true });
        expect((error as Error).cause).toBeDefined();
        return true;
      });
      expect(fs.existsSync(`${target}.lock`)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
