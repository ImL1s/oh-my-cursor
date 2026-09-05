import { assertExclusivePathClaims } from '../modes/path-claims.js';
import type { DagRank, DagTaskSpec } from './types.js';

export function validateRankEditOwnership(
  ranks: readonly DagRank[],
  defaultWorkspace: string
): void {
  for (const rank of ranks) {
    // Group tasks in this rank by their target workspace/worktree
    const workspaceGroups = new Map<string, DagTaskSpec[]>();

    for (const task of rank.tasks) {
      // If task specifies its own isolated worktree, it has its own isolated filesystem
      const effectiveLocation = task.worktree ?? task.workspace ?? defaultWorkspace;
      const group = workspaceGroups.get(effectiveLocation) ?? [];
      group.push(task);
      workspaceGroups.set(effectiveLocation, group);
    }

    // Check each group where tasks share the exact same filesystem location
    for (const [location, tasksAtLocation] of workspaceGroups.entries()) {
      const editingTasks = tasksAtLocation.filter(
        (t) => t.ownedPaths && t.ownedPaths.length > 0
      );
      if (editingTasks.length <= 1) continue;

      // Validate that the path claims among concurrent siblings do not overlap
      const claims = editingTasks.map((t) => ({
        ownerId: t.id,
        paths: t.ownedPaths!,
      }));

      assertExclusivePathClaims(claims, {
        invalid: `E_DAG_OWNERSHIP_PATH_INVALID: invalid path claim in rank ${rank.rankIndex}`,
        conflict: (owner, claimant) =>
          `E_DAG_OWNERSHIP_CONFLICT: concurrent editing tasks '${owner}' and '${claimant}' in rank ${rank.rankIndex} have overlapping owned paths at ${location}`,
      });
    }
  }
}
