import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { redact } from '../runtime/redaction.js';
import { withinStateRoot, type StateRoot } from '../runtime/state-root.js';
import { ProjectMemoryStore } from '../memory/index.js';
import { readRecovery } from '../recovery/index.js';

export interface JsonRpcRequest { readonly jsonrpc: '2.0'; readonly id?: string | number | null; readonly method: string; readonly params?: unknown }
export interface JsonRpcResponse { readonly jsonrpc: '2.0'; readonly id: string | number | null; readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string } }
const TOOLS = [
  { name: 'omcu.memory.search', description: 'Search redacted project memory', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'], additionalProperties: false } },
  { name: 'omcu.memory.show', description: 'Show one redacted project memory', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'omcu.recovery.show', description: 'Show an immutable recovery snapshot', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'omcu.proposal.write', description: 'Write a redacted non-authoritative proposal', inputSchema: { type: 'object', properties: { id: { type: 'string' }, proposal: {} }, required: ['id', 'proposal'], additionalProperties: false } },
] as const;
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
function publishProposal(file: string, proposal: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o400);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(proposal, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.linkSync(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('E_MCP_PROPOSAL_EXISTS');
    throw error;
  } finally {
    fs.unlinkSync(temporary);
  }
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export function createMcpRequestHandler(root: StateRoot): (request: JsonRpcRequest) => Promise<JsonRpcResponse> {
  const memory = new ProjectMemoryStore(root);
  return async (request) => {
    const id = request.id ?? null;
    try {
      const requestedTool = request.params !== null && typeof request.params === 'object' ? (request.params as { name?: unknown }).name : undefined;
      if (forbiddenName(request.method) || (typeof requestedTool === 'string' && forbiddenName(requestedTool)) || forbiddenStructure(request.params)) throw new Error('E_MCP_STRUCTURAL_REFUSAL');
      if (request.method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'oh-my-cursor', version: '0.1.0' } } };
      if (request.method === 'notifications/initialized') return { jsonrpc: '2.0', id, result: {} };
      if (request.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      if (request.method !== 'tools/call' || request.params === null || typeof request.params !== 'object') throw new Error('E_MCP_METHOD_NOT_ALLOWED');
      const name = (request.params as { name?: unknown }).name; const input = args(request.params);
      if (name === 'omcu.memory.search') return { jsonrpc: '2.0', id, result: toolResult(memory.search(String(input.query ?? ''), input.limit === undefined ? 20 : Number(input.limit))) };
      if (name === 'omcu.memory.show') return { jsonrpc: '2.0', id, result: toolResult(memory.show(safe(input.id))) };
      if (name === 'omcu.recovery.show') return { jsonrpc: '2.0', id, result: toolResult(readRecovery(root, safe(input.id))) };
      if (name === 'omcu.proposal.write') {
        const proposalId = safe(input.id); const file = withinStateRoot(root, 'mcp', 'proposals', `${proposalId}.json`);
        const proposal = { schema_version: 1, id: proposalId, authoritative: false, proposal: redact(input.proposal), created_at: new Date().toISOString() };
        publishProposal(file, proposal); return { jsonrpc: '2.0', id, result: toolResult(proposal) };
      }
      throw new Error('E_MCP_TOOL_NOT_ALLOWED');
    } catch (error) { return { jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }; }
  };
}

export async function serveMcpStdio(root: StateRoot, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const handle = createMcpRequestHandler(root); const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let response: JsonRpcResponse;
    try { response = await handle(JSON.parse(line) as JsonRpcRequest); }
    catch { response = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'E_MCP_PARSE_ERROR' } }; }
    output.write(`${JSON.stringify(response)}\n`);
  }
}
