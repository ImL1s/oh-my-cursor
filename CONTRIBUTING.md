# Contributing

Thank you for improving Oh My Cursor. Keep changes capability-grounded, testable, and explicit about authority.

## Development setup

Requirements: Node.js 20 or newer and npm.

```sh
git clone <repository-url>
cd oh-my-cursor
npm ci
npm run check
```

Cursor Agent is optional for hermetic tests but required for live capability and plugin checks. Install it from the [official Cursor CLI documentation](https://cursor.com/docs/cli/overview).

## Before changing behavior

1. Identify whether the change is Cursor-backed, experimental local behavior, or unsupported by the pinned host.
2. Read the relevant implementation and tests; do not infer behavior from command names.
3. Add a focused regression test before a cleanup or bug fix when coverage is missing.
4. Preserve project-state authority, revision/generation fences, redaction, bounded input/output, and shell-free invocation.
5. Do not add a dependency unless the task explicitly requires one.

## Repository map

- `src/`: runtime and CLI implementation.
- `bin/`: executable entry point.
- `tests/`: Vitest suites, organized by subsystem.
- `.cursor-plugin/`, `.cursor/`, `commands/`, `skills/`, `agents/`, `hooks/`: Cursor plugin surfaces.
- `scripts/`: build and receipt-based lifecycle entry points.
- `docs/`: architecture, operations, and release documentation.

Generated `dist/`, local `.omcu/`, and `.omcu-worktrees/` are not source files.

## Validation

Run the smallest relevant suite while editing, then the complete gate:

```sh
npm test -- tests/<area>.test.ts
npm run check
git diff --check
```

For CLI changes, also run:

```sh
node dist/bin/omcu.js --help
node dist/bin/omcu.js --version
```

For host-facing changes, run `node dist/bin/omcu.js capabilities discover` against the pinned Cursor Agent and record the exact version. For lifecycle changes, use temporary `--home`, `--state-root`, and project directories. Never test installers against a developer's real home by default.

## Documentation

Document only commands present in the compiled CLI or lifecycle scripts. Test every example. Link host claims to official `cursor.com/docs` pages. State when a check could not run.

## Commits and pull requests

Use an imperative, scoped subject such as `cli: fence notification dispatch`. Keep generated files and unrelated cleanup out of the commit.

A pull request should include:

- problem and bounded solution;
- capability tier and authority impact;
- files changed;
- commands run with exit codes/test counts;
- live Cursor evidence when host behavior changed;
- release, external, or manual gaps.

Do not claim a workflow receipt, hook, subagent, recovery snapshot, or tmux capture verified the change. Verification belongs to fresh command evidence and the CLI-owned run transition.

## Security

Follow [SECURITY.md](SECURITY.md). Never commit credentials, transcripts, receipts, `.omcu/`, or private project paths. Report vulnerabilities privately.
