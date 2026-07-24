import crypto from 'node:crypto';
import { buildPrintArgv } from '../host/cursor-agent.js';
import { AutopilotPipeline, CursorWorktreeUlw, evaluateGate, runRalph, runRalplan, type AdvisoryGate, type UlwWorkerSpec } from '../modes/index.js';
import { ExperimentalTmuxTeamSupervisor, TeamManifestStore, type TeamWorkerSpec } from '../team/index.js';
import { planWorkflow, replayWorkflow, validateWorkflowDefinition, WorkflowPersistenceStore, WorkflowRunner, type WorkflowDefinition, type WorkflowExecutionLease } from '../workflows/index.js';
import { integerOption, jsonOption, option, requiredOption } from './parser.js';
import { commandRunner, printJson, readJsonFile, type CliContext } from './shared.js';

export async function handleOrchestration(command: string, action: string | null, args: readonly string[], context: CliContext): Promise<number | null> {
  if (command === 'workflow') return handleWorkflow(action, args, context);
  if (command === 'ralplan') { const result = await runRalplan(context, objective(args), integerOption(args, '--rounds', 3)); printJson(context.io, result); return result.status === 'accepted' ? 0 : 1; }
  if (command === 'ralph') { const result = await runRalph(context, objective(args), { maxIterations: integerOption(args, '--iterations', 5) }); printJson(context.io, result); return result.status === 'complete' ? 0 : 1; }
  if (command === 'ulw') return handleUlw(args, context);
  if (command === 'team') return handleTeam(action, args, context);
  if (command === 'autopilot' || command === 'pipeline') return handlePipeline(args, context);
  if (['review', 'qa', 'accept', 'integrate', 'ask'].includes(command)) return handlePrompt(command, args, context);
  return null;
}

const VALUE_OPTIONS = new Set(['--rounds', '--iterations', '--id', '--name', '--version', '--file', '--workers-json', '--gates-json', '--format', '--objective', '--prompt', '--state-root', '--receipt']);
function objective(args: readonly string[]): string {
  const named = option(args, '--objective') ?? option(args, '--prompt');
  if (named !== undefined) return named;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (VALUE_OPTIONS.has(value)) { index += 1; continue; }
    if (!value.startsWith('--')) return value;
  }
  throw new Error('E_OBJECTIVE_REQUIRED: pass --objective <text> (or a bare goal argument)');
}
function readDefinition(store: WorkflowPersistenceStore, args: readonly string[]): WorkflowDefinition {
  return store.readDefinition(requiredOption(args, '--name'), option(args, '--version') ?? '1');
}

async function handleWorkflow(action: string | null, args: readonly string[], context: CliContext): Promise<number> {
  const store = new WorkflowPersistenceStore(context.root);
  if (action === 'install') {
    const definition = validateWorkflowDefinition(readJsonFile(requiredOption(args, '--file')) as WorkflowDefinition);
    printJson(context.io, await store.installDefinition(definition)); return 0;
  }
  if (action === 'list') {
    printJson(context.io, store.listDefinitions()); return 0;
  }
  if (action === 'show') { printJson(context.io, readDefinition(store, args)); return 0; }
  if (action === 'plan') {
    const plan = planWorkflow(readDefinition(store, args), requiredOption(args, '--id'), objective(args));
    await store.create(plan); printJson(context.io, plan); return 0;
  }
  const id = requiredOption(args, '--id');
  let record = store.read(id);
  if (action === 'run') {
    const definition = store.readDefinition(record.plan.workflow_name, record.plan.workflow_version);
    const ownerId = `cli-${process.pid}-${crypto.randomUUID()}`;
    const result = await new WorkflowRunner(context.adapter, context.cwd).run(definition, record.plan, record.events, async (event) => {
      record = await store.append(id, record.revision, event);
    }, {
      acquire: async (taskId) => {
        record = await store.acquireExecutionLease(id, record.revision, taskId, ownerId, process.pid);
        return record.execution_lease;
      },
      release: async (taskId, token) => {
        const lease = token as WorkflowExecutionLease | null;
        if (lease === null) throw new Error('E_WORKFLOW_LEASE_NOT_OWNER');
        record = await store.releaseExecutionLease(id, record.revision, taskId, ownerId, lease.generation);
      },
    });
    printJson(context.io, result.status); return result.status.status === 'complete' ? 0 : 1;
  }
  if (action === 'status' || action === 'replay') { const status = replayWorkflow(record.plan, record.events); printJson(context.io, status); return status.status === 'complete' ? 0 : status.status === 'active' ? 2 : 1; }
  throw new Error('E_WORKFLOW_ACTION_INVALID');
}

