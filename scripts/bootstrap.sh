#!/usr/bin/env bash
# One-line installer for oh-my-cursor (OMCU):
#   curl -fsSL https://raw.githubusercontent.com/ImL1s/oh-my-cursor/main/scripts/bootstrap.sh | bash
# Pin a release:
#   OMCU_TAG=v0.3.0 curl -fsSL .../scripts/bootstrap.sh | bash
# Initialize a project during install:
#   OMCU_PROJECT=/abs/path curl -fsSL .../scripts/bootstrap.sh | bash
#
# Hardened bootstrap lifecycle:
# 1. Enforces Node >= 20 preflight with actionable diagnostics before running package code.
# 2. Validates release tag grammar and parses GitHub API with structured JSON handling.
# 3. Downloads release archive and SHA256SUMS over HTTPS, verifying SHA-256 digest.
# 4. Performs strict pre-extraction archive safety validation: rejects empty names, NULs,
#    absolute paths, drive prefixes, '..' traversal, non-canonical paths, non-package roots,
#    duplicate/conflicting entries, hardlinks, devices, FIFOs, sockets, escaping symlinks,
#    and excessive entry count (> 10,000) or uncompressed size (> 256 MB).
# 5. Defensively extracts into a private temporary directory (0700).
# 6. Runs the packaged receipt-based installer, capturing structured JSON execution result.
#    Exit code 2 is only accepted if a valid install receipt exists and is verified.
# 7. Performs final readback verification: validates that the installed stable shim exists,
#    is executable, and its --version output exactly matches the target release version.
set -euo pipefail
umask 077

REPO="${OMCU_REPO:-ImL1s/oh-my-cursor}"
API="${OMCU_API_URL:-https://api.github.com/repos/${REPO}/releases}"

