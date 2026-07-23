#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -f "$ROOT/dist/src/setup/script-entry.js" ]]; then
  (cd "$ROOT" && npm run build >/dev/null)
fi
# Cursor plugin loading is verified per invocation via --plugin-dir. This script
# intentionally does not mutate ~/.cursor; pass lifecycle options to install.
exec node "$ROOT/dist/src/setup/script-entry.js" install "$@"
