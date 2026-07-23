#!/usr/bin/env bash
# One-line installer for oh-my-cursor (OMCU):
#   curl -fsSL https://raw.githubusercontent.com/ImL1s/oh-my-cursor/main/scripts/bootstrap.sh | bash
# Pin a release:
#   OMCU_TAG=v0.2.0 curl -fsSL .../scripts/bootstrap.sh | bash
# Initialize a project during install:
#   OMCU_PROJECT=/abs/path curl -fsSL .../scripts/bootstrap.sh | bash
#
# Downloads the release archive + SHA256SUMS from GitHub, verifies the
# checksum, extracts to a private temp dir, and runs the packaged
# receipt-based installer (which re-verifies the archive before its managed
# extraction). Nothing is executed before the checksum passes.
set -euo pipefail

REPO="ImL1s/oh-my-cursor"
API="https://api.github.com/repos/${REPO}/releases"

log() { printf '==> %s\n' "$*" >&2; }
fail() { printf 'omcu bootstrap: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || fail "curl is required"
command -v tar >/dev/null || fail "tar is required"
command -v node >/dev/null || fail "node is required (>= 20)"

if command -v shasum >/dev/null; then
  CHECK=(shasum -a 256 -c)
elif command -v sha256sum >/dev/null; then
  CHECK=(sha256sum -c)
else
  fail "shasum or sha256sum is required"
fi

TAG="${OMCU_TAG:-}"
if [[ -z "$TAG" ]]; then
  TAG="$(curl -fsSL "${API}/latest" | tr -d '\r' | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  [[ -n "$TAG" ]] || fail "could not resolve the latest release tag"
fi
VERSION="${TAG#v}"
ARCHIVE="iml1s-oh-my-cursor-${VERSION}.tgz"
BASE="https://github.com/${REPO}/releases/download/${TAG}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/omcu-bootstrap-XXXXXX")"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

log "downloading ${TAG} (${ARCHIVE})"
curl -fSL --proto '=https' -o "$WORK/$ARCHIVE" "$BASE/$ARCHIVE"
curl -fSL --proto '=https' -o "$WORK/SHA256SUMS" "$BASE/SHA256SUMS"

log "verifying checksum"
(cd "$WORK" && "${CHECK[@]}" SHA256SUMS >&2)

log "extracting"
tar -xzf "$WORK/$ARCHIVE" -C "$WORK"
[[ -f "$WORK/package/scripts/install.sh" ]] || fail "release archive is missing package/scripts/install.sh"

INSTALL_ARGS=(--archive "$WORK/$ARCHIVE" --checksums "$WORK/SHA256SUMS")
if [[ -n "${OMCU_PROJECT:-}" ]]; then
  INSTALL_ARGS+=(--project "$OMCU_PROJECT")
fi

log "running receipt-based installer"
bash "$WORK/package/scripts/install.sh" "${INSTALL_ARGS[@]}"

log "installed. Ensure ~/.local/bin is on PATH, then run: omcu --version"
