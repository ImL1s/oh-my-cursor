import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteText, withDirectoryLock } from '../runtime/atomic.js';
import { Journal } from '../runtime/journal.js';
import { redact } from '../runtime/redaction.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';

export type LifecyclePhase = 'created' | 'started' | 'checkpointed' | 'completed' | 'failed' | 'cancelled';
export interface LifecycleEvent { readonly schema_version: 1; readonly subject_id: string; readonly sequence: number; readonly phase: LifecyclePhase; readonly detail: unknown; readonly at: string }
const transitions: Record<LifecyclePhase, readonly LifecyclePhase[]> = {
  created: ['started', 'cancelled'], started: ['checkpointed', 'completed', 'failed', 'cancelled'], checkpointed: ['checkpointed', 'completed', 'failed', 'cancelled'], completed: [], failed: [], cancelled: [],
};
function safe(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('E_TRACKER_SUBJECT_INVALID'); return value; }

export const TRACKER_JOURNAL_MAX_RECORD_BYTES = 128 * 1024; // 128 KiB covers up to 64 KiB detail payload + envelope overhead
export const TRACKER_JOURNAL_MAX_SEGMENT_BYTES = 4 * 1024 * 1024; // 4 MiB

export class LifecycleTracker {
  constructor(private readonly root: StateRoot, private readonly now: () => Date = () => new Date()) {}
  private file(id: string): string { return withinStateRoot(this.root, 'tracker', `${safe(id)}.jsonl`); }
  private journalDir(id: string): string { return withinStateRoot(this.root, 'tracker', 'journals', safe(id)); }
  private journal(id: string): Journal<LifecycleEvent> {
    return new Journal<LifecycleEvent>(this.journalDir(id), `tracker/${safe(id)}`, {
      now: this.now,
      maxRecordBytes: TRACKER_JOURNAL_MAX_RECORD_BYTES,
      maxSegmentBytes: TRACKER_JOURNAL_MAX_SEGMENT_BYTES,
    });
  }

  private isMigrated(id: string): boolean {
    const marker = path.join(this.journalDir(id), '.migrated');
    return fs.existsSync(marker);
  }

  private markMigrated(id: string): void {
    const dir = this.journalDir(id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const marker = path.join(dir, '.migrated');
    if (!fs.existsSync(marker)) {
      try {
        atomicWriteText(marker, '', { mode: 0o600 });
      } catch {}
    }
  }

  private readLegacyEvents(file: string): LifecycleEvent[] {
    if (!fs.existsSync(file)) return [];
    try {
      if (!fs.statSync(file).isFile()) return [];
    } catch {
      return [];
    }
    const content = fs.readFileSync(file, 'utf8').trim();
    if (!content) return [];
    const lines = content.split(/\r?\n/).filter(Boolean);
    return lines.map((line) => {
      let parsed: LifecycleEvent;
      try {
        parsed = JSON.parse(line) as LifecycleEvent;
      } catch (error) {
        throw new Error('E_TRACKER_CORRUPT', { cause: error });
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.phase !== 'string' ||
        !(parsed.phase in transitions) ||
        typeof parsed.sequence !== 'number'
      ) {
        throw new Error('E_TRACKER_CORRUPT');
      }
      return parsed;
    });
  }

  private async migrateLegacy(id: string, journal: Journal<LifecycleEvent>): Promise<void> {
    if (this.isMigrated(id)) return;
    const file = this.file(id);
    if (!fs.existsSync(file)) {
      this.markMigrated(id);
      return;
    }
    try {
      if (!fs.statSync(file).isFile()) {
        this.markMigrated(id);
        return;
      }
    } catch {
      return;
    }

    const head = journal.readHead();
    let events: LifecycleEvent[];
    try {
      events = this.readLegacyEvents(file);
    } catch (error) {
      if (head !== null && head.head_sequence > 0) {
        this.markMigrated(id);
        return;
      }
      throw error;
    }

    if (events.length === 0) {
      this.markMigrated(id);
      return;
    }

    const startIndex = head !== null ? head.head_sequence : 0;
    if (startIndex < events.length) {
      if (head === null) {
        journal.init();
      }
      for (let i = startIndex; i < events.length; i++) {
        const event = events[i]!;
        try {
          await journal.append({ kind: event.phase, payload: event, at: event.at });
        } catch (error) {
          throw new Error('E_TRACKER_CORRUPT', { cause: error });
        }
      }
    }
    this.markMigrated(id);
  }

  history(id: string): LifecycleEvent[] {
    const journal = this.journal(id);
    const head = journal.readHead();
    if (this.isMigrated(id)) {
      return journal.readRange().map((r) => r.payload);
    }

    const file = this.file(id);
    let legacyEvents: LifecycleEvent[] = [];
    if (fs.existsSync(file)) {
      try {
        if (fs.statSync(file).isFile()) {
          legacyEvents = this.readLegacyEvents(file);
        }
      } catch (error) {
        if (head !== null && head.head_sequence > 0) {
          return journal.readRange().map((r) => r.payload);
        }
        throw error;
      }
    }
    const shouldLoadJournal =
      head !== null &&
      head.head_sequence > 0 &&
      (legacyEvents.length === 0 || head.head_sequence >= legacyEvents.length);

    if (shouldLoadJournal) {
      return journal.readRange().map((r) => r.payload);
    }
    return legacyEvents;
  }

  async record(id: string, phase: LifecyclePhase, detail: unknown = {}): Promise<LifecycleEvent> {
    if (!(phase in transitions)) throw new Error('E_TRACKER_PHASE_INVALID');
    const file = this.file(id);
    const journal = this.journal(id);
    return withDirectoryLock(file, async () => {
      await this.migrateLegacy(id, journal);
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

      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
        fs.chmodSync(file, 0o600);
      } catch {
        // Non-authoritative legacy mirror write is best-effort after authoritative journal append
      }
      return event;
    });
  }
}
