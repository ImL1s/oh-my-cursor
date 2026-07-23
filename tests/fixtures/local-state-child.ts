import { createMcpRequestHandler } from '../../src/mcp/index.js';
import { ProjectMemoryStore } from '../../src/memory/index.js';
import { ensureExternalStateRoot } from '../../src/runtime/state-root.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [action, rootPath, id, value] = process.argv.slice(2);
if (rootPath === undefined || id === undefined) throw new Error('E_FIXTURE_ARGUMENTS');
const root = ensureExternalStateRoot(rootPath);

if (action === 'memory-hold-lock') {
  const lock = path.join(root.path, 'memory', 'index.json.lock');
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({
    schema_version: 1,
    pid: process.pid,
    token: crypto.randomBytes(16).toString('hex'),
    created_at_ms: Date.now(),
  }), { mode: 0o600 });
  process.stdout.write('ready\n');
  process.stdin.resume();
  await new Promise<void>((resolve) => process.stdin.once('end', resolve));
  fs.rmSync(lock, { recursive: true });
} else if (action === 'memory-put') {
  await new ProjectMemoryStore(root).put(value ?? id, {}, id);
} else if (action === 'proposal-write') {
  const response = await createMcpRequestHandler(root)({
    jsonrpc: '2.0',
    id: process.pid,
    method: 'tools/call',
    params: { name: 'omcu.proposal.write', arguments: { id, proposal: { value } } },
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
} else {
  throw new Error('E_FIXTURE_ACTION');
}
