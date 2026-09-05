import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  MAX_OPTION_VALUE_BYTES,
  option,
  parseCli,
  renderCommandHelp,
  tokenizeArgs,
  validateArgsAgainstSchema,
} from '../src/cli/parser.js';

function reconciliationProof(): Record<string, unknown> {
  return {
    run_id: 'r1',
    task_id: 'task',
    owner_id: 'owner',
    owner_pid: 2,
    owner_start_identity_sha256: 'a'.repeat(64),
    owner_start_identity_proven: true,
    owner_nonce_sha256: null,
    generation: 1,
    acquired_at: '2026-07-31T00:00:00.000Z',
    expected_status: 'ambiguous',
    expected_reason: 'legacy_nonce_unproven',
    operator_confirmation: 'owner-dead-side-effects-reviewed',
  };
}

describe('strict CLI grammar (#12)', () => {
  it('accepts --key=value and -- end-of-options', () => {
    expect(option(['--id=run-1', '--objective', 'ship'], '--id')).toBe('run-1');
    expect(option(['--id', 'run-1'], '--id')).toBe('run-1');
    const tokenized = tokenizeArgs(['--id', 'a', '--', '--not-a-flag', 'pos'], new Set(['--id']));
    expect(tokenized.positionals).toEqual(['--not-a-flag', 'pos']);
    expect(tokenized.flags.get('--id')).toEqual(['a']);
  });

  it('rejects unknown and duplicate singleton options', () => {
    expect(() => validateArgsAgainstSchema(['--id', 'a', '--unknown', 'x'], {
      options: [{ name: '--id', kind: 'string' }],
    })).toThrow('E_OPTION_UNKNOWN');
    expect(() => validateArgsAgainstSchema(['--id', 'a', '--id', 'b'], {
      options: [{ name: '--id', kind: 'string' }],
    })).toThrow('E_OPTION_DUPLICATE');
    expect(() => option(['--id', 'a', '--id', 'b'], '--id')).toThrow('E_OPTION_DUPLICATE');
  });

  it('rejects unknown commands and misspelled actions before dispatch', () => {
    expect(() => parseCli(['not-a-real-command', 'list'])).toThrow('E_CLI_INVALID');
    expect(() => parseCli(['workflow', 'instal', '--file', 'x.json'])).toThrow('E_ACTION_INVALID');
    expect(() => parseCli(['recover', 'shwo', '--id', 'r1'])).toThrow('E_ACTION_INVALID');
    expect(() => parseCli(['memory', 'lst'])).toThrow('E_ACTION_INVALID');
    expect(() => parseCli(['state'])).toThrow('E_ACTION_REQUIRED');
    for (const inherited of ['constructor', 'toString', '__proto__']) {
      expect(() => parseCli([inherited, '--help'])).toThrow('E_CLI_INVALID');
      expect(() => parseCli(['workflow', inherited])).toThrow('E_ACTION_INVALID');
      expect(() => renderCommandHelp([inherited])).toThrow('E_CLI_INVALID');
    }
  });

  it('parses valid existing command surfaces', () => {
    expect(parseCli(['run', 'create', '--id', 'r1', '--objective', 'test'])).toMatchObject({
      command: 'run',
      action: 'create',
      args: ['--id', 'r1', '--objective', 'test'],
      options: { '--id': 'r1', '--objective': 'test' },
      positionals: [],
      stateAccess: 'write-ensure',
    });
    expect(parseCli(['run', 'create', '--id=r1', '--objective=test'])).toMatchObject({
      command: 'run',
      action: 'create',
      args: ['--id=r1', '--objective=test'],
    });
    expect(parseCli(['workflow', 'list'])).toMatchObject({
      command: 'workflow',
      action: 'list',
      args: [],
    });
    expect(parseCli(['persist'])).toMatchObject({
      command: 'persist',
      action: 'status',
      args: [],
    });
    expect(parseCli(['recover', '--transcript', '/tmp/t.jsonl'])).toMatchObject({
      command: 'recover',
      action: 'create',
      args: ['--transcript', '/tmp/t.jsonl'],
    });
    expect(parseCli(['ralph', '--', '--extra'])).toMatchObject({
      command: 'ralph',
      action: null,
      positionals: ['--extra'],
    });
  });

  it('keeps the documented non-host command examples compatible', () => {
    const evidenceSha = 'a'.repeat(64);
    const workers = JSON.stringify([
      { id: 'one', objective: 'implement', owned_paths: ['src/one'] },
    ]);
    const gates = JSON.stringify([
      {
        gate: 'plan',
        passed: true,
        verified: false,
        verification_authority: 'omcu-cli-only',
        evidence_sha256: evidenceSha,
      },
    ]);
    const documentedInvocations: readonly (readonly string[])[] = [
      ['help'],
      ['help', 'workflow', 'plan'],
      ['version'],
      ['setup', '--source', '/tmp/source', '--state-root', '/tmp/install-state'],
      ['update', '--source=/tmp/source', '--state-root=/tmp/install-state'],
      ['doctor'],
      ['doctor', '--repair-owner'],
      ['uninstall', '--receipt', '/tmp/receipt.json', '--state-root', '/tmp/install-state'],
      ['capabilities', 'discover'],
      ['capabilities', 'native-status'],
      ['native-status'],
      ['mcp-server'],
      ['mcp-install', '--file', '/tmp/mcp.json'],
      ['session', 'create'],
      ['session', 'list'],
      ['session', 'resume', '--id', 'chat-1', '--prompt', 'continue'],
      ['session', 'continue', '--prompt', 'continue'],
      ['resume', '--id', 'chat-1', '--prompt', 'continue'],
      ['state', 'create', '--id', 'run-1', '--objective', 'ship'],
      ['state', 'status', '--id', 'run-1'],
      ['state', 'transition', '--id', 'run-1', '--revision', '1', '--status', 'active'],
      ['state', 'verify', '--id', 'run-1', '--revision', '1', '--evidence-sha256', evidenceSha],
      ['state', 'event', '--id', 'run-1', '--type', 'note', '--payload-json', '{}'],
      ['run', 'create', '--id', 'run-1', '--objective', 'ship'],
      ['run', 'status', '--id', 'run-1'],
      ['run', 'transition', '--id', 'run-1', '--revision', '1', '--status', 'complete'],
      ['run', 'verify', '--id', 'run-1', '--revision', '1', '--evidence-sha256', evidenceSha],
      ['run', 'event', '--id', 'run-1', '--type', 'note', '--payload-json', '{}'],
      ['lease', 'acquire', '--run', 'run-1', '--name', 'execute', '--owner', 'owner-1', '--ttl-ms', '30000'],
      ['lease', 'status', '--run', 'run-1', '--name', 'execute'],
      ['lease', 'release', '--run', 'run-1', '--name', 'execute', '--owner', 'owner-1', '--generation', '1'],
      ['cancel', '--id', 'run-1'],
      ['recover', '--transcript', '/tmp/transcript.jsonl', '--id', 'recovery-1'],
      ['recover', '--transcript', '/tmp/transcript.jsonl', '--id', 'recovery-1', '--summary'],
      ['recover', '--project-jsonl', '/tmp/project.jsonl', '--id', 'recovery-1'],
      ['recover', 'show', '--id', 'recovery-1'],
      ['recover', 'show', '--id', 'recovery-1', '--summary'],
      ['compact', 'checkpoint', '--id', 'checkpoint-1', '--generation', '0', '--payload-json', '{}'],
      ['compact', 'show', '--id', 'checkpoint-1'],
      ['compact', 'render', '--id', 'checkpoint-1', '--generation', '0'],
      ['memory', 'put', '--text', 'remember this', '--id', 'memory-1', '--metadata-json', '{}'],
      ['memory', 'list'],
      ['memory', 'show', '--id', 'memory-1'],
      ['memory', 'search', '--query', 'remember', '--limit', '20'],
      ['memory', 'export'],
      ['memory', 'import', '--file', '/tmp/memory.json'],
      ['memory', 'rescan'],
      ['notify', 'status'],
      ['notify', 'configure', '--generation', '0'],
      ['notify', 'configure', '--generation', '0', '--enable', '--destination', 'test://sink'],
      ['notify', 'enqueue', '--payload-json', '{}', '--id', 'notification-1'],
      ['notify', 'show', '--id', 'notification-1'],
      ['notify', 'dispatch', '--id', 'notification-1', '--generation', '0', '--nonce', '0123456789abcdef'],
      ['tracker', 'record', '--id', 'subject-1', '--phase', 'created', '--detail-json', '{}'],
      ['tracker', 'history', '--id', 'subject-1'],
      ['wiki', 'render', '--slug', 'subject-1', '--tracker', 'subject-1', '--generation', '0', '--title', 'Subject'],
      ['wiki', 'show', '--slug', 'subject-1'],
      ['workflow', 'install', '--file', '/tmp/delivery.json'],
      ['workflow', 'list'],
      ['workflow', 'show', '--name', 'delivery', '--version', '1'],
      ['workflow', 'plan', '--name', 'delivery', '--version', '1', '--id', 'run-1', '--objective', 'ship safely'],
      ['workflow', 'plan', '--name', 'delivery', '--id', 'run-2', '--', 'ship safely'],
      ['workflow', 'run', '--id', 'run-1'],
      ['workflow', 'status', '--id', 'run-1'],
      ['workflow', 'replay', '--id', 'run-1'],
      ['workflow', 'lease-status', '--id', 'run-1'],
      ['workflow', 'lease-reconcile', '--id', 'run-1', '--revision', '1', '--credential-json', JSON.stringify(reconciliationProof())],
      ['team', 'start', '--id', 'team-1', '--workers-json', workers],
      ['team', 'run', '--id', 'team-1', '--workers-json', workers],
      ['team', 'status', '--id', 'team-1'],
      ['team', 'collect', '--id', 'team-1'],
      ['team', 'stop', '--id', 'team-1'],
      ['team', 'api', 'get-summary', '--input', '{}'],
      ['team', 'api', '--help'],
      ['persist'],
      ['persist', 'start', '--goal', 'finish', '--max-loops', '25', '--deadline-min', '120'],
      ['persist', 'stop'],
      ['persist', 'done'],
      ['persist', 'status'],
      ['persist', 'decide', '--input', '{}'],
      ['ralplan', '--objective', 'plan', '--rounds', '3'],
      ['ralph', '--objective', 'execute', '--iterations', '5'],
      ['ulw', '--id', 'ulw-1', '--workers-json', workers],
      ['autopilot', '--objective', 'ship'],
      ['autopilot', '--gates-json', gates],
      ['pipeline', '--gates-json', gates],
      ['review', '--prompt', 'review this', '--format', 'stream-json'],
      ['qa', '--prompt', 'test this', '--format', 'stream-json'],
      ['accept', '--prompt', 'accept this', '--format', 'stream-json'],
      ['integrate', '--prompt', 'integrate this', '--format', 'stream-json'],
      ['ask', '--prompt', 'answer this', '--format', 'stream-json'],
    ];

    for (const argv of documentedInvocations) {
      expect(() => parseCli(argv), argv.join(' ')).not.toThrow();
    }
  });

  it('allows objective values that start with dashes via --key=value', () => {
    expect(option(['--objective=--force-ship'], '--objective')).toBe('--force-ship');
    expect(parseCli(['ralplan', '--objective=--dashed', '--rounds', '2']).args).toContain('--objective=--dashed');
  });

  it('treats -- as end-of-options and requires equals syntax for a literal -- value', () => {
    expect(() => parseCli(['run', 'create', '--id', 'r1', '--objective', '--'])).toThrow('E_OPTION_REQUIRED');
    const parsed = parseCli(['run', 'create', '--id', 'r1', '--objective=--']);
    expect(parsed.options['--objective']).toBe('--');
    expect(option(parsed.args, '--objective')).toBe('--');
  });

  it('validates typed integer, enum, JSON, range, and combination semantics', () => {
    expect(() => parseCli(['memory', 'search', '--query', 'x', '--limit=-1'])).toThrow('E_INTEGER_RANGE');
    expect(() => parseCli(['memory', 'search', '--query', 'x', '--limit=1.5'])).toThrow('E_INTEGER_INVALID');
    expect(() => parseCli(['memory', 'search', '--query', 'x', '--limit=9007199254740992'])).toThrow('E_INTEGER_UNSAFE');
    expect(() => parseCli(['state', 'transition', '--id', 'r', '--revision', '1', '--status', 'done'])).toThrow('E_OPTION_ENUM_INVALID');
    expect(() => parseCli(['state', 'event', '--id', 'r', '--type', 'x', '--payload-json', '{bad'])).toThrow('E_JSON_INVALID');
    expect(() => parseCli(['state', 'event', '--id', 'r', '--type', 'x', '--payload-json', `"${'x'.repeat(MAX_OPTION_VALUE_BYTES)}"`])).toThrow('E_OPTION_TOO_LARGE');
    expect(() => parseCli(['recover', '--transcript', '/a', '--project-jsonl', '/b'])).toThrow('E_OPTION_COMBINATION_REQUIRED');
    expect(() => parseCli(['recover'])).toThrow('E_OPTION_COMBINATION_REQUIRED');
    expect(() => parseCli(['workflow', 'plan', '--name', 'x', '--id', 'r', '--objective', 'a', 'b'])).toThrow('E_OPTION_COMBINATION_REQUIRED');
    expect(() => parseCli(['team', 'start', '--id', 't1', '--workers-json', '{}'])).toThrow('E_JSON_DOMAIN_INVALID');
    expect(() => parseCli(['autopilot', '--gates-json', '{}'])).toThrow('E_JSON_DOMAIN_INVALID');
    expect(() => parseCli(['workflow', 'lease-reconcile', '--id', 'r1', '--revision', '1', '--credential-json', '{}'])).toThrow('E_JSON_DOMAIN_INVALID');
    expect(() => parseCli(['notify', 'enqueue', '--payload-json', '[]'])).toThrow('E_JSON_DOMAIN_INVALID');
    expect(() => parseCli(['recover', '--transcript', 'relative.jsonl'])).toThrow('E_OPTION_FORMAT_INVALID');
    expect(() => parseCli(['state', 'create', '--id', 'r', '--objective', 'x'.repeat(16_385)])).toThrow('E_OPTION_LENGTH_INVALID');
    expect(() => parseCli(['state', 'event', '--id', 'r', '--type', 'bad/type'])).toThrow('E_OPTION_FORMAT_INVALID');
    expect(() => parseCli(['persist', 'start', '--goal', 'x'.repeat(8193)])).toThrow('E_OPTION_LENGTH_INVALID');
    expect(() => parseCli(['notify', 'configure', '--generation', '0', '--enable', '--destination', 'x'.repeat(2049)])).toThrow('E_OPTION_LENGTH_INVALID');
    expect(() => parseCli(['notify', 'dispatch', '--id', 'n', '--generation', '0', '--nonce', 'short'])).toThrow('E_OPTION_LENGTH_INVALID');
    expect(() => parseCli(['wiki', 'render', '--slug', 'bad/slug', '--tracker', 't', '--generation', '0', '--title', 'x'])).toThrow('E_OPTION_FORMAT_INVALID');
    expect(() => parseCli(['workflow', 'show', '--name', 'bad/name'])).toThrow('E_OPTION_FORMAT_INVALID');
    expect(() => parseCli(['workflow', 'lease-reconcile', '--id', 'r1', '--revision', '1', '--credential-json', JSON.stringify({
      run_id: 'r1', task_id: 'task', owner_id: 'owner', owner_pid: 2,
      owner_start_identity: 'start', owner_start_identity_proven: true,
      owner_nonce: 'a'.repeat(32), generation: 1,
    })])).toThrow('E_JSON_DOMAIN_INVALID');
    const tooManyWorkers = JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
      id: `w${index}`, objective: 'x', owned_paths: [`src/${index}`],
    })));
    expect(() => parseCli(['team', 'start', '--id', 't1', '--workers-json', tooManyWorkers]))
      .toThrow('E_JSON_DOMAIN_INVALID');
    expect(() => parseCli(['team', 'start', '--id', 't1', '--workers-json', JSON.stringify([
      { id: 'one', objective: 'x', owned_paths: ['src'] },
      { id: 'two', objective: 'y', owned_paths: ['src/nested'] },
    ])])).toThrow('E_JSON_DOMAIN_INVALID');
  });

  it('generates command/action help from the same schema', () => {
    expect(parseCli(['help', 'workflow'])).toMatchObject({ command: 'help', args: ['workflow'] });
    expect(parseCli(['workflow', '--help'])).toMatchObject({ command: 'help', args: ['workflow'] });
    expect(parseCli(['workflow', 'plan', '--help'])).toMatchObject({ command: 'help', args: ['workflow', 'plan'] });
    expect(parseCli(['ralplan', '--objective', '--help'])).toMatchObject({ command: 'ralplan', options: { '--objective': '--help' } });
    expect(parseCli(['ralplan', '--objective', '-h'])).toMatchObject({ command: 'ralplan', options: { '--objective': '-h' } });
    expect(parseCli(['ralplan', '--objective=--help'])).toMatchObject({ command: 'ralplan', options: { '--objective': '--help' } });
    expect(renderCommandHelp(['workflow', 'plan'])).toContain('--objective');
    expect(renderCommandHelp(['workflow', 'plan'])).toContain('--name');
    expect(() => parseCli(['state', 'create', '--bogus', 'x', '--help'])).toThrow('E_OPTION_UNKNOWN');
    expect(() => parseCli(['state', 'create', '--id', 'a', '--id', 'b', '--help'])).toThrow('E_OPTION_DUPLICATE');
  });

  it('routes team api help flags to its dedicated operation help', () => {
    for (const flag of ['--help', '-h']) {
      expect(parseCli(['team', 'api', flag])).toMatchObject({
        command: 'team',
        action: 'api',
        args: [flag],
        positionals: ['help'],
        stateAccess: 'none',
      });
    }
  });

  it('classifies option-dependent project state access', () => {
    expect(parseCli(['setup']).stateAccess).toBe('none');
    expect(parseCli(['setup', '--init-project-state']).stateAccess).toBe('write-ensure');
    expect(parseCli(['doctor']).stateAccess).toBe('none');
    expect(parseCli(['doctor', '--repair-owner']).stateAccess).toBe('write-existing');
    expect(parseCli(['workflow', 'lease-status', '--id', 'r1']).stateAccess).toBe('read-existing');
    expect(parseCli(['workflow', 'lease-reconcile', '--id', 'r1', '--revision', '1', '--credential-json', JSON.stringify(reconciliationProof())]).stateAccess).toBe('write-existing');
    expect(parseCli(['team', 'collect', '--id', 't1']).stateAccess).toBe('read-existing');
    for (const operation of ['mailbox-list', 'list-tasks', 'get-summary']) {
      expect(parseCli(['team', 'api', operation, '--input', '{}']).stateAccess).toBe('read-existing');
      expect(parseCli(['team', 'api', '--op', operation, '--input', '{}']).stateAccess).toBe('read-existing');
    }
    expect(parseCli(['team', 'api', 'create-task', '--input', '{}']).stateAccess).toBe('write-ensure');
  });

  it('validates notify enable/destination combinations before state access', () => {
    expect(() => parseCli(['notify', 'configure', '--generation', '0', '--enable']))
      .toThrow('E_OPTION_COMBINATION_REQUIRED');
    expect(() => parseCli(['notify', 'configure', '--generation', '0', '--destination', 'test://sink']))
      .toThrow('E_OPTION_COMBINATION_REQUIRED');
    expect(() => parseCli(['notify', 'configure', '--generation', '0', '--enable', '--destination', '   ']))
      .toThrow('E_OPTION_FORMAT_INVALID');
    expect(parseCli(['notify', 'configure', '--generation', '0'])).toMatchObject({
      stateAccess: 'write-ensure',
      options: { '--generation': 0 },
    });
    expect(parseCli(['notify', 'configure', '--generation', '0', '--enable', '--destination', 'test://sink']))
      .toMatchObject({ options: { '--generation': 0, '--enable': true, '--destination': 'test://sink' } });
  });

  it('provides canonical typed defaults and keeps typed handlers off raw argv parsers', () => {
    expect(parseCli(['memory', 'search', '--query', 'x']).options).toMatchObject({
      '--query': 'x',
      '--limit': 20,
    });
    expect(parseCli(['state', 'event', '--id', 'r1', '--type', 'note']).options['--payload-json']).toEqual({});
    for (const file of ['lifecycle.ts', 'local-services.ts', 'orchestration.ts']) {
      const source = fs.readFileSync(new URL(`../src/cli/${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/from ['"]\.\/parser\.js['"]/);
      expect(source).not.toMatch(/\b(option|integerOption|jsonOption|requiredOption|hasFlag|parsedPositionals)\s*\(/);
    }
  });
});
