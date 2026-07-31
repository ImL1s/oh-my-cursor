import crypto from 'node:crypto';
import { buildPrintArgv } from '../host/cursor-agent.js';
import { currentProcessIdentity } from '../runtime/process-identity.js';
import { AutopilotPipeline, CursorWorktreeUlw, evaluateGate, runRalph, runRalplan, type AdvisoryGate, type UlwWorkerSpec } from '../modes/index.js';
import { executeTeamApiOperation, ExperimentalTmuxTeamSupervisor, TEAM_API_HELP, TeamManifestStore, validateTeamApiOperationInput, type TeamWorkerSpec } from '../team/index.js';
import { planWorkflow, replayWorkflow, validateWorkflowDefinition, WorkflowPersistenceStore, WorkflowRunner, type WorkflowDefinition, type WorkflowLeaseCredential, type WorkflowLeaseReconciliation } from '../workflows/index.js';
import { commandRunner, optionValue, positionalValue, printJson, readJsonFile, requiredOptionValue, type CliContext } from './shared.js';

export async function handleOrchestration(context: CliContext): Promise<number | null> {
  const { command, action } = context.parsed;
  if (command === 'workflow') return handleWorkflow(action, context);
  if (command === 'ralplan') { const result = await runRalplan(context, objective(context), requiredOptionValue<number>(context, '--rounds')); printJson(context.io, result); return result.status === 'accepted' ? 0 : 1; }
  if (command === 'ralph') { const result = await runRalph(context, objective(context), { maxIterations: requiredOptionValue<number>(context, '--iterations') }); printJson(context.io, result); return result.status === 'complete' ? 0 : 1; }
  if (command === 'ulw') return handleUlw(context);
  if (command === 'team') return handleTeam(action, context);
  if (command === 'autopilot' || command === 'pipeline') return handlePipeline(context);
  if (['review', 'qa', 'accept', 'integrate', 'ask'].includes(command)) return handlePrompt(command, context);
  return null;
}

function objective(context: CliContext): string {
  const named = optionValue<string>(context, '--objective') ?? optionValue<string>(context, '--prompt');
  if (named !== undefined) return named;
  const positional = positionalValue(context, 0);
  if (positional !== undefined) return positional;
  throw new Error('E_OBJECTIVE_REQUIRED: pass --objective <text> (or a bare goal argument)');
}
function readDefinition(store: WorkflowPersistenceStore, context: CliContext): WorkflowDefinition {
  return store.readDefinition(requiredOptionValue<string>(context, '--name'), requiredOptionValue<string>(context, '--version'));
}

async function handleWorkflow(action: string | null, context: CliContext): Promise<number> {
  const store = new WorkflowPersistenceStore(context.root);
  if (action === 'install') {
    const definition = validateWorkflowDefinition(readJsonFile(requiredOptionValue<string>(context, '--file')) as WorkflowDefinition);
    printJson(context.io, await store.installDefinition(definition)); return 0;
  }
  if (action === 'list') {
    printJson(context.io, store.listDefinitions()); return 0;
  }
  if (action === 'show') { printJson(context.io, readDefinition(store, context)); return 0; }
  if (action === 'plan') {
    const plan = planWorkflow(readDefinition(store, context), requiredOptionValue<string>(context, '--id'), objective(context));
    await store.create(plan); printJson(context.io, plan); return 0;
  }
  const id = requiredOptionValue<string>(context, '--id');
  if (action === 'lease-status') {
    printJson(context.io, store.executionLeaseStatus(id));
    return 0;
  }
  let record = store.read(id);
  if (action === 'lease-reconcile') {
    record = await store.reconcileAmbiguousExecutionLease(
      id,
      requiredOptionValue<number>(context, '--revision'),
      requiredOptionValue<WorkflowLeaseReconciliation>(context, '--credential-json'),
    );
    printJson(context.io, {
      reconciled: true,
      run_id: id,
      revision: record.revision,
      lease_status: store.executionLeaseStatus(id),
    });
    return 0;
  }
  if (action === 'run') {
    const definition = store.readDefinition(record.plan.workflow_name, record.plan.workflow_version);
    const ownerId = `cli-${process.pid}-${crypto.randomUUID()}`;
    const result = await new WorkflowRunner(context.adapter, context.cwd).run(definition, record.plan, record.events, async (event) => {
      record = await store.append(id, record.revision, event);
    }, {
      acquire: async (taskId) => {
        const acquired = await store.acquireExecutionLease(id, record.revision, taskId, ownerId, currentProcessIdentity());
        record = acquired.record;
        return acquired.credential;
      },
      release: async (_taskId, token) => {
        const credential = token as WorkflowLeaseCredential | null;
        if (credential === null) throw new Error('E_WORKFLOW_LEASE_NOT_OWNER');
        record = await store.releaseExecutionLease(id, record.revision, credential);
      },
    });
    printJson(context.io, result.status); return result.status.status === 'complete' ? 0 : 1;
  }
  if (action === 'status' || action === 'replay') {
    const status = replayWorkflow(record.plan, record.events);
    printJson(context.io, status);
    if (status.status === 'complete') return 0;
    if (status.status === 'active') return 2;
    return 1;
  }
  throw new Error('E_WORKFLOW_ACTION_INVALID');
}

