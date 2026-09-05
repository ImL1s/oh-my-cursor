import path from 'node:path';
import { withDirectoryLock } from '../runtime/atomic.js';
import { resolveProjectStatePath } from '../runtime/state-root.js';
import { WorkflowProjectionStore } from '../runtime/cursor-sdk/store.js';
import { getSourceProfile, getNextProfilePhase } from '../workflows/profiles/catalog.js';
import { deriveFailureFingerprint, evaluateFailureProgress } from './fingerprint.js';
import type {
  ContinuationTransactionOptions,
  ContinuationTransactionResult,
} from './types.js';
import type { WorkflowProjection } from '../workflows/projection.js';

export function buildProfileFollowupMessage(
  projection: WorkflowProjection,
  consumedContinuations: number,
  remainingContinuations: number,
  specialDirective?: string
): string {
  const profile = getSourceProfile(projection.source_profile);
  const profileName = profile?.canonicalName ?? projection.source_profile;

  const openGoal = projection.goals.find((g) => g.status === 'pending' || g.status === 'in_progress');
  const openStory = projection.stories.find((s) => s.status === 'pending' || s.status === 'in_progress');
  const openTodos = projection.todos.filter((t) => !t.completed && t.status !== 'cancelled');

  const lines: string[] = [
    `OMCU continuation active [Profile: ${profileName} | Phase: ${projection.phase}].`,
    `Continuation ${consumedContinuations} (${remainingContinuations} remaining before budget cap).`,
  ];

  if (openGoal) {
    lines.push(`Active Goal: ${openGoal.title}`);
    if (openGoal.acceptance_criteria.length > 0) {
      lines.push(`Acceptance Criteria: ${openGoal.acceptance_criteria.join('; ')}`);
    }
  }

  if (openStory) {
    lines.push(`Active Story: ${openStory.title} (Attempt ${openStory.attempt})`);
  }

  if (openTodos.length > 0 && openTodos[0]) {
    const nextTodo = openTodos[0];
    lines.push(`Current Todo: ${nextTodo.title} (${openTodos.length} total pending)`);
  }

  if (specialDirective) {
    lines.push(`Routing Directive: ${specialDirective}`);
  }

  lines.push(
    'Instructions: Take the smallest reversible step toward the objective and run targeted verification.',
    'Do NOT idle-stop or ask confirmation on obvious next steps.',
    'Never fabricate completion: do not claim verified. Authoritative verification is omcu-cli-only.',
    'When criteria are met with real test evidence, mark state completed and stop. If truly blocked on external decision, state blocker clearly.'
  );

  return lines.join('\n');
}

/**
 * Atomic continuation transaction over Cursor SDK persistence and native stop hooks.
 * Guarantees that stop and afterAgentResponse hook events only continue when
 * identity, epoch, budget, idempotency, and progress invariants hold.
 */
