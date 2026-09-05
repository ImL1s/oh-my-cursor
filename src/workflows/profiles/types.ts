export type SourceFamily = 'omc' | 'omx' | 'omo';

export type OmcProfileId =
  | 'omc-autopilot'
  | 'omc-ralph'
  | 'omc-ultrawork'
  | 'omc-ultraqa'
  | 'omc-pipeline'
  | 'omc-persistent-todo';

export type OmxProfileId =
  | 'omx-goal'
  | 'omx-ultragoal'
  | 'omx-ralplan'
  | 'omx-ralph'
  | 'omx-team'
  | 'omx-research-goal';

export type OmoProfileId =
  | 'omo-boulder'
  | 'omo-ulw-loop'
  | 'omo-atlas-todo'
  | 'omo-steering'
  | 'omo-closing-briefing';

export type SourceProfileId = OmcProfileId | OmxProfileId | OmoProfileId | (string & {});

export interface PhaseTransition {
  readonly from: string;
  readonly to: string;
}

export interface ProfileBudgets {
  readonly max_iterations: number;
  readonly max_continuations: number;
  readonly max_time_ms?: number | undefined;
}

export interface WorkflowProfileDefinition {
  readonly id: SourceProfileId;
  readonly canonicalName: string;
  readonly sourceFamily: SourceFamily;
  readonly description: string;
  readonly phases: readonly string[];
  readonly initialPhase: string;
  readonly terminalPhases: readonly string[];
  readonly allowedTransitions: readonly PhaseTransition[];
  readonly defaultBudgets: ProfileBudgets;
  readonly requiredArtifacts: readonly string[];
  readonly supportsChildTasks: boolean;
  readonly supportsWorktrees: boolean;
  readonly failureRouting: {
    readonly maxConsecutiveFailures: number;
    readonly onRepeatedFailure: 'rework' | 'replan' | 'specialist' | 'human_blocker' | 'terminal_failure';
    readonly specialistRole?: string | undefined;
  };
}
