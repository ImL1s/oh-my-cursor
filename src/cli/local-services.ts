import fs from 'node:fs';
import path from 'node:path';
import { CompactionStore } from '../compaction/index.js';
import { ProjectMemoryStore } from '../memory/index.js';
import { serveMcpStdio } from '../mcp/index.js';
import { NotificationService, refusingNotificationTransport } from '../notify/index.js';
import { readRecovery, recoverCursorSession } from '../recovery/index.js';
import { routeSessionCommand, type SessionCommand } from '../sessions/router.js';
import { createCliMutationAuthority } from '../state/authority.js';
import { LeaseStore, observeLease, observeRunState, RunStateStore } from '../state/store.js';
import type { RunStatus } from '../state/types.js';
import { completePersist, executePersistDecision, persistStatus, readPersistState, startPersist, stopPersist } from '../persist/state.js';
import { LifecycleTracker, type LifecyclePhase } from '../tracker/index.js';
import { LifecycleWiki } from '../wiki/index.js';
import { flagValue, optionValue, printJson, readJsonFile, requiredOptionValue, type CliContext } from './shared.js';

export async function handleLocalServices(context: CliContext): Promise<number | null> {
  const { command, action } = context.parsed;
  if (command === 'mcp-server') { await serveMcpStdio(context.root); return 0; }
  if (command === 'session' || command === 'resume') return handleSession(command === 'resume' ? 'resume' : action, context);
  if (command === 'recover') {
    if (action === 'show') {
      printJson(context.io, readRecovery(context.root, requiredOptionValue<string>(context, '--id')));
      return 0;
    }
    if (action === 'create' || action === null) {
      const transcriptPath = optionValue<string>(context, '--transcript'); const projectJsonlPath = optionValue<string>(context, '--project-jsonl'); const recoveryId = optionValue<string>(context, '--id');
      printJson(context.io, recoverCursorSession(context.root, {
        ...(transcriptPath === undefined ? {} : { transcriptPath }),
        ...(projectJsonlPath === undefined ? {} : { projectJsonlPath }),
        ...(recoveryId === undefined ? {} : { recoveryId }),
      }));
      return 0;
    }
    throw new Error(`E_RECOVERY_ACTION_INVALID: ${action}`);
  }
  if (command === 'compact') return handleCompaction(action, context);
  if (command === 'memory') return handleMemory(action, context);
  if (command === 'notify') return handleNotify(action, context);
  if (command === 'tracker') return handleTracker(action, context);
  if (command === 'wiki') return handleWiki(action, context);
  if (command === 'persist') return handlePersist(action, context);
  if (command === 'state' || command === 'run' || command === 'cancel' || command === 'lease') return handleState(command, action, context);
  return null;
}