async function handleUlw(context: CliContext): Promise<number> {
  const workers = requiredOptionValue<readonly UlwWorkerSpec[]>(context, '--workers-json');
  const result = await new CursorWorktreeUlw(context.adapter, commandRunner).run(context.cwd, requiredOptionValue<string>(context, '--id'), workers);
  printJson(context.io, result); return result.status === 'complete' ? 0 : 1;
}

async function handleTeam(action: string | null, context: CliContext): Promise<number> {
  if (action === 'api') {
    if (positionalValue(context, 0) === 'help') {
      context.io.stdout(TEAM_API_HELP);
      return 0;
    }
    const operation = optionValue<string>(context, '--op') ?? positionalValue(context, 0);
    if (operation === undefined) throw new Error('E_TEAM_API_OPERATION_REQUIRED');
    const input = requiredOptionValue<Record<string, unknown>>(context, '--input');
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('E_TEAM_API_INPUT_INVALID');
    validateTeamApiOperationInput(operation, input);
    const envelope = await executeTeamApiOperation(operation, input, context.root);
    printJson(context.io, envelope);
    return envelope.ok ? 0 : 1;
  }
  const store = new TeamManifestStore(context.root);
  const supervisor = new ExperimentalTmuxTeamSupervisor(store, commandRunner, undefined, undefined, undefined, context.root);
  const id = requiredOptionValue<string>(context, '--id');
  if (action === 'start' || action === 'run') {
    const raw = requiredOptionValue<readonly Omit<TeamWorkerSpec, 'cwd'>[]>(context, '--workers-json');
    const workers = raw.map((worker) => ({ ...worker, cwd: (worker as Partial<TeamWorkerSpec>).cwd ?? context.cwd }));
    const manifest = await supervisor.start(id, workers); printJson(context.io, manifest); return 0;
  }
  if (action === 'status') { printJson(context.io, store.read(id)); return 0; }
  if (action === 'collect') { printJson(context.io, await supervisor.collect(id)); return 0; }
  if (action === 'stop') { printJson(context.io, await supervisor.stop(id)); return 0; }
  throw new Error('E_TEAM_ACTION_INVALID');
}

async function handlePipeline(context: CliContext): Promise<number> {
  const pipeline = new AutopilotPipeline();
  const supplied = optionValue<readonly AdvisoryGate[]>(context, '--gates-json');
  if (supplied !== undefined) {
    for (const gate of supplied) pipeline.accept(gate);
  } else {
    const goal = objective(context);
    for (const phase of ['plan', 'execute', 'review', 'qa', 'acceptance'] as const) {
      const result = await context.adapter.run({ argv: buildPrintArgv(`${phase.toUpperCase()} phase. Objective: ${goal}. Return evidence.`, { format: 'json', mode: phase === 'plan' ? 'plan' : 'ask' }), cwd: context.cwd, interactive: false });
      pipeline.accept(evaluateGate({ phase, passed: result.code === 0, evidence: result.stdout }));
      if (result.code !== 0) break;
    }
  }
  const status = pipeline.status(); printJson(context.io, status); return status.phase === 'complete' ? 0 : 1;
}

async function handlePrompt(command: string, context: CliContext): Promise<number> {
  const prompt = objective(context);
  const prefix: Record<string, string> = {
    review: 'Read-only code review. Report findings with file references. Do not edit.',
    qa: 'Run appropriate quality checks and report exact evidence. Do not claim product verification beyond observed evidence.',
    accept: 'Evaluate acceptance criteria and return an advisory pass/fail decision with evidence.',
    integrate: 'Integrate the scoped completed work, resolve local issues, and run verification. Do not publish or mutate external production.',
    ask: 'Answer the following request using current repository truth.',
  };
  const result = await context.adapter.run({ argv: buildPrintArgv(`${prefix[command]}\n\n${prompt}`, { format: requiredOptionValue<string>(context, '--format') === 'stream-json' ? 'stream-json' : 'json', mode: command === 'review' || command === 'accept' ? 'plan' : 'ask' }), cwd: context.cwd, interactive: false });
  if (result.stdout) context.io.stdout(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  if (result.stderr) context.io.stderr(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
  return result.code;
}
