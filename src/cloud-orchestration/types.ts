export interface CloudHandoff {
  readonly handoffId: string;
  readonly fromTaskId: string;
  readonly toTaskId: string;
  readonly role: 'worker' | 'verifier' | 'subplanner';
  readonly branch?: string | undefined;
  readonly prUrl?: string | undefined;
  readonly summary: string;
  readonly artifacts: readonly string[];
  readonly verdict?: {
    readonly passed: boolean;
    readonly feedback?: string | undefined;
    readonly issues?: readonly string[] | undefined;
  } | undefined;
  readonly createdAt: string;
}

export interface CloudPlannedTask {
  readonly taskId: string;
  readonly title: string;
  readonly role: string;
  readonly profile?: string | undefined;
  readonly scope: string;
  readonly isolatedBranch?: string | undefined;
  readonly prompt: string;
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'verified' | 'cancelled';
  readonly cloudAgentId?: string | undefined;
  readonly cloudRunId?: string | undefined;
  readonly prUrl?: string | undefined;
  readonly workerHandoff?: CloudHandoff | undefined;
  readonly verifierHandoff?: CloudHandoff | undefined;
  readonly subplannerDepth: number;
  readonly completedAt?: string | undefined;
}

export interface CreateCloudTaskInput {
  readonly taskId?: string | undefined;
  readonly title: string;
  readonly role: string;
  readonly profile?: string | undefined;
  readonly scope: string;
  readonly isolatedBranch?: string | undefined;
  readonly prompt: string;
  readonly subplannerDepth?: number | undefined;
}

export interface CloudPlan {
  readonly schema_version: 1;
  readonly planId: string;
  readonly goal: string;
  readonly plannerId: string;
  readonly plannerAgentId?: string | undefined;
  readonly plannerRunId?: string | undefined;
  readonly tasks: readonly CloudPlannedTask[];
  readonly status:
    | 'planning'
    | 'executing'
    | 'verifying'
    | 'completed'
    | 'failed'
    | 'replanning'
    | 'cancelled';
  readonly verifierTaskId?: string | undefined;
  readonly lateHandoffs?: readonly CloudHandoff[] | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CloudOrchestratorOptions {
  readonly maxDelegationDepth?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => Date) | undefined;
}
