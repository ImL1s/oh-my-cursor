# Installation and lifecycle

## Requirements

- Node.js 20 or newer
- npm
- macOS or Linux shell tools used by the scripts
- Cursor Agent for live capability checks and plugin use
- `~/.local/bin` on `PATH` for the receipt-based CLI install

Install Cursor Agent using the [official Cursor CLI instructions](https://cursor.com/docs/cli/overview). OMCU does not install or authenticate Cursor Agent.

## Use from a source checkout

This is the simplest development path and does not create a persistent OMCU install:

```sh
npm ci
npm run build
node dist/bin/omcu.js --help
node dist/bin/omcu.js capabilities discover
cursor-agent --plugin-dir "$PWD"
```

`--plugin-dir` asks Cursor Agent to load the checkout for that invocation. It does not modify `~/.cursor`.

## Install from source

The lifecycle installer copies the built source tree to an immutable external stage and creates `~/.local/bin/omcu` as a symlink:

```sh
npm ci
npm run build
./scripts/install.sh --source "$PWD" --project /absolute/path/to/project
```

The command prints JSON containing `receiptPath`, the installed stage, source digest, and doctor result. Save the receipt path; uninstall requires it.

By default:

- install state: `~/.local/state/oh-my-cursor/`;
- CLI link: `~/.local/bin/omcu`;
- project state: `/absolute/path/to/project/.omcu/`.

Installation state and project state have different owners and lifetimes. Never copy install receipts into `.omcu/`, and never edit `.omcu/` manually.

## Install an offline release archive

Obtain both the versioned archive and its `SHA256SUMS` file through a trusted channel. The installer verifies the named archive before extraction and rejects absolute paths or `..` traversal entries.

If you already have a source checkout or an earlier extracted release:

```sh
./scripts/install.sh \
  --archive /absolute/path/to/iml1s-oh-my-cursor-0.2.1.tgz \
  --checksums /absolute/path/to/SHA256SUMS \
  --project /absolute/path/to/project
```

For a first offline install, verify and extract the release only to bootstrap its installer, then let that installer verify the archive again:

```sh
ASSET=/absolute/path/to/iml1s-oh-my-cursor-0.2.1.tgz
CHECKSUMS=/absolute/path/to/SHA256SUMS
(cd "$(dirname "$ASSET")" && shasum -a 256 -c "$CHECKSUMS")
BOOTSTRAP="$(mktemp -d)"
tar -xzf "$ASSET" -C "$BOOTSTRAP"
"$BOOTSTRAP/package/scripts/install.sh" \
  --archive "$ASSET" \
  --checksums "$CHECKSUMS" \
  --project /absolute/path/to/project
```

This path performs no package download. The archive must contain one package root with `package.json`, compiled `dist/bin/omcu.js`, plugin surfaces, and lifecycle scripts.

## Manual plugin loading

To inspect or use a trusted source checkout or extracted release without installing OMCU, point Cursor at it for one invocation:

```sh
cursor-agent --plugin-dir /absolute/path/to/oh-my-cursor
```

This is ephemeral and does not write Cursor user configuration. The release is not represented as installed until Cursor or the OMCU receipt-based lifecycle reports that state.

To add only the local OMCU MCP server to the current project's `.cursor/mcp.json`:

```sh
omcu mcp-install
```

This is an explicit project-file mutation. The shipped `.mcp.json` remains empty by default.

## Update

From a verified source checkout:

```sh
npm ci
npm run build
node dist/src/setup/script-entry.js update \
  --source "$PWD" \
  --project /absolute/path/to/project
```

From offline release assets:

```sh
node dist/src/setup/script-entry.js update \
  --archive /absolute/path/to/iml1s-oh-my-cursor-0.2.1.tgz \
  --checksums /absolute/path/to/SHA256SUMS \
  --project /absolute/path/to/project
```

An update stages new bytes before switching the CLI symlink. If staging or the post-install doctor fails, the installer restores the previous link and pointer.

## Doctor and readback

```sh
node dist/src/setup/script-entry.js doctor \
  --package-root "$PWD" \
  --project /absolute/path/to/project
```

Doctor checks the plugin manifest, Cursor version/status/help, whether Cursor accepts the `--plugin-dir` argument, rules, hooks, MCP configuration, and project state. Cursor currently returns success for `--plugin-dir … --help` even when a directory does not exist, so that probe is reported as an honest warning and never claimed as runtime activation proof. Exit `0` is clean, `2` contains warnings only, and `1` contains a failure.

For an installed copy, use the current receipt to verify immutable stage bytes and CLI link identity through the setup library or repeat doctor against the installed stage printed in the receipt.

## Uninstall

Use the exact receipt returned by install or update:

```sh
./scripts/uninstall.sh \
  --receipt /absolute/path/to/receipt.json
```

Uninstall removes only paths whose identity still matches the receipt. Modified or replaced paths are preserved and reported as collisions. Project `.omcu/` is preserved by default. To remove it only when it is still empty:

```sh
./scripts/uninstall.sh \
  --receipt /absolute/path/to/receipt.json \
  --purge-project-state
```

The scripts do not install globally and do not write Cursor user configuration.
