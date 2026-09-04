import crypto from 'node:crypto';
import fs from 'node:fs';
import { withDirectoryLock } from '../runtime/atomic.js';
import { Journal } from '../runtime/journal.js';
import type { StateRoot } from '../runtime/state-root.js';
import {
  assertSafeWorkerName,
  LEADER_MAILBOX,
  readTeamConfig,
  teamMailboxJournalDir,
  teamMailboxPath,
} from './state-root.js';

export interface TeamMailboxMessage {
  readonly message_id: string;
  readonly from_worker: string;
  readonly to_worker: string;
  readonly body: string;
  readonly created_at: string;
  readonly notified_at?: string;
  readonly delivered_at?: string;
}

export interface TeamMailbox {
  readonly worker: string;
  readonly messages: readonly TeamMailboxMessage[];
}

export type TeamMailboxEvent =
  | { readonly kind: 'send'; readonly message: TeamMailboxMessage }
  | { readonly kind: 'delivered'; readonly message_id: string; readonly delivered_at: string };

function assertMailboxMessage(raw: unknown): TeamMailboxMessage {
  if (raw === null || typeof raw !== 'object') throw new Error('E_TEAM_MAILBOX_CORRUPT');
  const row = raw as Partial<TeamMailboxMessage>;
  if (
    typeof row.message_id !== 'string' || row.message_id.trim() === ''
    || typeof row.from_worker !== 'string' || row.from_worker.trim() === ''
    || typeof row.to_worker !== 'string' || row.to_worker.trim() === ''
    || typeof row.body !== 'string'
    || typeof row.created_at !== 'string' || row.created_at.trim() === ''
  ) {
    throw new Error('E_TEAM_MAILBOX_CORRUPT');
  }
  if (row.notified_at !== undefined && typeof row.notified_at !== 'string') throw new Error('E_TEAM_MAILBOX_CORRUPT');
  if (row.delivered_at !== undefined && typeof row.delivered_at !== 'string') throw new Error('E_TEAM_MAILBOX_CORRUPT');
  return row as TeamMailboxMessage;
}

function readMailboxUnlocked(root: StateRoot, teamName: string, workerName: string): TeamMailbox {
  const name = assertSafeWorkerName(workerName);
  const file = teamMailboxPath(root, teamName, name);
  if (!fs.existsSync(file)) return { worker: name, messages: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TeamMailbox>;
    if (parsed.worker !== name || !Array.isArray(parsed.messages)) throw new Error('E_TEAM_MAILBOX_CORRUPT');
    return { worker: name, messages: parsed.messages.map(assertMailboxMessage) };
  } catch (error) {
    if ((error as Error).message === 'E_TEAM_MAILBOX_CORRUPT') throw error;
    throw new Error('E_TEAM_MAILBOX_CORRUPT');
  }
}

export const MAILBOX_MAX_RECORD_BYTES = 256 * 1024; // 256 KiB covers up to 64 KiB char body plus wrapping envelope
export const MAILBOX_MAX_SEGMENT_BYTES = 4 * 1024 * 1024; // 4 MiB

function mailboxJournal(root: StateRoot, teamName: string, workerName: string, now: () => Date): Journal<TeamMailboxEvent> {
  const dir = teamMailboxJournalDir(root, teamName, workerName);
  return new Journal<TeamMailboxEvent>(dir, `team/${teamName}/mailbox/${workerName}`, {
    now,
    maxRecordBytes: MAILBOX_MAX_RECORD_BYTES,
    maxSegmentBytes: MAILBOX_MAX_SEGMENT_BYTES,
  });
}

const migrationPromises = new Map<string, Promise<void>>();

async function migrateLegacyMailboxIfNeeded(
  root: StateRoot,
  teamName: string,
  workerName: string,
  journal: Journal<TeamMailboxEvent>,
): Promise<void> {
  const migrationKey = `${root.path}:${teamName}:${workerName}`;
  const existingPromise = migrationPromises.get(migrationKey);
  if (existingPromise !== undefined) {
    await existingPromise;
    return;
  }

  const promise = (async () => {
    const file = teamMailboxPath(root, teamName, workerName);
    if (!fs.existsSync(file)) return;
    const legacy = readMailboxUnlocked(root, teamName, workerName);
    if (legacy.messages.length === 0) return;
    const head = journal.readHead();
    if (head !== null && head.head_sequence > 0) return;

    for (const message of legacy.messages) {
      const currentMessages = journal.readHead()?.head_sequence ? readMessagesFromJournal(journal) : [];
      const exists = currentMessages.some((m) => m.message_id === message.message_id);
      if (!exists) {
        await journal.append({ kind: 'send', payload: { kind: 'send', message }, at: message.created_at });
      }
      if (message.delivered_at !== undefined) {
        const afterMessages = readMessagesFromJournal(journal);
        const deliveredMsg = afterMessages.find((m) => m.message_id === message.message_id);
        if (deliveredMsg && deliveredMsg.delivered_at !== message.delivered_at) {
          await journal.append({
            kind: 'delivered',
            payload: { kind: 'delivered', message_id: message.message_id, delivered_at: message.delivered_at },
            at: message.delivered_at,
          });
        }
      }
    }
  })();

  migrationPromises.set(migrationKey, promise);
  try {
    await promise;
  } finally {
    migrationPromises.delete(migrationKey);
  }
}

