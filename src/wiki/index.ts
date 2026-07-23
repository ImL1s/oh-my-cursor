import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, withDirectoryLock } from '../runtime/atomic.js';
import { redact, redactText } from '../runtime/redaction.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';
import type { LifecycleEvent } from '../tracker/index.js';

export interface WikiPage { readonly schema_version: 1; readonly slug: string; readonly generation: number; readonly title: string; readonly body: string; readonly lifecycle: readonly LifecycleEvent[]; readonly updated_at: string }
function safe(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('E_WIKI_SLUG_INVALID'); return value; }
export class LifecycleWiki {
  constructor(private readonly root: StateRoot, private readonly now: () => Date = () => new Date()) {}
  private file(slug: string): string { return withinStateRoot(this.root, 'wiki', `${safe(slug)}.json`); }
  show(slug: string): WikiPage | null { const file = this.file(slug); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as WikiPage : null; }
  async render(slug: string, expectedGeneration: number, title: string, events: readonly LifecycleEvent[]): Promise<WikiPage> {
    if (title.trim() === '' || title.length > 512) throw new Error('E_WIKI_TITLE_INVALID');
    if (events.length > 1000) throw new Error('E_WIKI_EVENT_LIMIT');
    return withDirectoryLock(this.file(slug), () => {
      const current = this.show(slug); if ((current?.generation ?? 0) !== expectedGeneration) throw new Error('E_GENERATION_CONFLICT');
      const lifecycle = events.map((event) => ({ ...event, detail: redact(event.detail) }));
      if (Buffer.byteLength(JSON.stringify(lifecycle)) > 4 * 1024 * 1024) throw new Error('E_WIKI_CONTENT_TOO_LARGE');
      const body = lifecycle.map((event) => `- ${event.at} [${event.phase}] ${JSON.stringify(event.detail)}`).join('\n');
      const page: WikiPage = { schema_version: 1, slug: safe(slug), generation: expectedGeneration + 1, title: redactText(title, 512), body: redactText(body, 64 * 1024), lifecycle, updated_at: this.now().toISOString() };
      atomicWriteJson(this.file(slug), page); return page;
    });
  }
}
