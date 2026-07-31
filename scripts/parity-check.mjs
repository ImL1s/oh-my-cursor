import assert from 'node:assert/strict';
import fs from 'node:fs';

const help = fs.readFileSync(new URL('../src/cli/application.ts', import.meta.url), 'utf8');
for (const command of ['setup', 'update', 'doctor', 'uninstall', 'capabilities', 'native-status', 'state', 'cancel', 'session', 'resume', 'recover', 'compact', 'memory', 'notify', 'tracker', 'wiki', 'mcp-server', 'mcp-install', 'workflow', 'ralplan', 'ralph', 'ulw', 'autopilot', 'pipeline', 'persist', 'team', 'review', 'qa', 'accept', 'integrate', 'ask']) assert.ok(help.includes(command), `missing help: ${command}`);
const { COMMAND_SCHEMAS, renderCommandHelp } = await import('../dist/src/cli/parser.js');
const REFERENCE_START = '<!-- OMCU:CLI-REFERENCE:START -->';
const REFERENCE_END = '<!-- OMCU:CLI-REFERENCE:END -->';

function optionReference(option) {
  const aliases = option.aliases?.length ? ` aliases=${option.aliases.join(',')}` : '';
  const required = option.required ? ' required' : '';
  const fallback = option.default === undefined ? '' : ` default=${JSON.stringify(option.default)}`;
  return `${option.name}:${option.kind}${required}${aliases}${fallback}`;
}

function referenceLine(path, schema) {
  const options = (schema.options ?? []).map(optionReference).join('; ') || 'none';
  const positionals = (schema.positionals ?? []).map((positional) => `${positional.name}${positional.required ? ':required' : ''}${positional.multiple ? ':multiple' : ''}`).join('; ') || 'none';
  return `- \`omcu ${path}\` | options: ${options} | positionals: ${positionals}`;
}

const referenceLines = [];
for (const [command, schema] of Object.entries(COMMAND_SCHEMAS)) {
  referenceLines.push(referenceLine(command, schema));
  for (const [action, actionSchema] of Object.entries(schema.actions ?? {})) {
    referenceLines.push(referenceLine(`${command} ${action}`, actionSchema));
  }
}
const generatedReference = `${REFERENCE_START}\n## Generated CLI reference\n\nDo not edit this block manually; it is generated from \`COMMAND_SCHEMAS\`.\n\n${referenceLines.join('\n')}\n${REFERENCE_END}`;

function replaceReference(doc) {
  const start = doc.indexOf(REFERENCE_START);
  const end = doc.indexOf(REFERENCE_END);
  if (start < 0 && end < 0) return `${doc.trimEnd()}\n\n${generatedReference}\n`;
  assert.ok(start >= 0 && end > start, 'malformed generated CLI reference markers');
  return `${doc.slice(0, start)}${generatedReference}${doc.slice(end + REFERENCE_END.length)}`;
}

if (process.argv.includes('--write-reference')) {
  for (const docName of ['cli.md', 'cli.zh.md', 'cli.zh-TW.md']) {
    const url = new URL(`../docs/${docName}`, import.meta.url);
    fs.writeFileSync(url, replaceReference(fs.readFileSync(url, 'utf8')));
  }
}
for (const [command, schema] of Object.entries(COMMAND_SCHEMAS)) {
  const commandHelp = renderCommandHelp([command]);
  assert.match(commandHelp, new RegExp(`^Usage: omcu ${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  for (const option of schema.options ?? []) {
    assert.ok(commandHelp.includes(option.name), `schema option missing from help: ${command} ${option.name}`);
  }
  for (const [action, actionSchema] of Object.entries(schema.actions ?? {})) {
    const actionHelp = renderCommandHelp([command, action]);
    assert.ok(actionHelp.startsWith(`Usage: omcu ${command} ${action}`), `wrong action usage: ${command} ${action}`);
    for (const option of actionSchema.options ?? []) {
      assert.ok(actionHelp.includes(option.name), `schema option missing from help: ${command} ${action} ${option.name}`);
    }
  }
}
let firstReference;
for (const docName of ['cli.md', 'cli.zh.md', 'cli.zh-TW.md']) {
  const doc = fs.readFileSync(new URL(`../docs/${docName}`, import.meta.url), 'utf8');
  const start = doc.indexOf(REFERENCE_START);
  const end = doc.indexOf(REFERENCE_END);
  assert.ok(start >= 0 && end > start, `missing generated CLI reference: ${docName}`);
  const reference = doc.slice(start, end + REFERENCE_END.length);
  assert.equal(reference, generatedReference, `stale generated CLI reference: ${docName}; run node scripts/parity-check.mjs --write-reference`);
  firstReference ??= reference;
  assert.equal(reference, firstReference, `translated CLI references differ: ${docName}`);
}
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
for (const asset of ['.cursor-plugin', '.cursor/rules', '.mcp.json', 'agents', 'commands', 'hooks', 'skills', 'templates']) assert.ok(manifest.files.includes(asset), `missing package asset: ${asset}`);
assert.equal('createCliMutationAuthority' in await import('../dist/src/index.js'), false, 'authority factory must not be public');
console.log('CLI_PARITY:PASS');
