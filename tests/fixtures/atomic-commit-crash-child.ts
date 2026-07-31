import fs from 'node:fs';
import path from 'node:path';
import {
  atomicCreateJson,
  atomicWriteJson,
  atomicWriteText,
} from '../../src/runtime/atomic.js';

const kind = process.argv[2];
const root = process.argv[3];
if ((kind !== 'json' && kind !== 'create' && kind !== 'text') || root === undefined) process.exit(2);

const file = path.join(root, kind === 'text' ? 'state.txt' : 'state.json');
if (kind === 'json') fs.writeFileSync(file, '{"before":true}\n', { mode: 0o600 });

let phase = 'missing-error';
try {
  if (kind === 'json') atomicWriteJson(file, { after: true }, { helperFaults: ['after_commit_crash'] });
  if (kind === 'create') atomicCreateJson(file, { created: true }, { helperFaults: ['after_commit_crash'] });
  if (kind === 'text') atomicWriteText(file, 'after\n', { helperFaults: ['after_commit_crash'] });
} catch (error) {
  phase = (error as { phase?: string }).phase ?? 'missing-phase';
}

process.stdout.write(JSON.stringify({
  phase,
  exists: fs.existsSync(file),
  content: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null,
}));
