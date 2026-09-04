import fs from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { redact } from '../runtime/redaction.js';
import {
  AtomicWriteError,
  atomicCreateJson,
  type AtomicWriteOptions,
} from '../runtime/atomic.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';
import { ProjectMemoryStore } from '../memory/index.js';
import { readRecovery } from '../recovery/index.js';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  PACKAGE_VERSION,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
} from '../version.js';

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  APPLICATION_ERROR: -32000,
} as const;

export const MCP_TOOLS = [
  {
    name: 'omcu.memory.search',
    description: 'Search redacted project memory',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'omcu.memory.show',
    description: 'Show one redacted project memory',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'omcu.recovery.show',
    description: 'Show an immutable recovery snapshot',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'omcu.proposal.write',
    description: 'Write a redacted non-authoritative proposal',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        proposal: { type: 'object' },
      },
      required: ['id', 'proposal'],
      additionalProperties: false,
    },
  },
] as const;

const TOOLS = MCP_TOOLS;
export const MAX_NESTING_DEPTH = 16;
export const MAX_PROPOSAL_BYTES = 64 * 1024;
export const MAX_STRING_LENGTH = 4096;
export const MAX_OBJECT_ENTRIES = 1000;
export const MAX_ARRAY_ENTRIES = 1000;
export const MAX_KEY_LENGTH = 256;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function checkStructureBounds(value: unknown, currentDepth = 0): void {
  if (currentDepth > MAX_NESTING_DEPTH) throw new Error('E_MCP_NESTING_TOO_DEEP');
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ENTRIES) throw new Error('E_MCP_ARRAY_TOO_LARGE');
      for (const item of value) checkStructureBounds(item, currentDepth + 1);
    } else {
      const entries = Object.entries(value);
      if (entries.length > MAX_OBJECT_ENTRIES) throw new Error('E_MCP_OBJECT_TOO_LARGE');
      for (const [key, child] of entries) {
        if (key.length > MAX_KEY_LENGTH) throw new Error('E_MCP_KEY_TOO_LONG');
        checkStructureBounds(child, currentDepth + 1);
      }
    }
  }
}

function forbiddenName(value: string): boolean {
  return /(?:^|[._-])(passes|verified|shell)(?:$|[._-])/i.test(value) || /^shell[A-Z_]/.test(value);
}
function forbiddenStructure(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(forbiddenStructure);
  return value !== null && typeof value === 'object'
    && Object.entries(value).some(([key, child]) => forbiddenName(key) || forbiddenStructure(child));
}
function args(params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== 'object') throw new Error('E_MCP_PARAMS_INVALID');
  const input = (params as { arguments?: unknown }).arguments;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('E_MCP_ARGUMENTS_INVALID');
  return input as Record<string, unknown>;
}
function safe(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error('E_MCP_ID_INVALID'); return value; }
function toolResult(value: unknown): unknown { return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; }
function proposalMatches(file: string, proposal: unknown): boolean {
  let expected: Buffer;
  try {
    expected = Buffer.from(`${JSON.stringify(proposal, null, 2)}\n`);
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.length
      || (typeof process.getuid === 'function' && before.uid !== process.getuid())
      || (process.platform !== 'win32' && (before.mode & 0o777) !== 0o400)) return false;
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size) return false;
      const observed = Buffer.alloc(opened.size);
      const bytes = fs.readSync(descriptor, observed, 0, observed.length, 0);
      const final = fs.fstatSync(descriptor);
      return bytes === observed.length && final.dev === opened.dev && final.ino === opened.ino
        && final.size === opened.size
        && (typeof process.getuid !== 'function' || final.uid === process.getuid())
        && (process.platform === 'win32' || (final.mode & 0o777) === 0o400)
        && observed.equals(expected);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return false;
  }
}

/** Exclusive immutable proposal publication; exported only for focused fault tests. */
export function publishProposal(
  file: string,
  proposal: unknown,
  options: AtomicWriteOptions = {},
): void {
  try {
    atomicCreateJson(file, proposal, { ...options, mode: 0o400 });
  } catch (error) {
    if (error instanceof AtomicWriteError && error.phase === 'commit_durability_unknown'
      && proposalMatches(file, proposal)) return;
    const details = `${error instanceof Error ? error.message : String(error)} ${
      error instanceof AtomicWriteError && error.causeError instanceof Error ? error.causeError.message : ''
    }`;
    if (error instanceof AtomicWriteError && error.phase === 'not_committed'
      && /(?:E_ATOMIC_EXISTS|EEXIST)/.test(details)) throw new Error('E_MCP_PROPOSAL_EXISTS', { cause: error });
    throw error;
  }
}

