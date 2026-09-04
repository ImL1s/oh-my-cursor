import fs from 'node:fs';
import path from 'node:path';
import { withDirectoryLock } from '../runtime/atomic.js';
import { Journal } from '../runtime/journal.js';
import { redact } from '../runtime/redaction.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';

export type LifecyclePhase = 'created' | 'started' | 'checkpointed' | 'completed' | 'failed' | 'cancelled';
export interface LifecycleEvent { readonly schema_version: 1; readonly subject_id: string; readonly sequence: number; readonly phase: LifecyclePhase; readonly detail: unknown; readonly at: string }
const transitions: Record<LifecyclePhase, readonly LifecyclePhase[]> = {
  created: ['started', 'cancelled'], started: ['checkpointed', 'completed', 'failed', 'cancelled'], checkpointed: ['checkpointed', 'completed', 'failed', 'cancelled'], completed: [], failed: [], cancelled: [],
};
function safe(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('E_TRACKER_SUBJECT_INVALID'); return value; }

export class LifecycleTracker {
  constructor(private readonly root: StateRoot, private readonly now: () => Date = () => new Date()) {}
  private file(id: string): string { return withinStateRoot(this.root, 'tracker', `${safe(id)}.jsonl`); }
  private journalDir(id: string): string { return withinStateRoot(this.root, 'tracker', 'journals', safe(id)); }
  private journal(id: string): Journal<LifecycleEvent> {
    return new Journal<LifecycleEvent>(this.journalDir(id), `tracker/${safe(id)}`, { now: this.now });
  }

  private migrateLegacy(id: string, journal: Journal<LifecycleEvent>): void {
    const file = this.file(id);
    if (!fs.existsSync(file)) return;
    const head = journal.readHead();
    if (head !== null && head.head_sequence > 0) return;
    journal.init();
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as LifecycleEvent;
        journal.append({ kind: parsed.phase, payload: parsed, at: parsed.at });
      } catch {
        // ignore
      }
    }
  }

  history(id: string): LifecycleEvent[] {
    const journal = this.journal(id);
    this.migrateLegacy(id, journal);
    const head = journal.readHead();
    if (head !== null && head.head_sequence > 0) {
      return journal.readRange().map((r) => r.payload);
    }
    const file = this.file(id);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as LifecycleEvent);
  }

  async record(id: string, phase: LifecyclePhase, detail: unknown = {}): Promise<LifecycleEvent> {
    if (!(phase in transitions)) throw new Error('E_TRACKER_PHASE_INVALID');
    const file = this.file(id);
    const journal = this.journal(id);
    return withDirectoryLock(file, async () => {
      this.migrateLegacy(id, journal);
      const last = journal.tail(1)[0];
      const previous = last ? last.payload.phase : undefined;
      if ((previous === undefined && phase !== 'created') || (previous !== undefined && !transitions[previous].includes(phase))) {
        throw new Error('E_TRACKER_TRANSITION_INVALID');
      }
      const head = journal.readHead();
      const currentSeq = head?.head_sequence ?? 0;
      if (currentSeq >= 10_000) throw new Error('E_TRACKER_LIMIT');

      const event: LifecycleEvent = {
        schema_version: 1,
        subject_id: safe(id),
        sequence: currentSeq + 1,
        phase,
        detail: redact(detail),
        at: this.now().toISOString(),
      };

      await journal.append({ kind: phase, payload: event, at: event.at });

      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      return event;
    });
  }
}
