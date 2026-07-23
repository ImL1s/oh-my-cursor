import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = new URL('../dist/bin/omcu.js', import.meta.url);
for (const args of [['--version'], ['help']]) {
  const result = spawnSync(process.execPath, [cli.pathname, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim().length > 0);
}
console.log('CLI_SMOKE:PASS');
