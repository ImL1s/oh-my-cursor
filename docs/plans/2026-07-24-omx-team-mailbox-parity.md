# OMCU OMX Team Mailbox / API Parity Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade experimental `omcu team` from pane spawn/stop into an OMX-shaped coordination plane with durable team state, mailbox, claim lifecycle, and `omcu team api` — while keeping `native_cursor_team: false` forever-honest.

**Architecture:** Extend `src/team/` beyond `ExperimentalTmuxTeamSupervisor` + manifest: add state root under `.omcu/state/team/<team>/` (mailbox, tasks, workers/inbox.md, dispatch). Keep cursor-agent panes as the control plane; data plane is files + CLI api. Host `--madmax`/`OMCU_LAUNCH_POLICY` remains separate.

**Tech Stack:** TypeScript, existing Jest tests, `src/team/*`, `src/cli/orchestration.ts`, OMX `TEAM_API_OPERATIONS` reference.

**Reference:**
- OMX demo: `src/scripts/demo-team-e2e.sh` (create→claim→transition→send-message→mailbox-list→cleanup)
- OMCU today: `omcu team start|run|status|collect|stop` only; no mailbox/api
- Asset: `assets/omcu-character.png` (shipped with README)

**Honesty / non-goals:**
- Never set `native_cursor_team: true`
- Never stamp `verified` from team collect
- P0 may keep experimental labeling; do not pretend Cursor ships native teams

---

### Task 1: Character asset + README (if missing)

**Files:**
- Ensure: `assets/omcu-character.png`
- Modify: `README.md` (+ locale readmes if they mirror hero)

**Step 1:** Confirm asset exists (1024 PNG)
**Step 2:** Center hero `<img>` like OMG/OMA
**Step 3:** Commit `docs: add omcu character asset`

---

### Task 2: Team state layout + failing tests

**Files:**
- Create: `src/team/state-root.ts`, `src/team/mailbox.ts`, `src/team/tasks.ts`
- Create: `tests/team/mailbox.test.ts`, `tests/team/api-interop.test.ts`

**Step 1: Failing tests for directory layout**

```text
.omcu/state/team/<team>/
  config.json
  manifest.v2.json   # or adapt schema_version honestly
  tasks/task-<id>.json
  mailbox/leader-fixed.json
  mailbox/worker-<n>.json
  workers/worker-<n>/inbox.md
  workers/worker-<n>/heartbeat.json
```

**Step 2:** Implement minimal create/load helpers
**Step 3:** Tests green
**Step 4:** Commit `feat(team): durable OMX-shaped state root`

---

### Task 3: Mailbox + claim primitives

**Files:**
- `src/team/mailbox.ts`, `src/team/tasks.ts`
- Tests as above

**Step 1:** Failing roundtrip send/list/ack + claim/transition
**Step 2:** Implement fenced JSON writes (fail closed on corruption)
**Step 3:** Green + commit `feat(team): mailbox and claim primitives`

---

### Task 4: `omcu team api` CLI

**Files:**
- Create: `src/team/api-interop.ts`
- Modify: `src/cli/orchestration.ts`, `src/cli/application.ts` help
- Test: parse + api unit tests

**P0 ops:**
`send-message`, `mailbox-list`, `mailbox-mark-delivered`, `create-task`, `list-tasks`, `claim-task`, `transition-task-status`, `release-task-claim`, `get-summary`, `write-worker-inbox`

**Step 1–4:** TDD → commit `feat(cli): omcu team api`

---

### Task 5: Wire supervisor start to initialize state + inboxes

**Files:**
- Modify: `src/team/supervisor.ts`
- On `team start`: create state root, write worker inboxes, retain pane spawn
- Prefer writing inbox then optional single trigger; do not make send-keys the source of truth

**Step 1:** Failing test that start creates mailbox + inbox files
**Step 2:** Implement
**Step 3:** Commit `feat(team): initialize mailbox/inbox on start`

---

### Task 6: status/resume/shutdown semantics

**Files:**
- Extend actions: `resume` (optional P0.5), ensure `stop` cleans panes **and** offers state cleanup api `cleanup`
- `status` includes task counts + dead workers if detectable

**Commit:** `feat(team): richer status/stop with state evidence`

---

### Task 7: Docs + skill honesty

**Files:**
- `skills/team/SKILL.md` — distinguish Cursor-native subagents vs `omcu team` tmux plane
- `README.md`, `CHANGELOG.md`, `docs/security.md` if present
- Explicit: experimental-local; not native Cursor team; P0 ops list

**Commit:** `docs(team): OMX-shaped api P0 + honesty`

---

### Task 8: Test gate

```bash
npm run build
npm run test:unit -- --testPathPattern='team|api-interop'
# e2e/package if applicable
```

---

## P1 / P2

- **P1:** Remaining OMX ops; dispatch queue; heartbeat watcher; worktree-aware workers
- **P2:** Mixed CLI workers (out of scope for cursor-only product default)

## Verification gate

- Unit tests green for mailbox/api
- `omcu team api --help` lists P0 ops
- `native_cursor_team` remains `false`
- Character asset present in README
