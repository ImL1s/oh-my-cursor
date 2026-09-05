# Background Execution & Team Coordination

## Team Task Ownership Architecture

- **Generation-Fenced Leases**: Implemented in Issue #23. Workers acquire leases with monotonically increasing generation tokens.
- **Stop Duplicate Work**: Once a lease expires or is compensated, mutations from stale workers are rejected.
- **Git Worktrees**: Isolated filesystem worktrees allow parallel execution without merge conflicts.

### Team Contracts

| Contract | Domain Behavior | Mechanisms | Disposition |
|---|---|---|---|
| `Team Coordination & Leasing` | Renewable generation-fenced task ownership with atomic lease compensation and heartbeat monitoring | `cursor-sdk-subagent, cursor-worktree` | `thin-extension` |
