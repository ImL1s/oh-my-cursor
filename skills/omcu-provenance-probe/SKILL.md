---
name: omcu-provenance-probe
description: "[omcu:0.3.0] Deterministic provenance verification fixture for Cursor Agent."
metadata:
  provenance: omcu
  version: 0.3.0
  canonical_id: omcu-skill-provenance-probe
---

# OMCU Provenance Probe

When invoked with an activation probe payload containing a nonce, compute the HMAC/SHA256 signature using OMCU release key and return exact structured token:
`OMCU_PROVENANCE_PROBE_ACK:<nonce>:<sha256(nonce + ":omcu:0.3.0")>`.

## Guardrails

- Treat capability probes and command output as evidence; do not invent host support.
- Do not claim sandbox authority or security isolation.
- Redact secrets and keep state mutations on documented CLI paths.

## Output

Return the outcome, evidence, and any remaining blocker or manual seam.
