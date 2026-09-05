# OMCU Canonical Agent Roles & Source Profiles

This document describes the canonical Cursor Agent role catalog in OMCU, including source profile mapping across upstream ecosystems (OMC, OMX, OMO), mechanical policy enforcement, prompt composition, and model routing.

---

## 1. Overview & Architecture

OMCU normalizes agent roles into canonical identities implemented through Cursor's native agent capabilities:
- **Cursor plugin `agents/` definitions**: Native markdown agent definitions with YAML frontmatter (`model: inherit`, single-level subagent boundaries).
- **Native subagents & `@cursor/sdk` profiles**: Programmatic and interactive child agent execution with bounded handoff artifacts.
- **Model routing**: Dynamic model matching using a strict 7-step precedence ladder resolved against Cursor Router.
- **Mechanical enforcement**: Strict tool whitelisting, write-scope enforcement (`none`, `markdown-only`, `worktree-only`, `path-scoped`, `all`), leaf agent delegation blocking (`maxDepth: 0`), and Team eligibility gating.

---

## 2. Canonical Roles & Source Profiles

Every upstream role from OMC, OMX, and OMO is mapped to a canonical OMCU role and explicit source profile:

| Canonical Role | Canonical ID | Mode | Category | Routing Tier | Source Profiles |
|---|---|---|---|---|---|
| `omcu-architect` | `omcu-agent-architect` | either | architecture | reasoning | `default`, `omc`, `omx`, `omo-oracle` |
| `omcu-critic` | `omcu-agent-critic` | subagent | review | reasoning | `default`, `omc`, `omo-momus` |
| `omcu-debugger` | `omcu-agent-debugger` | either | debugging | smart | `default`, `omc`, `omx`, `omx-tracer` |
| `omcu-executor` | `omcu-agent-executor` | either | execution | smart | `default`, `omc`, `omx`, `omo-junior`, `omo-hephaestus` |
| `omcu-explorer` | `omcu-agent-explore` | subagent | reconnaissance | fast | `default`, `omc`, `omx`, `omo-hermes` |
| `omcu-planner` | `omcu-agent-planner` | either | planning | reasoning | `default`, `omc`, `omx`, `omo-prometheus` |
| `omcu-qa-tester` | `omcu-agent-qa-tester` | either | testing | smart | `default`, `omc`, `omx`, `omo-athena` |
| `omcu-scientist` | `omcu-agent-scientist` | subagent | research | reasoning | `default`, `omc`, `omx` |
| `omcu-verifier` | `omcu-agent-verifier` | subagent | verification | reasoning | `default`, `omc`, `omx` |
| `omcu-writer` | `omcu-agent-writer` | either | documentation | fast | `default`, `omc`, `omx` |
| `omcu-analyst` | `omcu-agent-analyst` | subagent | analysis | smart | `default`, `omx`, `omo-metis` |
| `omcu-build-fixer` | `omcu-agent-build-fixer` | subagent | debugging | fast | `default`, `omx` |
| `omcu-code-simplifier` | `omcu-agent-code-simplifier` | subagent | refactoring | smart | `default`, `omx` |
| `omcu-git-master` | `omcu-agent-git-master` | either | operations | fast | `default`, `omx` |
| `omcu-lead` | `omcu-agent-lead` | primary | coordination | reasoning | `default`, `omo-lead` |
| `omcu-worker` | `omcu-agent-worker` | subagent | execution | smart | `default`, `omo-worker` |
| `omcu-inspector` | `omcu-agent-inspector` | subagent | review | smart | `default`, `omo-inspector`, `omo-argus` |
| `omcu-reviewer` | `omcu-agent-reviewer` | subagent | review | smart | `default`, `omc`, `omx`, `omx-security-reviewer` |
| `omcu-provenance-agent` | `omcu-agent-provenance-agent` | subagent | verification | fast | `default` |

### OMO 11 Built-in Role Clean-Room Mapping

