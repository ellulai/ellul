# Shield local daemon

The local Shield daemon (`packages/shield/`) sits on the operator's workstation and mediates outbound calls from CLI agents (Claude, Codex, Cursor, OpenCode) to external services. Distinct from the cloud Shield Gateway (`docs/v2/products/03-shield-gateway.md`), which provides the same boundary on a managed VPS.

## Section index

| File | Purpose |
| --- | --- |
| `01-onboarding.md` | First-run UX, signup, daemon install, certificate trust. |
| `02-architecture.md` | Daemon architecture: UDS API, redaction engine, capability exec model. |
| `03-api.md` | UDS API reference: endpoints, request/response, auth model. |

Migrated from legacy `docs/SHIELD-API.md`, `docs/SHIELD-ARCHITECTURE.md`, `docs/SHIELD-GATEWAY-ONBOARDING.md`.
