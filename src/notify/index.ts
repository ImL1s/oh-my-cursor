import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson, withDirectoryLock } from '../runtime/atomic.js';
import { redact } from '../runtime/redaction.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';

export interface NotificationConfig { readonly schema_version: 1; readonly enabled: boolean; readonly generation: number; readonly destination: string | null; readonly updated_at: string }
export interface QueuedNotification { readonly schema_version: 1; readonly id: string; readonly generation: number; readonly nonce: string; readonly payload: unknown; readonly status: 'pending' | 'sent'; readonly queued_at: string; readonly sent_at: string | null }
export interface OutboundNotification { readonly destination: string; readonly payload: unknown; readonly nonce: string }
export type NotificationTransport = (notification: OutboundNotification) => Promise<void>;
function safe(value: string): string { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('E_NOTIFICATION_ID_INVALID'); return value; }

export class NotificationService {
  constructor(private readonly root: StateRoot, private readonly transport: NotificationTransport, private readonly now: () => Date = () => new Date(), private readonly nonce: () => string = () => crypto.randomBytes(24).toString('hex')) {}
  private configFile(): string { return withinStateRoot(this.root, 'notify', 'config.json'); }
  private itemFile(id: string): string { return withinStateRoot(this.root, 'notify', 'queue', `${safe(id)}.json`); }
  config(): NotificationConfig {
    const file = this.configFile();
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as NotificationConfig : { schema_version: 1, enabled: false, generation: 0, destination: null, updated_at: new Date(0).toISOString() };
  }
  async configure(expectedGeneration: number, enabled: boolean, destination: string | null): Promise<NotificationConfig> {
    if (!Number.isInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('E_GENERATION_INVALID');
    if (enabled && (destination === null || destination.trim() === '' || destination.length > 2048)) throw new Error('E_NOTIFICATION_DESTINATION_REQUIRED');
    return withDirectoryLock(this.configFile(), () => {
      const current = this.config();
      if (current.generation !== expectedGeneration) throw new Error('E_GENERATION_CONFLICT');
      const next: NotificationConfig = { schema_version: 1, enabled, generation: expectedGeneration + 1, destination: enabled ? destination : null, updated_at: this.now().toISOString() };
      atomicWriteJson(this.configFile(), next); return next;
    });
  }
  async enqueue(payload: unknown, id = crypto.randomUUID()): Promise<QueuedNotification> {
    const file = this.itemFile(id);
    return withDirectoryLock(file, () => {
      if (fs.existsSync(file)) throw new Error('E_NOTIFICATION_EXISTS');
      const item: QueuedNotification = { schema_version: 1, id: safe(id), generation: 1, nonce: this.nonce(), payload: redact(payload), status: 'pending', queued_at: this.now().toISOString(), sent_at: null };
      atomicWriteJson(file, item); return item;
    });
  }
  read(id: string): QueuedNotification { return JSON.parse(fs.readFileSync(this.itemFile(id), 'utf8')) as QueuedNotification; }
  async dispatch(id: string, expectedGeneration: number, nonce: string): Promise<QueuedNotification> {
    const file = this.itemFile(id);
    return withDirectoryLock(file, async () => {
      const item = this.read(id);
      if (item.generation !== expectedGeneration) throw new Error('E_GENERATION_CONFLICT');
      if (item.nonce !== nonce || nonce.length < 16) throw new Error('E_NOTIFICATION_NONCE_INVALID');
      if (item.status !== 'pending') throw new Error('E_NOTIFICATION_ALREADY_SENT');
      const config = this.config();
      if (!config.enabled || config.destination === null) throw new Error('E_NOTIFICATIONS_DISABLED');
      await this.transport({ destination: config.destination, payload: item.payload, nonce: item.nonce });
      const sent: QueuedNotification = { ...item, generation: item.generation + 1, status: 'sent', sent_at: this.now().toISOString() };
      atomicWriteJson(file, sent); return sent;
    });
  }
}

/** A transport that makes the disabled-by-default behavior explicit and never performs network I/O. */
export const refusingNotificationTransport: NotificationTransport = async () => { throw new Error('E_NOTIFICATION_TRANSPORT_NOT_CONFIGURED'); };
