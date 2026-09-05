import type {
  SourceFamily,
  SourceProfileId,
  WorkflowProfileDefinition,
} from './types.js';

export const WORKFLOW_PROFILES: readonly WorkflowProfileDefinition[] = [
  // --- OMC Profiles ---
  {
    id: 'omc-autopilot',
    canonicalName: 'OMC Autopilot',
    sourceFamily: 'omc',
    description: 'Autonomous end-to-end loop with Socratic interview, planning, execution, review, and QA',
    phases: ['interview', 'plan', 'execute', 'review', 'qa', 'completed', 'failed'],
    initialPhase: 'interview',
    terminalPhases: ['completed', 'failed'],
    allowedTransitions: [
      { from: 'interview', to: 'plan' },
      { from: 'interview', to: 'failed' },
      { from: 'plan', to: 'execute' },
      { from: 'plan', to: 'interview' },
      { from: 'execute', to: 'review' },
      { from: 'execute', to: 'plan' },
      { from: 'review', to: 'qa' },
      { from: 'review', to: 'execute' },
      { from: 'qa', to: 'completed' },
      { from: 'qa', to: 'execute' },
      { from: 'qa', to: 'failed' },
    ],
    defaultBudgets: { max_iterations: 30, max_continuations: 60, max_time_ms: 7200000 },
    requiredArtifacts: ['objective', 'plan', 'review_verdict', 'qa_report'],
    supportsChildTasks: true,
    supportsWorktrees: true,
    failureRouting: {
      maxConsecutiveFailures: 3,
      onRepeatedFailure: 'replan',
    },
  },
  {
    id: 'omc-ralph',
    canonicalName: 'OMC Ralph',
    sourceFamily: 'omc',
    description: 'Self-referential persistence loop until task completion with architect verification',
    phases: ['loop', 'verify', 'completed', 'failed'],
    initialPhase: 'loop',
    terminalPhases: ['completed', 'failed'],
    allowedTransitions: [
      { from: 'loop', to: 'verify' },
      { from: 'loop', to: 'failed' },
      { from: 'verify', to: 'completed' },
      { from: 'verify', to: 'loop' },
    ],
    defaultBudgets: { max_iterations: 50, max_continuations: 100, max_time_ms: 14400000 },
    requiredArtifacts: ['objective', 'architect_signoff'],
    supportsChildTasks: true,
    supportsWorktrees: false,
    failureRouting: {
      maxConsecutiveFailures: 3,
      onRepeatedFailure: 'rework',
    },
  },
  {
    id: 'omc-ultrawork',
    canonicalName: 'OMC Ultrawork',
    sourceFamily: 'omc',
    description: 'High-throughput parallel worker execution across subagents',
    phases: ['dispatch', 'parallel_work', 'collect', 'verify', 'completed', 'failed'],
    initialPhase: 'dispatch',
    terminalPhases: ['completed', 'failed'],
    allowedTransitions: [
      { from: 'dispatch', to: 'parallel_work' },
      { from: 'dispatch', to: 'failed' },
      { from: 'parallel_work', to: 'collect' },
      { from: 'collect', to: 'verify' },
      { from: 'collect', to: 'dispatch' },
      { from: 'verify', to: 'completed' },
      { from: 'verify', to: 'parallel_work' },
      { from: 'verify', to: 'failed' },
    ],
    defaultBudgets: { max_iterations: 20, max_continuations: 40, max_time_ms: 3600000 },
    requiredArtifacts: ['dispatch_manifest', 'work_results'],
    supportsChildTasks: true,
    supportsWorktrees: true,
    failureRouting: {
      maxConsecutiveFailures: 2,
      onRepeatedFailure: 'specialist',
      specialistRole: 'debugger',
    },
  },
  {
    id: 'omc-ultraqa',
    canonicalName: 'OMC UltraQA',
    sourceFamily: 'omc',
    description: 'Adversarial dynamic QA cycle: scenario generation, execution, bug verification, and fix verification',
    phases: ['scenario_gen', 'test', 'verify', 'fix', 'completed', 'failed'],
    initialPhase: 'scenario_gen',
    terminalPhases: ['completed', 'failed'],
    allowedTransitions: [
      { from: 'scenario_gen', to: 'test' },
      { from: 'scenario_gen', to: 'failed' },
      { from: 'test', to: 'verify' },
      { from: 'verify', to: 'fix' },
      { from: 'verify', to: 'completed' },
      { from: 'fix', to: 'test' },
      { from: 'fix', to: 'failed' },
    ],
    defaultBudgets: { max_iterations: 25, max_continuations: 50, max_time_ms: 7200000 },
    requiredArtifacts: ['qa_scenarios', 'test_results', 'qa_verdict'],
    supportsChildTasks: true,
    supportsWorktrees: true,
    failureRouting: {
      maxConsecutiveFailures: 3,
      onRepeatedFailure: 'rework',
    },
  },
  {
    id: 'omc-pipeline',
    canonicalName: 'OMC Pipeline',
    sourceFamily: 'omc',
    description: 'Configurable multi-stage pipeline with strict stage barriers',
    phases: ['plan', 'implement', 'verify', 'accept', 'completed', 'failed'],
    initialPhase: 'plan',
    terminalPhases: ['completed', 'failed'],
    allowedTransitions: [
      { from: 'plan', to: 'implement' },
      { from: 'plan', to: 'failed' },
      { from: 'implement', to: 'verify' },
      { from: 'verify', to: 'accept' },
      { from: 'verify', to: 'implement' },
      { from: 'accept', to: 'completed' },
      { from: 'accept', to: 'plan' },
    ],
    defaultBudgets: { max_iterations: 15, max_continuations: 30, max_time_ms: 3600000 },
    requiredArtifacts: ['pipeline_plan', 'stage_receipts'],
    supportsChildTasks: true,
    supportsWorktrees: true,
    failureRouting: {
      maxConsecutiveFailures: 2,
      onRepeatedFailure: 'terminal_failure',
    },
  },
  {
    id: 'omc-persistent-todo',
    canonicalName: 'OMC Persistent Todo',
    sourceFamily: 'omc',
    description: 'Todo-driven continuation loop until all tasks marked completed with evidence',
    phases: ['todo_select', 'execute', 'verify_step', 'completed', 'failed'],
    initialPhase: 'todo_select',
    terminalPhases: ['completed', 'failed'],
    allowedTransitions: [
      { from: 'todo_select', to: 'execute' },
      { from: 'todo_select', to: 'completed' },
      { from: 'execute', to: 'verify_step' },
      { from: 'verify_step', to: 'todo_select' },
      { from: 'verify_step', to: 'execute' },
      { from: 'execute', to: 'failed' },
    ],
    defaultBudgets: { max_iterations: 40, max_continuations: 80, max_time_ms: 10800000 },
    requiredArtifacts: ['todo_list', 'step_evidence'],
    supportsChildTasks: true,
    supportsWorktrees: false,
    failureRouting: {
      maxConsecutiveFailures: 3,
      onRepeatedFailure: 'rework',
    },
  },

  // --- OMX Profiles ---
  {
    id: 'omx-goal',
    canonicalName: 'OMX Goal',
    sourceFamily: 'omx',
    description: 'Goal-driven execution with explicit acceptance criteria and milestone checkpoints',
    phases: ['goal_intake', 'milestone_execute', 'acceptance_gate', 'completed', 'failed'],
    initialPhase: 'goal_intake',
    terminalPhases: ['completed', 'failed'],
    allowedTransitions: [
      { from: 'goal_intake', to: 'milestone_execute' },
      { from: 'goal_intake', to: 'failed' },
      { from: 'milestone_execute', to: 'acceptance_gate' },
      { from: 'acceptance_gate', to: 'completed' },
      { from: 'acceptance_gate', to: 'milestone_execute' },
      { from: 'acceptance_gate', to: 'failed' },
    ],
    defaultBudgets: { max_iterations: 20, max_continuations: 50, max_time_ms: 7200000 },
    requiredArtifacts: ['goal_contract', 'acceptance_evidence'],
    supportsChildTasks: true,
    supportsWorktrees: true,
    failureRouting: {
      maxConsecutiveFailures: 3,
      onRepeatedFailure: 'human_blocker',
    },
  },
  {
    id: 'omx-ultragoal',
    canonicalName: 'OMX Ultragoal',
    sourceFamily: 'omx',
    description: 'Durable multi-goal stories and checkpoints with consensus review and ledger tracking',
    phases: ['story_breakdown', 'checkpoint_execute', 'consensus_review', 'completed', 'failed'],
    initialPhase: 'story_breakdown',
    terminalPhases: ['completed', 'failed'],
    allowedTransitions: [
      { from: 'story_breakdown', to: 'checkpoint_execute' },
      { from: 'story_breakdown', to: 'failed' },
      { from: 'checkpoint_execute', to: 'consensus_review' },
      { from: 'consensus_review', to: 'checkpoint_execute' },
      { from: 'consensus_review', to: 'completed' },
      { from: 'consensus_review', to: 'failed' },
    ],
    defaultBudgets: { max_iterations: 30, max_continuations: 60, max_time_ms: 10800000 },
    requiredArtifacts: ['story_ledger', 'checkpoint_receipts'],
    supportsChildTasks: true,
    supportsWorktrees: true,
    failureRouting: {
      maxConsecutiveFailures: 3,
      onRepeatedFailure: 'replan',
    },
  },
  {
    id: 'omx-ralplan',
    canonicalName: 'OMX Ralplan',
    sourceFamily: 'omx',
    description: 'Plan consensus FSM: propose -> critic challenge -> revise -> verifier handoff',
    phases: ['propose', 'critic', 'revise', 'verifier_handoff', 'approved', 'failed'],
    initialPhase: 'propose',
    terminalPhases: ['approved', 'failed'],
    allowedTransitions: [
      { from: 'propose', to: 'critic' },
      { from: 'propose', to: 'failed' },
      { from: 'critic', to: 'revise' },
      { from: 'revise', to: 'verifier_handoff' },
      { from: 'revise', to: 'critic' },
      { from: 'verifier_handoff', to: 'approved' },
      { from: 'verifier_handoff', to: 'revise' },
      { from: 'verifier_handoff', to: 'failed' },
    ],
    defaultBudgets: { max_iterations: 10, max_continuations: 20, max_time_ms: 1800000 },
    requiredArtifacts: ['plan_proposal', 'critic_evaluation', 'consensus_plan'],
    supportsChildTasks: false,
    supportsWorktrees: false,
    failureRouting: {
      maxConsecutiveFailures: 2,
      onRepeatedFailure: 'human_blocker',
    },
  },
  {
    id: 'omx-ralph',
    canonicalName: 'OMX Ralph',
    sourceFamily: 'omx',
    description: 'OMX persistence loop with evaluator gating and architect review',
    phases: ['iteration', 'architect_check', 'completed', 'failed'],
    initialPhase: 'iteration',
    terminalPhases: ['completed', 'failed'],
    allowedTransitions: [
      { from: 'iteration', to: 'architect_check' },
      { from: 'iteration', to: 'failed' },
      { from: 'architect_check', to: 'completed' },
      { from: 'architect_check', to: 'iteration' },
    ],
    defaultBudgets: { max_iterations: 50, max_continuations: 100, max_time_ms: 14400000 },
    requiredArtifacts: ['objective', 'architect_verdict'],
    supportsChildTasks: true,
    supportsWorktrees: false,
    failureRouting: {
      maxConsecutiveFailures: 3,
      onRepeatedFailure: 'rework',
    },
  },
  {
    id: 'omx-team',
    canonicalName: 'OMX Team',
    sourceFamily: 'omx',
    description: 'Team story execution across dedicated worker roles with story admittance and sync gates',
    phases: ['team_admit', 'story_dispatch', 'worker_sync', 'team_collect', 'completed', 'failed'],
    initialPhase: 'team_admit',
    terminalPhases: ['completed', 'failed'],
    allowedTransitions: [
      { from: 'team_admit', to: 'story_dispatch' },
      { from: 'team_admit', to: 'failed' },
      { from: 'story_dispatch', to: 'worker_sync' },
      { from: 'worker_sync', to: 'team_collect' },
      { from: 'team_collect', to: 'completed' },
      { from: 'team_collect', to: 'story_dispatch' },
      { from: 'team_collect', to: 'failed' },
    ],
    defaultBudgets: { max_iterations: 25, max_continuations: 50, max_time_ms: 7200000 },
    requiredArtifacts: ['team_roster', 'story_assignments', 'team_receipts'],
    supportsChildTasks: true,
    supportsWorktrees: true,
    failureRouting: {
      maxConsecutiveFailures: 3,
      onRepeatedFailure: 'replan',
    },
  },
  {
    id: 'omx-research-goal',
    canonicalName: 'OMX Research Goal',
    sourceFamily: 'omx',
    description: 'Hypothesis-driven research iterations producing validated synthesis artifacts',
    phases: ['hypothesis', 'deep_search', 'evidence_gather', 'synthesis', 'completed', 'failed'],
    initialPhase: 'hypothesis',
    terminalPhases: ['completed', 'failed'],
    allowedTransitions: [
      { from: 'hypothesis', to: 'deep_search' },
      { from: 'hypothesis', to: 'failed' },
      { from: 'deep_search', to: 'evidence_gather' },
      { from: 'evidence_gather', to: 'synthesis' },
      { from: 'synthesis', to: 'completed' },
      { from: 'synthesis', to: 'deep_search' },
    ],
    defaultBudgets: { max_iterations: 15, max_continuations: 30, max_time_ms: 3600000 },
    requiredArtifacts: ['hypothesis_memo', 'research_evidence', 'synthesis_brief'],
    supportsChildTasks: true,
    supportsWorktrees: false,
    failureRouting: {
      maxConsecutiveFailures: 2,
      onRepeatedFailure: 'rework',
    },
  },

  // --- OMO Profiles ---
  {
    id: 'omo-boulder',
    canonicalName: 'OMO Boulder',
    sourceFamily: 'omo',
    description: 'Start-work bootstrap and persistent boulder forward momentum ("the boulder never stops")',
    phases: ['start_work', 'momentum_loop', 'checkpoint', 'completed', 'failed'],
    initialPhase: 'start_work',
    terminalPhases: ['completed', 'failed'],
    allowedTransitions: [
      { from: 'start_work', to: 'momentum_loop' },
      { from: 'start_work', to: 'failed' },
      { from: 'momentum_loop', to: 'checkpoint' },
      { from: 'checkpoint', to: 'momentum_loop' },
      { from: 'checkpoint', to: 'completed' },
      { from: 'checkpoint', to: 'failed' },
    ],
    defaultBudgets: { max_iterations: 50, max_continuations: 100, max_time_ms: 14400000 },
    requiredArtifacts: ['boulder_state', 'checkpoint_log'],
    supportsChildTasks: true,
    supportsWorktrees: false,
    failureRouting: {
      maxConsecutiveFailures: 3,
      onRepeatedFailure: 'rework',
    },
  },
  {
    id: 'omo-ulw-loop',
    canonicalName: 'OMO ULW Loop',
    sourceFamily: 'omo',
    description: 'Clean-room ultrawork parallel execution loop with bounded worker concurrency',
    phases: ['fan_out', 'bounded_execute', 'sync_gate', 'completed', 'failed'],
    initialPhase: 'fan_out',
    terminalPhases: ['completed', 'failed'],
    allowedTransitions: [
      { from: 'fan_out', to: 'bounded_execute' },
      { from: 'fan_out', to: 'failed' },
      { from: 'bounded_execute', to: 'sync_gate' },
      { from: 'sync_gate', to: 'completed' },
      { from: 'sync_gate', to: 'fan_out' },
      { from: 'sync_gate', to: 'failed' },
    ],
    defaultBudgets: { max_iterations: 20, max_continuations: 40, max_time_ms: 3600000 },
    requiredArtifacts: ['ulw_roster', 'worker_outputs'],
    supportsChildTasks: true,
    supportsWorktrees: true,
    failureRouting: {
      maxConsecutiveFailures: 2,
      onRepeatedFailure: 'specialist',
      specialistRole: 'debugger',
    },
  },
  {
    id: 'omo-atlas-todo',
    canonicalName: 'OMO Atlas Todo',
    sourceFamily: 'omo',
    description: 'Atlas-style strict atomic todo discipline with pre/post-step audits and single-item execution',
    phases: ['todo_parse', 'atomic_step', 'audit_gate', 'next_todo', 'completed', 'failed'],
    initialPhase: 'todo_parse',
    terminalPhases: ['completed', 'failed'],
    allowedTransitions: [
      { from: 'todo_parse', to: 'atomic_step' },
      { from: 'todo_parse', to: 'completed' },
      { from: 'atomic_step', to: 'audit_gate' },
      { from: 'audit_gate', to: 'next_todo' },
      { from: 'audit_gate', to: 'atomic_step' },
      { from: 'next_todo', to: 'atomic_step' },
      { from: 'next_todo', to: 'completed' },
      { from: 'atomic_step', to: 'failed' },
    ],
    defaultBudgets: { max_iterations: 40, max_continuations: 80, max_time_ms: 10800000 },
    requiredArtifacts: ['atlas_todos', 'step_audits'],
    supportsChildTasks: false,
    supportsWorktrees: false,
    failureRouting: {
      maxConsecutiveFailures: 3,
      onRepeatedFailure: 'rework',
    },
  },
  {
    id: 'omo-steering',
    canonicalName: 'OMO Bounded Steering Excursion',
    sourceFamily: 'omo',
    description: 'Bounded steering excursions for sub-problem investigation without losing main execution thread',
    phases: ['excursion_start', 'sidequest_investigate', 'reconcile', 'return_to_main', 'failed'],
    initialPhase: 'excursion_start',
    terminalPhases: ['return_to_main', 'failed'],
    allowedTransitions: [
      { from: 'excursion_start', to: 'sidequest_investigate' },
      { from: 'excursion_start', to: 'failed' },
      { from: 'sidequest_investigate', to: 'reconcile' },
      { from: 'reconcile', to: 'return_to_main' },
      { from: 'reconcile', to: 'sidequest_investigate' },
      { from: 'reconcile', to: 'failed' },
    ],
    defaultBudgets: { max_iterations: 10, max_continuations: 15, max_time_ms: 1800000 },
    requiredArtifacts: ['excursion_brief', 'reconciliation_report'],
    supportsChildTasks: true,
    supportsWorktrees: true,
    failureRouting: {
      maxConsecutiveFailures: 2,
      onRepeatedFailure: 'replan',
    },
  },
  {
    id: 'omo-closing-briefing',
    canonicalName: 'OMO Closing Briefing',
    sourceFamily: 'omo',
    description: 'Structured closing briefing artifact generation, verification audit, and operator handoff',
    phases: ['audit_state', 'gather_evidence', 'render_briefing', 'handoff', 'completed', 'failed'],
    initialPhase: 'audit_state',
    terminalPhases: ['completed', 'failed'],
    allowedTransitions: [
      { from: 'audit_state', to: 'gather_evidence' },
      { from: 'audit_state', to: 'failed' },
      { from: 'gather_evidence', to: 'render_briefing' },
      { from: 'render_briefing', to: 'handoff' },
      { from: 'handoff', to: 'completed' },
      { from: 'handoff', to: 'audit_state' },
    ],
    defaultBudgets: { max_iterations: 5, max_continuations: 10, max_time_ms: 900000 },
    requiredArtifacts: ['state_audit', 'closing_briefing'],
    supportsChildTasks: false,
    supportsWorktrees: false,
    failureRouting: {
      maxConsecutiveFailures: 2,
      onRepeatedFailure: 'human_blocker',
    },
  },
];

