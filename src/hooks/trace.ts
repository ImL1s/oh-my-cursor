import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectStatePath } from '../runtime/state-root.js';
import type { HookTraceEntry } from './types.js';

const IN_MEMORY_TRACES: HookTraceEntry[] = [];
const MAX_MEMORY_TRACES = 500;

export function recordHookTrace(entry: HookTraceEntry, cwd?: string): void {
  IN_MEMORY_TRACES.push(entry);
  if (IN_MEMORY_TRACES.length > MAX_MEMORY_TRACES) {
    IN_MEMORY_TRACES.shift();
  }

  if (cwd) {
    try {
      const stateDir = resolveProjectStatePath(cwd);
      if (fs.existsSync(stateDir)) {
        const hooksDir = path.join(stateDir, 'hooks');
        if (!fs.existsSync(hooksDir)) {
          fs.mkdirSync(hooksDir, { recursive: true });
        }
        const traceFile = path.join(hooksDir, 'trace.jsonl');
        fs.appendFileSync(traceFile, `${JSON.stringify(entry)}\n`, 'utf8');
      }
    } catch {
      // Trace logging must never fail the execution
    }
  }
}

export function getHookTraces(runId?: string, cwd?: string): readonly HookTraceEntry[] {
  const traces: HookTraceEntry[] = [];

  // If cwd provided, try reading from disk first
  if (cwd) {
    try {
      const traceFile = path.join(resolveProjectStatePath(cwd), 'hooks', 'trace.jsonl');
      if (fs.existsSync(traceFile)) {
        const lines = fs.readFileSync(traceFile, 'utf8').split('\n');
        for (const line of lines) {
          if (line.trim() !== '') {
            try {
              const entry = JSON.parse(line) as HookTraceEntry;
              if (!runId || entry.runId === runId) {
                traces.push(entry);
              }
            } catch {
              // Ignore corrupt lines
            }
          }
        }
      }
    } catch {
      // Fall through to memory
    }
  }

  // Combine with in-memory traces avoiding duplicates by ID
  const seenIds = new Set(traces.map((t) => t.id));
  for (const entry of IN_MEMORY_TRACES) {
    if ((!runId || entry.runId === runId) && !seenIds.has(entry.id)) {
      traces.push(entry);
      seenIds.add(entry.id);
    }
  }

  return traces;
}

export function clearInMemoryTraces(): void {
  IN_MEMORY_TRACES.length = 0;
}
