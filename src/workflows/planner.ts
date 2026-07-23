import { deepFreeze, digestObject, type WorkflowDefinition, type WorkflowPlan } from './schema.js';

export function planWorkflow(definition: WorkflowDefinition, runId: string, objective: string): WorkflowPlan {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || objective.trim() === '' || objective.length > 16_384) throw new Error('E_WORKFLOW_PLAN_INPUT_INVALID');
  const tasks = definition.stages.map((stage, index) => ({ task_id: `${index + 1}-${stage.id}`, stage_id: stage.id, declaration_index: index, depends_on: stage.depends_on.map((dependency) => `${definition.stages.findIndex((candidate) => candidate.id === dependency) + 1}-${dependency}`) }));
  const material = { schema_version: 1 as const, run_id: runId, workflow_name: definition.name, workflow_version: definition.version, definition_sha256: definition.definition_sha256, objective, tasks };
  return deepFreeze({ ...material, plan_sha256: digestObject(material) });
}
