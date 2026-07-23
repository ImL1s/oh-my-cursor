import { eventDigest, receiptDigest, type WorkflowJournalEvent, type WorkflowPlan, type WorkflowReceipt, type WorkflowRunStatus } from './schema.js';

export function appendWorkflowEvent(events: readonly WorkflowJournalEvent[], runId: string, kind: WorkflowJournalEvent['kind'], payload: unknown): WorkflowJournalEvent {
  const previous = events.at(-1) ?? null;
  const material = { schema_version: 1 as const, run_id: runId, sequence: events.length + 1, kind, payload, previous_event_sha256: previous?.event_sha256 ?? null };
  return { ...material, event_sha256: eventDigest(material) };
}

export function replayWorkflow(plan: WorkflowPlan, events: readonly WorkflowJournalEvent[]): WorkflowRunStatus {
  let previous: string | null = null;
  const receipts: Record<string, WorkflowReceipt> = {};
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
      inFlight.add(payload.task_id);
    }
    if (event.kind === 'task_receipt') {
      const receipt = event.payload as WorkflowReceipt;
      if (!plan.tasks.some((task) => task.task_id === receipt.task_id)) throw new Error('E_WORKFLOW_RECEIPT_TASK_INVALID');
      const { receipt_sha256: claimedReceiptDigest, ...receiptMaterial } = receipt;
      if (receipt.run_id !== plan.run_id || receipt.verified !== false || receipt.verification_authority !== 'omcu-cli-only' || receiptDigest(receiptMaterial) !== claimedReceiptDigest) throw new Error('E_WORKFLOW_RECEIPT_INVALID');
      receipts[receipt.task_id] = receipt;
      inFlight.delete(receipt.task_id);
    }
    if (event.kind === 'run_finished') finished = true;
  }
  const statuses = Object.values(receipts).map((receipt) => receipt.status);
  const status = inFlight.size > 0 ? 'ambiguous' : statuses.includes('unsupported') ? 'unsupported' : statuses.includes('blocked') ? 'blocked' : statuses.includes('failed') ? 'failed' : finished && Object.keys(receipts).length === plan.tasks.length ? 'complete' : 'active';
  return { run_id: plan.run_id, status, receipts, verified: false, verification_authority: 'omcu-cli-only' };
}

export const workflowStatus = replayWorkflow;
