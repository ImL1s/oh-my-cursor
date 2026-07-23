import assert from 'node:assert/strict';
import fs from 'node:fs';

const help = fs.readFileSync(new URL('../src/cli/application.ts', import.meta.url), 'utf8');
for (const command of ['setup', 'update', 'doctor', 'uninstall', 'capabilities', 'native-status', 'state', 'cancel', 'session', 'resume', 'recover', 'compact', 'memory', 'notify', 'tracker', 'wiki', 'mcp-server', 'mcp-install', 'workflow', 'ralplan', 'ralph', 'ulw', 'autopilot', 'pipeline', 'team', 'review', 'qa', 'accept', 'integrate', 'ask']) assert.ok(help.includes(command), `missing help: ${command}`);
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
for (const asset of ['.cursor-plugin', '.cursor/rules', '.mcp.json', 'agents', 'commands', 'hooks', 'skills', 'templates']) assert.ok(manifest.files.includes(asset), `missing package asset: ${asset}`);
assert.equal('createCliMutationAuthority' in await import('../dist/src/index.js'), false, 'authority factory must not be public');
console.log('CLI_PARITY:PASS');
