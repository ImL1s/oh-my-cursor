import crypto from 'node:crypto';
import fs from 'node:fs';
import { atomicWriteJson, withDirectoryLock } from '../runtime/atomic.js';
import type { StateRoot } from '../runtime/state-root.js';
import {
  assertSafeWorkerName,
  LEADER_MAILBOX,
  readTeamConfig,
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

function readMailboxUnlocked(root: StateRoot, teamName: string, workerName: string): TeamMailbox {
  const name = assertSafeWorkerName(workerName);
  const file = teamMailboxPath(root, teamName, name);
  if (!fs.existsSync(file)) return { worker: name, messages: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TeamMailbox>;
    if (parsed.worker !== name || !Array.isArray(parsed.messages)) throw new Error('E_TEAM_MAILBOX_CORRUPT');
    return { worker: name, messages: parsed.messages as TeamMailboxMessage[] };
  } catch (error) {
    if ((error as Error).message === 'E_TEAM_MAILBOX_CORRUPT') throw error;
    throw new Error('E_TEAM_MAILBOX_CORRUPT');
  }
}

function writeMailboxUnlocked(root: StateRoot, teamName: string, mailbox: TeamMailbox): void {
  atomicWriteJson(teamMailboxPath(root, teamName, mailbox.worker), mailbox);
}

export async function listMailboxMessages(
  root: StateRoot,
  teamName: string,
  workerName: string,
  options: { readonly includeDelivered?: boolean } = {},
): Promise<readonly TeamMailboxMessage[]> {
  const mailbox = await withDirectoryLock(teamMailboxPath(root, teamName, workerName), () => readMailboxUnlocked(root, teamName, workerName));
  if (options.includeDelivered === false) return mailbox.messages.filter((message) => message.delivered_at === undefined);
  return mailbox.messages;
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
  if (to !== LEADER_MAILBOX && !config.workers.some((worker) => worker.name === to)) {
    throw new Error('E_TEAM_WORKER_NOT_FOUND');
  }

  return withDirectoryLock(teamMailboxPath(root, teamName, to), () => {
    const mailbox = readMailboxUnlocked(root, teamName, to);
    const existing = mailbox.messages.find((candidate) =>
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
    writeMailboxUnlocked(root, teamName, { worker: to, messages: [...mailbox.messages, message] });
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

  return withDirectoryLock(teamMailboxPath(root, teamName, worker), () => {
    const mailbox = readMailboxUnlocked(root, teamName, worker);
    const index = mailbox.messages.findIndex((message) => message.message_id === id);
    if (index < 0) return false;
    const current = mailbox.messages[index]!;
    if (current.delivered_at !== undefined) return true;
    const updated: TeamMailboxMessage = { ...current, delivered_at: now().toISOString() };
    const messages = [...mailbox.messages];
    messages[index] = updated;
    writeMailboxUnlocked(root, teamName, { worker, messages });
    return true;
  });
}
