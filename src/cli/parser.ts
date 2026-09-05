import path from 'node:path';
import { teamApiOperationStateAccess } from '../team/api-interop.js';

/**
 * Strict CLI grammar for non-host-launch OMCU commands.
 *
 * Supports:
 * - `--key value` and `--key=value`
 * - end-of-options `--` (remaining tokens are positionals / opaque)
 * - rejection of unknown and duplicate singleton flags
 * - rejection of unknown commands / actions before handlers run
 */

export interface ParsedCommand {
  readonly command: string;
  readonly action: string | null;
  readonly args: readonly string[];
  readonly options: Readonly<Record<string, string | number | boolean | unknown>>;
  readonly positionals: readonly string[];
  readonly stateAccess: StateAccess;
}

export type OptionKind = 'flag' | 'string' | 'integer' | 'json';
export type StateAccess = 'none' | 'read-existing' | 'write-existing' | 'write-ensure';

export interface PositionalSchema {
  readonly name: string;
  readonly required?: boolean;
  readonly multiple?: boolean;
  readonly pattern?: RegExp;
  readonly maxBytes?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly absolutePath?: boolean;
}

export interface OptionSchema {
  readonly name: string;
  readonly kind: OptionKind;
  readonly aliases?: readonly string[];
  /** When true, the option may appear more than once. */
  readonly multiple?: boolean;
  readonly required?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly enum?: readonly string[];
  readonly maxBytes?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly absolutePath?: boolean;
  readonly default?: string | number | boolean | unknown;
  readonly stateAccess?: StateAccess;
  readonly pattern?: RegExp;
  /** Decode and validate a parsed JSON value into the handler's domain type. */
  readonly jsonDomain?: JsonDomain;
}

export type JsonDomain = 'object' | 'team-workers' | 'ulw-workers' | 'gates' | 'workflow-lease-credential';

export interface ActionSchema {
  readonly options?: readonly OptionSchema[];
  readonly positionals?: readonly PositionalSchema[];
  readonly mutuallyExclusive?: readonly (readonly string[])[];
  readonly exactlyOneOf?: readonly (readonly string[])[];
  readonly allOrNoneOf?: readonly (readonly string[])[];
  readonly stateAccess?: StateAccess;
}

export interface CommandSchema {
  readonly actions?: Readonly<Record<string, ActionSchema>>;
  /** Commands without a required action (setup, cancel, ralph, …). */
  readonly options?: readonly OptionSchema[];
  readonly positionals?: readonly PositionalSchema[];
  readonly mutuallyExclusive?: readonly (readonly string[])[];
  readonly exactlyOneOf?: readonly (readonly string[])[];
  readonly allOrNoneOf?: readonly (readonly string[])[];
  readonly stateAccess?: StateAccess;
  /** When set, an action token is required and must be one of the keys. */
  readonly requireAction?: boolean;
  /** Action used when none is provided (e.g. recover default). */
  readonly defaultAction?: string;
}

export const MAX_CLI_TOKENS = 256;
export const MAX_CLI_BYTES = 256 * 1024;
export const MAX_OPTION_VALUE_BYTES = 64 * 1024;
const SAFE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TEAM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NON_BLANK_PATTERN = /\S/;
const SAFE_TEAM_WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SAFE_ULW_WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const objectJson = (name: string, required = false, defaultValue?: unknown): OptionSchema => ({
  name,
  kind: 'json',
  ...(required ? { required: true } : {}),
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
  jsonDomain: 'object',
});
const workersJson = (domain: 'team-workers' | 'ulw-workers'): OptionSchema => ({
  name: '--workers-json',
  kind: 'json',
  required: true,
  jsonDomain: domain,
});
const gatesJson = (): OptionSchema => ({ name: '--gates-json', kind: 'json', jsonDomain: 'gates' });

