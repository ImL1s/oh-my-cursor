# Permissions & Auto-Review Gate Parity

## Permission Engine

OMCU maps upstream approval mechanisms to Cursor's native `local.autoReview` API and `permissions.json`.

### Contract Details

| Contract | Selected Mechanisms | Disposition | Status |
|---|---|---|---|
| `Policy & Permission Boundary` | `cursor-permissions-auto-review, omcu-domain-layer` | `native` | `pass` |

- Fail-closed security boundaries prevent arbitrary code execution outside designated workspace bounds.