log() { printf '==> %s\n' "$*" >&2; }
fail() { printf 'omcu bootstrap: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

if ! command -v node >/dev/null 2>&1; then
  fail "node >= 20 is required, but node is not installed or not on PATH"
fi

NODE_VERSION="$(node -e 'process.stdout.write(process.versions.node || "")' 2>/dev/null || true)"
if ! node -e 'const [m] = process.versions.node.split("."); if (parseInt(m, 10) < 20) process.exit(1);' 2>/dev/null; then
  fail "node >= 20 is required; current version: ${NODE_VERSION:-unknown}"
fi

if command -v shasum >/dev/null 2>&1; then
  CHECK=(shasum -a 256 -c)
elif command -v sha256sum >/dev/null 2>&1; then
  CHECK=(sha256sum -c)
else
  fail "shasum or sha256sum is required"
fi

TAG="${OMCU_TAG:-}"
if [[ -n "$TAG" ]]; then
  if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    fail "invalid release tag format: '${TAG}' (expected format: vX.Y.Z or vX.Y.Z-prerelease)"
  fi
else
  log "fetching latest release from GitHub"
  CURL_PROTO=(--proto '=https')
  if [[ -n "${OMCU_ALLOW_INSECURE_PROTO:-}" ]]; then
    CURL_PROTO=(--proto '=https,http,file')
  fi
  API_RESPONSE="$(curl -sSL "${CURL_PROTO[@]}" -H "Accept: application/vnd.github+json" -H "User-Agent: omcu-bootstrap" "${API}/latest" 2>/dev/null || true)"
  [[ -n "$API_RESPONSE" ]] || fail "failed to connect to GitHub releases API"

  TAG="$(printf '%s' "$API_RESPONSE" | node -e '
    const fs = require("fs");
    const raw = fs.readFileSync(0, "utf8");
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      process.stderr.write("failed to parse GitHub releases API response as JSON\n");
      process.exit(1);
    }
    if (!data || typeof data !== "object") {
      process.stderr.write("invalid GitHub releases API response\n");
      process.exit(1);
    }
    if (typeof data.message === "string") {
      process.stderr.write(`GitHub API error: ${data.message}\n`);
      process.exit(1);
    }
    if (typeof data.tag_name !== "string" || !data.tag_name) {
      process.stderr.write("GitHub releases API response missing tag_name\n");
      process.exit(1);
    }
    const tag = data.tag_name;
    if (!/^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(tag)) {
      process.stderr.write(`GitHub release tag "${tag}" has invalid format\n`);
      process.exit(1);
    }
    process.stdout.write(tag);
  ' 2>&1 || true)"

  if [[ ! "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    fail "could not resolve latest release tag: ${TAG}"
  fi
fi

VERSION="${TAG#v}"
ARCHIVE="iml1s-oh-my-cursor-${VERSION}.tgz"
BASE="${OMCU_BASE_URL:-https://github.com/${REPO}/releases/download/${TAG}}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/omcu-bootstrap-XXXXXX")"
chmod 700 "$WORK"
cleanup() { local rc=$?; rm -rf "$WORK"; exit "$rc"; }
trap cleanup EXIT

log "downloading ${TAG} (${ARCHIVE})"
DL_PROTO=(--proto '=https')
if [[ -n "${OMCU_ALLOW_INSECURE_PROTO:-}" ]]; then
  DL_PROTO=(--proto '=https,http,file')
fi

curl -fSL "${DL_PROTO[@]}" -o "$WORK/$ARCHIVE" "$BASE/$ARCHIVE"
curl -fSL "${DL_PROTO[@]}" -o "$WORK/SHA256SUMS" "$BASE/SHA256SUMS"

log "verifying checksum"
(cd "$WORK" && "${CHECK[@]}" SHA256SUMS >&2)

log "validating archive safety"
node -e '
  const cp = require("child_process");
  const path = require("path");
  const archive = process.argv[1];

  const tz = cp.spawnSync("tar", ["-tzf", archive], { encoding: "utf8", timeout: 30000 });
  if (tz.status !== 0) {
    process.stderr.write("failed to list archive contents with tar -tzf\n");
    process.exit(1);
  }
  const tv = cp.spawnSync("tar", ["-tvzf", archive], { encoding: "utf8", timeout: 30000 });
  if (tv.status !== 0) {
    process.stderr.write("failed to inspect archive contents with tar -tvzf\n");
    process.exit(1);
  }

  const tzEntries = tz.stdout.split(/\r?\n/).filter(Boolean);
  const tvEntries = tv.stdout.split(/\r?\n/).filter(Boolean);

  if (tzEntries.length === 0) {
    process.stderr.write("archive is empty\n");
    process.exit(1);
  }
  if (tzEntries.length > 10000) {
    process.stderr.write("archive contains too many entries (> 10000)\n");
    process.exit(1);
  }
  if (tzEntries.length !== tvEntries.length) {
    process.stderr.write("archive listing entry count mismatch\n");
    process.exit(1);
  }

  const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
  const MAX_SINGLE_BYTES = 64 * 1024 * 1024;
  let totalSize = 0;
  const seen = new Map();

  for (let i = 0; i < tzEntries.length; i++) {
    const entry = tzEntries[i];
    const tvLine = tvEntries[i];

    if (!entry || entry.includes("\0")) {
      process.stderr.write("empty entry or NUL byte in path: " + JSON.stringify(entry) + "\n");
      process.exit(1);
    }
    if (entry.startsWith("/") || entry.startsWith("\\")) {
      process.stderr.write("absolute path forbidden: " + entry + "\n");
      process.exit(1);
    }
    if (/^[A-Za-z]:/.test(entry)) {
      process.stderr.write("drive prefix forbidden: " + entry + "\n");
      process.exit(1);
    }
    if (entry.split("/").includes("..") || entry.split("\\").includes("..")) {
      process.stderr.write("path traversal forbidden: " + entry + "\n");
      process.exit(1);
    }
    if (entry.includes("\\")) {
      process.stderr.write("backslash forbidden: " + entry + "\n");
      process.exit(1);
    }
    if (entry.startsWith("./") || entry === ".") {
      process.stderr.write("non-canonical path forbidden: " + entry + "\n");
      process.exit(1);
    }
    if (entry.includes("//")) {
      process.stderr.write("empty path segments forbidden: " + entry + "\n");
      process.exit(1);
    }

    const norm = entry.replace(/\/+$/, "");
    if (norm !== "package" && !norm.startsWith("package/")) {
      process.stderr.write("entry outside package/ root: " + entry + "\n");
      process.exit(1);
    }

    const typeChar = tvLine[0];
    if (tvLine.includes(" link to ") || typeChar === "h") {
      process.stderr.write("hardlinks forbidden: " + entry + "\n");
      process.exit(1);
    }
    if (typeChar !== "-" && typeChar !== "d" && typeChar !== "l") {
      process.stderr.write("forbidden entry type (" + typeChar + "): " + entry + "\n");
      process.exit(1);
    }

    let type = "file";
    if (typeChar === "d") {
      type = "dir";
    } else if (typeChar === "l") {
      type = "symlink";
      const arrow = tvLine.lastIndexOf(" -> ");
      if (arrow === -1) {
        process.stderr.write("malformed symlink entry: " + entry + "\n");
        process.exit(1);
      }
      const target = tvLine.slice(arrow + 4).trim();
      if (!target || target.includes("\0")) {
        process.stderr.write("invalid symlink target: " + entry + "\n");
        process.exit(1);
      }
      if (target.startsWith("/") || target.startsWith("\\") || /^[A-Za-z]:/.test(target)) {
        process.stderr.write("absolute symlink forbidden: " + entry + " -> " + target + "\n");
        process.exit(1);
      }
      const resolved = path.posix.resolve("/", path.posix.dirname(entry), target);
      if (resolved !== "/package" && !resolved.startsWith("/package/")) {
        process.stderr.write("symlink escapes package/ root: " + entry + " -> " + target + "\n");
        process.exit(1);
      }
    } else if (typeChar === "-") {
      if (entry.endsWith("/")) {
        process.stderr.write("regular file cannot have trailing slash: " + entry + "\n");
        process.exit(1);
      }
      const sizeMatch = tvLine.match(/\s+(\d+)\s+(?:[A-Za-z]{3}\s+\d+|\d{4}-\d{2}-\d{2})\s+/);
      if (sizeMatch) {
        const sz = parseInt(sizeMatch[1], 10);
        if (sz > MAX_SINGLE_BYTES) {
          process.stderr.write("entry exceeds maximum size: " + entry + "\n");
          process.exit(1);
        }
        totalSize += sz;
        if (totalSize > MAX_TOTAL_BYTES) {
          process.stderr.write("archive exceeds total uncompressed size limit\n");
          process.exit(1);
        }
      }
    }

    if (seen.has(norm)) {
      process.stderr.write("duplicate entry forbidden: " + norm + "\n");
      process.exit(1);
    }
    seen.set(norm, type);

    const parts = norm.split("/");
    for (let p = 1; p < parts.length; p++) {
      const parent = parts.slice(0, p).join("/");
      if (seen.has(parent) && seen.get(parent) !== "dir") {
        process.stderr.write("entry conflicts with non-directory parent: " + norm + "\n");
        process.exit(1);
      }
    }
  }

  if (!seen.has("package/package.json")) {
    process.stderr.write("archive missing package/package.json\n");
    process.exit(1);
  }
' "$WORK/$ARCHIVE" 2> "$WORK/archive-err.txt" || {
  ERR_MSG="$(cat "$WORK/archive-err.txt" 2>/dev/null || true)"
  fail "release archive failed safety preflight validation: ${ERR_MSG:-invalid archive}"
}

