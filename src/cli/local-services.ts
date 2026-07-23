import fs from 'node:fs';
import path from 'node:path';
import { CompactionStore } from '../compaction/index.js';
import { ProjectMemoryStore } from '../memory/index.js';
import { serveMcpStdio } from '../mcp/index.js';
import { NotificationService, refusingNotificationTransport } from '../notify/index.js';
import { readRecovery, recoverCursorSession } from '../recovery/index.js';
import { routeSessionCommand, type SessionCommand } from '../sessions/router.js';
import { createCliMutationAuthority } from '../state/authority.js';
import { LeaseStore, RunStateStore } from '../state/store.js';
import type { RunStatus } from '../state/types.js';
import { decidePersist } from '../persist/decision.js';
import { completePersist, persistStatus, readPersistState, startPersist, stopPersist } from '../persist/state.js';
import { LifecycleTracker, type LifecyclePhase } from '../tracker/index.js';
import { LifecycleWiki } from '../wiki/index.js';
import { integerOption, jsonOption, option, requiredOption } from './parser.js';
import { printJson, readJsonFile, type CliContext } from './shared.js';

export async function handleLocalServices(command: string, action: string | null, args: readonly string[], context: CliContext): Promise<number | null> {
  if (command === 'mcp-server') { await serveMcpStdio(context.root); return 0; }
  if (command === 'session' || command === 'resume') return handleSession(command === 'resume' ? 'resume' : action, args, context);
  if (command === 'recover') {
    if (action === 'show') printJson(context.io, readRecovery(context.root, requiredOption(args, '--id')));
    else {
      const transcriptPath = option(args, '--transcript'); const projectJsonlPath = option(args, '--project-jsonl'); const recoveryId = option(args, '--id');
      printJson(context.io, recoverCursorSession(context.root, {
        ...(transcriptPath === undefined ? {} : { transcriptPath }),
        ...(projectJsonlPath === undefined ? {} : { projectJsonlPath }),
        ...(recoveryId === undefined ? {} : { recoveryId }),
      }));
    }
    return 0;
  }
  if (command === 'compact') return handleCompaction(action, args, context);
  if (command === 'memory') return handleMemory(action, args, context);
  if (command === 'notify') return handleNotify(action, args, context);
  if (command === 'tracker') return handleTracker(action, args, context);
  if (command === 'wiki') return handleWiki(action, args, context);
  if (command === 'persist') return handlePersist(action, args, context);
  if (command === 'state' || command === 'run' || command === 'cancel' || command === 'lease') return handleState(command, action, args, context);
  return null;
}

function handlePersist(action: string | null, args: readonly string[], context: CliContext): number {
  if (action === 'start') {
    const goal = requiredOption(args, '--goal');
    const maxLoops = option(args, '--max-loops');
    const deadline = option(args, '--deadline-min');
    const state = startPersist(context.root, {
      goal,
      ...(maxLoops === undefined ? {} : { maxLoops: integerOption(args, '--max-loops') }),
      ...(deadline === undefined ? {} : { deadlineMinutes: integerOption(args, '--deadline-min') }),
    });
    printJson(context.io, { ok: true, action: 'start', state });
    return 0;
  }
  if (action === 'stop') {
    printJson(context.io, { ok: true, action: 'stop', state: stopPersist(context.root) });
    return 0;
  }
  if (action === 'done') {
    printJson(context.io, { ok: true, action: 'done', state: completePersist(context.root) });
    return 0;
  }
  if (action === 'status' || action === null) {
    printJson(context.io, { ok: true, action: 'status', ...persistStatus(context.root) });
    return 0;
  }
  if (action === 'decide') {
    // Read-only decision oracle: consulted by the stop hook. Reads Cursor's
    // hook stdin JSON and prints the followup decision. Never mutates state.
    let input: unknown = {};
    const inline = option(args, '--input');
    if (inline !== undefined) {
      try { input = JSON.parse(inline); } catch { input = {}; }
    } else {
      try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { input = {}; }
    }
    const decision = decidePersist(readPersistState(context.root), input, Date.now());
    printJson(context.io, decision);
    return 0;
  }
  throw new Error(`E_PERSIST_ACTION_UNKNOWN: ${action}`);
}

