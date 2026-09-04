import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { projectStateRoot } from '../src/runtime/state-root.js';
import { ProjectMemoryStore } from '../src/memory/index.js';
import {
  createMcpRequestHandler,
  serveMcpStdio,
  JSONRPC_ERRORS,
  MAX_MCP_LINE_BYTES,
} from '../src/mcp/index.js';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  PACKAGE_VERSION,
} from '../src/version.js';

const roots: string[] = [];
function workspace(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-mcp-test-'));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('MCP protocol and handler', () => {
  it('synchronizes version with single source of truth in initialize', async () => {
    const root = projectStateRoot(workspace());
    const handle = createMcpRequestHandler(root);

    const initRes = await handle({
      jsonrpc: '2.0',
      id: 'init-1',
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });

    expect(initRes).toBeDefined();
    expect(initRes?.id).toBe('init-1');
    expect(initRes?.error).toBeUndefined();
    expect(initRes?.result).toEqual({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: {
        name: MCP_SERVER_NAME,
        version: PACKAGE_VERSION,
      },
    });
  });

  it('handles version negotiation and rejects invalid initialize params', async () => {
    const root = projectStateRoot(workspace());
    const handle = createMcpRequestHandler(root);

    const fallbackRes = await handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 'unknown-future-version' },
    });
    expect((fallbackRes?.result as { protocolVersion: string }).protocolVersion).toBe(MCP_PROTOCOL_VERSION);

    const invalidVer = await handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: 123 },
    });
    expect(invalidVer?.error?.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    expect(invalidVer?.error?.message).toBe('E_MCP_PARAMS_INVALID');

    const invalidCap = await handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: { capabilities: 'not-an-object' },
    });
    expect(invalidCap?.error?.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    expect(invalidCap?.error?.message).toBe('E_MCP_PARAMS_INVALID');

    const invalidClient = await handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'initialize',
      params: { clientInfo: [1, 2] },
    });
    expect(invalidClient?.error?.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    expect(invalidClient?.error?.message).toBe('E_MCP_PARAMS_INVALID');
  });

  it('never returns a response for notifications', async () => {
    const root = projectStateRoot(workspace());
    const handle = createMcpRequestHandler(root);

    const initNote = await handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(initNote).toBeUndefined();

    const pingNote = await handle({
      jsonrpc: '2.0',
      method: 'ping',
    });
    expect(pingNote).toBeUndefined();

    const badNote = await handle({
      jsonrpc: '1.0',
      method: 'bad/note',
    });
    expect(badNote).toBeUndefined();
  });

  it('validates request envelope and IDs strictly', async () => {
    const root = projectStateRoot(workspace());
    const handle = createMcpRequestHandler(root);

    const nonObj = await handle('not-json-rpc');
    expect(nonObj?.error?.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST);
    expect(nonObj?.error?.message).toBe('E_MCP_INVALID_REQUEST');
    expect(nonObj?.id).toBeNull();

    const arr = await handle([]);
    expect(arr?.error?.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST);
    expect(arr?.error?.message).toBe('E_MCP_INVALID_REQUEST');

    const badRpc = await handle({ jsonrpc: '1.0', id: 10, method: 'ping' });
    expect(badRpc?.error?.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST);
    expect(badRpc?.error?.message).toBe('E_MCP_INVALID_JSONRPC_VERSION');
    expect(badRpc?.id).toBe(10);

    const badMethod = await handle({ jsonrpc: '2.0', id: 11, method: '' });
    expect(badMethod?.error?.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST);
    expect(badMethod?.error?.message).toBe('E_MCP_INVALID_METHOD');

    const boolId = await handle({ jsonrpc: '2.0', id: true, method: 'ping' });
    expect(boolId?.error?.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST);
    expect(boolId?.error?.message).toBe('E_MCP_INVALID_ID');
    expect(boolId?.id).toBeNull();

    const strId = await handle({ jsonrpc: '2.0', id: 'req-1', method: 'ping' });
    expect(strId?.id).toBe('req-1');
    expect(strId?.result).toEqual({});

    const numId = await handle({ jsonrpc: '2.0', id: 42, method: 'ping' });
    expect(numId?.id).toBe(42);
    expect(numId?.result).toEqual({});

    const unknownMethod = await handle({ jsonrpc: '2.0', id: 50, method: 'unknown/action' });
    expect(unknownMethod?.error?.code).toBe(JSONRPC_ERRORS.METHOD_NOT_FOUND);
    expect(unknownMethod?.error?.message).toBe('E_MCP_METHOD_NOT_ALLOWED');
  });

  it('enforces strictLifecycle when enabled', async () => {
    const root = projectStateRoot(workspace());
    const handle = createMcpRequestHandler(root, { strictLifecycle: true });

    const uninitList = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(uninitList?.error?.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST);
    expect(uninitList?.error?.message).toBe('E_MCP_NOT_INITIALIZED');

    // Premature notifications/initialized must not unlock lifecycle
    const prematureNote = await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(prematureNote).toBeUndefined();
    const stillUninit = await handle({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
    expect(stillUninit?.error?.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST);
    expect(stillUninit?.error?.message).toBe('E_MCP_NOT_INITIALIZED');

    // notifications/initialized with an id must be rejected
    const idNote = await handle({ jsonrpc: '2.0', id: 11, method: 'notifications/initialized' });
    expect(idNote?.error?.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST);
    expect(idNote?.error?.message).toBe('E_MCP_NOTIFICATION_HAS_ID');

    // Initialize succeeds
    const initRes = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize' });
    expect(initRes?.error).toBeUndefined();

    // Now notifications/initialized marks it initialized
    const validNote = await handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(validNote).toBeUndefined();

    const afterInit = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(afterInit?.error).toBeUndefined();
    expect((afterInit?.result as { tools: unknown[] }).tools).toHaveLength(4);
  });

  it('enforces tool schema boundaries and additionalProperties: false', async () => {
    const root = projectStateRoot(workspace());
    const memory = new ProjectMemoryStore(root);
    await memory.put('first alpha note', {}, 'alpha');
    const handle = createMcpRequestHandler(root);

    const unknownTool = await handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'omcu.nonexistent', arguments: {} },
    });
    expect(unknownTool?.error?.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    expect(unknownTool?.error?.message).toBe('E_MCP_TOOL_NOT_ALLOWED');

    const missingArgs = await handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'omcu.memory.search' },
    });
    expect(missingArgs?.error?.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    expect(missingArgs?.error?.message).toBe('E_MCP_ARGUMENTS_INVALID');

    const extraProp = await handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'omcu.memory.search',
        arguments: { query: 'alpha', extra_param: true },
      },
    });
    expect(extraProp?.error?.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    expect(extraProp?.error?.message).toBe('E_MCP_ARGUMENTS_INVALID');

    const badLimit = await handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'omcu.memory.search',
        arguments: { query: 'alpha', limit: -5 },
      },
    });
    expect(badLimit?.error?.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    expect(badLimit?.error?.message).toBe('E_MCP_ARGUMENTS_INVALID');

    const validSearch = await handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'omcu.memory.search',
        arguments: { query: 'alpha', limit: 10 },
      },
    });
    expect(validSearch?.error).toBeUndefined();
    const searchRes = (validSearch?.result as { structuredContent: Array<{ id: string }> });
    expect(searchRes.structuredContent).toHaveLength(1);
    expect(searchRes.structuredContent[0]?.id).toBe('alpha');

    // 3,000 emojis = 3,000 code points (<= 4096 maxLength) but 6,000 UTF-16 code units
    const emojiQuery = await handle({
      jsonrpc: '2.0',
      id: 'emoji-search',
      method: 'tools/call',
      params: {
        name: 'omcu.memory.search',
        arguments: { query: '🎉'.repeat(3000), limit: 10 },
      },
    });
    expect(emojiQuery?.error).toBeUndefined();

    // 4,097 emojis = 4,097 code points (> 4096 maxLength) must be rejected
    const oversizedEmojiQuery = await handle({
      jsonrpc: '2.0',
      id: 'oversized-emoji-search',
      method: 'tools/call',
      params: {
        name: 'omcu.memory.search',
        arguments: { query: '🎉'.repeat(4097), limit: 10 },
      },
    });
    expect(oversizedEmojiQuery?.error?.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    expect(oversizedEmojiQuery?.error?.message).toBe('E_MCP_ARGUMENTS_INVALID');

    const badId = await handle({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'omcu.memory.show',
        arguments: { id: '../traversal' },
      },
    });
    expect(badId?.error?.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    expect(badId?.error?.message).toBe('E_MCP_ID_INVALID');

    const absent = await handle({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'omcu.memory.show',
        arguments: { id: 'absent-id' },
      },
    });
    expect(absent?.error?.code).toBe(JSONRPC_ERRORS.APPLICATION_ERROR);
    expect(absent?.error?.message).toBe('E_STATE_ABSENT');

    const hugeProposal = await handle({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'omcu.proposal.write',
        arguments: {
          id: 'huge-prop',
          proposal: { big: 'x'.repeat(70 * 1024) },
        },
      },
    });
    expect(hugeProposal?.error?.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    expect(hugeProposal?.error?.message).toBe('E_MCP_PROPOSAL_TOO_LARGE');

    // Multibyte string exceeding UTF-8 bytes even if string length < 64K
    const multibyteProposal = await handle({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'omcu.proposal.write',
        arguments: {
          id: 'emoji-prop',
          // 20000 4-byte emojis = 80000 UTF-8 bytes (> 64KB), but string length is ~40000 (< 64KB)
          proposal: { emoji: '🎉'.repeat(20000) },
        },
      },
    });
    expect(multibyteProposal?.error?.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    expect(multibyteProposal?.error?.message).toBe('E_MCP_PROPOSAL_TOO_LARGE');
  });

  it('bounds nesting depth, array entries, and object keys', async () => {
    const root = projectStateRoot(workspace());
    const handle = createMcpRequestHandler(root);

    let deep: Record<string, unknown> = { query: 'deep' };
    for (let i = 0; i < 20; i++) {
      deep = { nested: deep };
    }
    const deepCall = await handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'omcu.memory.search', arguments: deep },
    });
    expect(deepCall?.error?.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    expect(deepCall?.error?.message).toBe('E_MCP_NESTING_TOO_DEEP');

    const hugeArray = Array.from({ length: 1001 }, () => 1);
    const arrayCall = await handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: hugeArray,
    });
    expect(arrayCall?.error?.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    expect(arrayCall?.error?.message).toBe('E_MCP_ARRAY_TOO_LARGE');

    const hugeObj: Record<string, number> = {};
    for (let i = 0; i < 1001; i++) hugeObj[`k${i}`] = i;
    const objCall = await handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: hugeObj,
    });
    expect(objCall?.error?.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    expect(objCall?.error?.message).toBe('E_MCP_OBJECT_TOO_LARGE');

    const longKeyObj = { ['k'.repeat(300)]: 'value' };
    const keyCall = await handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: longKeyObj,
    });
    expect(keyCall?.error?.code).toBe(JSONRPC_ERRORS.INVALID_PARAMS);
    expect(keyCall?.error?.message).toBe('E_MCP_KEY_TOO_LONG');
  });
});

