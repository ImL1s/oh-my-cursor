import {
  createCliMutationAuthority,
  quarantineInvalidCliOwnerRecord,
} from '../../src/state/authority.js';
import { ensureExternalStateRoot } from '../../src/runtime/state-root.js';

const [action, rootPath] = process.argv.slice(2);
if (rootPath === undefined) throw new Error('E_FIXTURE_ARGUMENTS');
const root = ensureExternalStateRoot(rootPath);

if (action === 'repair') {
  process.stdout.write(`${JSON.stringify({ quarantine: quarantineInvalidCliOwnerRecord(root) })}\n`);
} else if (action === 'create') {
  process.stdout.write(`${JSON.stringify({ token: createCliMutationAuthority(root).ownerToken })}\n`);
} else {
  throw new Error('E_FIXTURE_ACTION');
}
