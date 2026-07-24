# Live verification

English | 繁中／简体尚未提供，請看英文

Live verification proves only the environment and command that were actually tested. Keep host, project, install, and external publication proof separate.

## Environment

```sh
node --version
npm --version
cursor-agent --version
cursor-agent status
```

Node must be 20 or newer. The pinned Cursor version is `2026.07.23-e383d2b`. Authentication status may expose account information; do not paste unredacted output into public logs.

## Capability probe

```sh
node dist/bin/omcu.js capabilities discover > /tmp/omcu-capabilities.json
node -e '
const x = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
if (!x.verified || !x.version_matches || !x.help_matches) process.exit(1);
' /tmp/omcu-capabilities.json
```

The probe checks exact version and required help surfaces. It intentionally preserves negative claims for native team orchestration, a native workflow engine, and a proven security-isolation boundary.

## Project state smoke test

Use a temporary project so no real `.omcu/` state is modified:

```sh
TMP_PROJECT="$(mktemp -d)"
(
  cd "$TMP_PROJECT"
  node /absolute/path/to/oh-my-cursor/dist/bin/omcu.js run create \
    --id smoke \
    --objective "verify CLI state lifecycle"
  node /absolute/path/to/oh-my-cursor/dist/bin/omcu.js run status --id smoke
)
```

Confirm `.omcu/` is mode `0700` and the state reports revision `1`, status `active`, and `verified: false`. Remove only the temporary project afterward.

## Session smoke test

`omcu session list` and interactive resume change terminal state but not project files. Run them only in a terminal where interaction is expected:

```sh
omcu session list
omcu session resume --id <known-chat-id>
```

For non-interactive routing, a prompt uses Cursor JSON output:

```sh
omcu session resume --id <known-chat-id> --prompt "Summarize current objective; do not edit files."
```

This invocation uses `--print`. The prompt alone does not enforce read-only behavior; choose Ask/Plan mode through a workflow designed for that boundary.

## Plugin loadability

```sh
cursor-agent --plugin-dir "$PWD" --help >/tmp/omcu-plugin-help.txt
```

A zero exit proves the current Cursor binary accepted the plugin directory for that invocation. It does not prove marketplace installation, user-level persistence, hook enforcement, MCP authentication, or every slash command's semantic result.

## Verification authority

A workflow or test result is evidence, not authoritative state. To verify a terminal run:

1. save the exact evidence in a stable file;
2. calculate its lowercase SHA-256;
3. transition the run with the current revision;
4. verify using the new revision and digest;
5. read back the state.

```sh
DIGEST="$(shasum -a 256 evidence.txt | awk '{print $1}')"
omcu run transition --id release-0.1.0 --revision 1 --status complete
omcu run verify --id release-0.1.0 --revision 2 --evidence-sha256 "$DIGEST"
omcu run status --id release-0.1.0
```

A stale revision, active run, malformed digest, warning-only doctor report, recovered transcript, subagent response, workflow receipt, or tmux capture cannot substitute for this readback.
