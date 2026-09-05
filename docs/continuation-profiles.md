# Goal and Continuation Profiles over Cursor SDK Persistence & Native Hooks

OMCU provides a durable domain projection over Cursor's persisted agents and native hooks.

## Ownership Architecture

```text
┌────────────────────────────────────────────────────────┐
│                   Cursor SDK Store                     │
│  (Conversation transcripts, Agent IDs, Run IDs, Store) │
├────────────────────────────────────────────────────────┤
│                   Cursor Native Hooks                  │
│       (stop, afterAgentResponse, followup_message)      │
├────────────────────────────────────────────────────────┤
│                      OMCU Journal                      │
│   (Objectives, Phases, Goals, Stories, Todos, Budgets, │
│    Handoffs, Evidence References, Authoritative Gate)  │
└────────────────────────────────────────────────────────┘
```

OMCU never duplicates Cursor transcript persistence or creates a second agent session database.

## 1. Canonical Workflow Projection Schema

A rebuildable projection from the OMCU journal referencing exact Cursor native IDs and immutable artifacts:

```json
{
  "run_id": "omcu-...",
  "cursor_agent_id": "...",
  "cursor_run_id": "...",
  "source_profile": "omc-autopilot|omx-ultragoal|omo-ulw-loop|...",
  "epoch": 1,
  "revision": 12,
  "status": "active",
  "phase": "execution",
  "objective_artifact": "artifact:...",
  "budgets": {
    "max_iterations": 20,
    "max_continuations": 50,
    "deadline_at": "..."
  },
  "goals": [],
  "stories": [],
  "todos": [],
  "child_tasks": [],
  "handoffs": [],
  "evidence": [],
  "failure_fingerprint": null,
  "cancel_requested": false,
  "verified": false,
  "verification_authority": "omcu-cli-only"
}
```

## 2. Source Profiles

### OMC Profiles
- **omc-autopilot**: Autonomous loop: Socratic interview → plan → execute → review → qa → complete.
- **omc-ralph**: Self-referential loop until task completion with architect verification.
- **omc-ultrawork**: High-throughput parallel execution across child agents.
- **omc-ultraqa**: Adversarial QA scenario generation and dynamic test repair loop.
- **omc-pipeline**: Multi-stage pipeline with strict stage receipts and barriers.
- **omc-persistent-todo**: Persistent todo continuation loop until all tasks marked completed.

### OMX Profiles
- **omx-goal**: Goal-driven execution with explicit acceptance criteria.
- **omx-ultragoal**: Multi-goal stories and checkpoints with consensus review.
- **omx-ralplan**: Plan consensus FSM (propose → critic → revise → verifier handoff).
- **omx-ralph**: OMX persistence loop with evaluator gating and architect sign-off.
- **omx-team**: Team story execution across dedicated worker roles.
- **omx-research-goal**: Bounded research goal iterations producing verified synthesis artifacts.

### OMO Profiles
- **omo-boulder**: Start-work bootstrap and persistent boulder forward momentum ("the boulder never stops").
- **omo-ulw-loop**: Clean-room ultrawork parallel execution loop with bounded worker concurrency.
- **omo-atlas-todo**: Atlas-style strict atomic todo discipline with pre/post-step audits.
- **omo-steering**: Bounded steering excursions for sub-problem investigation without losing the main thread.
- **omo-closing-briefing**: Closing briefing artifact generation and state audit.

## 3. Atomic Continuation Transaction

A native `stop` or `afterAgentResponse` hook event continues only when an atomic OMCU transaction under directory lock proves:
1. Matching Cursor agent and run identity.
2. Matching OMCU epoch.
3. Idempotency key verified (no duplicate event execution).
4. Workflow active and cancellation not requested.
5. Deadline not reached.
6. Continuation budget remains (`consumed < max_continuations`).
7. Ambiguous side effects absent (fails closed if unverified side effects detected).
8. Failure fingerprint & progress bounds preserved (repeated identical failures trigger replan/rework/block routing).
9. Next action exists.

The transaction atomically consumes ONE continuation slot before returning the native `followup_message`.

## 4. Compaction & Resume

Before context boundaries, OMCU generates a compact handoff artifact containing:
- Objective and current phase
- Open goals, stories, and todos
- Known facts and unresolved decisions
- Changed files and worktrees
- Latest checks, reviews, and QA evidence
- Child native run status
- Next safe action
- Remaining budgets

A new process resumes via `resumeWorkflowFromHandoff` combining `Agent.resume(cursor_agent_id)` with the handoff artifact, advancing the epoch and rejecting any mismatched agent identity.

## 5. Authoritative Verification Distinction

Workflow completion (`status: 'completed'`) never automatically stamps `verified: true`.
Authoritative verification is strictly reserved for OMCU verification gates (`omcu-cli-only`).
