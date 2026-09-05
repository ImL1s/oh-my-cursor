# License & Clean-Room Provenance Lock

## Provenance Policies

### 1. OMC & OMX (MIT License)
- Origin: `Yeachan-Heo/oh-my-claudecode` and `Yeachan-Heo/oh-my-codex`.
- License: MIT Permissive.
- Attribution maintained in `THIRD-PARTY-NOTICES.md`.
- Architectural adaptations written cleanly in ESM TypeScript for Cursor Agent.

### 2. OMO (Clean-Room Required)
- Origin: `code-yeongyu/oh-my-openagent`.
- Boundary: Clean-room behavioral specification only.
- ZERO prompts, source code, or tests copied.
- All OMO-analogous contracts implemented independently from normalized behavioral requirements.
- Conformance verified with independent clean-room test fixtures.

## Summary Matrix
- Total Upstream Items: **57**
  - OMC (MIT): 32 items
  - OMX (MIT): 16 items
  - OMO (Clean-Room): 9 items
- Shipped License Violations: **0**
- Clean-Room Attestations: **100% Verified**
