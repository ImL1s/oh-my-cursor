import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifySha256Sums } from '../../src/setup/digest.js';

describe('offline release verification', () => {
  it('requires one exact SHA256SUMS row and rejects mismatches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omcu-digest-'));
    try {
      const asset = path.join(root, 'omcu.tgz');
      const sums = path.join(root, 'SHA256SUMS');
      fs.writeFileSync(asset, 'release');
      const digest = crypto.createHash('sha256').update('release').digest('hex');
      fs.writeFileSync(sums, `${digest}  omcu.tgz\n`);
      expect(verifySha256Sums(asset, sums)).toBe(digest);
      fs.writeFileSync(sums, `${'0'.repeat(64)}  omcu.tgz\n`);
      expect(() => verifySha256Sums(asset, sums)).toThrow('E_RELEASE_CHECKSUM_MISMATCH');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
