import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/application.js';
import { buildHostLaunchPlan, shouldHostLaunch } from '../src/cli/host-launch.js';
import { TEAM_API_HELP } from '../src/team/index.js';

function tempCwd(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('side-effect-free CLI entry paths (#8)', () => {
  it('does not create .omcu for --help or --version in an empty cwd', async () => {
    const cwd = tempCwd('omcu-side-effect-');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = { stdout: (t: string) => stdout.push(t), stderr: (t: string) => stderr.push(t) };
    try {
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);
      expect(await runCli(['--version'], { cwd, packageRoot: path.resolve('.'), version: '0.3.0' }, io)).toBe(0);
      expect(stdout.join('')).toContain('0.3.0');
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);
      stdout.length = 0;
      expect(await runCli(['--help'], { cwd, packageRoot: path.resolve('.') }, io)).toBe(0);
      expect(stdout.join('')).toContain('oh-my-cursor');
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);
      expect(stderr).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('prints dedicated team api help without creating project state', async () => {
    for (const flag of ['--help', '-h']) {
      const cwd = tempCwd('omcu-team-api-help-');
      const stdout: string[] = [];
      const stderr: string[] = [];
      try {
        expect(await runCli(['team', 'api', flag], { cwd, packageRoot: path.resolve('.') }, {
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
        })).toBe(0);
        expect(stdout.join('')).toBe(TEAM_API_HELP);
        expect(stdout.join('')).toContain('send-message');
        expect(stdout.join('')).toContain('Examples:');
        expect(stderr).toEqual([]);
        expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  it('prints help/version from a read-only cwd without failing on state creation', async () => {
    const cwd = tempCwd('omcu-ro-');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = { stdout: (t: string) => stdout.push(t), stderr: (t: string) => stderr.push(t) };
    try {
      fs.chmodSync(cwd, 0o555);
      expect(await runCli(['--help'], { cwd, packageRoot: path.resolve('.') }, io)).toBe(0);
      expect(stdout.join('')).toContain('Host launch');
      stdout.length = 0;
      expect(await runCli(['--version'], { cwd, packageRoot: path.resolve('.'), version: '0.3.0' }, io)).toBe(0);
      expect(stdout.join('')).toMatch(/0\.3\.0/);
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);
    } finally {
      fs.chmodSync(cwd, 0o755);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('launches a fake Cursor binary without creating project state', async () => {
    const cwd = tempCwd('omcu-host-no-state-');
    const fakeCursor = path.join(cwd, 'cursor-agent-fake');
    const capturedArgs = path.join(cwd, 'captured-args.txt');
    const priorCursorBin = process.env.OMCU_CURSOR_BIN;
    const priorLaunchPolicy = process.env.OMCU_LAUNCH_POLICY;
    const priorCapture = process.env.OMCU_FAKE_CAPTURE;
    fs.writeFileSync(fakeCursor, [
      '#!/bin/sh',
      'printf \'%s\\n\' "$@" > "$OMCU_FAKE_CAPTURE"',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o700 });
    process.env.OMCU_CURSOR_BIN = fakeCursor;
    process.env.OMCU_LAUNCH_POLICY = 'direct';
    process.env.OMCU_FAKE_CAPTURE = capturedArgs;
    try {
      for (const argv of [[], ['ship safely'], ['--madmax', 'ship safely']] as const) {
        expect(await runCli(argv, { cwd, packageRoot: path.resolve('.') }, {
          stdout: () => undefined,
          stderr: () => undefined,
        })).toBe(0);
        expect(fs.existsSync(capturedArgs), argv.join(' ')).toBe(true);
        expect(fs.existsSync(path.join(cwd, '.omcu')), argv.join(' ')).toBe(false);
      }
      expect(fs.readFileSync(capturedArgs, 'utf8')).toContain('--sandbox');
    } finally {
      if (priorCursorBin === undefined) delete process.env.OMCU_CURSOR_BIN;
      else process.env.OMCU_CURSOR_BIN = priorCursorBin;
      if (priorLaunchPolicy === undefined) delete process.env.OMCU_LAUNCH_POLICY;
      else process.env.OMCU_LAUNCH_POLICY = priorLaunchPolicy;
      if (priorCapture === undefined) delete process.env.OMCU_FAKE_CAPTURE;
      else process.env.OMCU_FAKE_CAPTURE = priorCapture;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not chmod an existing .omcu when running --version', async () => {
    const cwd = tempCwd('omcu-perm-');
    const omcu = path.join(cwd, '.omcu');
    const stdout: string[] = [];
    const io = { stdout: (t: string) => stdout.push(t), stderr: () => undefined };
    try {
      fs.mkdirSync(omcu, { mode: 0o750 });
      fs.chmodSync(omcu, 0o750);
      const before = fs.statSync(omcu).mode & 0o777;
      expect(await runCli(['--version'], { cwd, packageRoot: path.resolve('.'), version: '0.3.0' }, io)).toBe(0);
      const after = fs.statSync(omcu).mode & 0o777;
      expect(after).toBe(before);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects write-existing authority operations in an over-wide state root without chmodding it', async () => {
    const cwd = tempCwd('omcu-write-existing-mode-');
    const root = path.join(cwd, '.omcu');
    const stderr: string[] = [];
    try {
      fs.mkdirSync(root, { mode: 0o755 });
      fs.chmodSync(root, 0o755);
      expect(await runCli(['doctor', '--repair-owner'], { cwd, packageRoot: path.resolve('.') }, {
        stdout: () => undefined,
        stderr: (text) => stderr.push(text),
      })).toBe(1);
      expect(stderr.join('')).toContain('E_OWNER_ROOT_MODE_UNSAFE');
      expect(fs.statSync(root).mode & 0o777).toBe(0o755);
      expect(fs.existsSync(path.join(root, 'owner.json'))).toBe(false);

      stderr.length = 0;
      expect(await runCli([
        'workflow', 'lease-reconcile', '--id', 'r1', '--revision', '1',
        '--credential-json', JSON.stringify({
          run_id: 'r1', task_id: 'task', owner_id: 'owner', owner_pid: 2,
          owner_start_identity_sha256: 'a'.repeat(64), owner_start_identity_proven: true,
          owner_nonce_sha256: null, generation: 1, acquired_at: '2026-07-31T00:00:00.000Z',
          expected_status: 'ambiguous', expected_reason: 'legacy_nonce_unproven',
          operator_confirmation: 'owner-dead-side-effects-reviewed',
        }),
      ], { cwd, packageRoot: path.resolve('.') }, {
        stdout: () => undefined,
        stderr: (text) => stderr.push(text),
      })).toBe(1);
      expect(stderr.join('')).toContain('E_OWNER_ROOT_MODE_UNSAFE');
      expect(fs.statSync(root).mode & 0o777).toBe(0o755);
    } finally {
      fs.chmodSync(root, 0o700);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not create project state for grammar failures or host-launch planning', async () => {
    const cwd = tempCwd('omcu-grammar-');
    const stderr: string[] = [];
    const io = { stdout: () => undefined, stderr: (t: string) => stderr.push(t) };
    try {
      expect(await runCli(['workflow', 'instal', '--file', 'x'], { cwd, packageRoot: path.resolve('.') }, io)).toBe(1);
      expect(stderr.join('')).toContain('E_ACTION_INVALID');
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);

      stderr.length = 0;
      expect(await runCli(['worfklow'], { cwd, packageRoot: path.resolve('.') }, io)).toBe(1);
      expect(stderr.join('')).toContain('E_CLI_INVALID');
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);

      stderr.length = 0;
      expect(await runCli(['worfklow', '--madmax'], { cwd, packageRoot: path.resolve('.') }, io)).toBe(1);
      expect(stderr.join('')).toContain('E_CLI_INVALID');
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);

      stderr.length = 0;
      expect(await runCli(['notify', 'configure', '--generation', '0', '--enable'], {
        cwd, packageRoot: path.resolve('.'),
      }, io)).toBe(1);
      expect(stderr.join('')).toContain('E_OPTION_COMBINATION_REQUIRED');
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);

      stderr.length = 0;
      expect(await runCli(['team', 'api', 'not-an-operation', '--input', '{}'], {
        cwd, packageRoot: path.resolve('.'),
      }, io)).toBe(1);
      expect(stderr.join('')).toContain('E_TEAM_API_OPERATION_INVALID');
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);

      stderr.length = 0;
      expect(await runCli(['team', 'api', 'send-message', '--input', JSON.stringify({ team_name: 't1' })], {
        cwd, packageRoot: path.resolve('.'),
      }, io)).toBe(1);
      expect(stderr.join('')).toContain('E_TEAM_API_INPUT_INVALID');
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);

      stderr.length = 0;
      expect(await runCli(['memory', 'search', '--query', 'x', '--limit', '-1'], { cwd, packageRoot: path.resolve('.') }, io)).toBe(1);
      expect(stderr.join('')).toContain('E_INTEGER_RANGE');
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);

      for (const invalid of [
        ['state', 'create', '--id', 'bad/id', '--objective', 'test'],
        ['state', 'verify', '--id', 'r1', '--revision', '1', '--evidence-sha256', 'bad'],
        ['recover'],
      ] as const) {
        stderr.length = 0;
        expect(await runCli(invalid, { cwd, packageRoot: path.resolve('.') }, io)).toBe(1);
        expect(stderr.join('')).toMatch(/E_(OPTION_FORMAT_INVALID|OPTION_COMBINATION_REQUIRED)/);
        expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);
      }

      stderr.length = 0;
      expect(await runCli(['--json-errors', 'worfklow', 'list'], {
        cwd, packageRoot: path.resolve('.'),
      }, io)).toBe(1);
      expect(JSON.parse(stderr.join(''))).toMatchObject({
        code: 'E_CLI_INVALID',
        token: 'worfklow',
        usage: expect.stringContaining('Usage: omcu'),
      });
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);

      expect(shouldHostLaunch(['fix the tests'])).toBe(true);
      const promptPlan = buildHostLaunchPlan(['fix the tests'], {
        packageRoot: path.resolve('.'),
        env: { ...process.env, OMCU_CURSOR_BIN: process.execPath },
      });
      expect(promptPlan.argv).toContain('fix the tests');
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('escapes terminal control characters in human parse errors', async () => {
    const cwd = tempCwd('omcu-control-error-');
    const stderr: string[] = [];
    try {
      expect(await runCli([`bad\u001b[31m\ncommand`, 'status'], { cwd, packageRoot: path.resolve('.') }, {
        stdout: () => undefined,
        stderr: (text) => stderr.push(text),
      })).toBe(1);
      const output = stderr.join('');
      expect(output).not.toContain('\u001b');
      expect(output).toContain('\\u001b');
      expect(output).toContain('\\u000a');
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('redacts secret-shaped unknown command and action tokens in human and JSON errors', async () => {
    const cwd = tempCwd('omcu-redacted-error-');
    const stderr: string[] = [];
    const secret = 'ghp_1234567890abcdef';
    try {
      expect(await runCli(['workflow', `token=${secret}\u001b`], { cwd, packageRoot: path.resolve('.') }, {
        stdout: () => undefined,
        stderr: (text) => stderr.push(text),
      })).toBe(1);
      expect(stderr.join('')).not.toContain(secret);
      expect(stderr.join('')).not.toContain('\u001b');
      expect(stderr.join('')).toContain('<redacted>');

      stderr.length = 0;
      expect(await runCli(['--json-errors', `Bearer ${secret}`, 'status'], { cwd, packageRoot: path.resolve('.') }, {
        stdout: () => undefined,
        stderr: (text) => stderr.push(text),
      })).toBe(1);
      const envelope = JSON.parse(stderr.join('')) as { token: string; message: string; command_path: string };
      expect(JSON.stringify(envelope)).not.toContain(secret);
      expect(envelope.token).toBe('<redacted>');
      expect(envelope.command_path).toBe('<redacted>');
      expect(envelope.message).toContain('Bearer <redacted>');
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a terminator used as a spaced value before state creation', async () => {
    const cwd = tempCwd('omcu-literal-terminator-');
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const code = await runCli(['run', 'create', '--id', 'r1', '--objective', '--'], {
        cwd, packageRoot: path.resolve('.'),
      }, {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });
      expect(code).toBe(1);
      expect(stderr.join('')).toContain('E_OPTION_REQUIRED');
      expect(stdout).toEqual([]);
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('emits structured parse errors before any state side effect', async () => {
    const cwd = tempCwd('omcu-json-errors-');
    const stderr: string[] = [];
    try {
      const code = await runCli([
        '--json-errors', 'state', 'create', '--id', 'r1', '--objective', '',
      ], { cwd, packageRoot: path.resolve('.') }, {
        stdout: () => undefined,
        stderr: (text) => stderr.push(text),
      });
      expect(code).toBe(1);
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);
      expect(JSON.parse(stderr.join(''))).toMatchObject({
        code: 'E_OPTION_FORMAT_INVALID',
        command_path: 'state create',
        token: '--objective',
        message: expect.stringContaining('E_OPTION_FORMAT_INVALID'),
        usage: expect.stringContaining('Usage: omcu state create'),
      });
      stderr.length = 0;
      expect(await runCli(['--json-errors', 'team', 'start', '--id', 't1', '--workers-json', '{}'], {
        cwd, packageRoot: path.resolve('.'),
      }, { stdout: () => undefined, stderr: (text) => stderr.push(text) })).toBe(1);
      expect(JSON.parse(stderr.join(''))).toMatchObject({
        code: 'E_JSON_DOMAIN_INVALID',
        command_path: 'team start',
        token: '--workers-json',
        usage: expect.stringContaining('Usage: omcu team start'),
      });
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not create state for read-only actions when project state is absent', async () => {
    const invocations: readonly string[][] = [
      ['memory', 'list'],
      ['workflow', 'list'],
      ['persist', 'status'],
      ['notify', 'status'],
      ['team', 'status', '--id', 'missing'],
      ['team', 'collect', '--id', 'missing'],
      ['team', 'api', 'mailbox-list', '--input', '{"team_name":"missing","worker":"one"}'],
      ['team', 'api', '--op', 'list-tasks', '--input', '{"team_name":"missing"}'],
      ['team', 'api', 'get-summary', '--input', '{"team_name":"missing"}'],
      ['state', 'status', '--id', 'missing'],
      ['lease', 'status', '--run', 'missing', '--name', 'main'],
    ];
    for (const argv of invocations) {
      const cwd = tempCwd('omcu-read-absent-');
      const stderr: string[] = [];
      try {
        const code = await runCli(argv, { cwd, packageRoot: path.resolve('.') }, {
          stdout: () => undefined,
          stderr: (text) => stderr.push(text),
        });
        expect(code, argv.join(' ')).toBe(1);
        expect(stderr.join(''), argv.join(' ')).toContain('E_STATE_ROOT_ABSENT');
        expect(fs.existsSync(path.join(cwd, '.omcu')), argv.join(' ')).toBe(false);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  it('rejects overlong team task references before creating project state', async () => {
    const taskId = '1'.repeat(21);
    for (const [operation, input] of [
      ['create-task', {
        team_name: 't1', subject: 'blocked task', description: 'wait for dependency', blocked_by: [taskId],
      }],
      ['claim-task', { team_name: 't1', task_id: taskId, worker: 'one' }],
      ['transition-task-status', {
        team_name: 't1', task_id: taskId, from: 'in_progress', to: 'completed', claim_token: 'token',
      }],
      ['release-task-claim', { team_name: 't1', task_id: taskId, worker: 'one', claim_token: 'token' }],
    ] as const) {
      const cwd = tempCwd('omcu-team-task-id-');
      const stderr: string[] = [];
      try {
        expect(await runCli(['team', 'api', operation, '--input', JSON.stringify(input)], {
          cwd, packageRoot: path.resolve('.'),
        }, { stdout: () => undefined, stderr: (text) => stderr.push(text) })).toBe(1);
        expect(stderr.join('')).toContain('E_TEAM_API_INPUT_INVALID');
        expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(false);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  it('read-only list/status paths do not initialize service files in an existing root', async () => {
    const cwd = tempCwd('omcu-read-existing-');
    const root = path.join(cwd, '.omcu');
    fs.mkdirSync(root, { mode: 0o700 });
    const before = fs.readdirSync(root);
    try {
      for (const argv of [['memory', 'list'], ['workflow', 'list'], ['persist', 'status']] as const) {
        expect(await runCli(argv, { cwd, packageRoot: path.resolve('.') }, {
          stdout: () => undefined,
          stderr: () => undefined,
        }), argv.join(' ')).toBe(0);
        expect(fs.readdirSync(root), argv.join(' ')).toEqual(before);
      }
      const stderr: string[] = [];
      expect(await runCli(['notify', 'status'], { cwd, packageRoot: path.resolve('.') }, {
        stdout: () => undefined, stderr: (text) => stderr.push(text),
      })).toBe(1);
      expect(stderr.join('')).toBe('E_STATE_ABSENT\n');
      expect(fs.readdirSync(root)).toEqual(before);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('observes state and leases without owner authority, locks, or root mtime changes', async () => {
    const cwd = tempCwd('omcu-observe-state-');
    const root = path.join(cwd, '.omcu');
    const runDir = path.join(root, 'runs', 'r1');
    const leaseDir = path.join(root, 'leases', 'r1');
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({
      store_kind: 'run_state', schema_version: 1, repository_id: 'OMCU', run_id: 'r1', revision: 1,
      status: 'active', objective: 'test', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      verification: { verified: false, evidence_sha256: null, verified_at: null },
      last_mutation: { source: 'omcu-cli', owner_token_sha256: 'a'.repeat(64), writer_pid: 1, mutated_at: '2026-01-01T00:00:00.000Z' },
    }));
    fs.writeFileSync(path.join(leaseDir, 'main.json'), JSON.stringify({
      store_kind: 'run_lease', schema_version: 1, repository_id: 'OMCU', run_id: 'r1', lease_name: 'main', owner: 'owner', generation: 1,
      expires_at: '2026-01-01T00:00:00.000Z',
      mutation: { source: 'omcu-cli', owner_token_sha256: 'a'.repeat(64), writer_pid: 1, mutated_at: '2026-01-01T00:00:00.000Z' },
    }));
    const fixed = new Date('2020-01-01T00:00:00.000Z');
    fs.utimesSync(root, fixed, fixed);
    const beforeMtime = fs.statSync(root).mtimeMs;
    const stdout: string[] = [];
    try {
      for (const argv of [
        ['state', 'status', '--id', 'r1'],
        ['run', 'status', '--id', 'r1'],
        ['lease', 'status', '--run', 'r1', '--name', 'main'],
      ] as const) {
        expect(await runCli(argv, { cwd, packageRoot: path.resolve('.') }, {
          stdout: (text) => stdout.push(text), stderr: () => undefined,
        })).toBe(0);
      }
      expect(stdout.join('')).toContain('"run_id": "r1"');
      expect(fs.existsSync(path.join(root, 'owner.json'))).toBe(false);
      expect(fs.readdirSync(root).some((name) => name.endsWith('.lock'))).toBe(false);
      expect(fs.statSync(root).mtimeMs).toBe(beforeMtime);

      const stderr: string[] = [];
      expect(await runCli(['state', 'status', '--id', 'missing'], { cwd, packageRoot: path.resolve('.') }, {
        stdout: () => undefined, stderr: (text) => stderr.push(text),
      })).toBe(1);
      expect(stderr.join('')).toContain('E_STATE_ABSENT');
      expect(fs.existsSync(path.join(root, 'owner.json'))).toBe(false);
      expect(fs.statSync(root).mtimeMs).toBe(beforeMtime);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('wraps corrupt read-only state and memory as E_STATE_CORRUPT', async () => {
    const cwd = tempCwd('omcu-read-corrupt-');
    const root = path.join(cwd, '.omcu');
    fs.mkdirSync(path.join(root, 'runs', 'bad'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, 'leases', 'bad'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, 'memory', 'records'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, 'runs', 'bad', 'state.json'), '{bad');
    fs.writeFileSync(path.join(root, 'leases', 'bad', 'main.json'), '{bad');
    fs.writeFileSync(path.join(root, 'memory', 'records', 'bad.json'), '{bad');
    try {
      for (const argv of [
        ['state', 'status', '--id', 'bad'],
        ['lease', 'status', '--run', 'bad', '--name', 'main'],
        ['memory', 'show', '--id', 'bad'],
        ['memory', 'list'],
      ] as const) {
        const stderr: string[] = [];
        expect(await runCli(argv, { cwd, packageRoot: path.resolve('.') }, {
          stdout: () => undefined, stderr: (text) => stderr.push(text),
        })).toBe(1);
        expect(stderr.join(''), argv.join(' ')).toContain('E_STATE_CORRUPT');
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects parseable memory records with invalid schema or filename identity', async () => {
    const cwd = tempCwd('omcu-read-schema-corrupt-');
    const records = path.join(cwd, '.omcu', 'memory', 'records');
    fs.mkdirSync(records, { recursive: true, mode: 0o700 });
    try {
      for (const [id, record] of [
        ['empty', {}],
        ['mismatch', { schema_version: 1, id: 'other', text: 'valid', metadata: {}, updated_at: new Date().toISOString() }],
        ['fields', { schema_version: 1, id: 'fields', text: 42, metadata: {}, updated_at: false }],
      ] as const) {
        fs.writeFileSync(path.join(records, `${id}.json`), JSON.stringify(record));
        const stderr: string[] = [];
        expect(await runCli(['memory', 'show', '--id', id], { cwd, packageRoot: path.resolve('.') }, {
          stdout: () => undefined, stderr: (text) => stderr.push(text),
        })).toBe(1);
        expect(stderr.join('')).toContain('E_STATE_CORRUPT');
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('repairs an invalid owner record only through explicit doctor --repair-owner', async () => {
    const cwd = tempCwd('omcu-owner-repair-');
    const root = path.join(cwd, '.omcu');
    const owner = path.join(root, 'owner.json');
    fs.mkdirSync(root, { mode: 0o700 });
    fs.writeFileSync(owner, '{"invalid":true}', { mode: 0o600 });
    try {
      await runCli(['doctor'], { cwd, packageRoot: path.resolve('.') }, { stdout: () => undefined, stderr: () => undefined });
      expect(fs.existsSync(owner)).toBe(true);

      const stdout: string[] = [];
      const code = await runCli(['doctor', '--repair-owner'], { cwd, packageRoot: path.resolve('.') }, {
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
      });
      const report = JSON.parse(stdout.join('')) as {
        exit_code: 0 | 1 | 2;
        owner_repair: { repaired: boolean };
      };
      // Owner repair is independent of live Cursor health. A machine without
      // cursor-agent correctly returns the doctor failure code after repair.
      expect(code).toBe(report.exit_code);
      expect([0, 1, 2]).toContain(code);
      expect(fs.existsSync(owner)).toBe(false);
      const quarantine = fs.readdirSync(root).filter((name) => name.startsWith('owner.json.invalid-'));
      expect(quarantine).toHaveLength(1);
      expect(report.owner_repair.repaired).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 40_000);

  it('still creates project state for mutating commands after validation', async () => {
    const cwd = tempCwd('omcu-mutate-');
    const stdout: string[] = [];
    const io = { stdout: (t: string) => stdout.push(t), stderr: () => undefined };
    try {
      expect(await runCli(['run', 'create', '--id', 'r1', '--objective', 'test'], { cwd, packageRoot: path.resolve('.') }, io)).toBe(0);
      expect(fs.existsSync(path.join(cwd, '.omcu'))).toBe(true);
      expect(stdout.join('')).toContain('"run_id": "r1"');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
