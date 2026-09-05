import crypto from 'node:crypto';
import { buildPrintArgv } from '../host/cursor-agent.js';
import { currentProcessIdentity } from '../runtime/process-identity.js';
import { AutopilotPipeline, CursorWorktreeUlw, evaluateGate, runRalph, runRalplan, type AdvisoryGate, type UlwWorkerSpec } from '../modes/index.js';
import {
  executeTeamApiOperation,
  ExperimentalTmuxTeamSupervisor,
  TEAM_API_HELP,
  TeamManifestStore,
  validateTeamApiOperationInput,
  type TeamWorkerSpec,
} from '../team/index.js';
import {
  planWorkflow,
  replayWorkflow,
  validateWorkflowDefinition,
  WorkflowPersistenceStore,
  WorkflowRunner,
  type WorkflowDefinition,
  type WorkflowLeaseCredential,
  type WorkflowLeaseReconciliation,
} from '../workflows/index.js';
import type { TaskRuntime } from '../tasks/types.js';
import type { DagDefinition } from '../dag/types.js';
import {
  commandRunner,
  flagValue,
  optionValue,
  positionalValue,
  printJson,
  readJsonFile,
  requiredOptionValue,
  type CliContext,
} from './shared.js';

export async function handleOrchestration(context: CliContext): Promise<number | null> {
  const { command, action } = context.parsed;
  if (command === 'workflow') return handleWorkflow(action, context);
  if (command === 'ralplan') {
    const result = await runRalplan(context, objective(context), requiredOptionValue<number>(context, '--rounds'));
    printJson(context.io, result);
    return result.status === 'accepted' ? 0 : 1;
  }
  if (command === 'ralph') {
    const result = await runRalph(context, objective(context), { maxIterations: requiredOptionValue<number>(context, '--iterations') });
    printJson(context.io, result);
    return result.status === 'complete' ? 0 : 1;
  }
  if (command === 'ulw') return handleUlw(context);
  if (command === 'team') return handleTeam(action, context);
  if (command === 'task') return handleTask(action, context);
  if (command === 'dag') return handleDag(action, context);
  if (command === 'automation') return handleAutomation(action, context);
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
    printJson(context.io, await store.installDefinition(definition));
    return 0;
  }
  if (action === 'list') {
    printJson(context.io, store.listDefinitions());
    return 0;
  }
  if (action === 'show') {
    printJson(context.io, readDefinition(store, context));
    return 0;
  }
  if (action === 'plan') {
    const plan = planWorkflow(readDefinition(store, context), requiredOptionValue<string>(context, '--id'), objective(context));
    await store.create(plan);
    printJson(context.io, plan);
    return 0;
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
    printJson(context.io, result.status);
    return result.status.status === 'complete' ? 0 : 1;
  }
  if (action === 'status' || action === 'replay') {
    const definition = store.readDefinition(record.plan.workflow_name, record.plan.workflow_version);
    const status = replayWorkflow(definition, record.plan, record.events);
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
  printJson(context.io, result);
  return result.status === 'complete' ? 0 : 1;
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
    const isSupervisor = flagValue(context, '--supervisor');
    const envelope = await executeTeamApiOperation(operation, input, context.root, { isSupervisor });
    printJson(context.io, envelope);
    return envelope.ok ? 0 : 1;
  }

  const id = requiredOptionValue<string>(context, '--id');
  const isNative = flagValue(context, '--native');

  if (action === 'monitor' || action === 'resume' || action === 'shutdown' || isNative) {
    const { CursorNativeTeamSupervisor } = await import('../team/native-supervisor.js');
    const nativeSupervisor = new CursorNativeTeamSupervisor(context.root);

    if (action === 'monitor') {
      const output = await nativeSupervisor.monitor(id);
      context.io.stdout(output.endsWith('\n') ? output : `${output}\n`);
      return 0;
    }
    if (action === 'resume') {
      const manifest = await nativeSupervisor.resume(id);
      printJson(context.io, manifest);
      return 0;
    }
    if (action === 'shutdown') {
      const manifest = await nativeSupervisor.shutdown(id);
      printJson(context.io, manifest);
      return 0;
    }
    if (action === 'start' || action === 'run') {
      const raw = requiredOptionValue<readonly Omit<TeamWorkerSpec, 'cwd'>[]>(context, '--workers-json');
      const workers = raw.map((worker) => ({ ...worker, cwd: (worker as Partial<TeamWorkerSpec>).cwd ?? context.cwd }));
      const runtime = (optionValue<string>(context, '--runtime') ?? 'local') as 'local' | 'cloud';
      const manifest = await nativeSupervisor.start(id, workers, { runtime });
      printJson(context.io, manifest);
      return 0;
    }
    if (action === 'status') {
      const stat = await nativeSupervisor.status(id);
      printJson(context.io, stat);
      return 0;
    }
  }

  const store = new TeamManifestStore(context.root);
  const supervisor = new ExperimentalTmuxTeamSupervisor(store, commandRunner, undefined, undefined, undefined, context.root);

  if (action === 'start' || action === 'run') {
    const raw = requiredOptionValue<readonly Omit<TeamWorkerSpec, 'cwd'>[]>(context, '--workers-json');
    const workers = raw.map((worker) => ({ ...worker, cwd: (worker as Partial<TeamWorkerSpec>).cwd ?? context.cwd }));
    const manifest = await supervisor.start(id, workers);
    printJson(context.io, manifest);
    return 0;
  }
  if (action === 'status') {
    printJson(context.io, store.read(id));
    return 0;
  }
  if (action === 'collect') {
    printJson(context.io, await supervisor.collect(id));
    return 0;
  }
  if (action === 'stop') {
    printJson(context.io, await supervisor.stop(id));
    return 0;
  }
  throw new Error('E_TEAM_ACTION_INVALID');
}

