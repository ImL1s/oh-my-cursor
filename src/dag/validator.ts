import type { DagDefinition, DagRank, DagTaskSpec } from './types.js';

export interface DagValidationResult {
  readonly ranks: readonly DagRank[];
  readonly topologicalOrder: readonly string[];
}

export function validateDag(dag: DagDefinition): DagValidationResult {
  if (!dag.tasks || dag.tasks.length === 0) {
    throw new Error('E_DAG_EMPTY: dag has no tasks');
  }

  const taskMap = new Map<string, DagTaskSpec>();
  for (const task of dag.tasks) {
    if (!task.id || task.id.trim() === '') {
      throw new Error('E_DAG_TASK_ID_INVALID: task id must be a non-empty string');
    }
    if (taskMap.has(task.id)) {
      throw new Error(`E_DAG_DUPLICATE_TASK_ID: duplicate task id '${task.id}'`);
    }
    taskMap.set(task.id, task);
  }

  // Validate dependencies existence and self-dependency
  for (const task of dag.tasks) {
    if (task.dependencies) {
      for (const dep of task.dependencies) {
        if (dep === task.id) {
          throw new Error(`E_DAG_SELF_DEPENDENCY: task '${task.id}' cannot depend on itself`);
        }
        if (!taskMap.has(dep)) {
          throw new Error(`E_DAG_DEPENDENCY_NOT_FOUND: task '${task.id}' depends on missing task '${dep}'`);
        }
      }
    }
  }

  // Cycle detection with DFS
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(taskId: string, pathStack: string[]): void {
    visited.add(taskId);
    recStack.add(taskId);
    pathStack.push(taskId);

    const task = taskMap.get(taskId)!;
    if (task.dependencies) {
      for (const dep of task.dependencies) {
        if (!visited.has(dep)) {
          dfs(dep, pathStack);
        } else if (recStack.has(dep)) {
          const cycleStr = [...pathStack.slice(pathStack.indexOf(dep)), dep].join(' -> ');
          throw new Error(`E_DAG_CYCLE: cycle detected: ${cycleStr}`);
        }
      }
    }

    recStack.delete(taskId);
    pathStack.pop();
  }

  for (const taskId of taskMap.keys()) {
    if (!visited.has(taskId)) {
      dfs(taskId, []);
    }
  }

  // Compute topological ranks
  // rank(T) = 0 if no dependencies, else 1 + max(rank(dep) for dep in T.dependencies)
  const rankMap = new Map<string, number>();

  function computeRank(taskId: string): number {
    if (rankMap.has(taskId)) {
      return rankMap.get(taskId)!;
    }
    const task = taskMap.get(taskId)!;
    if (!task.dependencies || task.dependencies.length === 0) {
      rankMap.set(taskId, 0);
      return 0;
    }
    let maxDepRank = -1;
    for (const dep of task.dependencies) {
      maxDepRank = Math.max(maxDepRank, computeRank(dep));
    }
    const myRank = maxDepRank + 1;
    rankMap.set(taskId, myRank);
    return myRank;
  }

  for (const taskId of taskMap.keys()) {
    computeRank(taskId);
  }

  // Group by rank
  const maxRank = Math.max(...rankMap.values());
  const ranks: DagRank[] = [];
  const topologicalOrder: string[] = [];

  for (let r = 0; r <= maxRank; r++) {
    const tasksInRank: DagTaskSpec[] = [];
    for (const [id, rankVal] of rankMap.entries()) {
      if (rankVal === r) {
        const spec = taskMap.get(id)!;
        tasksInRank.push(spec);
        topologicalOrder.push(id);
      }
    }
    ranks.push({
      rankIndex: r,
      tasks: tasksInRank,
    });
  }

  return {
    ranks,
    topologicalOrder,
  };
}
