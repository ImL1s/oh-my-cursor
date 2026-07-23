# Repository Guidelines

## Project structure

`src/` contains the TypeScript runtime: Cursor host and capability adapters, project state, setup lifecycle, sessions and recovery, workflow modes, services, and experimental orchestration. `bin/omcu.ts` is the CLI entry point. Cursor plugin surfaces live in `.cursor-plugin/`, `.cursor/`, `commands/`, `skills/`, `agents/`, and `hooks/`. Tests mirror those areas under `tests/`. Generated output belongs in `dist/`; project runtime state belongs in `.omcu/` and must not be edited by hand.

## Build and test commands

Use Node.js 20 or newer.

- `npm ci` installs the locked development dependencies.
- `npm run build` cleans and compiles TypeScript into `dist/`.
- `npm test` runs the Vitest suite once.
- `npm run check` runs the release gate: build, then all tests.
- `node dist/bin/omcu.js --help` checks the compiled CLI surface.
- `node dist/bin/omcu.js capabilities discover` compares the live Cursor Agent against the pinned capability lock.

## Code and documentation style

Use ESM TypeScript, explicit types at public boundaries, two-space indentation, semicolons, and single quotes. Keep state writes atomic and inside `.omcu/`. Preserve structured `E_*` errors, redaction, revision/generation fences, and shell-free argument construction. Use lowercase kebab-case for Markdown workflow names and descriptive `*.test.ts` names.

## Testing expectations

Add focused Vitest coverage for every behavior change. Prefer temporary directories and fake command runners; do not mutate a developer’s Cursor configuration, home directory, or global installation. Verify negative paths, authority boundaries, and nonzero exit codes, not only happy paths.

## Commits and pull requests

Use concise imperative commit subjects, for example `docs: document offline install`. Keep commits scoped. Pull requests should state the capability tier, list commands run, attach fresh output for live probes, and separate automated proof from manual or external seams.

## Security

Never commit credentials, transcripts, `.omcu/`, or install receipts. Treat hooks as policy signals, not a sandbox. Only `omcu` may write verification state; plugin skills, subagents, MCP proposals, and workflow receipts remain non-authoritative.