async function handleTask(action: string | null, context: CliContext): Promise<number> {
  const { TaskRunner, TaskStore } = await import('../tasks/index.js');
  const store = new TaskStore(context.cwd);
  const runner = new TaskRunner(context.cwd, store);

  if (action === 'start') {
    const role = requiredOptionValue<string>(context, '--agent');
    const runtime = (optionValue<string>(context, '--runtime') ?? 'local') as TaskRuntime;
    const prompt = requiredOptionValue<string>(context, '--prompt');
    const background = flagValue(context, '--background');
    const taskId = optionValue<string>(context, '--id');
    const worktree = optionValue<string>(context, '--worktree');
    const workflowId = optionValue<string>(context, '--workflow');

    const created = runner.createTask({
      taskId,
      role,
      runtime,
      prompt,
      worktree,
      workflowId,
      workspace: context.cwd,
    });

    const result = await runner.run(created, { background });
    printJson(context.io, result);
    return result.status === 'failed' ? 1 : 0;
  }

  if (action === 'list') {
    const workflowId = optionValue<string>(context, '--workflow');
    const status = optionValue<string>(context, '--status') as any;
    const tasks = store.list({ workflowId, status });
    printJson(context.io, tasks);
    return 0;
  }

  const id = optionValue<string>(context, '--id') ?? positionalValue(context, 0);
  if (!id) throw new Error('E_TASK_ID_REQUIRED: specify task id');

  if (action === 'status') {
    const task = store.get(id);
    if (!task) throw new Error(`E_TASK_NOT_FOUND: task '${id}' not found`);
    printJson(context.io, task);
    return 0;
  }

  if (action === 'output') {
    const task = store.get(id);
    if (!task) throw new Error(`E_TASK_NOT_FOUND: task '${id}' not found`);
    context.io.stdout(task.output ?? '');
    return 0;
  }

  if (action === 'cancel') {
    const task = await runner.cancel(id);
    printJson(context.io, task);
    return 0;
  }

  if (action === 'resume') {
    const task = await runner.resume(id);
    printJson(context.io, task);
    return task.status === 'failed' ? 1 : 0;
  }

  throw new Error('E_TASK_ACTION_INVALID');
}

async function handleDag(action: string | null, context: CliContext): Promise<number> {
  if (action === 'run') {
    const file = requiredOptionValue<string>(context, '--file');
    const canvas = flagValue(context, '--canvas');
    const workspace = optionValue<string>(context, '--workspace') ?? context.cwd;
    const dagDef = readJsonFile(file) as DagDefinition;
    const { DagRunner } = await import('../dag/index.js');
    const dagRunner = new DagRunner(workspace);
    const result = await dagRunner.run(dagDef, { canvas });
    printJson(context.io, result);
    return result.status === 'completed' ? 0 : 1;
  }
  throw new Error('E_DAG_ACTION_INVALID');
}

async function handleAutomation(action: string | null, context: CliContext): Promise<number> {
  const { AutomationManager } = await import('../automations/index.js');
  const manager = new AutomationManager(context.cwd);

  if (action === 'plan') {
    const name = requiredOptionValue<string>(context, '--name');
    const prompt = requiredOptionValue<string>(context, '--prompt');
    const cron = optionValue<string>(context, '--cron');
    const event = optionValue<string>(context, '--event');
    const role = optionValue<string>(context, '--agent') ?? 'omcu-worker';
    const runtime = (optionValue<string>(context, '--runtime') ?? 'local') as any;
    const automationId = optionValue<string>(context, '--id');

    const trigger = cron
      ? { kind: 'cron' as const, cron }
      : event
        ? { kind: 'event' as const, event }
        : { kind: 'schedule' as const };

    const plan = manager.plan({
      automationId,
      name,
      trigger,
      action: {
        role,
        prompt,
        runtime,
      },
    });
    printJson(context.io, plan);
    return 0;
  }

  if (action === 'status') {
    const id = optionValue<string>(context, '--id');
    const stat = manager.status(id);
    printJson(context.io, stat);
    return 0;
  }

  if (action === 'install') {
    const id = requiredOptionValue<string>(context, '--id');
    const manifest = manager.install(id);
    printJson(context.io, manifest);
    return 0;
  }

  if (action === 'remove') {
    const id = requiredOptionValue<string>(context, '--id');
    const removed = manager.remove(id);
    printJson(context.io, { removed, id });
    return removed ? 0 : 1;
  }

  throw new Error('E_AUTOMATION_ACTION_INVALID');
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
  const status = pipeline.status();
  printJson(context.io, status);
  return status.phase === 'complete' ? 0 : 1;
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
