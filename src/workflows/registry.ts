import { deepFreeze, validateWorkflowDefinition, type WorkflowDefinition } from './schema.js';

export class WorkflowRegistry {
  private readonly definitions = new Map<string, WorkflowDefinition>();

  register(raw: Omit<WorkflowDefinition, 'definition_sha256'> & { readonly definition_sha256?: string }): WorkflowDefinition {
    const definition = validateWorkflowDefinition(raw);
    const key = `${definition.name}@${definition.version}`;
    const existing = this.definitions.get(key);
    if (existing !== undefined && existing.definition_sha256 !== definition.definition_sha256) throw new Error('E_WORKFLOW_VERSION_IMMUTABLE');
    if (existing === undefined) this.definitions.set(key, definition);
    return existing ?? definition;
  }

  get(name: string, version: string): WorkflowDefinition {
    const definition = this.definitions.get(`${name}@${version}`);
    if (definition === undefined) throw new Error('E_WORKFLOW_NOT_FOUND');
    return definition;
  }

  list(): readonly WorkflowDefinition[] {
    return deepFreeze([...this.definitions.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)));
  }
}
