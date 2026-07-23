#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export const SUPPORTED_EVENTS = new Set([
  'sessionStart',
  'preToolUse',
  'beforeSubmitPrompt',
  'preCompact',
  'stop',
  'subagentStop',
]);

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
  return event === 'beforeSubmitPrompt' ? { continue: true } : {};
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

export async function runHook(event, inputText) {
  parseHookInput(inputText); // Validate and redact before any optional diagnostics.
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
