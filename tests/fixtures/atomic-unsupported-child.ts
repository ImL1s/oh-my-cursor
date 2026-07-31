import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

Object.defineProperty(process, 'platform', { value: 'win32' });
const { atomicWriteJson } = await import('../../src/runtime/atomic.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-atomic-unsupported-'));
const file = path.join(root, 'state.json');
let phase = 'missing-error';
try {
  atomicWriteJson(file, { value: true });
} catch (error) {
  phase = (error as { phase?: string }).phase ?? 'missing-phase';
}
process.stdout.write(JSON.stringify({ phase, exists: fs.existsSync(file) }));
fs.rmSync(root, { recursive: true, force: true });
