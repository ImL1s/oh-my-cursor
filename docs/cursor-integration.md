# Cursor integration

English | [简体中文](./cursor-integration.zh.md) | [繁體中文](./cursor-integration.zh-TW.md)

## Verified host surface

OMCU pins Cursor Agent `2026.07.20-8cc9c0b`. Run:

```sh
omcu capabilities discover
```

A result is verified only when both the version and required help text match the lock. This protects documentation and orchestration from silently assuming a newer or different CLI.

The pinned surface includes:

- interactive Agent sessions and non-interactive `--print` output;
- `text`, `json`, and `stream-json` output;
- session creation, selection, exact resume, and latest-session continue;
- Ask and Plan modes;
- plugin loading, rules, skills, hooks, MCP, and subagents.

Cursor's official references:

- [Cursor CLI overview](https://cursor.com/docs/cli/overview)
- [Using Agent in CLI](https://cursor.com/docs/cli/using)
- [CLI parameters](https://cursor.com/docs/cli/reference/parameters)
- [Output formats](https://cursor.com/docs/cli/reference/output-format)
- [Rules](https://cursor.com/docs/rules)
- [Agent Skills](https://cursor.com/docs/skills)
- [Subagents](https://cursor.com/docs/subagents)
- [Hooks](https://cursor.com/docs/hooks)
- [MCP](https://cursor.com/docs/mcp)
- [Plugins](https://cursor.com/docs/plugins)
- [Terminal tool](https://cursor.com/docs/agent/tools/terminal)

## Read-only behavior

`--print` only makes a run non-interactive. Cursor documents that print mode has all tools, including file writes and shell commands. It is therefore unsafe to treat this as a read-only flag:

```sh
# Non-interactive, but not read-only by itself
cursor-agent --print "inspect the repository"

# OMCU read-only planning lanes add Plan mode
cursor-agent --print --mode plan "produce a plan; do not edit files"
```

Ask and Plan reduce editing authority in the pinned host surface, but they do not prove OS-level isolation. Use Cursor's own approvals and sandbox configuration for that boundary.

## Sessions

```sh
omcu session create
omcu session list
omcu session resume --id <chat-id>
omcu session continue
```

Without `--prompt`, resume and continue open Cursor interactively. With `--prompt`, OMCU uses non-interactive JSON output. Exact resume validates the supplied ID and never falls back to a different chat.

## Plugin, rules, skills, and agents

Load the checkout for one Cursor invocation:

```sh
cursor-agent --plugin-dir "$PWD"
```

The plugin manifest exposes:

- slash commands in `commands/`;
- paired Agent Skills in `skills/`;
- custom agents in `agents/`;
- the always-applied rule in `.cursor/rules/oh-my-cursor.mdc`;
- lifecycle hooks from `hooks/hooks.json`;
- MCP configuration from `.mcp.json`.

Subagents are Cursor-native workers. OMCU's custom agents explicitly forbid nested delegation and keep final integration and verification with the parent. OMCU does not claim a documented native Cursor `team` command or general workflow-engine command.

## MCP

Cursor Agent reads project MCP configuration. OMCU ships an empty `.mcp.json` so installation does not silently start or authorize a server. The local MCP service implements only:

- `omcu.memory.search`;
- `omcu.memory.show`;
- `omcu.recovery.show`;
- `omcu.proposal.write`.

It exposes no shell tool and refuses fields that attempt to claim `passes` or `verified`. Proposals are redacted and non-authoritative.

## Worktrees and tmux

Cursor supports terminal tools and subagents. OMCU additionally provides:

- worktree-backed ULW: isolated detached Git worktrees with non-overlapping path ownership;
- an experimental tmux supervisor: local `cursor-agent --print --mode ask` processes in recorded panes and process groups.

These are OMCU local implementations. They are not native Cursor team authority, do not self-verify, and require a parent process to integrate results. tmux behavior depends on the local terminal, shell configuration, and process-group support. Cursor's terminal documentation recommends simplifying shell prompts when agent terminal output is malformed.

## No native memory or notification claim

Cursor documentation cited above does not define a Cursor Agent memory-management CLI or notification-delivery CLI. OMCU's `memory` and `notify` modules are project-local services under `.omcu/`. Notifications are disabled by default and OMCU includes only a refusing transport, so no message is sent until an application supplies and enables a transport.
