import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectStateRoot } from '../src/runtime/state-root.js';
import { atomicWriteJson } from '../src/runtime/atomic.js';
import { readRecovery, recoverCursorSession } from '../src/recovery/index.js';
import { CompactionStore } from '../src/compaction/index.js';
import { ProjectMemoryStore } from '../src/memory/index.js';
import { NotificationService } from '../src/notify/index.js';
import { LifecycleTracker } from '../src/tracker/index.js';
import { LifecycleWiki } from '../src/wiki/index.js';
import { createMcpRequestHandler, publishProposal } from '../src/mcp/index.js';
import crypto from 'node:crypto';

const roots: string[] = [];
function workspace(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-services-')); roots.push(value); return value; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const now = () => new Date('2026-07-23T02:00:00.000Z');
const viteNode = path.join(process.cwd(), 'node_modules', '.bin', 'vite-node');
const localStateChild = path.join(process.cwd(), 'tests', 'fixtures', 'local-state-child.ts');

function child(action: string, root: string, id: string, value: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const process = spawn(viteNode, [localStateChild, action, root, id, value], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    process.stdout.on('data', (chunk) => { stdout += String(chunk); });
    process.stderr.on('data', (chunk) => { stderr += String(chunk); });
    process.once('error', reject);
    process.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('Cursor service layer', () => {
  it('creates a bounded immutable recovery tail and preserves partial/unknown/chain warnings', () => {
    const cwd = workspace(); const transcript = path.join(cwd, 'project.jsonl');
    const lines = Array.from({ length: 902 }, (_, index) => JSON.stringify({ id: `m${index}`, type: 'message' }));
    lines.push(JSON.stringify({ id: 'last', parent_id: 'outside-window', type: 'message', token: 'secret' }), '{"partial":');
    fs.writeFileSync(transcript, `${lines.join('\n')}\n`);
    const snapshot = recoverCursorSession(projectStateRoot(cwd), { projectJsonlPath: transcript, recoveryId: 'r1', now });
    expect(snapshot.copied_lines).toBe(900);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.warnings.map(({ code }) => code)).toEqual(expect.arrayContaining(['W_PARTIAL_RECORD', 'W_BROKEN_CHAIN']));
    const copied = fs.readFileSync(snapshot.copy_path, 'utf8');
    expect(copied.split('\n').filter(Boolean)).toHaveLength(900);
    expect(copied).not.toContain('"secret"');
    expect(copied).toContain('<redacted>');
    expect(crypto.createHash('sha256').update(copied).digest('hex')).toBe(snapshot.copied_sha256);
    expect(fs.statSync(snapshot.copy_path).mode & 0o777).toBe(0o400);
    expect(fs.statSync(path.join(path.dirname(snapshot.copy_path), 'snapshot.json')).mode & 0o777).toBe(0o400);
    expect(() => recoverCursorSession(projectStateRoot(cwd), { projectJsonlPath: transcript, recoveryId: 'r1', now })).not.toThrow();
    expect(readRecovery(projectStateRoot(cwd), 'r1')).toEqual(snapshot);
  });

  it('rejects recovery metadata, copy-path, copy-byte, symlink, and mode tampering on direct and MCP reads', async () => {
    const cwd = workspace(); const root = projectStateRoot(cwd); const transcript = path.join(cwd, 'project.jsonl');
    fs.writeFileSync(transcript, `${JSON.stringify({ id: 'one', type: 'message' })}\n`);
    const snapshot = recoverCursorSession(root, { projectJsonlPath: transcript, recoveryId: 'tamper', now });
    const metadata = path.join(root.path, 'recovery', 'tamper', 'snapshot.json');
    const handle = createMcpRequestHandler(root);
    const expectMcpRefusal = async () => {
      const response = await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'omcu.recovery.show', arguments: { id: 'tamper' } } });
      expect(response.error?.message).toBe('E_RECOVERY_INVALID');
    };

    fs.chmodSync(metadata, 0o600);
    fs.writeFileSync(metadata, JSON.stringify({ ...snapshot, recovery_id: 'other' }));
    fs.chmodSync(metadata, 0o400);
    expect(() => readRecovery(root, 'tamper')).toThrow('E_RECOVERY_INVALID');
    await expectMcpRefusal();

    fs.chmodSync(metadata, 0o600);
    fs.writeFileSync(metadata, JSON.stringify({ ...snapshot, copy_path: path.join(cwd, 'elsewhere.jsonl') }));
    fs.chmodSync(metadata, 0o400);
    expect(() => readRecovery(root, 'tamper')).toThrow('E_RECOVERY_INVALID');

    fs.chmodSync(metadata, 0o600);
    fs.writeFileSync(metadata, JSON.stringify(snapshot));
    fs.chmodSync(metadata, 0o400);
    fs.chmodSync(snapshot.copy_path, 0o600);
    fs.writeFileSync(snapshot.copy_path, '{}\n');
    fs.chmodSync(snapshot.copy_path, 0o400);
    expect(() => readRecovery(root, 'tamper')).toThrow('E_RECOVERY_INVALID');

    fs.unlinkSync(snapshot.copy_path);
    fs.symlinkSync(transcript, snapshot.copy_path);
    expect(() => readRecovery(root, 'tamper')).toThrow('E_RECOVERY_INVALID');

    fs.unlinkSync(snapshot.copy_path);
    fs.writeFileSync(snapshot.copy_path, `${JSON.stringify(snapshot.records[0])}\n`, { mode: 0o600 });
    expect(() => readRecovery(root, 'tamper')).toThrow('E_RECOVERY_INVALID');
  });

  it('fences compaction checkpoints and rendering by generation', async () => {
    const store = new CompactionStore(projectStateRoot(workspace()), now);
    const first = await store.checkpoint('chat-1', 0, { token: 'secret', summary: 'kept' });
    expect(first.payload).toEqual({ token: '<redacted>', summary: 'kept' });
    await expect(store.checkpoint('chat-1', 0, {})).rejects.toThrow('E_GENERATION_CONFLICT');
    expect(() => store.render('chat-1', 2)).toThrow('E_GENERATION_CONFLICT');
    expect(store.render('chat-1', 1)).toContain('"summary": "kept"');
  });

  it('adopts an identical immutable generation after interrupted pointer publication', async () => {
    const root = projectStateRoot(workspace());
    const store = new CompactionStore(root, now);
    const first = await store.checkpoint('interrupted', 0, { summary: 'same', token: 'secret' });
    fs.unlinkSync(path.join(root.path, 'compaction', 'interrupted', 'current.json'));
    const adopted = await new CompactionStore(root, () => new Date('2026-07-23T03:00:00.000Z'))
      .checkpoint('interrupted', 0, { summary: 'same', token: 'different' });
    expect(adopted).toEqual(first);
    expect(new CompactionStore(root).read('interrupted')).toEqual(first);
  });

  it('rejects checkpoint digest and previous-chain tampering on read', async () => {
    const root = projectStateRoot(workspace());
    const store = new CompactionStore(root, now);
    await store.checkpoint('tamper', 0, { summary: 'one' });
    const second = await store.checkpoint('tamper', 1, { summary: 'two' });
    const immutable = path.join(root.path, 'compaction', 'tamper', 'generation-2.json');
    const tampered = { ...second, previous_sha256: '0'.repeat(64) };
    const { sha256: _ignored, ...body } = tampered;
    const rehashed = { ...body, sha256: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') };
    fs.writeFileSync(immutable, JSON.stringify(rehashed), { mode: 0o600 });
    fs.writeFileSync(path.join(root.path, 'compaction', 'tamper', 'current.json'), JSON.stringify(rehashed), { mode: 0o600 });
    expect(() => store.read('tamper')).toThrow('E_CHECKPOINT_INVALID');
  });

  it('supports redacted project memory put/search/show/export/import/rescan', async () => {
    const store = new ProjectMemoryStore(projectStateRoot(workspace()), now);
    await store.put('release token=secret checklist', { apiKey: 'secret' }, 'release');
    expect(store.search('release')).toHaveLength(1);
    expect(store.show('release').text).toContain('token=<redacted>');
    expect(store.show('release').metadata).toEqual({ apiKey: '<redacted>' });
    const bundle = store.export();
    const other = new ProjectMemoryStore(projectStateRoot(workspace()), now);
    expect(await other.import(bundle)).toBe(1);
    expect(other.rescan()).toEqual(['release']);
  });

  it('imports a validated memory batch under one index rescan with last duplicate winning', async () => {
    const store = new ProjectMemoryStore(projectStateRoot(workspace()), now);
    const internal = store as unknown as { rescanUnlocked: () => readonly string[] };
    const originalRescan = internal.rescanUnlocked.bind(store);
    let rescans = 0;
    internal.rescanUnlocked = () => { rescans += 1; return originalRescan(); };

    await expect(store.import({
      schema_version: 1,
      memories: [
        { schema_version: 1, id: 'duplicate', text: 'old', metadata: {}, updated_at: 'ignored' },
        { schema_version: 1, id: 'unique', text: 'value', metadata: {}, updated_at: 'ignored' },
        { schema_version: 1, id: 'duplicate', text: 'new', metadata: {}, updated_at: 'ignored' },
      ],
    })).resolves.toBe(3);
    expect(rescans).toBe(1);
    expect(store.show('duplicate').text).toBe('new');
    expect(store.list().map(({ id }) => id)).toEqual(['duplicate', 'unique']);

    const empty = new ProjectMemoryStore(projectStateRoot(workspace()), now);
    await expect(empty.import({
      schema_version: 1,
      memories: [
        { schema_version: 1, id: 'would-have-written', text: 'valid', metadata: {}, updated_at: 'ignored' },
        { schema_version: 1, id: '../invalid', text: 'invalid', metadata: {}, updated_at: 'ignored' },
      ],
    })).rejects.toThrow('E_MEMORY_ID_INVALID');
    expect(empty.list()).toEqual([]);
  });

  it('rebuilds the memory index after a later record write fails during import', async () => {
    const root = projectStateRoot(workspace());
    const store = new ProjectMemoryStore(root, now, (file, value) => {
      if (file.endsWith(`${path.sep}b.json`)) throw new Error('E_INJECTED_RECORD_WRITE');
      return atomicWriteJson(file, value);
    });
    await expect(store.import({
      schema_version: 1,
      memories: [
        { schema_version: 1, id: 'a', text: 'committed', metadata: {}, updated_at: 'ignored' },
        { schema_version: 1, id: 'b', text: 'fails', metadata: {}, updated_at: 'ignored' },
      ],
    })).rejects.toThrow('E_INJECTED_RECORD_WRITE');
    const index = JSON.parse(fs.readFileSync(path.join(root.path, 'memory', 'index.json'), 'utf8')) as { ids: string[] };
    expect(index.ids).toEqual(['a']);
    expect(store.show('a').text).toBe('committed');
    expect(fs.existsSync(path.join(root.path, 'memory', 'records', 'b.json'))).toBe(false);
  });

  it('serializes shared memory index updates across processes without losing records', async () => {
    const root = projectStateRoot(workspace());
    const holder = spawn(viteNode, [localStateChild, 'memory-hold-lock', root.path, 'unused', 'unused'], { stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      holder.once('error', reject);
      holder.stdout.once('data', () => resolve());
    });
    const pending = Promise.all(Array.from({ length: 12 }, (_, index) => (
      child('memory-put', root.path, `record-${index}`, `value-${index}`)
    )));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fs.existsSync(path.join(root.path, 'memory', 'records'))).toBe(false);
    holder.stdin.end();
    await new Promise<void>((resolve) => holder.once('close', () => resolve()));
    const results = await pending;
    expect(results.map(({ code }) => code)).toEqual(Array(12).fill(0));
    const index = JSON.parse(fs.readFileSync(path.join(root.path, 'memory', 'index.json'), 'utf8')) as { ids: string[] };
    expect(index.ids).toEqual(Array.from({ length: 12 }, (_, index) => `record-${index}`).sort());
    expect(new ProjectMemoryStore(root).list().map(({ id }) => id)).toEqual(index.ids);
  }, 20_000);

  it('serializes memory delete with put so the shared index matches record truth', async () => {
    const root = projectStateRoot(workspace()); const store = new ProjectMemoryStore(root, now);
    await store.put('old', {}, 'old');
    const puts = Promise.all(Array.from({ length: 8 }, (_, index) => child('memory-put', root.path, `new-${index}`, `value-${index}`)));
    expect(await store.delete('old')).toBe(true);
    expect((await puts).every(({ code }) => code === 0)).toBe(true);
    const index = JSON.parse(fs.readFileSync(path.join(root.path, 'memory', 'index.json'), 'utf8')) as { ids: string[] };
    expect(index.ids).toEqual(store.list().map(({ id }) => id));
    expect(index.ids).not.toContain('old');
  }, 20_000);

  it('keeps notifications disabled by default and fences dispatch by nonce/generation', async () => {
    const sent = vi.fn(async () => undefined);
    const service = new NotificationService(projectStateRoot(workspace()), sent, now, () => 'a'.repeat(32));
    const queued = await service.enqueue({ token: 'secret', message: 'done' }, 'n1');
    await expect(service.dispatch('n1', 1, queued.nonce)).rejects.toThrow('E_NOTIFICATIONS_DISABLED');
    await service.configure(0, true, 'test://sink');
    await expect(service.dispatch('n1', 2, queued.nonce)).rejects.toThrow('E_GENERATION_CONFLICT');
    const result = await service.dispatch('n1', 1, queued.nonce);
    expect(result.status).toBe('sent');
    expect(sent).toHaveBeenCalledWith({ destination: 'test://sink', nonce: queued.nonce, payload: { token: '<redacted>', message: 'done' } });
  });

  it('maps missing and corrupt observational notification reads to stable state errors', async () => {
    const root = projectStateRoot(workspace());
    const service = new NotificationService(root, vi.fn(async () => undefined));
    expect(() => service.config()).toThrow('E_STATE_ABSENT');
    expect(() => service.read('missing')).toThrow('E_STATE_ABSENT');
    fs.mkdirSync(path.join(root.path, 'notify'), { recursive: true });
    fs.writeFileSync(path.join(root.path, 'notify', 'config.json'), JSON.stringify({ schema_version: 1 }));
    fs.mkdirSync(path.join(root.path, 'notify', 'queue'), { recursive: true });
    fs.writeFileSync(path.join(root.path, 'notify', 'queue', 'bad.json'), '{bad');
    expect(() => service.config()).toThrow('E_STATE_CORRUPT');
    expect(() => service.read('bad')).toThrow('E_STATE_CORRUPT');
  });

  it('tracks lifecycle and renders a generation-fenced wiki', async () => {
    const root = projectStateRoot(workspace()); const tracker = new LifecycleTracker(root, now);
    await tracker.record('run-1', 'created'); await tracker.record('run-1', 'started', { token: 'secret' }); await tracker.record('run-1', 'completed');
    await expect(tracker.record('run-1', 'started')).rejects.toThrow('E_TRACKER_TRANSITION_INVALID');
    const wiki = new LifecycleWiki(root, now);
    const page = await wiki.render('run-1', 0, 'Run token=secret', tracker.history('run-1'));
    expect(page.generation).toBe(1); expect(page.title).toContain('<redacted>');
    await expect(wiki.render('run-1', 0, 'stale', [])).rejects.toThrow('E_GENERATION_CONFLICT');
  });

  it('supports tracker record with detail near 64 KiB without E_JOURNAL_RECORD_TOO_LARGE', async () => {
    const root = projectStateRoot(workspace());
    const tracker = new LifecycleTracker(root, now);
    await tracker.record('run-large', 'created');

    // Create a detail object with ~60 KiB of data across entries
    const detail: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      detail[`field_${i}`] = 'y'.repeat(2000);
    }
    const event = await tracker.record('run-large', 'started', detail);
    expect(event.phase).toBe('started');

    const history = tracker.history('run-large');
    expect(history).toHaveLength(2);
    expect((history[1]?.detail as any)?.field_0).toBe('y'.repeat(2000));
  });

  it('does not fail tracker.record when legacy jsonl mirror encounters write failure', async () => {
    const root = projectStateRoot(workspace());
    const tracker = new LifecycleTracker(root, now);
    await tracker.record('run-mirror-fail', 'created');

    const legacyFile = path.join(root.path, 'tracker', 'run-mirror-fail.jsonl');
    // Replace legacy jsonl file with directory to cause appendFileSync to fail
    fs.unlinkSync(legacyFile);
    fs.mkdirSync(legacyFile);

    // Authoritative journal append should still succeed
    const event = await tracker.record('run-mirror-fail', 'started', { ok: true });
    expect(event.phase).toBe('started');

    const history = tracker.history('run-mirror-fail');
    expect(history).toHaveLength(2);
    expect(history[1]?.phase).toBe('started');
  });

  it('resumes partial tracker migration without losing remaining events', async () => {
    const root = projectStateRoot(workspace());
    const tracker = new LifecycleTracker(root, now);
    const legacyFile = path.join(root.path, 'tracker', 'run-partial.jsonl');
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });

    const ev1 = { schema_version: 1, subject_id: 'run-partial', sequence: 1, phase: 'created', detail: {}, at: '2026-07-23T02:00:00.000Z' };
    const ev2 = { schema_version: 1, subject_id: 'run-partial', sequence: 2, phase: 'started', detail: {}, at: '2026-07-23T02:00:01.000Z' };
    const ev3 = { schema_version: 1, subject_id: 'run-partial', sequence: 3, phase: 'checkpointed', detail: {}, at: '2026-07-23T02:00:02.000Z' };

    fs.writeFileSync(legacyFile, `${JSON.stringify(ev1)}\n${JSON.stringify(ev2)}\n${JSON.stringify(ev3)}\n`);

    // Simulate partial migration: only event 1 was committed to the journal
    const journal = (tracker as any).journal('run-partial');
    journal.init();
    await journal.append({ kind: ev1.phase, payload: ev1, at: ev1.at });

    // History should return all 3 events from legacy file because journal head sequence 1 < 3
    const midHistory = tracker.history('run-partial');
    expect(midHistory).toHaveLength(3);
    expect(midHistory[2]?.phase).toBe('checkpointed');

    // Next record should resume migration of remaining events (2 and 3) then append event 4
    const newEvent = await tracker.record('run-partial', 'completed', { ok: true });
    expect(newEvent.sequence).toBe(4);
    expect(newEvent.phase).toBe('completed');

    // History should now return all 4 events from the journal
    const finalHistory = tracker.history('run-partial');
    expect(finalHistory).toHaveLength(4);
    expect(finalHistory[0]?.phase).toBe('created');
    expect(finalHistory[1]?.phase).toBe('started');
    expect(finalHistory[2]?.phase).toBe('checkpointed');
    expect(finalHistory[3]?.phase).toBe('completed');
  });

  it('rejects corrupt tracker migration input with E_TRACKER_CORRUPT', async () => {
    const root = projectStateRoot(workspace());
    const tracker = new LifecycleTracker(root, now);
    const legacyFile = path.join(root.path, 'tracker', 'run-corrupt.jsonl');
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });

    const ev1 = { schema_version: 1, subject_id: 'run-corrupt', sequence: 1, phase: 'created', detail: {}, at: '2026-07-23T02:00:00.000Z' };
    // Line 2 has invalid json
    fs.writeFileSync(legacyFile, `${JSON.stringify(ev1)}\n{invalid-json\n`);

    expect(() => tracker.history('run-corrupt')).toThrow('E_TRACKER_CORRUPT');
    await expect(tracker.record('run-corrupt', 'started')).rejects.toThrow('E_TRACKER_CORRUPT');
  });

  it('offers only fixed MCP read/proposal tools and structurally refuses authority and shell fields', async () => {
    const root = projectStateRoot(workspace()); const memory = new ProjectMemoryStore(root, now);
    await memory.put('known fact', {}, 'fact');
    const handle = createMcpRequestHandler(root);
    const listed = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(JSON.stringify(listed)).not.toContain('shell');
    const search = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'omcu.memory.search', arguments: { query: 'known' } } });
    expect(search.error).toBeUndefined();
    const refusal = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'omcu.proposal.write', arguments: { id: 'bad', proposal: { verified: true } } } });
    expect(refusal.error?.message).toBe('E_MCP_STRUCTURAL_REFUSAL');
    const proposal = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'omcu.proposal.write', arguments: { id: 'p1', proposal: { token: 'secret', suggestion: 'review' } } } });
    expect(proposal.error).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(root.path, 'mcp/proposals/p1.json'), 'utf8')).proposal.token).toBe('<redacted>');
  });

  it('publishes proposal ids exclusively so concurrent processes cannot clobber the winner', async () => {
    const root = projectStateRoot(workspace());
    const results = await Promise.all([
      child('proposal-write', root.path, 'same', 'first'),
      child('proposal-write', root.path, 'same', 'second'),
    ]);
    expect(results.map(({ code }) => code)).toEqual([0, 0]);
    const responses = results.map(({ stdout }) => JSON.parse(stdout.trim()) as { error?: { message: string }; result?: unknown });
    expect(responses.filter(({ result }) => result !== undefined)).toHaveLength(1);
    expect(responses.filter(({ error }) => error?.message === 'E_MCP_PROPOSAL_EXISTS')).toHaveLength(1);
    const file = path.join(root.path, 'mcp', 'proposals', 'same.json');
    const preserved = JSON.parse(fs.readFileSync(file, 'utf8')) as { proposal: { value: string } };
    expect(['first', 'second']).toContain(preserved.proposal.value);
    expect(fs.statSync(file).mode & 0o777).toBe(0o400);
  });

  it('uses hardened atomic proposal creation and resolves only an exact durability-unknown commit', () => {
    const root = projectStateRoot(workspace());
    const proposals = path.join(root.path, 'mcp', 'proposals');
    const failed = path.join(proposals, 'failed.json');
    const committed = path.join(proposals, 'committed.json');
    const proposal = { schema_version: 1, id: 'committed', authoritative: false, proposal: { value: 'ok' } };

    expect(() => publishProposal(failed, proposal, { helperFaults: ['write'] }))
      .toThrowError(expect.objectContaining({ phase: 'not_committed' }));
    expect(fs.existsSync(failed)).toBe(false);
    expect(fs.readdirSync(proposals).filter((name) => name.includes('.tmp-'))).toEqual([]);

    expect(() => publishProposal(committed, proposal, { helperFaults: ['after_commit_crash'] }))
      .not.toThrow();
    expect(JSON.parse(fs.readFileSync(committed, 'utf8'))).toEqual(proposal);
    expect(fs.readdirSync(proposals).filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect(() => publishProposal(committed, { ...proposal, proposal: { value: 'other' } }))
      .toThrow('E_MCP_PROPOSAL_EXISTS');
    expect(JSON.parse(fs.readFileSync(committed, 'utf8'))).toEqual(proposal);
  });
});
