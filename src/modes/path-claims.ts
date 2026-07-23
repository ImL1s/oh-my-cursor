import path from 'node:path';

/** Returns the path when it is already in canonical owned-path form; otherwise null. */
export function canonicalizeOwnedPath(owned: string): string | null {
  if (owned === '' || path.isAbsolute(owned) || owned.split(/[/\\]/).includes('..')) return null;
  if (path.posix.normalize(owned) !== owned || owned === '.' || owned.includes('\\') || owned.endsWith('/')) {
    return null;
  }
  return owned;
}

export interface PathClaimOwner {
  readonly ownerId: string;
  readonly paths: readonly string[];
}

/**
 * Validates exclusive owned-path claims: canonical form required, conflicts compared casefolded.
 * Original strings are not rewritten; only the comparison key is lowercased.
 */
export function assertExclusivePathClaims(
  claims: readonly PathClaimOwner[],
  codes: {
    readonly invalid: string;
    readonly conflict: (owner: string, claimant: string) => string;
  },
): void {
  const claimed = new Map<string, string>();
  for (const entry of claims) {
    for (const owned of entry.paths) {
      if (canonicalizeOwnedPath(owned) === null) throw new Error(codes.invalid);
      const key = owned.toLowerCase();
      for (const [existingKey, owner] of claimed) {
        if (key === existingKey || key.startsWith(`${existingKey}/`) || existingKey.startsWith(`${key}/`)) {
          throw new Error(codes.conflict(owner, entry.ownerId));
        }
      }
      claimed.set(key, entry.ownerId);
    }
  }
}