describe('serveMcpStdio framing and transport', () => {
  it('streams full MCP lifecycle cleanly through stdio', async () => {
    const root = projectStateRoot(workspace());
    const input = new PassThrough();
    const output = new PassThrough();
    const responses: string[] = [];

    output.on('data', (chunk) => {
      responses.push(chunk.toString('utf8'));
    });

    const serverPromise = serveMcpStdio(root, input, output);

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');

    input.end();
    await serverPromise;

    const lines = responses.join('').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    const parsedInit = JSON.parse(lines[0]!);
    expect(parsedInit.id).toBe(1);
    expect(parsedInit.result.serverInfo.version).toBe(PACKAGE_VERSION);

    const parsedList = JSON.parse(lines[1]!);
    expect(parsedList.id).toBe(2);
    expect(parsedList.result.tools).toHaveLength(4);
    const searchTool = parsedList.result.tools.find((t: { name: string }) => t.name === 'omcu.memory.search');
    expect(searchTool.inputSchema.properties.limit).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 100,
    });
  });

  it('handles small chunk fragmentation without quadratic copying or data loss', async () => {
    const root = projectStateRoot(workspace());
    const input = new PassThrough();
    const output = new PassThrough();
    const responses: string[] = [];

    output.on('data', (chunk) => responses.push(chunk.toString('utf8')));
    const serverPromise = serveMcpStdio(root, input, output);

    const message = JSON.stringify({ jsonrpc: '2.0', id: 'frag-1', method: 'ping' }) + '\n';
    for (let i = 0; i < message.length; i++) {
      input.write(Buffer.from(message[i]!, 'utf8'));
    }

    input.end();
    await serverPromise;

    const lines = responses.join('').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.id).toBe('frag-1');
    expect(parsed.result).toEqual({});
  });

  it('handles parse error and NUL byte correctly in stream', async () => {
    const root = projectStateRoot(workspace());
    const input = new PassThrough();
    const output = new PassThrough();
    const responses: string[] = [];

    output.on('data', (chunk) => responses.push(chunk.toString('utf8')));
    const serverPromise = serveMcpStdio(root, input, output);

    input.write('not valid json\n');
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping\0"}\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');

    input.end();
    await serverPromise;

    const lines = responses.join('').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);

    const parseErr = JSON.parse(lines[0]!);
    expect(parseErr.error.code).toBe(JSONRPC_ERRORS.PARSE_ERROR);
    expect(parseErr.error.message).toBe('E_MCP_PARSE_ERROR');

    const nulErr = JSON.parse(lines[1]!);
    expect(nulErr.error.code).toBe(JSONRPC_ERRORS.PARSE_ERROR);
    expect(nulErr.error.message).toBe('E_MCP_PARSE_ERROR');

    const pingRes = JSON.parse(lines[2]!);
    expect(pingRes.id).toBe(2);
    expect(pingRes.result).toEqual({});
  });

  it('bounds line size and recovers gracefully when line exceeds MAX_MCP_LINE_BYTES', async () => {
    const root = projectStateRoot(workspace());
    const input = new PassThrough();
    const output = new PassThrough();
    const responses: string[] = [];

    output.on('data', (chunk) => responses.push(chunk.toString('utf8')));
    const serverPromise = serveMcpStdio(root, input, output);

    const oversized = 'x'.repeat(MAX_MCP_LINE_BYTES + 100) + '\n';
    input.write(oversized);
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }) + '\n');

    input.end();
    await serverPromise;

    const lines = responses.join('').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);

    const lineErr = JSON.parse(lines[0]!);
    expect(lineErr.error.code).toBe(JSONRPC_ERRORS.INVALID_REQUEST);
    expect(lineErr.error.message).toBe('E_MCP_LINE_TOO_LARGE');

    const pingRes = JSON.parse(lines[1]!);
    expect(pingRes.id).toBe(99);
    expect(pingRes.result).toEqual({});
  });

  it('handles backpressure on writable output stream', async () => {
    const root = projectStateRoot(workspace());
    const input = new PassThrough();

    let drained = false;
    let writeCount = 0;
    const slowOutput = new Writable({
      highWaterMark: 1,
      write(chunk, encoding, callback) {
        writeCount++;
        if (writeCount === 1) {
          setTimeout(() => {
            drained = true;
            callback();
          }, 50);
        } else {
          callback();
        }
      },
    });

    const serverPromise = serveMcpStdio(root, input, slowOutput);

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');

    input.end();
    await serverPromise;

    expect(drained).toBe(true);
    expect(writeCount).toBe(2);
  });

  it('terminates gracefully when output stream closes during backpressure', async () => {
    const root = projectStateRoot(workspace());
    const input = new PassThrough();

    const closingOutput = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {
        setTimeout(() => {
          closingOutput.destroy();
        }, 10);
      },
    });

    const serverPromise = serveMcpStdio(root, input, closingOutput);

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');

    await expect(serverPromise).resolves.toBeUndefined();
  });

  it('rejects when output stream emits error during backpressure', async () => {
    const root = projectStateRoot(workspace());
    const input = new PassThrough();

    const erroringOutput = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, _callback) {
        setTimeout(() => {
          erroringOutput.destroy(new Error('E_PIPE_BROKEN'));
        }, 10);
      },
    });

    const serverPromise = serveMcpStdio(root, input, erroringOutput);

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');

    await expect(serverPromise).rejects.toThrow('E_PIPE_BROKEN');
  });

  it('rejects when output stream emits async error below the high-water mark', async () => {
    const root = projectStateRoot(workspace());
    const input = new PassThrough();

    const erroringOutput = new Writable({
      highWaterMark: 1024 * 1024,
      write(_chunk, _encoding, callback) {
        setTimeout(() => {
          callback(new Error('EPIPE'));
        }, 10);
      },
    });

    const serverPromise = serveMcpStdio(root, input, erroringOutput);

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');

    await expect(serverPromise).rejects.toThrow('EPIPE');
  });

  it('rejects malformed UTF-8 input with E_MCP_PARSE_ERROR', async () => {
    const root = projectStateRoot(workspace());
    const input = new PassThrough();
    const output = new PassThrough();

    const serverPromise = serveMcpStdio(root, input, output);

    const invalidPayload = Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","id":1,"method":"omcu.proposal.write","params":{"id":"p1","proposal":{"bad":"'),
      Buffer.from([0xff, 0xff]),
      Buffer.from('"}一部}}\n'),
    ]);
    input.write(invalidPayload);

    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    input.end();

    await serverPromise;

    const lines = output.read()?.toString('utf8').trim().split('\n') ?? [];
    expect(lines).toHaveLength(2);

    const firstResponse = JSON.parse(lines[0]);
    expect(firstResponse.error.code).toBe(JSONRPC_ERRORS.PARSE_ERROR);
    expect(firstResponse.error.message).toBe('E_MCP_PARSE_ERROR');

    const secondResponse = JSON.parse(lines[1]);
    expect(secondResponse.id).toBe(2);
    expect(secondResponse.result).toEqual({});
  });
});