log "extracting"
tar -xzf "$WORK/$ARCHIVE" -C "$WORK"
[[ -f "$WORK/package/package.json" ]] || fail "release archive is missing package/package.json"
[[ -f "$WORK/package/scripts/install.sh" ]] || fail "release archive is missing package/scripts/install.sh"

INSTALL_ARGS=(--archive "$WORK/$ARCHIVE" --checksums "$WORK/SHA256SUMS")
if [[ -n "${OMCU_PROJECT:-}" ]]; then
  INSTALL_ARGS+=(--project "$OMCU_PROJECT")
fi
if [[ -n "${OMCU_HOME:-}" ]]; then
  INSTALL_ARGS+=(--home "$OMCU_HOME")
fi
if [[ -n "${OMCU_STATE_ROOT:-}" ]]; then
  INSTALL_ARGS+=(--state-root "$OMCU_STATE_ROOT")
fi
if [[ -n "${OMCU_NO_DOCTOR:-}" ]]; then
  INSTALL_ARGS+=(--no-doctor)
fi

log "running receipt-based installer"
INSTALL_OUT="$WORK/install-result.json"
set +e
bash "$WORK/package/scripts/install.sh" "${INSTALL_ARGS[@]}" > "$INSTALL_OUT"
INSTALL_RC=$?
set -e