export interface McpHandlerOptions {
  readonly strictLifecycle?: boolean;
}

export function createMcpRequestHandler(
  root: StateRoot,
  options: McpHandlerOptions = {},
): (request: unknown) => Promise<JsonRpcResponse | undefined> {
  const memory = new ProjectMemoryStore(root);
  let initialized = false;

  return async (rawRequest: unknown): Promise<JsonRpcResponse | undefined> => {
    // 1. Envelope validation
    if (rawRequest === null || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: 'E_MCP_INVALID_REQUEST' },
      };
    }

    const req = rawRequest as Record<string, unknown>;
    const hasId = Object.prototype.hasOwnProperty.call(req, 'id');
    const isNotification = !hasId || req.id === undefined;
    const id: string | number | null = hasId ? (req.id as string | number | null) : null;

    if (hasId && id !== null && typeof id !== 'string' && typeof id !== 'number') {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: 'E_MCP_INVALID_ID' },
      };
    }

    if (req.jsonrpc !== '2.0') {
      if (isNotification) return undefined;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: 'E_MCP_INVALID_JSONRPC_VERSION' },
      };
    }

    if (typeof req.method !== 'string' || req.method.trim() === '' || req.method.length > 128) {
      if (isNotification) return undefined;
      return {
        jsonrpc: '2.0',
        id,
        error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: 'E_MCP_INVALID_METHOD' },
      };
    }

    const method = req.method;

    // 2. Notification handling: notifications must not produce a response
    if (method === 'notifications/initialized') {
      initialized = true;
      return undefined;
    }
    if (isNotification) {
      return undefined;
    }

    // 3. Lifecycle check (if strictLifecycle is enabled)
    if (options.strictLifecycle && !initialized && method !== 'initialize' && method !== 'ping') {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: 'E_MCP_NOT_INITIALIZED' },
      };
    }

    // 4. Method dispatch
    try {
      checkStructureBounds(req.params);

      const requestedTool =
        req.params !== null && typeof req.params === 'object'
          ? (req.params as { name?: unknown }).name
          : undefined;

      if (
        forbiddenName(method) ||
        (typeof requestedTool === 'string' && forbiddenName(requestedTool)) ||
        forbiddenStructure(req.params)
      ) {
        throw new Error('E_MCP_STRUCTURAL_REFUSAL');
      }

      if (method === 'initialize') {
        let negotiatedProtocolVersion: string = MCP_PROTOCOL_VERSION;
        if (req.params !== undefined) {
          if (req.params === null || typeof req.params !== 'object' || Array.isArray(req.params)) {
            throw new Error('E_MCP_PARAMS_INVALID');
          }
          const initParams = req.params as Record<string, unknown>;
          if (initParams.protocolVersion !== undefined) {
            if (typeof initParams.protocolVersion !== 'string' || initParams.protocolVersion.trim() === '') {
              throw new Error('E_MCP_PARAMS_INVALID');
            }
            if ((SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(initParams.protocolVersion)) {
              negotiatedProtocolVersion = initParams.protocolVersion;
            }
          }
          if (initParams.capabilities !== undefined && (typeof initParams.capabilities !== 'object' || initParams.capabilities === null || Array.isArray(initParams.capabilities))) {
            throw new Error('E_MCP_PARAMS_INVALID');
          }
          if (initParams.clientInfo !== undefined && (typeof initParams.clientInfo !== 'object' || initParams.clientInfo === null || Array.isArray(initParams.clientInfo))) {
            throw new Error('E_MCP_PARAMS_INVALID');
          }
        }
        initialized = true;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiatedProtocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: MCP_SERVER_NAME, version: PACKAGE_VERSION },
          },
        };
      }

      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }

      if (method === 'tools/list') {
        if (req.params !== undefined && (req.params === null || typeof req.params !== 'object' || Array.isArray(req.params))) {
          throw new Error('E_MCP_PARAMS_INVALID');
        }
        return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
      }

      if (method !== 'tools/call') {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: JSONRPC_ERRORS.METHOD_NOT_FOUND, message: 'E_MCP_METHOD_NOT_ALLOWED' },
        };
      }

      // tools/call handling
      if (req.params === null || typeof req.params !== 'object' || Array.isArray(req.params)) {
        throw new Error('E_MCP_PARAMS_INVALID');
      }

      const params = req.params as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== 'string') {
        throw new Error('E_MCP_TOOL_NOT_ALLOWED');
      }

      const toolName = params.name;
      const toolDef = MCP_TOOLS.find((t) => t.name === toolName);
      if (!toolDef) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: JSONRPC_ERRORS.INVALID_PARAMS, message: 'E_MCP_TOOL_NOT_ALLOWED' },
        };
      }

      if (
        params.arguments === null ||
        typeof params.arguments !== 'object' ||
        Array.isArray(params.arguments)
      ) {
        throw new Error('E_MCP_ARGUMENTS_INVALID');
      }

      const inputArgs = params.arguments as Record<string, unknown>;

      // Schema enforcement: additionalProperties: false
      const allowedKeys = Object.keys(toolDef.inputSchema.properties);
      for (const key of Object.keys(inputArgs)) {
        if (!allowedKeys.includes(key)) {
          throw new Error('E_MCP_ARGUMENTS_INVALID');
        }
      }

      if (toolName === 'omcu.memory.search') {
        if (typeof inputArgs.query !== 'string' || inputArgs.query.length > MAX_STRING_LENGTH) {
          throw new Error('E_MCP_ARGUMENTS_INVALID');
        }
        let limit = 20;
        if (inputArgs.limit !== undefined) {
          if (!Number.isSafeInteger(inputArgs.limit) || (inputArgs.limit as number) < 1 || (inputArgs.limit as number) > 100) {
            throw new Error('E_MCP_ARGUMENTS_INVALID');
          }
          limit = inputArgs.limit as number;
        }
        return {
          jsonrpc: '2.0',
          id,
          result: toolResult(memory.search(inputArgs.query, limit)),
        };
      }

      if (toolName === 'omcu.memory.show') {
        const memoryId = safe(inputArgs.id);
        return {
          jsonrpc: '2.0',
          id,
          result: toolResult(memory.show(memoryId)),
        };
      }

      if (toolName === 'omcu.recovery.show') {
        const recoveryId = safe(inputArgs.id);
        return {
          jsonrpc: '2.0',
          id,
          result: toolResult(readRecovery(root, recoveryId)),
        };
      }

      if (toolName === 'omcu.proposal.write') {
        const proposalId = safe(inputArgs.id);
        if (
          inputArgs.proposal === null ||
          typeof inputArgs.proposal !== 'object' ||
          Array.isArray(inputArgs.proposal)
        ) {
          throw new Error('E_MCP_ARGUMENTS_INVALID');
        }
        const stringified = JSON.stringify(inputArgs.proposal);
        if (stringified.length > MAX_PROPOSAL_BYTES) {
          throw new Error('E_MCP_PROPOSAL_TOO_LARGE');
        }
        const file = withinStateRoot(root, 'mcp', 'proposals', `${proposalId}.json`);
        const proposal = {
          schema_version: 1,
          id: proposalId,
          authoritative: false,
          proposal: redact(inputArgs.proposal),
          created_at: new Date().toISOString(),
        };
        publishProposal(file, proposal);
        return { jsonrpc: '2.0', id, result: toolResult(proposal) };
      }

      throw new Error('E_MCP_TOOL_NOT_ALLOWED');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let code: number = JSONRPC_ERRORS.APPLICATION_ERROR;
      if (
        message === 'E_MCP_STRUCTURAL_REFUSAL' ||
        message === 'E_MCP_NESTING_TOO_DEEP' ||
        message === 'E_MCP_ARRAY_TOO_LARGE' ||
        message === 'E_MCP_OBJECT_TOO_LARGE' ||
        message === 'E_MCP_KEY_TOO_LONG' ||
        message === 'E_MCP_PARAMS_INVALID' ||
        message === 'E_MCP_ARGUMENTS_INVALID' ||
        message === 'E_MCP_ID_INVALID' ||
        message === 'E_MCP_TOOL_NOT_ALLOWED' ||
        message === 'E_MCP_PROPOSAL_TOO_LARGE' ||
        message === 'E_MEMORY_SEARCH_INVALID'
      ) {
        code = JSONRPC_ERRORS.INVALID_PARAMS;
      } else if (message === 'E_MCP_METHOD_NOT_ALLOWED') {
        code = JSONRPC_ERRORS.METHOD_NOT_FOUND;
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code, message },
      };
    }
  };
}

