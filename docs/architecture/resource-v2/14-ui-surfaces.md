# 14 — UI Surfaces

> Status: shipped (components in `packages/vps-ui/src/chat/` and `packages/vps-ui/src/code-browser/`).

## What this layer owns

The user-visible representation of every state the new backend exposes. Per the brief: every typed error code, every degraded mode, every queue position, every preview state, and every Pro Claude slot transition has a visible affordance.

## Components

| File | What it shows |
|---|---|
| `chat/components/SandboxSwitcher.tsx` | Active sandbox + warm/cold dot + Pro Claude slot count for the sandbox |
| `chat/composer/RuntimeModeToggle.tsx` | Lite / Pro toggle per thread; Pro reserves a slot |
| `chat/composer/QueuedSendPill.tsx` | Inference queue position + ETA |
| `chat/panels/ConnectionStatusBanner.tsx` | "Reconnecting…" / "Reconnected" indicator |
| `chat/panels/DegradationModeBanner.tsx` | "Auto-tidying" (yellow) / "System at capacity" (red) banner |
| `chat/panels/ThreadErrorBanner.tsx` | Extended: typed error codes with runbook links |
| `chat/sidebar/ArchiveSection.tsx` | Soft-archive UX with click-to-unarchive |
| `chat/lib/preview-keepalive.ts` | Visibility-driven WS keepalive client |
| `code-browser/components/PreviewStatusPill.tsx` | Ready / Starting / Sleeping per preview |

## WS protocol additions

Server → client (broadcast):

- `system_health_update` — `{ state: "green"|"yellow"|"red", sliceUtilizationPct, psiMemAvg10 }`
- `pro_claude_slot_update` — `[{ slotIndex, state, threadId, inWarmCache, lastUseAt }]`
- `inference_queue_update` — `[{ key: { sandbox, adapter }, queued: [{ turnId, position, etaMs }] }]`
- `preview_state_update` — `{ appDirectory, state: "ready"|"starting"|"sleeping"|"failed", lastActivityAt }`
- `bridge_shutting_down` — release-pipeline drain signal (see [15-release-pipeline.md](15-release-pipeline.md))

Client → server (request):

- `preview_keepalive` — `{ appDirectory, port, at }` — sent every 60 s while preview iframe is `visibilityState === 'visible'`

## Typed error code surface

`ThreadErrorBanner` extended to accept either a string (legacy) or a typed code. When code is provided, the banner renders the friendly message + a "Runbook" link to `https://docs.ellul.ai/runbooks/<code>` (resolves to the in-repo runbook in dev).

Codes the bridge can emit (mapped to runbooks under [runbooks/](runbooks/)):

- `ERR_ADMISSION_NO_HEADROOM`
- `ERR_ADMISSION_TIER_CAP`
- `ERR_ADMISSION_DEGRADED_RED`
- `ERR_ADMISSION_PRESSURE_HIGH`
- `ERR_ADMISSION_FRAMEWORK_TOO_BIG`
- `ERR_QUEUE_FULL`
- `ERR_SLOT_HYDRATE_FAILED`
- `ERR_SLOT_SPAWN_FAILED`
- `ERR_SLOT_EVICT_TIMEOUT`
- `ERR_SPAWN_SCOPE_BINARY_MISSING`
- `ERR_PORT_BIND_TIMEOUT`
- `ERR_CHECKPOINT_DISK_FULL`
- `ERR_CGROUPV2_NOT_MOUNTED`

## Acceptance

| Criterion | How verified |
|---|---|
| All new components render without throwing on minimal props | Component snapshot tests |
| Preview keepalive client stops on visibility hide, resumes on show | Hook unit test |
| Typed error banner links to runbook | Component test |
| Queue pill shows position + ETA when queued; hides when accepted | Component test |
| Degradation banner copy matches state | Component test |