function readMessagesFromJournal(journal: Journal<TeamMailboxEvent>): TeamMailboxMessage[] {
  const records = journal.readRange();
  const messagesMap = new Map<string, TeamMailboxMessage>();
  for (const rec of records) {
    const event = rec.payload;
    if (event.kind === 'send') {
      const existing = messagesMap.get(event.message.message_id);
      if (existing) {
        const deliveredAt = existing.delivered_at ?? event.message.delivered_at;
        const merged: TeamMailboxMessage = {
          ...event.message,
          ...(deliveredAt !== undefined ? { delivered_at: deliveredAt } : {}),
        };
        messagesMap.set(event.message.message_id, merged);
      } else {
        messagesMap.set(event.message.message_id, event.message);
      }
    } else if (event.kind === 'delivered') {
      const existing = messagesMap.get(event.message_id);
      if (existing) {
        messagesMap.set(event.message_id, { ...existing, delivered_at: event.delivered_at });
      }
    }
  }
  return Array.from(messagesMap.values());
}

export async function listMailboxMessages(
  root: StateRoot,
  teamName: string,
  workerName: string,
  options: { readonly includeDelivered?: boolean } = {},
): Promise<readonly TeamMailboxMessage[]> {
  const name = assertSafeWorkerName(workerName);
  const file = teamMailboxPath(root, teamName, name);
  if (!fs.existsSync(file)) return [];

  return withDirectoryLock(file, async () => {
    if (!fs.existsSync(file)) return [];
    const legacy = readMailboxUnlocked(root, teamName, name);
    const journal = mailboxJournal(root, teamName, name, () => new Date());
    await migrateLegacyMailboxIfNeeded(root, teamName, name, journal);

    const head = journal.readHead();
    let messages: TeamMailboxMessage[];
    if (head !== null && head.head_sequence > 0) {
      messages = readMessagesFromJournal(journal);
    } else {
      messages = [...legacy.messages];
    }

    if (options.includeDelivered === false) return messages.filter((message) => message.delivered_at === undefined);
    return messages;
  });
}

export async function sendDirectMessage(
  root: StateRoot,
  teamName: string,
  fromWorker: string,
  toWorker: string,
  body: string,
  now: () => Date = () => new Date(),
): Promise<TeamMailboxMessage> {
  const from = assertSafeWorkerName(fromWorker);
  const to = assertSafeWorkerName(toWorker);
  const trimmed = body.trim();
  if (trimmed === '') throw new Error('E_TEAM_MESSAGE_BODY_REQUIRED');

  const config = readTeamConfig(root, teamName);
  if (config === null) throw new Error('E_TEAM_NOT_FOUND');
  if (from !== LEADER_MAILBOX && !config.workers.some((worker) => worker.name === from)) {
    throw new Error('E_TEAM_WORKER_NOT_FOUND');
  }
  if (to !== LEADER_MAILBOX && !config.workers.some((worker) => worker.name === to)) {
    throw new Error('E_TEAM_WORKER_NOT_FOUND');
  }

  return withDirectoryLock(teamMailboxPath(root, teamName, to), async () => {
    readMailboxUnlocked(root, teamName, to);
    const journal = mailboxJournal(root, teamName, to, now);
    await migrateLegacyMailboxIfNeeded(root, teamName, to, journal);

    const existingMessages = journal.readHead()?.head_sequence
      ? readMessagesFromJournal(journal)
      : readMailboxUnlocked(root, teamName, to).messages;

    const existing = existingMessages.find((candidate) =>
      candidate.from_worker === from
      && candidate.to_worker === to
      && candidate.body === trimmed
      && candidate.delivered_at === undefined);
    if (existing) return existing;

    const message: TeamMailboxMessage = {
      message_id: crypto.randomUUID(),
      from_worker: from,
      to_worker: to,
      body: trimmed,
      created_at: now().toISOString(),
    };

    await journal.append({
      kind: 'send',
      payload: { kind: 'send', message },
      at: message.created_at,
    });

    return message;
  });
}

export async function markMessageDelivered(
  root: StateRoot,
  teamName: string,
  workerName: string,
  messageId: string,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  const worker = assertSafeWorkerName(workerName);
  const id = messageId.trim();
  if (id === '') throw new Error('E_TEAM_MESSAGE_ID_REQUIRED');

  return withDirectoryLock(teamMailboxPath(root, teamName, worker), async () => {
    readMailboxUnlocked(root, teamName, worker);
    const journal = mailboxJournal(root, teamName, worker, now);
    await migrateLegacyMailboxIfNeeded(root, teamName, worker, journal);

    const messages = journal.readHead()?.head_sequence
      ? readMessagesFromJournal(journal)
      : readMailboxUnlocked(root, teamName, worker).messages;

    const target = messages.find((m) => m.message_id === id);
    if (!target) return false;
    if (target.delivered_at !== undefined) return true;

    const deliveredAt = now().toISOString();
    await journal.append({
      kind: 'delivered',
      payload: { kind: 'delivered', message_id: id, delivered_at: deliveredAt },
      at: deliveredAt,
    });

    return true;
  });
}
