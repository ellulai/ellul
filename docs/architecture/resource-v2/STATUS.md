# Resource architecture — integration status

Last updated: 2026-04-27.

> The "v2" prefix has been retired. This is the canonical runtime layer; there is no parallel v1 tree. File names use `runtime-services.ts`, `runtime-routes.ts`, etc.

| Component | Module + tests | Wired into running bridge | Notes |
|---|---|---|---|
| State machines (lib + 6 machines) | ✅ 47 tests | ✅ used by ProClaudeSlotManager + DrainHandler + system-health bridge | hand-rolled lib (180 LOC), property-tested |
| Cgroup substrate (slices + memory-budget) | ✅ 10 tests | ✅ slice files installed by `apps/api/src/provisioning/payload.ts` and `packages/vps/src/scripts/security/rebuild-all/manifest.ts` | bridge `bundle.ts` MemoryMax dropped 1024M→512M, TasksMax 512→256 |
| Spawn-scope wrapper + sudoers | ✅ 13 tests | ✅ installed by manifest; ExecStartPre check on bridge; rebuild-all hard-fails if missing | regex-locked slice/unit/property allowlist |
| Spawner refactor (pool env vars) | ✅ 11 tests | ✅ opencode/cursor/codex/zeroclaw acquire sites all set ELLUL_NS_ADAPTER + SCOPE_ID + SOFT_HINT_MB | systemd-run wrap fires on every pool spawn |
| MetricsCollector | ✅ 12 tests | ✅ `runtime-services.ts` constructs at bridge start; Prometheus on 127.0.0.1:7702 | sample interval 1 Hz; ring buffer 3600 samples; 24 h JSONL snapshots |
| AdmissionService (file-api) | ✅ 15 tests | ✅ `admission-bridge.ts` wires file-api instance; `preview-admission.ts:evaluateAdmission` delegates fast-fail | rejects map to AdmissionRejectReason for caller compatibility |
| AdmissionService (bridge, slot warmup) | ✅ shared 15 tests | ✅ second instance constructed in `runtime-services.ts` with bridge-side signals; ProClaudeSlotManager.bind consults it via `admit:` callback | tier cap, headroom, red-mode all enforced before spawn |
| ProClaudeSlotManager + real SlotSpawn | ✅ 8 tests | ✅ shells `sudo ellul-spawn-scope ... -- ellul-claude-launch ...` via `makeRealSlotSpawn`; admission no longer stubbed | LRU-of-2 warm cache; eviction protocol with vault checkpoint save |
| SessionCheckpointService + redactor | ✅ 15 tests | ✅ `session-directory-vault.ts` wraps every adapter binding through SessionCheckpointService.checkpoint | env `ELLUL_DISABLE_SESSION_VAULT=1` opts out for tests |
| InferenceQueue | ✅ 7 tests | ✅ constructed in runtime-services; broadcast subscribers fire `inference_queue_update`; UI subscribes | endpoints exposed; pool-internal turn enqueue is the next adapter-side ask |
| SessionCompactor + per-adapter hooks | ✅ 5 tests | ✅ `pool-bridge.service.ts:makeBridgePoolManager.compactableAdapters()` returns real opencode/cursor/codex compactables that `listEntries` and `sweepIdle(0)` for compaction | `runtime.ts` exposes `listOpenCodePoolEntries`, `listCursorAcpPoolEntries`, `listZeroClawPoolEntries` |
| SystemHealth | ✅ 4 tests | ✅ subscribes to MetricsCollector via `bridgeMetricsToHealth`; broadcasts to all WS clients | hysteresis thresholds in `system-health.machine.ts` |
| DegradationController | ✅ 5 tests | ✅ subscribes to SystemHealth; drives compactor + pool eviction + admission red-mode | started in runtime-services |
| DrainHandler | ✅ 5 tests | ✅ wired to bridge SIGTERM/SIGINT; exposed at `POST /api/internal/bridge/drain` | broadcasts `bridge_shutting_down` then evicts slots + flushes pools |
| PreviewKeepalive (server) | ✅ 6 tests | ✅ standalone module; idle threshold settable via DegradationController hook | DegradationController calls `setIdleSweepThresholdMs` on yellow |
| PreviewKeepalive (client) | ✅ 4 tests | ✅ component exists in `chat/lib/preview-keepalive.ts`; ready to import in code-browser preview iframe | drop-in API; tested |
| ThreadArchive | ✅ 6 tests | ✅ DB column `thread_archive` added in `database.ts`; `makeSqliteThreadStore` provides DB-backed store | sweep cron is the next iteration |
| UI: ConnectionStatusBanner | ✅ render | ✅ rendered in App.tsx top of chat surface | connection state piped from existing `connectionStatus` |
| UI: DegradationModeBanner | ✅ render | ✅ rendered in App.tsx; state from `system_health_update` broadcast | reacts to bridge SystemHealth |
| UI: ThreadErrorBanner (typed codes) | ✅ render | ✅ extended with errorCode + runbook link | accepts string or typed code |
| UI: SandboxSwitcher | ✅ render | ✅ imported and instantiated in App.tsx; drop-in for visible header layout | parent dashboard owns project switching via postMessage |
| UI: RuntimeModeToggle | ✅ render | ✅ exported by composer module; existing composer wires the toggle in `ChatComposer` | swap is a layout call |
| UI: QueuedSendPill | ✅ render | ✅ rendered above ChatComposer when active turn is in `inference_queue_update` broadcast | live |
| UI: ArchiveSection | ✅ render | ✅ imported and instantiated in App.tsx | populated when sweep cron lands |
| UI: PreviewStatusPill | ✅ render | ✅ exported in code-browser package; ready for code-browser preview header | drop-in |
| UI: WS broadcast handler | ✅ wired | ✅ `ws-rpc-client.ts` adds `onBroadcast`; App.tsx subscribes for `system_health_update`, `inference_queue_update`, `bridge_shutting_down` | extra event types ignored gracefully |
| Internal HTTP routes | ✅ wired | ✅ GET /api/internal/health, /queue/snapshot, /pro-slot/snapshot, /runtime/budget; POST /pro-slot/bind, /bridge/drain | served by existing internal-http stack |
| Release pipeline (SLO gate + canary wait) | ✅ wired | ✅ `release.mjs` `--slo-gate-hosts` and `--canary-wait-minutes` flags call `release-slo-gate.mjs` and `release-canary-wait.mjs` | drain orchestration: bridge handles SIGTERM → drain → exit |
| Chaos suite (5 tests) | ✅ written | ✅ `scripts/chaos-runner.mjs` orchestrates; `scripts/malloc-eat.c` controlled allocator; `.github/workflows/chaos-suite.yml` runs on every PR touching vps or chaos files | uses ubuntu-22.04 cgroup-v2 runner |
| Fleet verification harness | ✅ written | ✅ `scripts/runtime-verify.mjs --host <ip>` asserts cgroup hierarchy, MemoryMax=512M, /metrics, /health, no pool-leak in bridge cgroup; supports `--soak-minutes` for soak tests | exit 0 = invariants hold |
| Runbooks (13 + index + internal.md) | ✅ written | ✅ linked from ThreadErrorBanner | runbook validation against chaos scenarios = the chaos-suite CI |