function handlePersist(action: string | null, context: CliContext): number {
  if (action === 'start') {
    const goal = requiredOptionValue<string>(context, '--goal');
    const maxLoops = requiredOptionValue<number>(context, '--max-loops');
    const deadline = requiredOptionValue<number>(context, '--deadline-min');
    const state = startPersist(context.root, {
      goal,
      maxLoops,
      deadlineMinutes: deadline,
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
    let input: unknown = {};
    const inline = optionValue<unknown>(context, '--input');
    if (inline !== undefined) {
      input = inline;
    } else {
      try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { input = {}; }
    }
    const decision = executePersistDecision(context.root, input, Date.now());
    printJson(context.io, decision);
    return 0;
  }
  throw new Error(`E_PERSIST_ACTION_UNKNOWN: ${action}`);
}

async function handleSession(action: string | null, context: CliContext): Promise<number> {
  const prompt = optionValue<string>(context, '--prompt');
  let session: SessionCommand;
  if (action === 'create' || action === 'list') session = { kind: action };
  else if (action === 'resume') session = prompt === undefined ? { kind: 'resume', sessionId: requiredOptionValue<string>(context, '--id') } : { kind: 'resume', sessionId: requiredOptionValue<string>(context, '--id'), prompt };
  else if (action === 'continue') session = prompt === undefined ? { kind: 'continue' } : { kind: 'continue', prompt };
  else throw new Error('E_SESSION_ACTION_INVALID');
  const result = await context.adapter.run(routeSessionCommand(session, context.cwd));
  if (result.stdout) context.io.stdout(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) context.io.stderr(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  return result.code;
}

async function handleCompaction(action: string | null, context: CliContext): Promise<number> {
  const store = new CompactionStore(context.root); const id = requiredOptionValue<string>(context, '--id');
  if (action === 'checkpoint') printJson(context.io, await store.checkpoint(id, requiredOptionValue<number>(context, '--generation'), requiredOptionValue<unknown>(context, '--payload-json')));
  else if (action === 'show') printJson(context.io, store.read(id));
  else if (action === 'render') context.io.stdout(store.render(id, requiredOptionValue<number>(context, '--generation')));
  else throw new Error('E_COMPACT_ACTION_INVALID');
  return 0;
}

async function handleMemory(action: string | null, context: CliContext): Promise<number> {
  const store = new ProjectMemoryStore(context.root);
  if (action === 'put') {
    const id = optionValue<string>(context, '--id');
    printJson(context.io, id === undefined
      ? await store.put(requiredOptionValue<string>(context, '--text'), requiredOptionValue<unknown>(context, '--metadata-json'))
      : await store.put(requiredOptionValue<string>(context, '--text'), requiredOptionValue<unknown>(context, '--metadata-json'), id as `${string}-${string}-${string}-${string}-${string}`));
  }
  else if (action === 'list') printJson(context.io, store.list());
  else if (action === 'show') printJson(context.io, store.show(requiredOptionValue<string>(context, '--id')));
  else if (action === 'search') printJson(context.io, store.search(requiredOptionValue<string>(context, '--query'), requiredOptionValue<number>(context, '--limit')));
  else if (action === 'export') printJson(context.io, store.export());
  else if (action === 'import') printJson(context.io, { imported: await store.import(readJsonFile(requiredOptionValue<string>(context, '--file'))) });
  else if (action === 'rescan') printJson(context.io, { ids: store.rescan() });
  else throw new Error('E_MEMORY_ACTION_INVALID');
  return 0;
}

async function handleNotify(action: string | null, context: CliContext): Promise<number> {
  const service = new NotificationService(context.root, refusingNotificationTransport);
  if (action === 'status') printJson(context.io, service.config());
  else if (action === 'configure') printJson(context.io, await service.configure(requiredOptionValue<number>(context, '--generation'), flagValue(context, '--enable'), optionValue<string>(context, '--destination') ?? null));
  else if (action === 'enqueue') {
    const id = optionValue<string>(context, '--id');
    printJson(context.io, id === undefined
      ? await service.enqueue(requiredOptionValue<unknown>(context, '--payload-json'))
      : await service.enqueue(requiredOptionValue<unknown>(context, '--payload-json'), id as `${string}-${string}-${string}-${string}-${string}`));
  }
  else if (action === 'show') printJson(context.io, service.read(requiredOptionValue<string>(context, '--id')));
  else if (action === 'dispatch') printJson(context.io, await service.dispatch(requiredOptionValue<string>(context, '--id'), requiredOptionValue<number>(context, '--generation'), requiredOptionValue<string>(context, '--nonce')));
  else throw new Error('E_NOTIFY_ACTION_INVALID');
  return 0;
}

async function handleTracker(action: string | null, context: CliContext): Promise<number> {
  const tracker = new LifecycleTracker(context.root); const id = requiredOptionValue<string>(context, '--id');
  if (action === 'history') printJson(context.io, tracker.history(id));
  else if (action === 'record') printJson(context.io, await tracker.record(id, requiredOptionValue<string>(context, '--phase') as LifecyclePhase, requiredOptionValue<unknown>(context, '--detail-json')));
  else throw new Error('E_TRACKER_ACTION_INVALID');
  return 0;
}

async function handleWiki(action: string | null, context: CliContext): Promise<number> {
  const wiki = new LifecycleWiki(context.root); const slug = requiredOptionValue<string>(context, '--slug');
  if (action === 'show') printJson(context.io, wiki.show(slug));
  else if (action === 'render') {
    const events = new LifecycleTracker(context.root).history(requiredOptionValue<string>(context, '--tracker'));
    printJson(context.io, await wiki.render(slug, requiredOptionValue<number>(context, '--generation'), requiredOptionValue<string>(context, '--title'), events));
  } else throw new Error('E_WIKI_ACTION_INVALID');
  return 0;
}

async function handleState(command: string, action: string | null, context: CliContext): Promise<number> {
  const readOnly = (command === 'lease' && action === 'status')
    || ((command === 'state' || command === 'run') && action === 'status');
  if (readOnly) {
    if (command === 'lease') {
      printJson(context.io, observeLease(context.root, requiredOptionValue<string>(context, '--run'), requiredOptionValue<string>(context, '--name')));
    } else {
      printJson(context.io, observeRunState(context.root, requiredOptionValue<string>(context, '--id')));
    }
    return 0;
  }
  const authority = createCliMutationAuthority(context.root);
  if (command === 'lease') {
    const store = new LeaseStore(context.root, authority); const run = requiredOptionValue<string>(context, '--run'); const name = requiredOptionValue<string>(context, '--name');
    if (action === 'status') printJson(context.io, store.read(run, name));
    else if (action === 'acquire') printJson(context.io, await store.acquire(run, name, requiredOptionValue<string>(context, '--owner'), requiredOptionValue<number>(context, '--ttl-ms')));
    else if (action === 'release') { await store.release(run, name, requiredOptionValue<string>(context, '--owner'), requiredOptionValue<number>(context, '--generation')); printJson(context.io, { released: true }); }
    else throw new Error('E_LEASE_ACTION_INVALID');
    return 0;
  }
  const store = new RunStateStore(context.root, authority);
  const effectiveAction = command === 'cancel' ? 'cancel' : action;
  const id = requiredOptionValue<string>(context, '--id');
  if (effectiveAction === 'create') printJson(context.io, await store.create(id, requiredOptionValue<string>(context, '--objective')));
  else if (effectiveAction === 'status' || effectiveAction === 'show') printJson(context.io, store.read(id));
  else if (effectiveAction === 'transition') printJson(context.io, await store.transition(id, requiredOptionValue<number>(context, '--revision'), requiredOptionValue<string>(context, '--status') as RunStatus));
  else if (effectiveAction === 'cancel') { const current = store.read(id); printJson(context.io, await store.transition(id, current.revision, 'cancelled')); }
  else if (effectiveAction === 'verify') printJson(context.io, await store.verify(id, requiredOptionValue<number>(context, '--revision'), requiredOptionValue<string>(context, '--evidence-sha256')));
  else if (effectiveAction === 'event') printJson(context.io, await store.appendEvent(id, requiredOptionValue<string>(context, '--type'), requiredOptionValue<unknown>(context, '--payload-json')));
  else throw new Error('E_STATE_ACTION_INVALID');
  return 0;
}
