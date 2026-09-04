import { eventDigest, receiptDigest, type WorkflowDefinition, type WorkflowJournalEvent, type WorkflowPlan, type WorkflowReceipt, type WorkflowRunStatus, type WorkflowTaskRunState, type WorkflowTaskStatus } from './schema.js';

export function appendWorkflowEvent(events: readonly WorkflowJournalEvent[], runId: string, kind: WorkflowJournalEvent['kind'], payload: unknown): WorkflowJournalEvent {
  const previous = events.at(-1) ?? null;
  const material = { schema_version: 1 as const, run_id: runId, sequence: events.length + 1, kind, payload, previous_event_sha256: previous?.event_sha256 ?? null };
  return { ...material, event_sha256: eventDigest(material) };
}

export function replayWorkflow(definition: WorkflowDefinition, plan: WorkflowPlan, events: readonly WorkflowJournalEvent[]): WorkflowRunStatus {
  if (plan.definition_sha256 !== definition.definition_sha256) throw new Error('E_WORKFLOW_PLAN_DEFINITION_MISMATCH');

  let previous: string | null = null;
  const taskAttempts: Record<string, WorkflowReceipt[]> = {};
  const inFlight = new Set<string>();
  let finished = false;

  for (const [index, event] of events.entries()) {
    const { event_sha256: claimedDigest, ...material } = event;
    if (event.run_id !== plan.run_id || event.sequence !== index + 1 || event.previous_event_sha256 !== previous || eventDigest(material) !== claimedDigest) throw new Error('E_WORKFLOW_JOURNAL_INVALID');
    previous = event.event_sha256;
    if (event.kind === 'task_started') {
      const payload = event.payload as Partial<{ task_id: string; attempt: number; argv_sha256: string }>;
      if (typeof payload.task_id !== 'string' || !plan.tasks.some((task) => task.task_id === payload.task_id)
        || !Number.isSafeInteger(payload.attempt) || !/^[a-f0-9]{64}$/.test(payload.argv_sha256 ?? '')) throw new Error('E_WORKFLOW_INTENT_INVALID');
      const task = plan.tasks.find((t) => t.task_id === payload.task_id)!;
      const stage = definition.stages[task.declaration_index];
      if (!stage || payload.attempt! < 1 || payload.attempt! > stage.max_attempts) throw new Error('E_WORKFLOW_INTENT_INVALID');
      inFlight.add(payload.task_id);
    }
    if (event.kind === 'task_receipt') {
      const receipt = event.payload as WorkflowReceipt;
      if (!plan.tasks.some((task) => task.task_id === receipt.task_id)) throw new Error('E_WORKFLOW_RECEIPT_TASK_INVALID');
      const { receipt_sha256: claimedReceiptDigest, ...receiptMaterial } = receipt;
      if (receipt.run_id !== plan.run_id || receipt.verified !== false || receipt.verification_authority !== 'omcu-cli-only' || receiptDigest(receiptMaterial) !== claimedReceiptDigest) throw new Error('E_WORKFLOW_RECEIPT_INVALID');
      const task = plan.tasks.find((t) => t.task_id === receipt.task_id)!;
      const stage = definition.stages[task.declaration_index];
      if (!stage || receipt.attempt < 1 || receipt.attempt > stage.max_attempts) throw new Error('E_WORKFLOW_RECEIPT_INVALID');
      if (!taskAttempts[receipt.task_id]) taskAttempts[receipt.task_id] = [];
      taskAttempts[receipt.task_id]!.push(receipt);
      inFlight.delete(receipt.task_id);
    }
    if (event.kind === 'run_finished') finished = true;
  }

  const tasks: Record<string, WorkflowTaskStatus> = {};
  for (const task of plan.tasks) {
    const attempts = taskAttempts[task.task_id] ?? [];
    const stage = definition.stages[task.declaration_index];
    const max_attempts = stage?.max_attempts ?? 1;

    let status: WorkflowTaskRunState = 'pending';
    if (attempts.length > 0) {
      const last = attempts[attempts.length - 1]!;
      if (last.status === 'passed' || last.status === 'blocked' || last.status === 'unsupported') {
        status = last.status;
      } else if (last.status === 'failed') {
        if (attempts.length >= max_attempts) {
          status = 'attempt_failed_terminal';
        } else {
          status = 'attempt_failed_retryable';
        }
      }
    }
    if (inFlight.has(task.task_id)) {
      status = 'attempt_ambiguous';
    }

    tasks[task.task_id] = {
      task_id: task.task_id,
      status,
      attempts
    };
  }

  const statuses = Object.values(tasks).map((t) => t.status);
  const status = statuses.includes('attempt_ambiguous') ? 'ambiguous' : statuses.includes('unsupported') ? 'unsupported' : statuses.includes('blocked') ? 'blocked' : statuses.includes('attempt_failed_terminal') ? 'failed' : finished && statuses.every((s) => s === 'passed') ? 'complete' : 'active';
  return { run_id: plan.run_id, status, tasks, verified: false, verification_authority: 'omcu-cli-only' };
}

export const workflowStatus = replayWorkflow;
