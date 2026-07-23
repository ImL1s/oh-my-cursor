import { buildPrintArgv, type CursorAgentAdapter } from '../host/cursor-agent.js';
import { redact } from '../runtime/redaction.js';
import { appendWorkflowEvent, replayWorkflow } from './replay.js';
import { receiptDigest, sha256, type WorkflowDefinition, type WorkflowJournalEvent, type WorkflowPlan, type WorkflowReceipt, type WorkflowRunStatus } from './schema.js';

export interface WorkflowRunResult { readonly status: WorkflowRunStatus; readonly events: readonly WorkflowJournalEvent[] }
export type WorkflowEventSink = (event: WorkflowJournalEvent) => Promise<void>;
export interface WorkflowLeaseController {
  acquire(taskId: string): Promise<unknown>;
  release(taskId: string, token: unknown): Promise<void>;
}

export class WorkflowRunner {
  constructor(private readonly adapter: CursorAgentAdapter, private readonly cwd: string, private readonly now: () => Date = () => new Date()) {}

  async run(definition: WorkflowDefinition, plan: WorkflowPlan, priorEvents: readonly WorkflowJournalEvent[] = [], sink?: WorkflowEventSink, leases?: WorkflowLeaseController): Promise<WorkflowRunResult> {
    if (plan.definition_sha256 !== definition.definition_sha256) throw new Error('E_WORKFLOW_PLAN_DEFINITION_MISMATCH');
    const events = [...priorEvents];
    const record = async (kind: WorkflowJournalEvent['kind'], payload: unknown): Promise<void> => {
      const event = appendWorkflowEvent(events, plan.run_id, kind, payload);
      if (sink !== undefined) await sink(event);
      events.push(event);
    };
    if (events.length === 0) await record('run_started', { plan_sha256: plan.plan_sha256 });
    let snapshot = replayWorkflow(plan, events);
    if (snapshot.status !== 'active') return { status: snapshot, events };
    for (const task of plan.tasks) {
      if (snapshot.receipts[task.task_id] !== undefined) continue;
      const dependenciesReady = task.depends_on.every((dependency) => snapshot.receipts[dependency]?.status === 'passed');
      const stage = definition.stages[task.declaration_index];
      if (stage === undefined) throw new Error('E_WORKFLOW_STAGE_MISSING');
      let receipt: WorkflowReceipt;
      if (!dependenciesReady) {
        receipt = makeReceipt(plan.run_id, task.task_id, 1, 'blocked', [], null, null, null, { error: 'dependency_not_passed' }, definition, this.now());
      } else if (definition.capability_tier === 'unsupported') {
        receipt = makeReceipt(plan.run_id, task.task_id, 1, 'unsupported', [], null, null, null, null, definition, this.now());
      } else {
        receipt = makeReceipt(plan.run_id, task.task_id, 1, 'failed', [], null, null, null, null, definition, this.now());
        for (let attempt = 1; attempt <= stage.max_attempts; attempt += 1) {
          const argv = buildPrintArgv(`${stage.prompt}\n\nObjective: ${plan.objective}\nAttempt: ${attempt}/${stage.max_attempts}`, { format: 'json', mode: stage.mode });
          const lease = leases === undefined ? undefined : await leases.acquire(task.task_id);
          try {
            await record('task_started', { task_id: task.task_id, attempt, argv_sha256: sha256(JSON.stringify(argv)) });
            const result = await this.adapter.run({ argv, cwd: this.cwd, interactive: false });
            receipt = makeReceipt(plan.run_id, task.task_id, attempt, result.code === 0 ? 'passed' : 'failed', argv, result.code, result.stdout, result.stderr, result.json ?? result.stdout, definition, this.now(), result.raw_stdout_sha256, result.raw_stderr_sha256);
            await record('task_receipt', receipt);
          } finally {
            if (leases !== undefined) await leases.release(task.task_id, lease);
          }
          if (receipt.status === 'passed') break;
        }
      }
      if (definition.capability_tier === 'unsupported' || !dependenciesReady) await record('task_receipt', receipt);
      snapshot = replayWorkflow(plan, events);
      if (receipt.status !== 'passed') break;
    }
    await record('run_finished', { receipt_count: Object.keys(replayWorkflow(plan, events).receipts).length });
    return { status: replayWorkflow(plan, events), events };
  }
}

function makeReceipt(runId: string, taskId: string, attempt: number, status: WorkflowReceipt['status'], argv: readonly string[], exitCode: number | null, stdout: string | null, stderr: string | null, output: unknown, definition: WorkflowDefinition, now: Date, rawStdoutSha256?: string, rawStderrSha256?: string): WorkflowReceipt {
  const material = { schema_version: 1 as const, run_id: runId, task_id: taskId, attempt, status, invoked_argv: argv, exit_code: exitCode, stdout_sha256: rawStdoutSha256 ?? (stdout === null ? null : sha256(stdout)), stderr_sha256: rawStderrSha256 ?? (stderr === null ? null : sha256(stderr)), output: redact(output), capability_tier: definition.capability_tier, unsupported_reason: definition.unsupported_reason ?? null, verified: false as const, verification_authority: 'omcu-cli-only' as const, created_at: now.toISOString() };
  return { ...material, receipt_sha256: receiptDigest(material) };
}
