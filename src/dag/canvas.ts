import type { TaskRecord } from '../tasks/types.js';
import type { DagDefinition, DagRank } from './types.js';

export function renderDagCanvas(
  dag: DagDefinition,
  ranks: readonly DagRank[],
  taskRecords: Record<string, TaskRecord | { status: string; role?: string }>
): string {
  const lines: string[] = [];
  lines.push(`=== DAG Canvas: ${dag.dagId} ===`);
  if (dag.description) {
    lines.push(`Description: ${dag.description}`);
  }
  lines.push('');

  const statusIcons: Record<string, string> = {
    pending: '[ ]',
    running: '[⏳]',
    completed: '[✓]',
    failed: '[✗]',
    cancelled: '[⊘]',
    blocked: '[🛑]',
    skipped: '[⏭]',
  };

  for (const rank of ranks) {
    lines.push(`Rank ${rank.rankIndex}:`);
    for (const task of rank.tasks) {
      const record = taskRecords[task.id];
      const status = record?.status ?? 'pending';
      const icon = statusIcons[status] ?? '[?]';
      const deps = task.dependencies && task.dependencies.length > 0
        ? ` <- [${task.dependencies.join(', ')}]`
        : '';
      const roleStr = task.role ? ` role=${task.role}` : '';
      lines.push(`  ${icon} ${task.id}:${roleStr} (${status})${deps}`);
    }
    lines.push('');
  }

  lines.push('===============================');
  return lines.join('\n');
}
