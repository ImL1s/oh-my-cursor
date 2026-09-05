import crypto from 'node:crypto';
import { getHookRegistry } from './registry.js';
import { recordHookTrace } from './trace.js';
import {
  CURSOR_NATIVE_HOOK_EVENTS,
  type CursorNativeHookEvent,
  type HookExecutionContext,
  type HookHandlerResult,
  type HookTraceEntry,
} from './types.js';

const MAX_INPUT_BYTES = 1024 * 1024;
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api[_-]?key|private[_-]?key)/i;
const INLINE_SECRET = /\b(Bearer\s+|token\s*[=:]\s*|api[_-]?key\s*[=:]\s*|password\s*[=:]\s*)[^\s,;]+/gi;

export function redactHookInput(value: unknown, depth = 0): unknown {
  if (depth > 8) return '<truncated:depth>';
  if (typeof value === 'string') {
    return value.replace(INLINE_SECRET, '$1<redacted>').slice(0, 8192);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 128).map((entry) => redactHookInput(entry, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).slice(0, 256).map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) ? '<redacted>' : redactHookInput(entry, depth + 1),
      ])
    );
  }
  return value;
}

export interface DispatchOptions {
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly runId?: string | undefined;
  readonly toolName?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface DispatchResult {
  readonly success: boolean;
  readonly event: CursorNativeHookEvent | string;
  readonly response: Record<string, unknown>;
  readonly durationMs: number;
  readonly denied?: boolean | undefined;
  readonly reason?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly results: readonly HookHandlerResult[];
}

export async function dispatchHook(
  event: string,
  rawInput: unknown,
  options?: DispatchOptions
): Promise<DispatchResult> {
  const start = Date.now();
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const runId = options?.runId ?? `hook-run-${crypto.randomUUID().slice(0, 8)}`;

  // 1. Input parsing and validation
  let parsedInput: unknown = rawInput;
  if (typeof rawInput === 'string') {
    if (Buffer.byteLength(rawInput, 'utf8') > MAX_INPUT_BYTES) {
      throw new Error('E_HOOK_INPUT_TOO_LARGE');
    }
    if (rawInput.trim() === '') {
      parsedInput = {};
    } else {
      try {
        parsedInput = JSON.parse(rawInput);
      } catch {
        throw new Error('E_HOOK_INPUT_INVALID');
      }
    }
  } else if (rawInput !== undefined && rawInput !== null) {
    try {
      const serialized = JSON.stringify(rawInput);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_BYTES) {
        throw new Error('E_HOOK_INPUT_TOO_LARGE');
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'E_HOOK_INPUT_TOO_LARGE') {
        throw e;
      }
      throw new Error('E_HOOK_INPUT_INVALID');
    }
  }

  // Redact input for safety (passwords, tokens, cookies)
  const redactedInput = redactHookInput(parsedInput);

  // 2. Check for live probe nonce
  if (
    typeof redactedInput === 'object' &&
    redactedInput !== null &&
    typeof (redactedInput as Record<string, unknown>).omcu_probe_nonce === 'string'
  ) {
    const nonce = (redactedInput as Record<string, unknown>).omcu_probe_nonce as string;
    const probeResponse = {
      provenance: 'omcu',
      version: '0.3.0',
      nonce,
      event,
    };
    return {
      success: true,
      event,
      response: probeResponse,
      durationMs: Date.now() - start,
      results: [{ handled: true, action: 'pass', outputPayload: probeResponse }],
    };
  }

  // 3. Match native hook event
  const nativeEvent = event as CursorNativeHookEvent;
  if (!CURSOR_NATIVE_HOOK_EVENTS.includes(nativeEvent)) {
    return {
      success: false,
      event,
      response: {},
      durationMs: Date.now() - start,
      denied: true,
      reason: `Unknown or unsupported hook event: ${event}`,
      errorCode: 'E_HOOK_UNKNOWN_EVENT',
      results: [],
    };
  }
  const registry = getHookRegistry();
  const handlers = registry.getOrderedHandlersForEvent(nativeEvent);

  const inputObj = typeof redactedInput === 'object' && redactedInput !== null
    ? (redactedInput as Record<string, unknown>)
    : {};

