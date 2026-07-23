# Test readiness

This file is the release verification checklist for `0.1.0`. Record fresh results; do not convert planned checks into claims.

## Automated gate

```sh
npm ci
npm run check
node dist/bin/omcu.js --version
node dist/bin/omcu.js --help
```

Expected version: `0.1.0`. `npm run check` must compile TypeScript and pass every Vitest suite.

## Live Cursor gate

```sh
cursor-agent --version
node dist/bin/omcu.js capabilities discover
```

The live host must exactly match `2026.07.20-8cc9c0b`, and discovery must return `"verified": true`. A version or help mismatch is capability drift, not a soft success.

Then run the setup doctor from the source checkout:

```sh
node dist/src/setup/script-entry.js doctor \
  --package-root "$PWD" \
  --project "$PWD"
```

Exit codes: `0` means all checks pass, `2` means no failures but at least one warning, and `1` means at least one failure.

## Isolated lifecycle gate

Use temporary directories; do not write a real home or global Cursor configuration.

```sh
TMP_ROOT="$(mktemp -d)"
mkdir -p "$TMP_ROOT/home" "$TMP_ROOT/project" "$TMP_ROOT/state"
./scripts/install.sh \
  --source "$PWD" \
  --home "$TMP_ROOT/home" \
  --state-root "$TMP_ROOT/state" \
  --project "$TMP_ROOT/project" \
  --no-doctor >"$TMP_ROOT/install.json"
"$TMP_ROOT/home/.local/bin/omcu" --version
RECEIPT="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(x.receiptPath)' "$TMP_ROOT/install.json")"
./scripts/uninstall.sh \
  --receipt "$RECEIPT" \
  --home "$TMP_ROOT/home" \
  --state-root "$TMP_ROOT/state"
rm -rf "$TMP_ROOT"
```

The readback must print `0.1.0`; uninstall must report `uninstalled` without collisions. Project `.omcu/` is preserved unless `--purge-project-state` is supplied, and even then removal occurs only when it is still empty.

## Documentation gate

- Every relative Markdown link resolves.
- Every documented repository path exists or is explicitly described as a generated release asset.
- Shell examples parse with `bash -n` where applicable.
- Official host links use `https://cursor.com/docs/...`.

## Current result

Verified locally on 2026-07-23 (Asia/Taipei) from an unborn repository with no commit or tag:

| Check | Result |
| --- | --- |
| `npm run check` | PASS: TypeScript build, 21 test files / 100 tests, CLI smoke, and CLI parity |
| `npm pack --dry-run --json` | PASS: `iml1s-oh-my-cursor-0.1.0.tgz`, 270 entries; all 13 README-reachable Markdown files are included |
| `cursor-agent --version` | PASS: `2026.07.20-8cc9c0b` |
| `omcu capabilities discover` | PASS: exact version/help match, `verified: true` |
| `omcu doctor` | PASS WITH HONEST WARNING: exit `2`, capability tier 3; local plugin/config checks pass while `--help` alone leaves runtime plugin activation explicitly unproven |
| Isolated source install/update/readback/uninstall | PASS: `0.1.0`, receipt removal without collisions; project state preserved |
| Offline `.tgz` checksum/bootstrap/install/readback/uninstall | PASS: basename-only `SHA256SUMS` entry verified twice, `0.1.0`, receipt removal without collisions |
| CLI state, workflow-definition, recovery, MCP, memory, and notification examples | PASS in temporary projects |
| Documentation relative links and repository paths | PASS |
| Eleven official `cursor.com/docs` links | PASS: HTTP 200 with redirects followed |

No required local blocker remains in this snapshot. Publication, marketplace installation, commit, tag, push, and real-home/global installation were intentionally not performed and require separate evidence.