async function handleSession(action: string | null, args: readonly string[], context: CliContext): Promise<number> {
  const prompt = option(args, '--prompt');
  let session: SessionCommand;
  if (action === 'create' || action === 'list') session = { kind: action };
  else if (action === 'resume') session = prompt === undefined ? { kind: 'resume', sessionId: requiredOption(args, '--id') } : { kind: 'resume', sessionId: requiredOption(args, '--id'), prompt };
  else if (action === 'continue') session = prompt === undefined ? { kind: 'continue' } : { kind: 'continue', prompt };
  else throw new Error('E_SESSION_ACTION_INVALID');
  const result = await context.adapter.run(routeSessionCommand(session, context.cwd));
  if (result.stdout) context.io.stdout(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) context.io.stderr(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  return result.code;
}

async function handleCompaction(action: string | null, args: readonly string[], context: CliContext): Promise<number> {
  const store = new CompactionStore(context.root); const id = requiredOption(args, '--id');
  if (action === 'checkpoint') printJson(context.io, await store.checkpoint(id, integerOption(args, '--generation'), jsonOption(args, '--payload-json')));
  else if (action === 'show') printJson(context.io, store.read(id));
  else if (action === 'render') context.io.stdout(store.render(id, integerOption(args, '--generation')));
  else throw new Error('E_COMPACT_ACTION_INVALID');
  return 0;
}

async function handleMemory(action: string | null, args: readonly string[], context: CliContext): Promise<number> {
  const store = new ProjectMemoryStore(context.root);
  if (action === 'put') {
    const id = option(args, '--id');
    printJson(context.io, id === undefined
      ? await store.put(requiredOption(args, '--text'), jsonOption(args, '--metadata-json', {}))
      : await store.put(requiredOption(args, '--text'), jsonOption(args, '--metadata-json', {}), id as `${string}-${string}-${string}-${string}-${string}`));
  }
  else if (action === 'list') printJson(context.io, store.list());
  else if (action === 'show') printJson(context.io, store.show(requiredOption(args, '--id')));
  else if (action === 'search') printJson(context.io, store.search(requiredOption(args, '--query'), integerOption(args, '--limit', 20)));
  else if (action === 'export') printJson(context.io, store.export());
  else if (action === 'import') printJson(context.io, { imported: await store.import(readJsonFile(requiredOption(args, '--file'))) });
  else if (action === 'rescan') printJson(context.io, { ids: store.rescan() });
  else throw new Error('E_MEMORY_ACTION_INVALID');
  return 0;
}

async function handleNotify(action: string | null, args: readonly string[], context: CliContext): Promise<number> {
  const service = new NotificationService(context.root, refusingNotificationTransport);
  if (action === 'status') printJson(context.io, service.config());
  else if (action === 'configure') printJson(context.io, await service.configure(integerOption(args, '--generation'), args.includes('--enable'), option(args, '--destination') ?? null));
  else if (action === 'enqueue') {
    const id = option(args, '--id');
    printJson(context.io, id === undefined
      ? await service.enqueue(jsonOption(args, '--payload-json'))
      : await service.enqueue(jsonOption(args, '--payload-json'), id as `${string}-${string}-${string}-${string}-${string}`));
  }
  else if (action === 'show') printJson(context.io, service.read(requiredOption(args, '--id')));
  else if (action === 'dispatch') printJson(context.io, await service.dispatch(requiredOption(args, '--id'), integerOption(args, '--generation'), requiredOption(args, '--nonce')));
  else throw new Error('E_NOTIFY_ACTION_INVALID');
  return 0;
}

async function handleTracker(action: string | null, args: readonly string[], context: CliContext): Promise<number> {
  const tracker = new LifecycleTracker(context.root); const id = requiredOption(args, '--id');
  if (action === 'history') printJson(context.io, tracker.history(id));
  else if (action === 'record') printJson(context.io, await tracker.record(id, requiredOption(args, '--phase') as LifecyclePhase, jsonOption(args, '--detail-json', {})));
  else throw new Error('E_TRACKER_ACTION_INVALID');
  return 0;
}

async function handleWiki(action: string | null, args: readonly string[], context: CliContext): Promise<number> {
  const wiki = new LifecycleWiki(context.root); const slug = requiredOption(args, '--slug');
  if (action === 'show') printJson(context.io, wiki.show(slug));
  else if (action === 'render') {
    const events = new LifecycleTracker(context.root).history(requiredOption(args, '--tracker'));
    printJson(context.io, await wiki.render(slug, integerOption(args, '--generation'), requiredOption(args, '--title'), events));
  } else throw new Error('E_WIKI_ACTION_INVALID');
  return 0;
}

async function handleState(command: string, action: string | null, args: readonly string[], context: CliContext): Promise<number> {
  const authority = createCliMutationAuthority(context.root);
  if (command === 'lease') {
    const store = new LeaseStore(context.root, authority); const run = requiredOption(args, '--run'); const name = requiredOption(args, '--name');
    if (action === 'status') printJson(context.io, store.read(run, name));
    else if (action === 'acquire') printJson(context.io, await store.acquire(run, name, requiredOption(args, '--owner'), integerOption(args, '--ttl-ms', 30_000)));
    else if (action === 'release') { await store.release(run, name, requiredOption(args, '--owner'), integerOption(args, '--generation')); printJson(context.io, { released: true }); }
    else throw new Error('E_LEASE_ACTION_INVALID');
    return 0;
  }
  const store = new RunStateStore(context.root, authority);
  const effectiveAction = command === 'cancel' ? 'cancel' : action;
  const id = requiredOption(args, '--id');
  if (effectiveAction === 'create') printJson(context.io, await store.create(id, requiredOption(args, '--objective')));
  else if (effectiveAction === 'status' || effectiveAction === 'show') printJson(context.io, store.read(id));
  else if (effectiveAction === 'transition') printJson(context.io, await store.transition(id, integerOption(args, '--revision'), requiredOption(args, '--status') as RunStatus));
  else if (effectiveAction === 'cancel') { const current = store.read(id); printJson(context.io, await store.transition(id, current.revision, 'cancelled')); }
  else if (effectiveAction === 'verify') printJson(context.io, await store.verify(id, integerOption(args, '--revision'), requiredOption(args, '--evidence-sha256')));
  else if (effectiveAction === 'event') printJson(context.io, await store.appendEvent(id, requiredOption(args, '--type'), jsonOption(args, '--payload-json', {})));
  else throw new Error('E_STATE_ACTION_INVALID');
  return 0;
}