export const MAX_MCP_LINE_BYTES = 1024 * 1024;

export interface BoundedLineResult {
  readonly line?: string;
  readonly error?: 'E_MCP_LINE_TOO_LARGE';
}

export async function* readBoundedLines(
  input: Readable,
  maxLineBytes: number = MAX_MCP_LINE_BYTES,
): AsyncGenerator<BoundedLineResult> {
  let buffer = Buffer.alloc(0);
  let discarding = false;

  for await (const rawChunk of input) {
    const chunkBuf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as string);
    let offset = 0;

    while (offset < chunkBuf.length) {
      const newlineIndex = chunkBuf.indexOf(0x0a, offset);

      if (newlineIndex === -1) {
        const remaining = chunkBuf.subarray(offset);
        if (discarding) {
          offset = chunkBuf.length;
        } else if (buffer.length + remaining.length > maxLineBytes) {
          discarding = true;
          buffer = Buffer.alloc(0);
          yield { error: 'E_MCP_LINE_TOO_LARGE' };
          offset = chunkBuf.length;
        } else {
          buffer = Buffer.concat([buffer, remaining]);
          offset = chunkBuf.length;
        }
      } else {
        const segment = chunkBuf.subarray(offset, newlineIndex);
        offset = newlineIndex + 1;

        if (discarding) {
          discarding = false;
        } else if (buffer.length + segment.length > maxLineBytes) {
          buffer = Buffer.alloc(0);
          yield { error: 'E_MCP_LINE_TOO_LARGE' };
        } else {
          const fullLineBuf = Buffer.concat([buffer, segment]);
          buffer = Buffer.alloc(0);
          let lineStr = fullLineBuf.toString('utf8');
          if (lineStr.endsWith('\r')) {
            lineStr = lineStr.slice(0, -1);
          }
          yield { line: lineStr };
        }
      }
    }
  }

  if (!discarding && buffer.length > 0) {
    if (buffer.length > maxLineBytes) {
      yield { error: 'E_MCP_LINE_TOO_LARGE' };
    } else {
      let lineStr = buffer.toString('utf8');
      if (lineStr.endsWith('\r')) {
        lineStr = lineStr.slice(0, -1);
      }
      yield { line: lineStr };
    }
  }
}