if [[ "$INSTALL_RC" -ne 0 && "$INSTALL_RC" -ne 2 ]]; then
  fail "installer failed (exit ${INSTALL_RC})"
fi

RECEIPT_VALID="$(node -e '
  const fs = require("fs");
  const [, resultFile, expectedVersion] = process.argv;
  try {
    const raw = fs.readFileSync(resultFile, "utf8").trim();
    let text = raw;
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      text = text.slice(start, end + 1);
    }
    const result = JSON.parse(text);
    if (!result || typeof result !== "object") process.exit(1);
    if (typeof result.receiptPath !== "string" || !result.receiptPath) process.exit(2);
    if (!fs.existsSync(result.receiptPath)) process.exit(3);
    const receipt = JSON.parse(fs.readFileSync(result.receiptPath, "utf8"));
    if (receipt.store_kind !== "omcu_install_receipt" || receipt.schema_version !== 1) process.exit(4);
    if (receipt.version !== expectedVersion) process.exit(5);
    process.stdout.write("ok");
  } catch (e) {
    process.stderr.write(e.message || String(e));
    process.exit(6);
  }
' "$INSTALL_OUT" "$VERSION" 2> "$WORK/receipt-err.txt" || true)"

if [[ "$RECEIPT_VALID" != "ok" ]]; then
  RECEIPT_ERR="$(cat "$WORK/receipt-err.txt" 2>/dev/null || true)"
  fail "install verification failed: invalid or missing install receipt (${RECEIPT_ERR:-schema mismatch})"
fi

if [[ "$INSTALL_RC" -eq 2 ]]; then
  log "installer reported doctor warnings (exit 2); install receipt was verified"
fi

HOME_DIR="${OMCU_HOME:-$HOME}"
OMCU_BIN="${HOME_DIR}/.local/bin/omcu"

[[ -f "$OMCU_BIN" ]] || fail "installed omcu binary not found at ${OMCU_BIN}"
[[ -x "$OMCU_BIN" ]] || fail "installed omcu binary at ${OMCU_BIN} is not executable"

READBACK_VERSION="$("$OMCU_BIN" --version 2>/dev/null || true)"
READBACK_VERSION="$(printf '%s' "$READBACK_VERSION" | tr -d '\r\n')"

[[ "$READBACK_VERSION" == "$VERSION" ]] || fail "readback version mismatch: expected '${VERSION}', got '${READBACK_VERSION}'"

log "verified omcu ${VERSION} at ${OMCU_BIN}"
log "installed. Ensure ~/.local/bin is on PATH, then run: omcu --version && omcu doctor"
