# Release process

This process creates release assets without publishing them. Tagging, pushing, package publication, and marketplace submission are separate authorized actions.

## 1. Prepare

Confirm the checkout is clean and the versions match:

```sh
git status --short
node -p "require('./package.json').version"
node -p "require('./.cursor-plugin/plugin.json').version"
node dist/bin/omcu.js --version
```

For `0.1.0`, all three version values must be `0.1.0`.

Review `CHANGELOG.md`, `PROJECT.md`, `SECURITY.md`, and `TEST_READY.md`. Confirm the capability lock names the intended Cursor Agent baseline.

## 2. Build and test

```sh
npm ci
npm run check
node dist/bin/omcu.js --help
node dist/bin/omcu.js capabilities discover
node dist/src/setup/script-entry.js doctor \
  --package-root "$PWD" \
  --project "$PWD"
```

Do not tag when compilation, any test, CLI help, or the pinned live capability probe fails. A doctor warning is not automatically fatal, but it must be explained in `TEST_READY.md`.

## 3. Inspect package contents

The package manifest is the distribution allowlist. Confirm the dry run contains compiled output, plugin surfaces, lifecycle scripts, the capability lock, README, license, and package metadata, and excludes `.git/`, `.omcu/`, `node_modules/`, coverage, logs, and credentials.

```sh
npm run package:dry-run
```

## 4. Create release assets

```sh
VERSION="$(node -p "require('./package.json').version")"
npm run release:archive
ASSET_BASENAME="iml1s-oh-my-cursor-${VERSION}.tgz"
ASSET="release/${ASSET_BASENAME}"
CHECKSUMS="release/SHA256SUMS"
(cd release && shasum -a 256 -c SHA256SUMS)
```

`release:archive` creates both files. `SHA256SUMS` contains exactly one basename-only archive entry; do not add a `release/` path prefix.

Expected assets:

- `release/iml1s-oh-my-cursor-0.1.0.tgz`
- `release/SHA256SUMS` with a basename-only archive entry

## 5. Test the archive offline

Run the isolated lifecycle gate from `TEST_READY.md`, replacing source install with:

```sh
./scripts/install.sh \
  --archive "$PWD/release/iml1s-oh-my-cursor-${VERSION}.tgz" \
  --checksums "$PWD/release/SHA256SUMS" \
  --home "$TMP_ROOT/home" \
  --state-root "$TMP_ROOT/state" \
  --project "$TMP_ROOT/project" \
  --no-doctor
```

Verify installed `omcu --version`, capability discovery when Cursor is available, update rollback behavior, and receipt-based uninstall.

## 6. Record evidence

Write the date, exact commit, Node/npm/Cursor versions, command exit codes, test counts, asset SHA-256, and any warning to `TEST_READY.md`. Verification evidence must be fresh and must remain separate from later tag, push, registry, or marketplace proof.
