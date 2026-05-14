# Runbooks

One markdown file per typed error code emitted by the resource-v2 services. Each runbook follows the same structure:

1. **What the user sees** — the UI surface that displays this code.
2. **What the system did automatically** — the service-level response (queueing, eviction, restart, etc.).
3. **What an operator should check** — concrete commands.
4. **Validating chaos scenario** — which `packages/vps/test/chaos/*.test.ts` exercises this code.
5. **Past incidents** — links if any.

User-visible codes (mapped from `ThreadErrorBanner`):

| Code | Runbook |
|---|---|
| ERR_ADMISSION_NO_HEADROOM | [ERR_ADMISSION_NO_HEADROOM.md](ERR_ADMISSION_NO_HEADROOM.md) |
| ERR_ADMISSION_TIER_CAP | [ERR_ADMISSION_TIER_CAP.md](ERR_ADMISSION_TIER_CAP.md) |
| ERR_ADMISSION_DEGRADED_RED | [ERR_ADMISSION_DEGRADED_RED.md](ERR_ADMISSION_DEGRADED_RED.md) |
| ERR_ADMISSION_PRESSURE_HIGH | [ERR_ADMISSION_PRESSURE_HIGH.md](ERR_ADMISSION_PRESSURE_HIGH.md) |
| ERR_ADMISSION_FRAMEWORK_TOO_BIG | [ERR_ADMISSION_FRAMEWORK_TOO_BIG.md](ERR_ADMISSION_FRAMEWORK_TOO_BIG.md) |
| ERR_QUEUE_FULL | [ERR_QUEUE_FULL.md](ERR_QUEUE_FULL.md) |
| ERR_SLOT_HYDRATE_FAILED | [ERR_SLOT_HYDRATE_FAILED.md](ERR_SLOT_HYDRATE_FAILED.md) |
| ERR_SLOT_SPAWN_FAILED | [ERR_SLOT_SPAWN_FAILED.md](ERR_SLOT_SPAWN_FAILED.md) |
| ERR_SLOT_EVICT_TIMEOUT | [ERR_SLOT_EVICT_TIMEOUT.md](ERR_SLOT_EVICT_TIMEOUT.md) |
| ERR_SPAWN_SCOPE_BINARY_MISSING | [ERR_SPAWN_SCOPE_BINARY_MISSING.md](ERR_SPAWN_SCOPE_BINARY_MISSING.md) |
| ERR_PORT_BIND_TIMEOUT | [ERR_PORT_BIND_TIMEOUT.md](ERR_PORT_BIND_TIMEOUT.md) |
| ERR_CHECKPOINT_DISK_FULL | [ERR_CHECKPOINT_DISK_FULL.md](ERR_CHECKPOINT_DISK_FULL.md) |
| ERR_CGROUPV2_NOT_MOUNTED | [ERR_CGROUPV2_NOT_MOUNTED.md](ERR_CGROUPV2_NOT_MOUNTED.md) |

Internal codes (logged but not user-visible) are in [internal.md](internal.md).
