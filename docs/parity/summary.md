# OMC / OMX / OMO to Cursor Parity Contract Matrix Summary

## Overview

This document presents the comprehensive contract matrix mapping all user-visible and runtime behaviors from upstream ecosystems (**OMC** - `oh-my-claudecode`, **OMX** - `oh-my-codex`, and **OMO** - `oh-my-openagent`) to official **Cursor Native Mechanisms**.

### Upstream Baselines

| Project | Repository | Commit Hash | License Classification |
|---|---|---|---|
| **OMC** | `Yeachan-Heo/oh-my-claudecode` | `41a4c0f77144c5beb5f5f000a89cff379c680606` | MIT (Attributed) |
| **OMX** | `Yeachan-Heo/oh-my-codex` | `f43034aad68ed08dd886bf7f209a0415b8a7adb4` | MIT (Attributed) |
| **OMO** | `code-yeongyu/oh-my-openagent` | `888a26b6182ffbc5369cda3d35bd3eafb389dd96` | Clean-Room Required |

### Target Cursor Runtime Baselines

- **Cursor SDK**: `@cursor/sdk@1.0.31`
- **Cursor Plugins**: `cursor/plugins @ 15ef02d9719259476fbd13de1b2db35d79f04797`
- **Cursor Cookbook**: `cursor/cookbook @ 1907605052e378a315efd2565beee198c3922c87`
- **Host Capabilities**: Version 2 schema with 18 official Cursor primitives.

---

## Contract Disposition Breakdown

Total Normalized Contracts: **50**
- **Native** (`native`): 26 (52%) — Directly executed via official Cursor host primitives.
- **Composed** (`composed`): 16 (32%) — Assembled from Cursor SDK, plugins, subagents, and hooks without runtime re-implementation.
- **Thin Extension** (`thin-extension`): 8 (16%) — Native Cursor mechanism combined with atomic OMCU coordination state (.omcu/ leases, journals, compaction fences).
- **Fallback** (`fallback`): 0 (0%)
- **Unsupported** (`unsupported`): 0 (0%)

---

## Verification Status

- **Passing** (`pass`): 50 / 50 (100%)
- **Blocked / Partial / Drifted**: 0

All 57 inventoried upstream source items are 100% accounted for and mapped directly to verifiable Cursor host primitives.