  const context: HookExecutionContext = {
    event: nativeEvent,
    rawInput: redactedInput,
    cwd,
    env,
    runId,
    agentId: typeof inputObj.agent_id === 'string' ? inputObj.agent_id : undefined,
    sessionId: typeof inputObj.session_id === 'string' ? inputObj.session_id : undefined,
    turnId: typeof inputObj.turn_id === 'string' ? inputObj.turn_id : undefined,
    loopCount: typeof inputObj.loop_count === 'number' ? inputObj.loop_count : undefined,
    toolName: options?.toolName ?? (typeof inputObj.tool_name === 'string' ? inputObj.tool_name : undefined),
    toolInput: typeof inputObj.tool_input === 'object' && inputObj.tool_input !== null
      ? (inputObj.tool_input as Record<string, unknown>)
      : (typeof inputObj === 'object' && inputObj !== null ? inputObj : undefined),
    toolOutput: inputObj.tool_output,
    agentResponse: typeof inputObj.agent_response === 'string' ? inputObj.agent_response : undefined,
    prompt: typeof inputObj.prompt === 'string' ? inputObj.prompt : undefined,
    timestamp: start,
  };

  const results: HookHandlerResult[] = [];
  let combinedResponse: Record<string, unknown> = {};

  // Base response per Cursor contract
  if (nativeEvent === 'beforeSubmitPrompt') {
    combinedResponse.continue = true;
  }

  for (const handler of handlers) {
    const handlerStart = Date.now();
    let handlerResult: HookHandlerResult;

    try {
      const handlerPromise = Promise.resolve(handler.handler(context));
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('E_HOOK_TIMEOUT')), handler.timeoutMs);
      });

      handlerResult = await Promise.race([handlerPromise, timeoutPromise]);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMsg === 'E_HOOK_TIMEOUT';

      recordHookTrace({
        id: crypto.randomUUID(),
        runId,
        event: nativeEvent,
        eventType: 'native_hook',
        handlerId: handler.id,
        tier: handler.tier,
        status: 'failed',
        durationMs: Date.now() - handlerStart,
        timestamp: new Date().toISOString(),
        details: { error: errorMsg },
      }, cwd);

      if (handler.failurePolicy === 'fail_closed' || handler.tier === 1) {
        return {
          success: false,
          event: nativeEvent,
          response: {},
          durationMs: Date.now() - start,
          denied: true,
          reason: `Handler ${handler.id} failed closed: ${errorMsg}`,
          errorCode: isTimeout ? 'E_HOOK_TIMEOUT' : 'E_HOOK_FAILED',
          results,
        };
      }

      // Fail-open: continue to next handler
      continue;
    }

    results.push(handlerResult);

    const traceEntry: HookTraceEntry = {
      id: crypto.randomUUID(),
      runId,
      event: nativeEvent,
      eventType: 'native_hook',
      handlerId: handler.id,
      tier: handler.tier,
      status: handlerResult.action === 'deny'
        ? 'denied'
        : handlerResult.action === 'continue'
          ? 'continued'
          : 'success',
      durationMs: Date.now() - handlerStart,
      timestamp: new Date().toISOString(),
      details: handlerResult.traceRecord,
    };
    recordHookTrace(traceEntry, cwd);

    // If Tier 1 safety handler denies or any handler with fail_closed denies
    if (handlerResult.action === 'deny') {
      return {
        success: false,
        event: nativeEvent,
        response: {
          action: 'deny',
          message: handlerResult.reason ?? 'Action denied by hook policy',
          code: handlerResult.errorCode ?? 'E_HOOK_DENIED',
        },
        durationMs: Date.now() - start,
        denied: true,
        reason: handlerResult.reason,
        errorCode: handlerResult.errorCode,
        results,
      };
    }

    if (handlerResult.outputPayload) {
      combinedResponse = { ...combinedResponse, ...handlerResult.outputPayload };
    }
    if (handlerResult.followupMessage) {
      combinedResponse.followup_message = handlerResult.followupMessage;
    }
  }

  return {
    success: true,
    event: nativeEvent,
    response: combinedResponse,
    durationMs: Date.now() - start,
    results,
  };
}