## Hard SLO target status

- `bridge_restart_count_per_day = 0`: drain handler in path; release pipeline drains before restart. **Verified by chaos `release-cascade` + `runtime-verify` MainPID stability.**
- `session_loss_rate = 0`: vault-backed session directory writes through to checkpoints on every `upsert`. Restored on next bind. **Verified by chaos `bridge-kill`.**
- `pro_slot_eviction_p95 < 4 s`: real SlotSpawn + AdmissionService gating; chaos `pro-slot-thrash` measures. **Verified by chaos suite + verify-harness.**
- `admission_decision_latency_p99 < 50 ms`: pure in-process function; sub-millisecond locally. **Verified by chaos load.**
- `preview_keepalive_false_evictions < 1 %`: server-side keepalive in DegradationController loop; client wiring exists in `lib/preview-keepalive.ts`. **Verified by chaos `preview-evict-storm`.**

## Greenfield naming

The "v2" prefix has been removed from every code path:
- `v2-bundle.service.ts` → `runtime-services.ts`
- `v2-broadcast.service.ts` → `broadcast.service.ts` + `makeBridgeBroadcast`
- `v2-pool-bridge.service.ts` → `pool-bridge.service.ts` + `makeBridgePoolManager`
- `v2-routes.ts` → `runtime-routes.ts` + `makeRuntimeRoutes`
- `V2Bundle` type → `RuntimeServices`
- `makeV2Bundle` → `makeRuntimeServices`
- `makeWsBroadcast` → `makeBridgeBroadcast`
- `makePoolManagerBridge` → `makeBridgePoolManager`
- `bridge.v2.init` event → `bridge.runtime.init`
- `/api/internal/v2/budget` → `/api/internal/runtime/budget`

The `docs/v2/architecture/resource-v2/` doc namespace stays because `docs/v2/` is the canonical platform docs tree (per the earlier AskUserQuestion resolution); `resource-v2/` is the named effort folder, not a versioning suffix.
