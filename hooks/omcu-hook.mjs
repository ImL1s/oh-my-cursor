#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SUPPORTED_EVENTS = new Set([
  'sessionStart',
  'preToolUse',
  'beforeSubmitPrompt',
  'preCompact',
  'stop',
  'subagentStop',
]);

// Events whose stopped turn may be continued by an opt-in persist loop.
const PERSIST_CONTINUABLE = new Set(['stop', 'subagentStop']);

const MAX_INPUT_BYTES = 1024 * 1024;
const SENSITIVE_KEY = /(authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;
const INLINE_SECRET = /\b(Bearer\s+|token\s*[=:]\s*|api[_-]?key\s*[=:]\s*|password\s*[=:]\s*)[^\s,;]+/gi;

export function redactHookValue(value, depth = 0) {
  if (depth > 8) return '<truncated:depth>';
  if (typeof value === 'string') return value.replace(INLINE_SECRET, '$1<redacted>').slice(0, 4096);
  if (Array.isArray(value)) return value.slice(0, 128).map((entry) => redactHookValue(entry, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 256).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? '<redacted>' : redactHookValue(entry, depth + 1),
    ]));
  }
  return value;
}

export function parseHookInput(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) throw new Error('E_HOOK_INPUT_TOO_LARGE');
  if (text.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('E_HOOK_INPUT_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('E_HOOK_INPUT_INVALID');
  return redactHookValue(parsed);
}

export function responseForEvent(event) {
  if (!SUPPORTED_EVENTS.has(event)) throw new Error('E_HOOK_EVENT_UNSUPPORTED');
  // Hooks intentionally express no permission or completion decision. Cursor remains
  // responsible for approvals; the CLI remains the only verification-state writer.
  // stop/subagentStop follow-ups are resolved separately by the persist oracle.
  return event === 'beforeSubmitPrompt' ? { continue: true } : {};
}

/** Resolve the installed omcu CLI entrypoint, or null if unavailable. */
export function resolveOmcuEntrypoint(env = process.env) {
  const pluginRoot = typeof env.CURSOR_PLUGIN_ROOT === 'string' ? env.CURSOR_PLUGIN_ROOT : '';
  if (pluginRoot.trim() === '') return null;
  const candidate = path.join(pluginRoot, 'dist', 'bin', 'omcu.js');
  try {
    if (fs.lstatSync(candidate).isFile()) return candidate;
  } catch {
    return null;
  }
  return null;
}

/**
 * Ask the omcu CLI whether an opt-in persist loop should continue this turn.
 * Fail-open on ANY problem: a missing CLI, a crash, a timeout, or malformed
 * output returns {} (a normal stop). The hook never mutates state itself.
 */
export function persistFollowup(rawInputText, env = process.env, runner = spawnSync) {
  const entry = resolveOmcuEntrypoint(env);
  if (entry === null) return {};
  let result;
  try {
    result = runner(process.execPath, [entry, 'persist', 'decide'], {
      input: rawInputText,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return {};
  }
  if (!result || result.status !== 0 || typeof result.stdout !== 'string') return {};
  let decision;
  try {
    decision = JSON.parse(result.stdout);
  } catch {
    return {};
  }
  if (decision && decision.continue === true && typeof decision.followup_message === 'string'
    && decision.followup_message.length > 0 && decision.followup_message.length <= 65_536) {
    return { followup_message: decision.followup_message };
  }
  return {};
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error('E_HOOK_INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function runHook(event, inputText, env = process.env, runner = spawnSync) {
  parseHookInput(inputText); // Validate and redact before any optional diagnostics.
  if (PERSIST_CONTINUABLE.has(event)) {
    const followup = persistFollowup(inputText, env, runner);
    // subagentStop only supports followup_message; stop supports it too. When the
    // persist oracle declines, both fall back to the passive base response.
    return Object.keys(followup).length > 0 ? followup : responseForEvent(event);
  }
  return responseForEvent(event);
}

async function main() {
  const event = process.argv[2] ?? '';
  try {
    const result = await runHook(event, await readStdin());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof Error && /^E_[A-Z_]+$/.test(error.message) ? error.message : 'E_HOOK_FAILED';
    process.stderr.write(`OMCU_HOOK_ERROR event=${SUPPORTED_EVENTS.has(event) ? event : 'unsupported'} code=${code}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
