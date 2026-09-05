import type { DagTaskSpec } from './types.js';

export const DEFAULT_MAX_UPSTREAM_CHARS = 2048;

export interface UpstreamHandoffContext {
  readonly taskId: string;
  readonly role: string;
  readonly output: string;
}

/**
 * Stitches bounded upstream context into a downstream DAG task's prompt.
 *
 * Strict invariants:
 * 1. Independent children inherit NO raw parent or sibling conversation turns.
 * 2. Stitched upstream text is bounded by maxChars per upstream dependency.
 * 3. Full parent transcripts are never passed.
 */
export function stitchBoundedUpstreamContext(
  task: DagTaskSpec,
  upstreamOutputs: Map<string, { role: string; output: string }>,
  maxChars = DEFAULT_MAX_UPSTREAM_CHARS
): string {
  if (!task.dependencies || task.dependencies.length === 0) {
    return task.prompt;
  }

  const stitchedBlocks: string[] = [];

  for (const depId of task.dependencies) {
    const upstream = upstreamOutputs.get(depId);
    if (!upstream) continue;

    const bounded = upstream.output.length > maxChars
      ? `${upstream.output.slice(0, maxChars)}\n[... output truncated to ${maxChars} chars ...]`
      : upstream.output;

    stitchedBlocks.push(
      `--- [Bounded Upstream Output: Task '${depId}' (${upstream.role})] ---\n${bounded}\n--- [End Upstream Output: '${depId}'] ---`
    );
  }

  if (stitchedBlocks.length === 0) {
    return task.prompt;
  }

  return `${stitchedBlocks.join('\n\n')}\n\nTask Instructions:\n${task.prompt}`;
}