export async function executeContinuationTransaction(
  options: ContinuationTransactionOptions
): Promise<ContinuationTransactionResult> {
  const statePath = resolveProjectStatePath(options.cwd);
  const store = new WorkflowProjectionStore(options.cwd);
  const sanitizedRunId = options.run_id.replace(/[^a-zA-Z0-9_-]/g, '_');
  const lockFile = path.join(statePath, 'workflows', `${sanitizedRunId}.lock`);

  return withDirectoryLock(lockFile, async (): Promise<ContinuationTransactionResult> => {
    const current = store.load(options.run_id);
    if (!current) {
      return {
        continue: false,
        reason: 'workflow_not_found',
        refusal_reason: `Workflow projection not found: ${options.run_id}`,
        continuation_slot_consumed: false,
      };
    }

    // 1. Validate matching Cursor Agent and Run identity
    if (current.cursor_agent_id !== options.cursor_agent_id) {
      return {
        continue: false,
        reason: 'mismatched_cursor_agent',
        refusal_reason: `Cursor agent mismatch: expected ${current.cursor_agent_id}, received ${options.cursor_agent_id}`,
        next_projection: current,
        continuation_slot_consumed: false,
      };
    }

    if (
      current.cursor_run_id &&
      options.cursor_run_id &&
      current.cursor_run_id !== options.cursor_run_id
    ) {
      return {
        continue: false,
        reason: 'mismatched_cursor_run',
        refusal_reason: `Cursor run mismatch: expected ${current.cursor_run_id}, received ${options.cursor_run_id}`,
        next_projection: current,
        continuation_slot_consumed: false,
      };
    }

    if (current.run_id !== options.run_id) {
      return {
        continue: false,
        reason: 'mismatched_run_id',
        refusal_reason: `Workflow run mismatch: expected ${current.run_id}, received ${options.run_id}`,
        next_projection: current,
        continuation_slot_consumed: false,
      };
    }

    // 2. Validate matching Epoch
    if (current.epoch !== options.epoch) {
      return {
        continue: false,
        reason: 'mismatched_epoch',
        refusal_reason: `Epoch mismatch: expected ${current.epoch}, received ${options.epoch}`,
        next_projection: current,
        continuation_slot_consumed: false,
      };
    }

    // 3. Idempotency key check
    const lastEventId = (current as unknown as { last_event_id?: string }).last_event_id;
    if (lastEventId !== undefined && lastEventId === options.event_id) {
      return {
        continue: false,
        reason: 'duplicate_event',
        refusal_reason: `Event ID ${options.event_id} has already been processed for this workflow`,
        next_projection: current,
        continuation_slot_consumed: false,
      };
    }

    // 4. Cancellation check
    const isCancelled =
      current.cancel_requested ||
      options.hook_status === 'cancelled' ||
      options.hook_status === 'abort';

    if (isCancelled) {
      const updated: WorkflowProjection = {
        ...current,
        status: 'cancelled',
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
      };
      store.save(updated);
      return {
        continue: false,
        reason: 'cancel_requested',
        refusal_reason: 'Workflow cancellation has been requested',
        next_projection: updated,
        continuation_slot_consumed: false,
      };
    }

    // 5. Active status check
    if (current.status !== 'active') {
      return {
        continue: false,
        reason: `status_${current.status}`,
        refusal_reason: `Workflow is not active (current status: ${current.status})`,
        next_projection: current,
        continuation_slot_consumed: false,
      };
    }

    const nowMs = options.now_ms ?? Date.now();

    // 6. Deadline check
    const deadlineMs = Date.parse(current.budgets.deadline_at);
    if (!Number.isNaN(deadlineMs) && nowMs >= deadlineMs) {
      const updated: WorkflowProjection = {
        ...current,
        status: 'failed',
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
      };
      store.save(updated);
      return {
        continue: false,
        reason: 'deadline_exhausted',
        refusal_reason: `Workflow deadline ${current.budgets.deadline_at} has passed`,
        next_projection: updated,
        continuation_slot_consumed: false,
      };
    }

    // 7. Continuation budget check
    const consumed = current.budgets.consumed_continuations ?? 0;
    const maxContinuations = current.budgets.max_continuations;
    if (consumed >= maxContinuations) {
      const updated: WorkflowProjection = {
        ...current,
        status: 'failed',
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
      };
      store.save(updated);
      return {
        continue: false,
        reason: 'continuation_budget_exhausted',
        refusal_reason: `Continuation budget exhausted (${consumed}/${maxContinuations})`,
        next_projection: updated,
        continuation_slot_consumed: false,
      };
    }

    // 8. Ambiguous side effect check (Fail closed!)
    if (options.ambiguous_side_effect || options.hook_status === 'ambiguous') {
      const updated: WorkflowProjection = {
        ...current,
        status: 'blocked',
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
      };
      store.save(updated);
      return {
        continue: false,
        reason: 'ambiguous_side_effect',
        refusal_reason: 'Ambiguous side effect detected; manual review required before continuing',
        next_projection: updated,
        continuation_slot_consumed: false,
      };
    }

    // 9. Failure fingerprint and progress intelligence
    let failureFingerprint: string | null = null;
    let failureDirective: string | undefined = undefined;
    const profile = getSourceProfile(current.source_profile);

    let observedFailure = options.observed_failure;
    if (!observedFailure && options.turn_output?.error) {
      observedFailure = {
        error: options.turn_output.error instanceof Error || typeof options.turn_output.error === 'string'
          ? options.turn_output.error
          : JSON.stringify(options.turn_output.error),
        output: options.turn_output.text,
      };
    } else if (!observedFailure && (options.hook_status === 'timeout' || options.hook_status === 'error' || options.hook_status === 'failed')) {
      observedFailure = {
        error: `Hook failure: ${options.hook_status}`,
        output: options.turn_output?.text,
      };
    }

    if (observedFailure) {
      failureFingerprint = deriveFailureFingerprint(observedFailure);
      const consecutiveFailures = (current as unknown as { consecutive_failures?: number }).consecutive_failures ?? 0;
      const progress = profile
        ? evaluateFailureProgress(profile, failureFingerprint, current.failure_fingerprint, consecutiveFailures)
        : {
            hasProgress: false,
            consecutiveFailures: consecutiveFailures + 1,
            repeatedFailure: failureFingerprint === current.failure_fingerprint && consecutiveFailures >= 2,
            recommendedAction: 'rework' as const,
            reason: 'failure_observed',
          };

      if (progress.repeatedFailure) {
        if (progress.recommendedAction === 'terminal_failure') {
          const updated: WorkflowProjection = {
            ...current,
            status: 'failed',
            failure_fingerprint: failureFingerprint,
            revision: current.revision + 1,
            updated_at: new Date().toISOString(),
          };
          store.save(updated);
          return {
            continue: false,
            reason: 'repeated_failure_detected',
            refusal_reason: progress.reason,
            failure_routing: 'terminal_failure',
            failure_fingerprint: failureFingerprint,
            next_projection: updated,
            continuation_slot_consumed: false,
          };
        }

        if (progress.recommendedAction === 'human_blocker') {
          const updated: WorkflowProjection = {
            ...current,
            status: 'blocked',
            failure_fingerprint: failureFingerprint,
            revision: current.revision + 1,
            updated_at: new Date().toISOString(),
          };
          store.save(updated);
          return {
            continue: false,
            reason: 'repeated_failure_detected',
            refusal_reason: progress.reason,
            failure_routing: 'human_blocker',
            failure_fingerprint: failureFingerprint,
            next_projection: updated,
            continuation_slot_consumed: false,
          };
        }

        if (progress.recommendedAction === 'replan') {
          failureDirective = 'Repeated failure detected. Re-evaluating plan and transitioning to replan phase.';
        } else if (progress.recommendedAction === 'specialist') {
          const specialist = profile?.failureRouting.specialistRole ?? 'debugger';
          failureDirective = `Repeated failure detected. Suggest delegating to ${specialist} specialist.`;
        } else {
          failureDirective = 'Repeated failure detected. Reworking approach with alternative strategy.';
        }
      }
    }

    // 10. Check if next action exists or all goals are satisfied
    const openGoals = current.goals.filter((g) => g.status === 'pending' || g.status === 'in_progress');
    const openStories = current.stories.filter((s) => s.status === 'pending' || s.status === 'in_progress');
    const openTodos = current.todos.filter((t) => !t.completed && t.status !== 'cancelled');

    const allGoalsDone = current.goals.length > 0 && current.goals.every((g) => g.status === 'completed');
    const allStoriesDone = current.stories.length > 0 && current.stories.every((s) => s.status === 'completed');
    const allTodosDone = current.todos.length > 0 && current.todos.every((t) => t.completed || t.status === 'cancelled');

    if (allGoalsDone && (current.stories.length === 0 || allStoriesDone) && (current.todos.length === 0 || allTodosDone)) {
      const updated: WorkflowProjection = {
        ...current,
        status: 'completed',
        phase: profile?.terminalPhases.includes('completed') ? 'completed' : current.phase,
        // Authoritative verification remains false until verified by omcu CLI
        verified: false,
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
      };
      store.save(updated);
      return {
        continue: false,
        reason: 'all_goals_satisfied',
        refusal_reason: 'All goals, stories, and todos in workflow are completed',
        next_projection: updated,
        continuation_slot_consumed: false,
      };
    }

    // Terminal phase check
    if (profile && profile.terminalPhases.includes(current.phase)) {
      return {
        continue: false,
        reason: 'terminal_phase_reached',
        refusal_reason: `Workflow is in terminal phase: ${current.phase}`,
        next_projection: current,
        continuation_slot_consumed: false,
      };
    }

    // Next action validation: ensure work remains or valid phase transition exists
    const hasOpenWork = openGoals.length > 0 || openStories.length > 0 || openTodos.length > 0;
    const hasDefinedEntities = current.goals.length > 0 || current.stories.length > 0 || current.todos.length > 0;
    const nextPhaseAvailable = profile ? getNextProfilePhase(current.source_profile, current.phase) !== null : false;
    const isIterativePhase = ['loop', 'momentum_loop', 'ulw_work_loop', 'parallel_work', 'test', 'fix', 'execute', 'implement'].includes(current.phase);

    if (hasDefinedEntities && !hasOpenWork) {
      return {
        continue: false,
        reason: 'no_next_action',
        refusal_reason: 'No open goals, stories, or todos remain to execute',
        next_projection: current,
        continuation_slot_consumed: false,
      };
    }

    if (!hasOpenWork && !nextPhaseAvailable && !isIterativePhase) {
      return {
        continue: false,
        reason: 'no_next_action',
        refusal_reason: 'No next action or phase transition available in workflow',
        next_projection: current,
        continuation_slot_consumed: false,
      };
    }

    // 11. Atomically consume ONE continuation slot
    const nextConsumed = consumed + 1;
    const remaining = Math.max(0, maxContinuations - nextConsumed);
    const nextRevision = current.revision + 1;

    let nextPhase = current.phase;
    if (failureDirective?.includes('replan') && profile && profile.phases.includes('plan')) {
      nextPhase = 'plan';
    }

    const updatedProjection: WorkflowProjection = {
      ...current,
      revision: nextRevision,
      phase: nextPhase,
      budgets: {
        ...current.budgets,
        consumed_continuations: nextConsumed,
      },
      failure_fingerprint: failureFingerprint ?? current.failure_fingerprint,
      updated_at: new Date().toISOString(),
      // Custom internal tracking properties
      ...({
        last_event_id: options.event_id,
        consecutive_failures: failureFingerprint
          ? (failureFingerprint === current.failure_fingerprint
              ? ((current as unknown as { consecutive_failures?: number }).consecutive_failures ?? 0) + 1
              : 1)
          : 0,
      } as Record<string, unknown>),
    };

    store.save(updatedProjection);

    const followupMessage = buildProfileFollowupMessage(
      updatedProjection,
      nextConsumed,
      remaining,
      failureDirective
    );

    return {
      continue: true,
      reason: 'continuation_granted',
      followup_message: followupMessage,
      next_projection: updatedProjection,
      continuation_slot_consumed: true,
      failure_fingerprint: failureFingerprint ?? undefined,
    };
  });
}