const PROFILE_MAP = new Map<string, WorkflowProfileDefinition>(
  WORKFLOW_PROFILES.map((p) => [p.id, p])
);

// Add aliases without prefix for user convenience
for (const profile of WORKFLOW_PROFILES) {
  const shortId = profile.id.replace(/^(?:omc|omx|omo)-/, '');
  if (!PROFILE_MAP.has(shortId)) {
    PROFILE_MAP.set(shortId, profile);
  }
}

// Canonical aliases explicitly listed in OMC/OMX/OMO requirements
const ALIAS_PAIRS: readonly [string, string][] = [
  // OMC
  ['autopilot', 'omc-autopilot'],
  ['ralph', 'omc-ralph'],
  ['ultrawork', 'omc-ultrawork'],
  ['ultraqa', 'omc-ultraqa'],
  ['pipeline', 'omc-pipeline'],
  ['persistent todo continuation', 'omc-persistent-todo'],
  ['persistent-todo-continuation', 'omc-persistent-todo'],
  ['persistent_todo', 'omc-persistent-todo'],
  // OMX
  ['goal', 'omx-goal'],
  ['ultragoal', 'omx-ultragoal'],
  ['ralplan', 'omx-ralplan'],
  ['ralplan/prometheus handoff', 'omx-ralplan'],
  ['prometheus', 'omx-ralplan'],
  ['prometheus-handoff', 'omx-ralplan'],
  ['omx-ralph', 'omx-ralph'],
  ['team', 'omx-team'],
  ['team story execution', 'omx-team'],
  ['team-story-execution', 'omx-team'],
  ['research-goal', 'omx-research-goal'],
  ['research goals', 'omx-research-goal'],
  ['research-goals', 'omx-research-goal'],
  // OMO
  ['boulder', 'omo-boulder'],
  ['boulder/start-work', 'omo-boulder'],
  ['start-work', 'omo-boulder'],
  ['start_work', 'omo-boulder'],
  ['ulw-loop', 'omo-ulw-loop'],
  ['ultrawork/ulw-loop', 'omo-ulw-loop'],
  ['atlas-todo', 'omo-atlas-todo'],
  ['Atlas-style todo discipline', 'omo-atlas-todo'],
  ['atlas-style-todo-discipline', 'omo-atlas-todo'],
  ['steering', 'omo-steering'],
  ['bounded steering excursions', 'omo-steering'],
  ['bounded-steering-excursions', 'omo-steering'],
  ['closing-briefing', 'omo-closing-briefing'],
  ['closing briefing', 'omo-closing-briefing'],
];