export async function serveMcpStdio(
  root: StateRoot,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  options: McpHandlerOptions = {},
): Promise<void> {
  const handle = createMcpRequestHandler(root, options);

  for await (const item of readBoundedLines(input, MAX_MCP_LINE_BYTES)) {
    if (item.error === 'E_MCP_LINE_TOO_LARGE') {
      const errResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: 'E_MCP_LINE_TOO_LARGE' },
      };
      const lineToWrite = `${JSON.stringify(errResponse)}\n`;
      if (!output.write(lineToWrite)) {
        await new Promise((resolve) => output.once('drain', resolve));
      }
      continue;
    }
    const line = item.line ?? '';
    if (line.trim() === '') {
      continue;
    }
    if (line.includes('\0')) {
      const errResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: JSONRPC_ERRORS.INVALID_REQUEST, message: 'E_MCP_INVALID_REQUEST' },
      };
      const lineToWrite = `${JSON.stringify(errResponse)}\n`;
      if (!output.write(lineToWrite)) {
        await new Promise((resolve) => output.once('drain', resolve));
      }
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const errResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: null,
        error: { code: JSONRPC_ERRORS.PARSE_ERROR, message: 'E_MCP_PARSE_ERROR' },
      };
      const lineToWrite = `${JSON.stringify(errResponse)}\n`;
      if (!output.write(lineToWrite)) {
        await new Promise((resolve) => output.once('drain', resolve));
      }
      continue;
    }
    const response = await handle(parsed);
    if (response !== undefined && response !== null) {
      const lineToWrite = `${JSON.stringify(response)}\n`;
      if (!output.write(lineToWrite)) {
        await new Promise((resolve) => output.once('drain', resolve));
      }
    }
  }
}

