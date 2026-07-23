#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -f "$ROOT/dist/src/setup/script-entry.js" ]]; then
  (cd "$ROOT" && npm run build >/dev/null)
fi
exec node "$ROOT/dist/src/setup/script-entry.js" uninstall "$@"
