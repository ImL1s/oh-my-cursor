import crypto from 'node:crypto';
import fs from 'node:fs';
import type { StateRoot } from '../runtime/state-root.js';

const CLI_AUTHORITY = Symbol('omcu-cli-authority');
const CLI_OWNER_FILE = Symbol('omcu-owner-file');
export interface CliMutationAuthority {
  readonly source: 'omcu-cli';
  readonly ownerToken: string;
  readonly [CLI_AUTHORITY]: true;
  readonly [CLI_OWNER_FILE]: string;
}

interface OwnerRecord { readonly schema_version: 1; readonly owner_token: string; readonly created_at: string }

function readOwner(file: string): OwnerRecord {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<OwnerRecord>;
  if (parsed.schema_version !== 1 || typeof parsed.owner_token !== 'string'
    || !/^[a-f0-9]{64}$/.test(parsed.owner_token) || typeof parsed.created_at !== 'string') {
    throw new Error('E_OWNER_RECORD_INVALID');
  }
  return parsed as OwnerRecord;
}

/** Internal entry point: intentionally not re-exported from the package root. */
export function createCliMutationAuthority(root: StateRoot): CliMutationAuthority {
  fs.mkdirSync(root.path, { recursive: true, mode: 0o700 });
  let record: OwnerRecord | null = null;
  const deadline = Date.now() + 2_000;
  while (record === null) {
    try {
      record = readOwner(root.ownerFile);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && fs.existsSync(root.ownerFile)) {
        if (Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        continue;
      }
    }
    const candidate: OwnerRecord = {
      schema_version: 1,
      owner_token: crypto.randomBytes(32).toString('hex'),
      created_at: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(root.ownerFile, `${JSON.stringify(candidate, null, 2)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      fs.chmodSync(root.ownerFile, 0o600);
      record = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return {
    source: 'omcu-cli',
    ownerToken: record.owner_token,
    [CLI_AUTHORITY]: true,
    [CLI_OWNER_FILE]: root.ownerFile,
  };
}

export function assertCliMutationAuthority(authority: CliMutationAuthority): void {
  if (authority.source !== 'omcu-cli' || authority[CLI_AUTHORITY] !== true || authority.ownerToken.length < 32) {
    throw new Error('E_CLI_MUTATION_AUTHORITY_REQUIRED');
  }
  const persisted = readOwner(authority[CLI_OWNER_FILE]);
  if (persisted.owner_token !== authority.ownerToken) throw new Error('E_CLI_MUTATION_AUTHORITY_STALE');
}

export function authorityDigest(authority: CliMutationAuthority): string {
  assertCliMutationAuthority(authority);
  return crypto.createHash('sha256').update(authority.ownerToken).digest('hex');
}