async function handleUlw(args: readonly string[], context: CliContext): Promise<number> {
  const workers = jsonOption(args, '--workers-json') as readonly UlwWorkerSpec[];
  const result = await new CursorWorktreeUlw(context.adapter, commandRunner).run(context.cwd, requiredOption(args, '--id'), workers);
  printJson(context.io, result); return result.status === 'complete' ? 0 : 1;
}

async function handleTeam(action: string | null, args: readonly string[], context: CliContext): Promise<number> {
  const store = new TeamManifestStore(context.root);
  const supervisor = new ExperimentalTmuxTeamSupervisor(store, commandRunner);
  const id = requiredOption(args, '--id');
  if (action === 'start' || action === 'run') {
    const raw = jsonOption(args, '--workers-json') as readonly Omit<TeamWorkerSpec, 'cwd'>[];
    const workers = raw.map((worker) => ({ ...worker, cwd: (worker as Partial<TeamWorkerSpec>).cwd ?? context.cwd }));
    const manifest = await supervisor.start(id, workers); printJson(context.io, manifest); return 0;
  }
  if (action === 'status') { printJson(context.io, store.read(id)); return 0; }
  if (action === 'collect') { printJson(context.io, await supervisor.collect(id)); return 0; }
  if (action === 'stop') { printJson(context.io, await supervisor.stop(id)); return 0; }
  throw new Error('E_TEAM_ACTION_INVALID');
}

async function handlePipeline(args: readonly string[], context: CliContext): Promise<number> {
  const pipeline = new AutopilotPipeline();
  const supplied = option(args, '--gates-json');
  if (supplied !== undefined) {
    for (const gate of JSON.parse(supplied) as AdvisoryGate[]) pipeline.accept(gate);
  } else {
    const goal = objective(args);
    for (const phase of ['plan', 'execute', 'review', 'qa', 'acceptance'] as const) {
      const result = await context.adapter.run({ argv: buildPrintArgv(`${phase.toUpperCase()} phase. Objective: ${goal}. Return evidence.`, { format: 'json', mode: phase === 'plan' ? 'plan' : 'ask' }), cwd: context.cwd, interactive: false });
      pipeline.accept(evaluateGate({ phase, passed: result.code === 0, evidence: result.stdout }));
      if (result.code !== 0) break;
    }
  }
  const status = pipeline.status(); printJson(context.io, status); return status.phase === 'complete' ? 0 : 1;
}

async function handlePrompt(command: string, args: readonly string[], context: CliContext): Promise<number> {
  const prompt = objective(args);
  const prefix: Record<string, string> = {
    review: 'Read-only code review. Report findings with file references. Do not edit.',
    qa: 'Run appropriate quality checks and report exact evidence. Do not claim product verification beyond observed evidence.',
    accept: 'Evaluate acceptance criteria and return an advisory pass/fail decision with evidence.',
    integrate: 'Integrate the scoped completed work, resolve local issues, and run verification. Do not publish or mutate external production.',
    ask: 'Answer the following request using current repository truth.',
  };
  const result = await context.adapter.run({ argv: buildPrintArgv(`${prefix[command]}\n\n${prompt}`, { format: option(args, '--format') === 'stream-json' ? 'stream-json' : 'json', mode: command === 'review' || command === 'accept' ? 'plan' : 'ask' }), cwd: context.cwd, interactive: false });
  if (result.stdout) context.io.stdout(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) context.io.stderr(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  return result.code;
}