for (const [alias, targetId] of ALIAS_PAIRS) {
  const target = PROFILE_MAP.get(targetId);
  if (target && !PROFILE_MAP.has(alias)) {
    PROFILE_MAP.set(alias, target);
  }
}

export function getSourceProfile(id: string): WorkflowProfileDefinition | undefined {
  if (PROFILE_MAP.has(id)) return PROFILE_MAP.get(id);
  const normalized = id.toLowerCase().trim();
  if (PROFILE_MAP.has(normalized)) return PROFILE_MAP.get(normalized);
  const slug = normalized.replace(/[\s/_-]+/g, '-');
  return PROFILE_MAP.get(slug);
}

export function listSourceProfiles(family?: SourceFamily): readonly WorkflowProfileDefinition[] {
  if (!family) return WORKFLOW_PROFILES;
  return WORKFLOW_PROFILES.filter((p) => p.sourceFamily === family);
}

export function validateProfileTransition(
  profileId: string,
  fromPhase: string,
  toPhase: string
): boolean {
  const profile = getSourceProfile(profileId);
  if (!profile) return false;
  return profile.allowedTransitions.some((t) => t.from === fromPhase && t.to === toPhase);
}

export function getNextProfilePhase(
  profileId: string,
  currentPhase: string
): string | null {
  const profile = getSourceProfile(profileId);
  if (!profile) return null;
  const match = profile.allowedTransitions.find(
    (t) => t.from === currentPhase && !profile.terminalPhases.includes(t.to)
  );
  return match?.to ?? null;
}