All 11 built-in OMO roles are clean-room mapped to canonical OMCU roles with source profiles:
1. `oracle` → `omcu-architect` (`--profile omo-oracle`)
2. `junior` → `omcu-executor` (`--profile omo-junior`)
3. `prometheus` → `omcu-planner` (`--profile omo-prometheus`)
4. `momus` → `omcu-critic` (`--profile omo-momus`)
5. `metis` → `omcu-analyst` (`--profile omo-metis`)
6. `hephaestus` → `omcu-executor` (`--profile omo-hephaestus`)
7. `argus` → `omcu-inspector` (`--profile omo-argus`)
8. `hermes` → `omcu-explorer` (`--profile omo-hermes`)
9. `athena` → `omcu-qa-tester` (`--profile omo-athena`)
10. `lead` → `omcu-lead` (`--profile omo-lead`)
11. `worker` → `omcu-worker` (`--profile omo-worker`)

---

## 3. Prompt Composition & Context Bounding

Role prompts are composed at invocation time from 6 modular sections:
1. **Identity**: Role persona, category, and single-level subagent boundary.
2. **Task Contract**: Expected inputs, outputs, and artifact destinations.
3. **Tool Policy**: Mechanically enforced allowed and denied tools with write scope.
4. **Evidence Rules**: Non-assumptive verification requirements and secret redaction.
5. **Source Profile**: Profile-specific behavioral guidance and intentional differences.
6. **Host Limitations**: Cursor native host constraints.

**Context Bounding**: Child subagents receive a bounded task handoff artifact compiled by `compileChildHandoffArtifact`, avoiding parent conversation transcript bleed.

**Deterministic Hashing**: Every prompt composition generates a SHA-256 `promptHash` included in task receipts.

---

## 4. Model Routing & Resolution Ladder

Model routing resolves via a 7-step precedence ladder:
1. `explicit_model`: Direct user flag `--model <model>`.
2. `profile_constraint`: Exact model requirement declared by role or profile.
3. `user_override`: Project or user override (`userOverrides[role]`).
4. `category_policy`: Routing tier matching (`reasoning`, `smart`, `fast`) via Cursor Router.
5. `compatible_fallback`: Ordered fallback tiers when preferred tier is unavailable.
6. `external_provider`: Explicitly selected external provider.
7. `unavailable`: Fails closed with `E_MODEL_UNAVAILABLE` if no compatible model exists.

---

## 5. Mechanical Policy Enforcement

- **Read-only advisors** (`architect`, `critic`, `analyst`, `inspector`, `reviewer`): Cannot write files, replace content, or execute mutating commands.
- **Leaf agents**: Cannot spawn subagents (`maxDepth: 0`, `canDelegate: false`).
- **Write scopes**:
  - `none`: Write operations strictly blocked.
  - `markdown-only`: Restricted to `docs/`, `*.md`, and `.omcu/artifacts/`.
  - `worktree-only`: Strictly restricted to assigned git worktree path.
  - `path-scoped`: Constrained to diagnostic compiler spans.
  - `all`: Full write permissions conforming to repository guidelines.
- **Team eligibility**: Ineligible roles (`git-master`, `provenance-agent`) fail closed before execution with `E_ROLE_TEAM_INELIGIBLE`.
- **Policy intersection**: Child subagent permissions are strictly narrowed to the intersection of parent policy and role definition.

---

## 6. CLI Usage

```bash
# List all canonical and custom roles
omcu agents list [--source omc|omx|omo|custom|all] [--json]

# Show detailed role metadata, profiles, and prompt preview
omcu agents show <role> [--profile <profile>] [--json]

# Invoke role with prompt and mechanical policy enforcement
omcu agents invoke <role> --prompt "<objective>" [--runtime local|cloud] [--background] [--profile <profile>] [--json]

# Explain model routing resolution steps
omcu route explain --agent <role> [--profile <profile>] [--model <model>] [--json]
```
