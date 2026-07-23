import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectStateRoot } from '../src/runtime/state-root.js';
import { readRecovery, recoverCursorSession } from '../src/recovery/index.js';
import { CompactionStore } from '../src/compaction/index.js';
import { ProjectMemoryStore } from '../src/memory/index.js';
import { NotificationService } from '../src/notify/index.js';
import { LifecycleTracker } from '../src/tracker/index.js';
import { LifecycleWiki } from '../src/wiki/index.js';
import { createMcpRequestHandler } from '../src/mcp/index.js';
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
  }, 10_000);

  it('serializes memory delete with put so the shared index matches record truth', async () => {
    const root = projectStateRoot(workspace()); const store = new ProjectMemoryStore(root, now);
    await store.put('old', {}, 'old');
    const puts = Promise.all(Array.from({ length: 8 }, (_, index) => child('memory-put', root.path, `new-${index}`, `value-${index}`)));
    expect(await store.delete('old')).toBe(true);
    expect((await puts).every(({ code }) => code === 0)).toBe(true);
    const index = JSON.parse(fs.readFileSync(path.join(root.path, 'memory', 'index.json'), 'utf8')) as { ids: string[] };
    expect(index.ids).toEqual(store.list().map(({ id }) => id));
    expect(index.ids).not.toContain('old');
  });

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

  it('tracks lifecycle and renders a generation-fenced wiki', async () => {
    const root = projectStateRoot(workspace()); const tracker = new LifecycleTracker(root, now);
    await tracker.record('run-1', 'created'); await tracker.record('run-1', 'started', { token: 'secret' }); await tracker.record('run-1', 'completed');
    await expect(tracker.record('run-1', 'started')).rejects.toThrow('E_TRACKER_TRANSITION_INVALID');
    const wiki = new LifecycleWiki(root, now);
    const page = await wiki.render('run-1', 0, 'Run token=secret', tracker.history('run-1'));
    expect(page.generation).toBe(1); expect(page.title).toContain('<redacted>');
    await expect(wiki.render('run-1', 0, 'stale', [])).rejects.toThrow('E_GENERATION_CONFLICT');
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
});