/** Known top-level commands that are not host-launch. Host-launch tokens are handled elsewhere. */
export const COMMAND_SCHEMAS: Readonly<Record<string, CommandSchema>> = Object.freeze({
  help: { stateAccess: 'none', positionals: [{ name: 'command' }, { name: 'action' }] },
  version: { stateAccess: 'none' },
  setup: {
    stateAccess: 'none',
    options: [
      { name: '--source', kind: 'string' },
      { name: '--archive', kind: 'string' },
      { name: '--checksums', kind: 'string' },
      { name: '--tag', kind: 'string' },
      { name: '--latest', kind: 'flag' },
      { name: '--state-root', kind: 'string' },
      { name: '--init-project-state', kind: 'flag', stateAccess: 'write-ensure' },
      { name: '--dry-run', kind: 'flag' },
    ],
  },
  update: {
    stateAccess: 'none',
    options: [
      { name: '--source', kind: 'string' },
      { name: '--archive', kind: 'string' },
      { name: '--checksums', kind: 'string' },
      { name: '--tag', kind: 'string' },
      { name: '--latest', kind: 'flag' },
      { name: '--state-root', kind: 'string' },
      { name: '--init-project-state', kind: 'flag', stateAccess: 'write-ensure' },
      { name: '--dry-run', kind: 'flag' },
    ],
  },
  install: {
    stateAccess: 'none',
    requireAction: true,
    actions: {
      status: {
        options: [
          { name: '--state-root', kind: 'string' },
        ],
      },
      list: {
        options: [
          { name: '--state-root', kind: 'string' },
        ],
      },
      verify: {
        options: [
          { name: '--state-root', kind: 'string' },
          { name: '--all', kind: 'flag' },
        ],
      },
      prune: {
        options: [
          { name: '--state-root', kind: 'string' },
          { name: '--dry-run', kind: 'flag' },
          { name: '--apply', kind: 'flag' },
          { name: '--keep', kind: 'integer', min: 0, default: 2 },
        ],
        mutuallyExclusive: [['--dry-run', '--apply']],
      },
      repair: {
        options: [
          { name: '--state-root', kind: 'string' },
        ],
      },
    },
  },
  rollback: {
    stateAccess: 'none',
    options: [
      { name: '--receipt', kind: 'string' },
      { name: '--state-root', kind: 'string' },
      { name: '--dry-run', kind: 'flag' },
    ],
  },
  doctor: { stateAccess: 'none', options: [{ name: '--repair-owner', kind: 'flag', stateAccess: 'write-existing' }, { name: '--repair-journals', kind: 'flag', stateAccess: 'write-existing' }] },
  uninstall: {
    stateAccess: 'none',
    options: [
      { name: '--receipt', kind: 'string' },
      { name: '--state-root', kind: 'string' },
      { name: '--purge-project-state', kind: 'flag' },
    ],
  },
  plugin: {
    stateAccess: 'none',
    requireAction: true,
    actions: {
      status: {
        options: [
          { name: '--json', kind: 'flag' },
          { name: '--state-root', kind: 'string' },
        ],
      },
      doctor: {
        options: [
          { name: '--live', kind: 'flag' },
          { name: '--json', kind: 'flag' },
          { name: '--state-root', kind: 'string' },
        ],
      },
    },
  },
  components: {
    stateAccess: 'none',
    requireAction: true,
    actions: {
      list: {
        options: [
          { name: '--resolved', kind: 'flag' },
          { name: '--json', kind: 'flag' },
          { name: '--state-root', kind: 'string' },
        ],
      },
    },
  },
  aliases: {
    stateAccess: 'none',
    requireAction: true,
    actions: {
      explain: {
        options: [
          { name: '--json', kind: 'flag' },
        ],
        positionals: [
          { name: 'name', required: true, minLength: 1 },
        ],
      },
    },
  },
  agents: {
    stateAccess: 'none',
    requireAction: true,
    actions: {
      list: {
        options: [
          { name: '--source', kind: 'string', enum: ['omc', 'omx', 'omo', 'omcu', 'custom', 'all'] },
          { name: '--json', kind: 'flag' },
        ],
      },
      show: {
        options: [
          { name: '--profile', kind: 'string' },
          { name: '--json', kind: 'flag' },
        ],
        positionals: [
          { name: 'role', required: true, minLength: 1 },
        ],
      },
      invoke: {
        options: [
          { name: '--prompt', kind: 'string', required: true, pattern: NON_BLANK_PATTERN },
          { name: '--runtime', kind: 'string', enum: ['local', 'cloud'], default: 'local' },
          { name: '--background', kind: 'flag' },
          { name: '--profile', kind: 'string' },
          { name: '--json', kind: 'flag' },
        ],
        positionals: [
          { name: 'role', required: true, minLength: 1 },
        ],
      },
    },
  },
  route: {
    stateAccess: 'none',
    requireAction: true,
    actions: {
      explain: {
        options: [
          { name: '--agent', kind: 'string', required: true },
          { name: '--profile', kind: 'string' },
          { name: '--model', kind: 'string' },
          { name: '--runtime', kind: 'string', enum: ['local', 'cloud'] },
          { name: '--json', kind: 'flag' },
        ],
      },
    },
  },
  hooks: {
    stateAccess: 'none',
    requireAction: true,
    actions: {
      list: {
        options: [
          { name: '--event', kind: 'string' },
          { name: '--json', kind: 'flag' },
        ],
      },
      show: {
        options: [
          { name: '--json', kind: 'flag' },
        ],
        positionals: [
          { name: 'id', required: true, minLength: 1 },
        ],
      },
      doctor: {
        options: [
          { name: '--live', kind: 'flag' },
          { name: '--json', kind: 'flag' },
        ],
      },
      trace: {
        options: [
          { name: '--run', kind: 'string' },
          { name: '--json', kind: 'flag' },
        ],
      },
      test: {
        options: [
          { name: '--fixture', kind: 'string' },
          { name: '--json', kind: 'flag' },
        ],
        positionals: [
          { name: 'event', required: true, minLength: 1 },
        ],
      },
      generate: {
        options: [
          { name: '--check', kind: 'flag' },
          { name: '--target', kind: 'string', enum: ['plugin', 'project'] },
          { name: '--json', kind: 'flag' },
        ],
      },
    },
  },
  capabilities: {
    stateAccess: 'none',
    requireAction: true,
    actions: {
      discover: {},
      'native-status': {},
      'cursor-components': {
        options: [
          { name: '--live', kind: 'flag' },
          { name: '--json', kind: 'flag' },
        ],
      },
    },
  },
  'native-status': { stateAccess: 'none' },
  'mcp-server': { stateAccess: 'write-ensure' },
  mcp: {
    stateAccess: 'none',
    requireAction: true,
    actions: {
      status: {
        options: [
          { name: '--file', kind: 'string' },
          { name: '--receipt', kind: 'string' },
          { name: '--no-probe', kind: 'flag' },
        ],
      },
      install: {
        options: [
          { name: '--file', kind: 'string' },
          { name: '--receipt', kind: 'string' },
          { name: '--dry-run', kind: 'flag' },
          { name: '--replace', kind: 'flag' },
        ],
      },
      uninstall: {
        options: [
          { name: '--file', kind: 'string' },
          { name: '--receipt', kind: 'string' },
          { name: '--dry-run', kind: 'flag' },
        ],
      },
    },
  },
  'mcp-install': {
    stateAccess: 'none',
    options: [
      { name: '--file', kind: 'string' },
      { name: '--receipt', kind: 'string' },
      { name: '--dry-run', kind: 'flag' },
      { name: '--replace', kind: 'flag' },
    ],
  },
  session: {
    stateAccess: 'none',
    requireAction: true,
    actions: {
      create: {},
      list: {},
      resume: { options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--prompt', kind: 'string', pattern: NON_BLANK_PATTERN }] },
      continue: { options: [{ name: '--prompt', kind: 'string', pattern: NON_BLANK_PATTERN }] },
    },
  },
  resume: {
    stateAccess: 'none',
    options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--prompt', kind: 'string', pattern: NON_BLANK_PATTERN }],
  },
  state: {
    requireAction: true,
    actions: {
      create: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--objective', kind: 'string', required: true, pattern: NON_BLANK_PATTERN, maxLength: 16_384 }] },
      status: { stateAccess: 'read-existing', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }] },
      transition: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--revision', kind: 'integer', required: true, min: 0 }, { name: '--status', kind: 'string', required: true, enum: ['active', 'complete', 'failed', 'cancelled'] }] },
      verify: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--revision', kind: 'integer', required: true, min: 0 }, { name: '--evidence-sha256', kind: 'string', required: true, pattern: SHA256_PATTERN }] },
      event: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--type', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, objectJson('--payload-json', false, {})] },
    },
  },
  run: {
    requireAction: true,
    actions: {
      create: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--objective', kind: 'string', required: true, pattern: NON_BLANK_PATTERN, maxLength: 16_384 }] },
      status: { stateAccess: 'read-existing', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }] },
      transition: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--revision', kind: 'integer', required: true, min: 0 }, { name: '--status', kind: 'string', required: true, enum: ['active', 'complete', 'failed', 'cancelled'] }] },
      verify: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--revision', kind: 'integer', required: true, min: 0 }, { name: '--evidence-sha256', kind: 'string', required: true, pattern: SHA256_PATTERN }] },
      event: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--type', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, objectJson('--payload-json', false, {})] },
    },
  },
  lease: {
    requireAction: true,
    actions: {
      status: { stateAccess: 'read-existing', options: [{ name: '--run', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--name', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }] },
      acquire: { stateAccess: 'write-ensure', options: [{ name: '--run', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--name', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--owner', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--ttl-ms', kind: 'integer', min: 1_000, max: 86_400_000, default: 30_000 }] },
      release: { stateAccess: 'write-ensure', options: [{ name: '--run', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--name', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--owner', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--generation', kind: 'integer', required: true, min: 1 }] },
    },
  },
  cancel: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }] },
  recover: {
    actions: {
      show: {
        stateAccess: 'read-existing',
        options: [
          { name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN },
          { name: '--summary', kind: 'flag' },
        ],
      },
      create: {
        stateAccess: 'write-ensure',
        options: [
          { name: '--transcript', kind: 'string', absolutePath: true },
          { name: '--project-jsonl', kind: 'string', absolutePath: true },
          { name: '--id', kind: 'string', pattern: SAFE_KEY_PATTERN },
          { name: '--summary', kind: 'flag' },
        ],
        exactlyOneOf: [['--transcript', '--project-jsonl']],
      },
    },
    defaultAction: 'create',
  },
  compact: {
    requireAction: true,
    actions: {
      checkpoint: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--generation', kind: 'integer', required: true, min: 0 }, objectJson('--payload-json', true)] },
      show: { stateAccess: 'read-existing', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }] },
      render: { stateAccess: 'read-existing', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--generation', kind: 'integer', required: true, min: 0 }] },
    },
  },
  memory: {
    requireAction: true,
    actions: {
      put: { stateAccess: 'write-ensure', options: [{ name: '--text', kind: 'string', required: true, pattern: NON_BLANK_PATTERN, maxBytes: 64 * 1024 }, { name: '--id', kind: 'string', pattern: SAFE_KEY_PATTERN }, objectJson('--metadata-json', false, {})] },
      list: { stateAccess: 'read-existing' },
      show: { stateAccess: 'read-existing', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }] },
      search: { stateAccess: 'read-existing', options: [{ name: '--query', kind: 'string', required: true, pattern: NON_BLANK_PATTERN, maxLength: 1024 }, { name: '--limit', kind: 'integer', min: 1, max: 100, default: 20 }] },
      export: { stateAccess: 'read-existing' },
      import: {
        stateAccess: 'write-ensure',
        options: [
          { name: '--file', kind: 'string', required: true },
          { name: '--conflict', kind: 'string', enum: ['reject', 'skip', 'replace', 'newer-wins'], default: 'reject' },
          { name: '--dry-run', kind: 'flag', stateAccess: 'read-existing' },
        ],
      },
      delete: {
        stateAccess: 'write-ensure',
        options: [
          { name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN },
          { name: '--expected-updated-at', kind: 'string', pattern: NON_BLANK_PATTERN },
        ],
      },
      doctor: {
        stateAccess: 'write-ensure',
        options: [
          { name: '--repair', kind: 'flag' },
        ],
      },
      rescan: { stateAccess: 'write-ensure' },
    },
  },
  notify: {
    requireAction: true,
    actions: {
      status: { stateAccess: 'read-existing' },
      configure: {
        stateAccess: 'write-ensure',
        options: [
          { name: '--generation', kind: 'integer', required: true, min: 0 },
          { name: '--enable', kind: 'flag' },
          { name: '--destination', kind: 'string', pattern: NON_BLANK_PATTERN, maxLength: 2048 },
        ],
        allOrNoneOf: [['--enable', '--destination']],
      },
      enqueue: { stateAccess: 'write-ensure', options: [objectJson('--payload-json', true), { name: '--id', kind: 'string', pattern: SAFE_KEY_PATTERN }] },
      show: { stateAccess: 'read-existing', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }] },
      dispatch: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--generation', kind: 'integer', required: true, min: 0 }, { name: '--nonce', kind: 'string', required: true, minLength: 16 }] },
    },
  },
  tracker: {
    requireAction: true,
    actions: {
      record: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--phase', kind: 'string', required: true, enum: ['created', 'started', 'checkpointed', 'completed', 'failed', 'cancelled'] }, objectJson('--detail-json', false, {})] },
      history: { stateAccess: 'read-existing', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }] },
    },
  },
  wiki: {
    requireAction: true,
    actions: {
      render: { stateAccess: 'write-ensure', options: [{ name: '--slug', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--tracker', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--generation', kind: 'integer', required: true, min: 0 }, { name: '--title', kind: 'string', required: true, pattern: NON_BLANK_PATTERN, maxLength: 512 }] },
      show: { stateAccess: 'read-existing', options: [{ name: '--slug', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }] },
    },
  },
  workflow: {
    requireAction: true,
    actions: {
      install: { stateAccess: 'write-ensure', options: [{ name: '--file', kind: 'string', required: true }] },
      list: { stateAccess: 'read-existing' },
      show: { stateAccess: 'read-existing', options: [{ name: '--name', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--version', kind: 'string', default: '1', pattern: SAFE_KEY_PATTERN }] },
      plan: { stateAccess: 'write-ensure', options: [{ name: '--name', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--version', kind: 'string', default: '1', pattern: SAFE_KEY_PATTERN }, { name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--objective', kind: 'string', pattern: NON_BLANK_PATTERN, maxLength: 16_384 }, { name: '--prompt', kind: 'string', pattern: NON_BLANK_PATTERN, maxLength: 16_384 }], positionals: [{ name: 'objective', pattern: NON_BLANK_PATTERN, maxLength: 16_384 }], exactlyOneOf: [['--objective', '--prompt', 'objective']] },
      run: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }] },
      status: { stateAccess: 'read-existing', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }] },
      replay: { stateAccess: 'read-existing', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }] },
      'lease-status': { stateAccess: 'read-existing', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }] },
      'lease-reconcile': { stateAccess: 'write-existing', options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, { name: '--revision', kind: 'integer', required: true, min: 1 }, { name: '--credential-json', kind: 'json', required: true, jsonDomain: 'workflow-lease-credential' }] },
    },
  },
  team: {
    requireAction: true,
    actions: {
      start: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: TEAM_ID_PATTERN }, workersJson('team-workers')] },
      run: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: TEAM_ID_PATTERN }, workersJson('team-workers')] },
      status: { stateAccess: 'read-existing', options: [{ name: '--id', kind: 'string', required: true, pattern: TEAM_ID_PATTERN }] },
      collect: { stateAccess: 'read-existing', options: [{ name: '--id', kind: 'string', required: true, pattern: TEAM_ID_PATTERN }] },
      stop: { stateAccess: 'write-ensure', options: [{ name: '--id', kind: 'string', required: true, pattern: TEAM_ID_PATTERN }] },
      api: {
        stateAccess: 'write-ensure',
        options: [
          { name: '--op', kind: 'string' },
          objectJson('--input', false, {}),
          { name: '--supervisor', kind: 'flag' },
          { name: '--help', kind: 'flag', aliases: ['-h'] },
        ],
        positionals: [{ name: 'operation' }],
        exactlyOneOf: [['--op', 'operation']],
      },
    },
  },
  persist: {
    actions: {
      start: { stateAccess: 'write-ensure', options: [{ name: '--goal', kind: 'string', required: true, pattern: NON_BLANK_PATTERN, maxLength: 8192 }, { name: '--max-loops', kind: 'integer', min: 1, max: 500, default: 25 }, { name: '--deadline-min', kind: 'integer', min: 1, max: 1440, default: 120 }] },
      stop: { stateAccess: 'write-ensure' },
      done: { stateAccess: 'write-ensure' },
      status: { stateAccess: 'read-existing' },
      decide: { stateAccess: 'write-existing', options: [{ name: '--input', kind: 'json' }] },
    },
    defaultAction: 'status',
  },
  ralplan: {
    stateAccess: 'none',
    options: [{ name: '--objective', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--prompt', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--rounds', kind: 'integer', min: 1, max: 10, default: 3 }],
    positionals: [{ name: 'objective', pattern: NON_BLANK_PATTERN }],
    exactlyOneOf: [['--objective', '--prompt', 'objective']],
  },
  ralph: {
    stateAccess: 'none',
    options: [{ name: '--objective', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--prompt', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--iterations', kind: 'integer', min: 1, max: 100, default: 5 }],
    positionals: [{ name: 'objective', pattern: NON_BLANK_PATTERN }],
    exactlyOneOf: [['--objective', '--prompt', 'objective']],
  },
  ulw: {
    stateAccess: 'none',
    options: [{ name: '--id', kind: 'string', required: true, pattern: SAFE_KEY_PATTERN }, workersJson('ulw-workers')],
  },
  autopilot: {
    stateAccess: 'none',
    options: [{ name: '--objective', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--prompt', kind: 'string', pattern: NON_BLANK_PATTERN }, gatesJson()],
    positionals: [{ name: 'objective', pattern: NON_BLANK_PATTERN }],
    exactlyOneOf: [['--objective', '--prompt', '--gates-json', 'objective']],
  },
  pipeline: {
    stateAccess: 'none',
    options: [{ name: '--objective', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--prompt', kind: 'string', pattern: NON_BLANK_PATTERN }, gatesJson()],
    positionals: [{ name: 'objective', pattern: NON_BLANK_PATTERN }],
    exactlyOneOf: [['--objective', '--prompt', '--gates-json', 'objective']],
  },
  review: {
    stateAccess: 'none',
    options: [{ name: '--objective', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--prompt', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--format', kind: 'string', enum: ['json', 'stream-json'], default: 'json' }],
    positionals: [{ name: 'objective', pattern: NON_BLANK_PATTERN }],
    exactlyOneOf: [['--objective', '--prompt', 'objective']],
  },
  qa: {
    stateAccess: 'none',
    options: [{ name: '--objective', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--prompt', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--format', kind: 'string', enum: ['json', 'stream-json'], default: 'json' }],
    positionals: [{ name: 'objective', pattern: NON_BLANK_PATTERN }],
    exactlyOneOf: [['--objective', '--prompt', 'objective']],
  },
  accept: {
    stateAccess: 'none',
    options: [{ name: '--objective', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--prompt', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--format', kind: 'string', enum: ['json', 'stream-json'], default: 'json' }],
    positionals: [{ name: 'objective', pattern: NON_BLANK_PATTERN }],
    exactlyOneOf: [['--objective', '--prompt', 'objective']],
  },
  integrate: {
    stateAccess: 'none',
    options: [{ name: '--objective', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--prompt', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--format', kind: 'string', enum: ['json', 'stream-json'], default: 'json' }],
    positionals: [{ name: 'objective', pattern: NON_BLANK_PATTERN }],
    exactlyOneOf: [['--objective', '--prompt', 'objective']],
  },
  ask: {
    stateAccess: 'none',
    options: [{ name: '--objective', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--prompt', kind: 'string', pattern: NON_BLANK_PATTERN }, { name: '--format', kind: 'string', enum: ['json', 'stream-json'], default: 'json' }],
    positionals: [{ name: 'objective', pattern: NON_BLANK_PATTERN }],
    exactlyOneOf: [['--objective', '--prompt', 'objective']],
  },
});

/** Canonical command names used by both parser dispatch and host-launch routing. */
export const COMMAND_NAMES: readonly string[] = Object.freeze(Object.keys(COMMAND_SCHEMAS));

export interface NearestCommand {
  readonly command: string;
  readonly distance: number;
}

export function nearestCommand(token: string, maximumDistance = 2): NearestCommand | null {
  if (token.startsWith('-') || token.length === 0) return null;
  let nearest: NearestCommand | null = null;
  for (const command of COMMAND_NAMES) {
    const distance = editDistance(token.toLocaleLowerCase(), command.toLocaleLowerCase());
    if (distance <= maximumDistance && (nearest === null || distance < nearest.distance
      || (distance === nearest.distance && command.localeCompare(nearest.command) < 0))) {
      nearest = { command, distance };
    }
  }
  return nearest;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (previous[rightIndex] ?? 0) + 1,
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? left.length;
}

const ACTION_COMMANDS = new Set(
  Object.entries(COMMAND_SCHEMAS)
    .filter(([, schema]) => schema.actions !== undefined)
    .map(([name]) => name),
);

export interface TokenizedArgs {
  readonly flags: ReadonlyMap<string, readonly string[] | true>;
  readonly positionals: readonly string[];
  readonly raw: readonly string[];
  readonly duplicateNames: ReadonlySet<string>;
}

export interface ValidatedArgs extends TokenizedArgs {
  readonly values: Readonly<Record<string, string | number | boolean | unknown>>;
  readonly namedPositionals: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/**
 * Tokenize argv fragments into flags/options and positionals.
 * Honors `--key=value`, `--key value`, and end-of-options `--`.
 */
export function tokenizeArgs(args: readonly string[], knownValueOptions?: ReadonlySet<string>): TokenizedArgs {
  assertArgvBounds(args);
  const flags = new Map<string, string[] | true>();
  const positionals: string[] = [];
  const duplicateNames = new Set<string>();
  let i = 0;
  while (i < args.length) {
    const token = args[i]!;
    if (token === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (token.startsWith('--') && token.includes('=') && token.length > 3) {
      const eq = token.indexOf('=');
      const name = token.slice(0, eq);
      const value = token.slice(eq + 1);
      recordFlag(flags, duplicateNames, name, value);
      i += 1;
      continue;
    }
    if (token.startsWith('--') || (token.startsWith('-') && token.length === 2 && token !== '-')) {
      const name = token;
      const next = args[i + 1];
      const isKnownValue = knownValueOptions?.has(name) === true;
      if (isKnownValue) {
        if (next === undefined || next === '--') throw new Error(`E_OPTION_REQUIRED: ${name}`);
        recordFlag(flags, duplicateNames, name, next);
        i += 2;
        continue;
      }
      if (next !== undefined && next !== '--' && !next.startsWith('-')) {
        recordFlag(flags, duplicateNames, name, next);
        i += 2;
        continue;
      }
      recordFlag(flags, duplicateNames, name, true);
      i += 1;
      continue;
    }
    positionals.push(token);
    i += 1;
  }
  return { flags, positionals, raw: args, duplicateNames };
}

function assertArgvBounds(args: readonly string[]): void {
  if (args.length > MAX_CLI_TOKENS) throw new Error(`E_CLI_TOO_MANY_TOKENS: max ${MAX_CLI_TOKENS}`);
  const bytes = args.reduce((total, token) => total + Buffer.byteLength(token), 0);
  if (bytes > MAX_CLI_BYTES) throw new Error(`E_CLI_TOO_LARGE: max ${MAX_CLI_BYTES} bytes`);
}

function recordFlag(
  flags: Map<string, string[] | true>,
  duplicates: Set<string>,
  name: string,
  value: string | true,
): void {
  const existing = flags.get(name);
  if (existing === undefined) {
    flags.set(name, value === true ? true : [value]);
    return;
  }
  duplicates.add(name);
  if (value === true) {
    flags.set(name, true);
    return;
  }
  if (existing === true) {
    flags.set(name, [value]);
    return;
  }
  existing.push(value);
}

export function validateArgsAgainstSchema(
  args: readonly string[],
  schema: ActionSchema | Pick<CommandSchema, 'options' | 'positionals' | 'mutuallyExclusive' | 'exactlyOneOf' | 'allOrNoneOf'>,
): ValidatedArgs {
  const options = schema.options ?? [];
  const byName = new Map<string, OptionSchema>();
  for (const opt of options) {
    byName.set(opt.name, opt);
    for (const alias of opt.aliases ?? []) byName.set(alias, opt);
  }
  const valueNames = new Set(
    options.filter((o) => o.kind !== 'flag').flatMap((o) => [o.name, ...(o.aliases ?? [])]),
  );
  const tokenized = tokenizeArgs(args, valueNames);
  const values: Record<string, string | number | boolean | unknown> = {};
  const seenCanonical = new Set<string>();

  for (const [name, value] of tokenized.flags) {
    const spec = byName.get(name);
    if (spec === undefined) throw new Error(`E_OPTION_UNKNOWN: ${name}`);
    if (seenCanonical.has(spec.name) && !spec.multiple) throw new Error(`E_OPTION_DUPLICATE: ${spec.name}`);
    seenCanonical.add(spec.name);
    if (tokenized.duplicateNames.has(name) && !spec.multiple) {
      throw new Error(`E_OPTION_DUPLICATE: ${name}`);
    }
    if (!spec.multiple && Array.isArray(value) && value.length > 1) {
      throw new Error(`E_OPTION_DUPLICATE: ${name}`);
    }
    if (spec.kind === 'flag' && value !== true) {
      throw new Error(`E_OPTION_FLAG_VALUE: ${name}`);
    }
    const rawValues = value === true ? [] : value;
    if (spec.kind === 'flag') {
      values[spec.name] = true;
      continue;
    }
    const parsed = rawValues.map((raw) => parseOptionValue(spec, raw));
    values[spec.name] = spec.multiple ? parsed : parsed[0]!;
  }

  for (const opt of options) {
    const present = tokenized.flags.has(opt.name)
      || (opt.aliases ?? []).some((a) => tokenized.flags.has(a));
    if (!present && opt.required) throw new Error(`E_OPTION_REQUIRED: ${opt.name}`);
    if (!present && opt.default !== undefined) values[opt.name] = opt.default;
  }

  const namedPositionals = validatePositionals(tokenized.positionals, schema.positionals ?? []);
  for (const group of schema.mutuallyExclusive ?? []) {
    if (group.filter((name) => argumentPresent(name, values, namedPositionals)).length > 1) {
      throw new Error(`E_OPTIONS_MUTUALLY_EXCLUSIVE: ${group.join(', ')}`);
    }
  }
  for (const group of schema.exactlyOneOf ?? []) {
    if (group.filter((name) => argumentPresent(name, values, namedPositionals)).length !== 1) {
      throw new Error(`E_OPTION_COMBINATION_REQUIRED: exactly one of ${group.join(', ')}`);
    }
  }
  for (const group of schema.allOrNoneOf ?? []) {
    const count = group.filter((name) => argumentPresent(name, values, namedPositionals)).length;
    if (count !== 0 && count !== group.length) {
      throw new Error(`E_OPTION_COMBINATION_REQUIRED: all or none of ${group.join(', ')}`);
    }
  }

  return { ...tokenized, values, namedPositionals };
}

function parseOptionValue(spec: OptionSchema, raw: string): string | number | unknown {
  const maxBytes = spec.maxBytes ?? MAX_OPTION_VALUE_BYTES;
  if (Buffer.byteLength(raw) > maxBytes) throw new Error(`E_OPTION_TOO_LARGE: ${spec.name}`);
  if (spec.kind === 'string') {
    if ((spec.minLength !== undefined && raw.length < spec.minLength)
      || (spec.maxLength !== undefined && raw.length > spec.maxLength)) {
      throw new Error(`E_OPTION_LENGTH_INVALID: ${spec.name}`);
    }
    if (spec.absolutePath === true && !path.isAbsolute(raw)) {
      throw new Error(`E_OPTION_FORMAT_INVALID: ${spec.name}`);
    }
    if (spec.pattern !== undefined && !spec.pattern.test(raw)) {
      throw new Error(`E_OPTION_FORMAT_INVALID: ${spec.name}`);
    }
    if (spec.enum !== undefined && !spec.enum.includes(raw)) {
      throw new Error(`E_OPTION_ENUM_INVALID: ${spec.name} (expected ${spec.enum.join('|')})`);
    }
    return raw;
  }
  if (spec.kind === 'integer') {
    if (!/^-?\d+$/.test(raw)) throw new Error(`E_INTEGER_INVALID: ${spec.name}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error(`E_INTEGER_UNSAFE: ${spec.name}`);
    if (spec.min !== undefined && value < spec.min) throw new Error(`E_INTEGER_RANGE: ${spec.name} >= ${spec.min}`);
    if (spec.max !== undefined && value > spec.max) throw new Error(`E_INTEGER_RANGE: ${spec.name} <= ${spec.max}`);
    return value;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`E_JSON_INVALID: ${spec.name}`);
  }
  return decodeJsonDomain(spec, parsed);
}

function jsonDomainInvalid(name: string): never {
  throw new Error(`E_JSON_DOMAIN_INVALID: ${name}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function nonBlankString(value: unknown, max = 32_768): value is string {
  return typeof value === 'string' && value.trim() !== '' && Buffer.byteLength(value) <= max;
}

function stringArray(value: unknown, requireNonEmpty = false): value is readonly string[] {
  return Array.isArray(value)
    && (!requireNonEmpty || value.length > 0)
    && value.every((entry) => nonBlankString(entry, 4096));
}

function decodeJsonDomain(spec: OptionSchema, value: unknown): unknown {
  if (spec.jsonDomain === undefined) return value;
  if (spec.jsonDomain === 'object') {
    if (!isObject(value)) jsonDomainInvalid(spec.name);
    return value;
  }
  if (spec.jsonDomain === 'team-workers' || spec.jsonDomain === 'ulw-workers') {
    const teamWorkers = spec.jsonDomain === 'team-workers';
    const maximum = teamWorkers ? 8 : 16;
    const idPattern = teamWorkers ? SAFE_TEAM_WORKER_ID_PATTERN : SAFE_ULW_WORKER_ID_PATTERN;
    if (!Array.isArray(value) || value.length === 0 || value.length > maximum) jsonDomainInvalid(spec.name);
    const ids = new Set<string>();
    const claims = new Map<string, string>();
    for (const worker of value) {
      if (!isObject(worker) || typeof worker.id !== 'string' || !idPattern.test(worker.id)
        || ids.has(worker.id) || !nonBlankString(worker.objective) || !stringArray(worker.owned_paths, true)
        || (worker.cwd !== undefined && (!nonBlankString(worker.cwd, 4096) || !path.isAbsolute(worker.cwd)))) {
        jsonDomainInvalid(spec.name);
      }
      ids.add(worker.id);
      for (const owned of worker.owned_paths) {
        if (!isCanonicalOwnedPath(owned)) jsonDomainInvalid(spec.name);
        const key = owned.toLowerCase();
        for (const [existing, owner] of claims) {
          if (owner !== worker.id && (key === existing || key.startsWith(`${existing}/`) || existing.startsWith(`${key}/`))) {
            jsonDomainInvalid(spec.name);
          }
        }
        claims.set(key, worker.id);
      }
    }
    return value;
  }
  if (spec.jsonDomain === 'gates') {
    const phases = new Set(['plan', 'execute', 'review', 'qa', 'acceptance']);
    if (!Array.isArray(value) || value.length === 0 || value.length > phases.size) jsonDomainInvalid(spec.name);
    const seen = new Set<string>();
    for (const gate of value) {
      if (!isObject(gate) || typeof gate.gate !== 'string' || !phases.has(gate.gate) || seen.has(gate.gate)
        || typeof gate.passed !== 'boolean' || gate.verified !== false
        || gate.verification_authority !== 'omcu-cli-only'
        || !(gate.evidence_sha256 === null || (typeof gate.evidence_sha256 === 'string' && SHA256_PATTERN.test(gate.evidence_sha256)))) {
        jsonDomainInvalid(spec.name);
      }
      seen.add(gate.gate);
    }
    return value;
  }
  if (!isObject(value)
    || !nonBlankString(value.run_id, 128) || !SAFE_KEY_PATTERN.test(value.run_id)
    || !nonBlankString(value.task_id, 128) || !SAFE_KEY_PATTERN.test(value.task_id)
    || !nonBlankString(value.owner_id, 128) || !SAFE_KEY_PATTERN.test(value.owner_id)
    || !Number.isSafeInteger(value.owner_pid) || (value.owner_pid as number) <= 1
    || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1
    || typeof value.owner_start_identity_sha256 !== 'string' || !SHA256_PATTERN.test(value.owner_start_identity_sha256)
    || typeof value.owner_start_identity_proven !== 'boolean'
    || !(value.owner_nonce_sha256 === null || (typeof value.owner_nonce_sha256 === 'string' && SHA256_PATTERN.test(value.owner_nonce_sha256)))
    || !nonBlankString(value.acquired_at, 128) || !Number.isFinite(Date.parse(value.acquired_at))
    || value.expected_status !== 'ambiguous'
    || !nonBlankString(value.expected_reason, 1024)
    || value.operator_confirmation !== 'owner-dead-side-effects-reviewed'
    || !hasExactKeys(value, [
      'run_id', 'task_id', 'owner_id', 'owner_pid', 'owner_start_identity_sha256',
      'owner_start_identity_proven', 'owner_nonce_sha256', 'generation', 'acquired_at',
      'expected_status', 'expected_reason', 'operator_confirmation',
    ])) jsonDomainInvalid(spec.name);
  return value;
}

function isCanonicalOwnedPath(owned: string): boolean {
  return owned !== ''
    && !path.isAbsolute(owned)
    && !owned.split(/[/\\]/).includes('..')
    && path.posix.normalize(owned) === owned
    && owned !== '.'
    && !owned.includes('\\')
    && !owned.endsWith('/');
}

function validatePositionals(
  positionals: readonly string[],
  schemas: readonly PositionalSchema[],
): Readonly<Record<string, string | readonly string[] | undefined>> {
  const result: Record<string, string | readonly string[] | undefined> = {};
  let offset = 0;
  for (const [index, schema] of schemas.entries()) {
    if (schema.multiple) {
      if (index !== schemas.length - 1) throw new Error(`E_SCHEMA_INVALID: repeated positional ${schema.name} must be last`);
      const rest = positionals.slice(offset);
      if (schema.required && rest.length === 0) throw new Error(`E_POSITIONAL_REQUIRED: ${schema.name}`);
      result[schema.name] = rest;
      offset = positionals.length;
      continue;
    }
    const value = positionals[offset];
    if (value === undefined) {
      if (schema.required) throw new Error(`E_POSITIONAL_REQUIRED: ${schema.name}`);
      result[schema.name] = undefined;
    } else {
      if (Buffer.byteLength(value) > (schema.maxBytes ?? MAX_OPTION_VALUE_BYTES)) throw new Error(`E_POSITIONAL_TOO_LARGE: ${schema.name}`);
      if ((schema.minLength !== undefined && value.length < schema.minLength)
        || (schema.maxLength !== undefined && value.length > schema.maxLength)) {
        throw new Error(`E_POSITIONAL_LENGTH_INVALID: ${schema.name}`);
      }
      if (schema.absolutePath === true && !path.isAbsolute(value)) throw new Error(`E_POSITIONAL_FORMAT_INVALID: ${schema.name}`);
      if (schema.pattern !== undefined && !schema.pattern.test(value)) throw new Error(`E_POSITIONAL_FORMAT_INVALID: ${schema.name}`);
      result[schema.name] = value;
      offset += 1;
    }
  }
  if (offset < positionals.length) throw new Error(`E_POSITIONAL_UNEXPECTED: ${positionals[offset]}`);
  return result;
}

function argumentPresent(
  name: string,
  values: Readonly<Record<string, unknown>>,
  positionals: Readonly<Record<string, unknown>>,
): boolean {
  const value = name.startsWith('-') ? values[name] : positionals[name];
  return Array.isArray(value) ? value.length > 0 : value !== undefined;
}

export function parseCli(argv: readonly string[]): ParsedCommand {
  assertArgvBounds(argv);
  if (argv.length === 0 || (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0] ?? ''))) {
    return parsedResult('help', null, [], validateArgsAgainstSchema([], COMMAND_SCHEMAS.help!), 'none');
  }
  if (argv.length === 1 && ['version', '--version', '-v'].includes(argv[0] ?? '')) {
    return parsedResult('version', null, [], validateArgsAgainstSchema([], COMMAND_SCHEMAS.version!), 'none');
  }
  if (argv[0] === 'help') {
    const target = argv.slice(1);
    validateHelpTarget(target);
    return parsedResult('help', null, target, validateArgsAgainstSchema(target, COMMAND_SCHEMAS.help!), 'none');
  }
  const [command = '', possibleAction, ...rest] = argv;

  if (!Object.hasOwn(COMMAND_SCHEMAS, command)) {
    throw new Error(`E_CLI_INVALID: unknown command: ${command}`);
  }
  const schema = COMMAND_SCHEMAS[command]!;

  if (!ACTION_COMMANDS.has(command)) {
    const args = argv.slice(1);
    if (isHelpRequest(args)) {
      const target = [command];
      return parsedResult('help', null, target, validateArgsAgainstSchema(target, COMMAND_SCHEMAS.help!), 'none');
    }
    const validated = validateArgsAgainstSchema(args, schema);
    return parsedResult(command, null, args, validated, resolvedStateAccess(schema, validated));
  }

  const actions = schema.actions ?? {};
  let action: string | null = null;
  let args: readonly string[] = argv.slice(1);

  if ((possibleAction === undefined || possibleAction.startsWith('-')) && isHelpRequest(args)) {
    const target = [command];
    return parsedResult('help', null, target, validateArgsAgainstSchema(target, COMMAND_SCHEMAS.help!), 'none');
  }

  if (possibleAction !== undefined && !possibleAction.startsWith('-')) {
    if (!Object.hasOwn(actions, possibleAction)) {
      throw new Error(`E_ACTION_INVALID: ${command} ${possibleAction}`);
    }
    action = possibleAction;
    args = rest;
  } else if (schema.defaultAction !== undefined) {
    action = schema.defaultAction;
    args = argv.slice(1);
  } else if (schema.requireAction) {
    throw new Error(`E_ACTION_REQUIRED: ${command}`);
  }

  const actionSchema = action !== null ? actions[action] : undefined;
  if (command === 'team' && action === 'api' && actionSchema !== undefined && isHelpRequest(args)) {
    const validated = validateArgsAgainstSchema(['help'], actionSchema);
    return parsedResult(command, action, args, validated, 'none');
  }
  if (action !== null && actionSchema !== undefined && isHelpRequest(args)) {
    const target = [command, action];
    return parsedResult('help', null, target, validateArgsAgainstSchema(target, COMMAND_SCHEMAS.help!), 'none');
  }
  const validated = validateArgsAgainstSchema(args, actionSchema ?? schema);
  const stateAccess = command === 'team' && action === 'api'
    ? teamApiStateAccess(validated)
    : resolvedStateAccess(actionSchema ?? schema, validated, schema.stateAccess);
  return parsedResult(command, action, args, validated, stateAccess);
}

function teamApiStateAccess(validated: ValidatedArgs): StateAccess {
  const selected = validated.values['--op'] ?? validated.namedPositionals.operation;
  if (typeof selected !== 'string') return 'write-ensure';
  return teamApiOperationStateAccess(selected);
}

function isHelpRequest(args: readonly string[]): boolean {
  return args.length === 1 && ['--help', '-h'].includes(args[0] ?? '');
}

function resolvedStateAccess(
  schema: ActionSchema | CommandSchema,
  validated: ValidatedArgs,
  inherited?: StateAccess,
): StateAccess {
  for (const option of schema.options ?? []) {
    if (validated.values[option.name] !== undefined && option.stateAccess !== undefined) return option.stateAccess;
  }
  return schema.stateAccess ?? inherited ?? 'none';
}

function validateHelpTarget(target: readonly string[]): void {
  if (target.length === 0) return;
  const command = target[0]!;
  if (!Object.hasOwn(COMMAND_SCHEMAS, command)) throw new Error(`E_CLI_INVALID: unknown command: ${command}`);
  const schema = COMMAND_SCHEMAS[command]!;
  if (target.length > 1 && !Object.hasOwn(schema.actions ?? {}, target[1]!)) {
    throw new Error(`E_ACTION_INVALID: ${command} ${target[1]}`);
  }
}

function parsedResult(
  command: string,
  action: string | null,
  args: readonly string[],
  validated: ValidatedArgs,
  stateAccess: StateAccess,
): ParsedCommand {
  return {
    command,
    action,
    args,
    options: validated.values,
    positionals: validated.positionals,
    stateAccess,
  };
}

export function parsedPositionals(command: string, action: string | null, args: readonly string[]): readonly string[] {
  if (!Object.hasOwn(COMMAND_SCHEMAS, command)) throw new Error(`E_CLI_INVALID: unknown command: ${command}`);
  const schema = COMMAND_SCHEMAS[command]!;
  let selected: ActionSchema | CommandSchema;
  if (action === null) {
    selected = schema;
  } else {
    if (!Object.hasOwn(schema.actions ?? {}, action)) throw new Error(`E_ACTION_INVALID: ${command} ${action}`);
    selected = schema.actions![action]!;
  }
  return validateArgsAgainstSchema(args, selected).positionals;
}

/** True when the first token is a known OMCU command (not host launch). */
export function isKnownCommand(token: string): boolean {
  return Object.hasOwn(COMMAND_SCHEMAS, token) || ['help', '--help', '-h', 'version', '--version', '-v'].includes(token);
}

export function renderCommandHelp(target: readonly string[]): string {
  if (target.length === 0) {
    return `Commands:\n${Object.keys(COMMAND_SCHEMAS).sort().map((name) => `  ${name}`).join('\n')}\n`;
  }
  const command = target[0]!;
  if (!Object.hasOwn(COMMAND_SCHEMAS, command)) throw new Error(`E_CLI_INVALID: unknown command: ${command}`);
  const commandSchema = COMMAND_SCHEMAS[command]!;
  const action = target[1];
  let schema: ActionSchema | CommandSchema;
  if (action === undefined) {
    schema = commandSchema;
  } else {
    if (!Object.hasOwn(commandSchema.actions ?? {}, action)) throw new Error(`E_ACTION_INVALID: ${command} ${action}`);
    schema = commandSchema.actions![action]!;
  }
  const path = ['omcu', command, ...(action === undefined ? [] : [action])].join(' ');
  const optionUsage = (schema.options ?? []).map((option) => {
    const value = option.kind === 'flag' ? '' : ` <${option.kind}>`;
    return option.required ? `${option.name}${value}` : `[${option.name}${value}]`;
  });
  const positionalUsage = (schema.positionals ?? []).map((positional) => {
    const value = positional.multiple ? `<${positional.name}...>` : `<${positional.name}>`;
    return positional.required ? value : `[${value}]`;
  });
  const actions = 'actions' in schema && schema.actions !== undefined
    ? `\nActions:\n${Object.keys(schema.actions).sort().map((name) => `  ${name}`).join('\n')}\n`
    : '';
  const options = (schema.options ?? []).length === 0 ? '' : `\nOptions:\n${(schema.options ?? []).map((option) => {
    const constraints = [
      option.kind,
      option.required ? 'required' : undefined,
      option.enum === undefined ? undefined : `one of ${option.enum.join('|')}`,
      option.min === undefined ? undefined : `min ${option.min}`,
      option.max === undefined ? undefined : `max ${option.max}`,
      option.default === undefined ? undefined : `default ${JSON.stringify(option.default)}`,
    ].filter((value): value is string => value !== undefined).join(', ');
    return `  ${option.name}${option.aliases?.length ? `, ${option.aliases.join(', ')}` : ''}  ${constraints}`;
  }).join('\n')}\n`;
  return `Usage: ${[path, ...optionUsage, ...positionalUsage].join(' ')}\n${actions}${options}`;
}

function collectOptionValues(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === '--') break;
    if (token.startsWith(`${name}=`)) {
      values.push(token.slice(name.length + 1));
      continue;
    }
    if (token === name) {
      const next = args[i + 1];
      if (next === undefined || next === '--') continue;
      values.push(next);
      i += 1;
    }
  }
  return values;
}

export function hasFlag(args: readonly string[], name: string): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === '--') break;
    if (token === name || token.startsWith(`${name}=`)) return true;
  }
  return false;
}

export function option(args: readonly string[], name: string): string | undefined {
  const values = collectOptionValues(args, name);
  if (values.length === 0) return undefined;
  if (values.length > 1) throw new Error(`E_OPTION_DUPLICATE: ${name}`);
  return values[0];
}

export function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new Error(`E_OPTION_REQUIRED: ${name}`);
  return value;
}

export function integerOption(args: readonly string[], name: string, fallback?: number): number {
  const raw = option(args, name);
  if (raw === undefined && fallback !== undefined) return fallback;
  if (raw === undefined) throw new Error(`E_OPTION_REQUIRED: ${name}`);
  if (!/^-?\d+$/.test(raw)) throw new Error(`E_INTEGER_INVALID: ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`E_INTEGER_UNSAFE: ${name}`);
  return value;
}

export function jsonOption(args: readonly string[], name: string, fallback?: unknown): unknown {
  const raw = option(args, name);
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`E_OPTION_REQUIRED: ${name}`);
  }
  if (Buffer.byteLength(raw) > MAX_OPTION_VALUE_BYTES) throw new Error(`E_OPTION_TOO_LARGE: ${name}`);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`E_JSON_INVALID: ${name}`);
  }
}
