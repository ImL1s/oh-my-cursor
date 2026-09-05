export interface WorkflowGoalInput {
  readonly goal: string;
  readonly phase?: string | undefined;
  readonly tags?: readonly string[] | undefined;
}

export interface ArtifactRecordInput {
  readonly category: string;
  readonly name: string;
  readonly content: string;
  readonly mimeType?: string | undefined;
}

export interface AgentInspectQuery {
  readonly agentId?: string | undefined;
  readonly runId?: string | undefined;
}
