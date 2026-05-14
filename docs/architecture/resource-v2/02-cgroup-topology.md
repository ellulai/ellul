# 02 — Cgroup Topology

> Status: shipped (slices + bundle.ts reduction + memory-budget extension + provisioning rename).

## What this layer owns

The cgroup-v2 hierarchy that bounds every process on the VPS. The previous topology
let pool processes (opencode-serve, cursor-agent ACP, codex daemon, Pro Claude SDK
processes) inherit `agent-bridge.service`'s cgroup, so a single Pro Claude thread on
top of warm pools could push the bridge's cgroup over `MemoryMax=1024M` and SIGABRT
the bridge — taking pool processes with it.

The new topology fixes this by:

1. **Reducing the bridge's own cap** to `MemoryMax=512M` — enough for the bridge
   itself plus immediate watchers; pools are no longer here so they no longer count.
2. **Adding `ellul-user-workload.slice`** as the aggregate cap on everything user
   workloads consume (previews + per-sandbox pool processes + Pro Claude slot
   processes).
3. **Adding per-sandbox transient slices** under `ellul-user-workload.slice` so each
   sandbox's pool processes have their own cgroup. Per-sandbox slices have a soft
   `MemoryHigh` hint (no hard `MemoryMax`) — pressure surfaces at the parent
   `ellul-user-workload.slice` level via `ManagedOOMMemoryPressure=kill`.
4. **Re-parenting the existing previews slice** under `ellul-user-workload.slice` so
   previews and pools share the same aggregate budget.

## The hierarchy

```
ellul.slice                           [auto, no-cap]
├── ellul-control-plane.slice         [EXISTS — cap reduced; bridge cap also reduced]
│   ├── ellul-agent-bridge.service    MemoryMax=512M  ← was 1024M
│   ├── ellul-sovereign-shield.service
│   ├── ellul-caddy.service
│   ├── ellul-file-api.service
│   ├── ellul-watchdog.service
│   ├── ellul-term-proxy.service
│   └── ellul-enforcer.service
│
├── ellul-user-workload.slice         [NEW]
│   │   MemoryMax=72%, MemoryHigh=64%       (sized via memory-tuning.sh exports)
│   │   ManagedOOMMemoryPressure=kill, MemoryPressureLimit=80%
│   │   MemorySwapMax=0
│   │   TasksMax = scales with tier
│   │
│   ├── ellul-user-workload-previews.slice   [RENAMED from ellul-previews.slice]
│   │   │   MemoryMax=70%, MemoryHigh=63%    (PREVIEW_SLICE_PERCENT pinned to admission)
│   │   │   per-unit cap written via writeFrameworkDropin (framework-aware)
│   │   └── ellul-preview@<instance>.service
│   │
│   ├── ellul-user-workload-sbx-<sandboxId>.slice    [NEW transient, per active sandbox]
│   │   │   MemoryHigh = perSandboxSoftHintMB  (1.5 G on $20 / 4 GB; 2 G on $50 / 8 GB)
│   │   │   no MemoryMax — soft-fences only; aggregate cap enforced at user-workload level
│   │   │   created on-demand via systemd-run --slice= --property=
│   │   ├── ellul-pool-sbx-<sandboxId>-opencode.scope
│   │   ├── ellul-pool-sbx-<sandboxId>-cursor.scope
│   │   ├── ellul-pool-sbx-<sandboxId>-codex.scope
│   │   └── (no Pro Claude scopes — see below)
│   │
│   └── ellul-pro-claude-slot<N>.scope  [NEW transient, slot-based not per-sandbox]
│           Pro Claude is slot-based across the VPS, not per-sandbox.
│           N ∈ {1} on $20 tier, {1,2,3} on $50 tier.
│
└── ellul-namespaces.slice            [EXISTS — unchanged, KB-sized]
    └── ellul-ns-<sandboxId>.service  (sleep-infinity anchors)
```

## Naming deviation from the brief

The brief shows two slices with names that don't match systemd's name-is-hierarchy
rule:

| Brief name | Systemd parent under that name | Resolution |
|---|---|---|
| `ellul-previews.slice` (re-parented under `ellul-user-workload`) | `ellul.slice` (sibling, not child) | Renamed to `ellul-user-workload-previews.slice` so systemd actually parents it under user-workload. |
| `ellul-ns-<sandbox>.slice` (transient under `ellul-user-workload`) | `ellul-ns.slice` (sibling, not child) | Renamed to `ellul-user-workload-sbx-<id>.slice` so transients land under the user-workload aggregate cap. |

Systemd does not allow a slice unit to override its parent — the dash hierarchy is
how systemd computes parent. Renaming is the only way to re-parent. Per the brief's
"no compatibility shims" rule, the rename is unconditional and the provisioning
section installs the new file paths and removes the old.

## Memory budget computation

Authoritative function: `computeWorkloadSliceBudget(physicalMB)` in
[`packages/vps/src/services/shared/memory-budget.ts`](../../../../packages/vps/src/services/shared/memory-budget.ts).

```
kernelReservedMB        = max(256, phys × 8%)
controlPlaneAggregateMB = phys × 28%        (sized to fit heap caps + ~150 MB off-heap + warm pool on 4 GB)
workloadMaxMB           = phys × 72%
workloadHighMB          = workloadMaxMB × 89%
previewBudgetMB         = phys × 70%        (PREVIEW_SLICE_PERCENT — pinned to admission's perPreviewBudget)
previewHighMB           = previewBudgetMB × 90%
perSandboxSoftHintMB    = 1536 if phys ≤ 4096 else 2048
```

Per-preview cap derives from the budget and the tier-specific hot-preview cap (2 / 3 / 4 / 6
on 4 GB / 8 GB / 16 GB / 32 GB), bounded by `PER_PREVIEW_FLOOR_MB=1280` and
`PER_PREVIEW_CEILING_MB=4096`.

Worked examples:

| Tier | phys | kernel | control-plane | workload max | preview budget | per-preview cap | concurrent |
|---|---|---|---|---|---|---|---|
| $20 indie | 4 096 MB | 327 | 1 146 | 2 949 (72 %) | 2 867 (70 %) | 1 433 | 2 |
| $50 pro | 8 192 MB | 655 | 2 293 | 5 898 (72 %) | 5 734 (70 %) | 1 911 | 3 |
| 16 GB | 16 384 MB | 1 310 | 4 587 | 11 796 (72 %) | 11 468 (70 %) | 2 867 | 4 |
| 32 GB | 32 768 MB | 2 621 | 9 175 | 23 592 (72 %) | 22 937 (70 %) | 3 822 (clamped) | 6 |

Slice files emit MB-explicit caps via bash variable substitution at boot
(`memory-tuning.sh` exports `ELLUL_PREVIEW_BUDGET_MB`, `ELLUL_WORKLOAD_MAX_MB`,
`ELLUL_CONTROL_PLANE_MAX_MB`, etc.; the unquoted heredoc in `payload.ts`
substitutes them into the slice file at write time):

```ini
# user-workload-unit.slice (after substitution on a 4 GB host)
MemoryHigh=2624M
MemoryMax=2949M
```

This guarantees admission's per-preview cap and the cgroup slice cap agree
exactly — no "budget says 80% but slice clips at 60%" gap on bigger tiers.

## Per-sandbox transient slice creation

Authoritative: [03-spawn-routing.md](03-spawn-routing.md). Summary:

```sh
sudo systemd-run \
  --quiet --collect --scope \
  --slice=ellul-user-workload-sbx-<sandboxId>.slice \
  --unit=ellul-pool-sbx-<sandboxId>-<adapter>-<scopeId> \
  --property=MemoryHigh=<perSandboxSoftHintMB>M \
  --property=MemorySwapMax=0 \
  --property=TasksMax=512 \
  -- \
  ellul-agent-namespace enter <sandboxId> -- <cmd> <args...>
```

`systemd-run` creates the slice on-demand if it doesn't exist; `--property=` on the
first scope sets the slice's `MemoryHigh`. Subsequent scopes in the same slice
inherit the existing properties. The slice is auto-collected when its last scope
exits.

For Pro Claude slot scopes, the slice is the user-workload slice directly:

```sh
sudo systemd-run \
  --quiet --collect --scope \
  --slice=ellul-user-workload.slice \
  --unit=ellul-pro-claude-slot<N> \
  --property=MemoryHigh=<proSlotSoftHintMB>M \
  --property=MemorySwapMax=0 \
  --property=TasksMax=256 \
  -- \
  ellul-claude-launch ...
```

## Bridge cap reduction

`packages/vps/src/services/backends/agent-bridge/bundle.ts` modified:

```diff
- MemoryHigh=768M
- MemoryMax=1024M
+ # v2: pools no longer inherit this cgroup (they spawn into per-sandbox
+ # transient slices under ellul-user-workload.slice). 512 M is enough for
+ # the bridge process, MetricsCollector sidecar, and immediate child watchers.
+ MemoryHigh=384M
+ MemoryMax=512M
```

The bridge's role narrows: it orchestrates spawn but does not host the pool
processes' RSS. Local benchmarks show the bridge process itself at ~170 MB
(Node + Effect + WebSocket server + adapter runtime), well under 512 M.

## What `systemd-cgls` shows after this lands

```
ellul.slice
├── ellul-control-plane.slice
│   ├── ellul-agent-bridge.service
│   │   └── 12345 /home/dev/.node/bin/node /usr/local/bin/ellul-agent-bridge
│   ├── ellul-sovereign-shield.service
│   ├── ellul-caddy.service
│   ├── ellul-file-api.service
│   ├── ellul-watchdog.service
│   ├── ellul-term-proxy.service
│   └── ellul-enforcer.service
│
├── ellul-user-workload.slice
│   ├── ellul-user-workload-previews.slice
│   │   ├── ellul-preview@workspace-apps-api.service
│   │   │   └── 22001 npm run dev
│   │   └── ellul-preview@workspace-apps-web.service
│   │       └── 22050 next dev
│   │
│   ├── ellul-user-workload-sbx-abc1234.slice
│   │   ├── ellul-pool-sbx-abc1234-opencode.scope
│   │   │   └── 33001 opencode serve
│   │   ├── ellul-pool-sbx-abc1234-cursor.scope
│   │   │   └── 33042 cursor-agent acp
│   │   └── ellul-pool-sbx-abc1234-codex.scope
│   │       └── 33078 codex daemon
│   │
│   ├── ellul-user-workload-sbx-def5678.slice
│   │   └── ellul-pool-sbx-def5678-opencode.scope
│   │       └── 33102 opencode serve
│   │
│   ├── ellul-pro-claude-slot1.scope
│   │   └── 44001 claude --resume <sessionId>
│   └── ellul-pro-claude-slot2.scope
│       └── 44102 claude --resume <sessionId>
│
└── ellul-namespaces.slice
    ├── ellul-ns-abc1234.service
    │   └── 11001 sleep infinity
    └── ellul-ns-def5678.service
        └── 11002 sleep infinity
```

`agent-bridge.service` is small. Pool processes are under their sandbox's slice.
Pro Claude slots are under user-workload directly.

## ManagedOOM / pressure handling

Per slice:

| Slice | ManagedOOMMemoryPressure | ManagedOOMSwap | Why |
|---|---|---|---|
| `ellul-control-plane.slice` | kill, 75% | kill | Existing — keep |
| `ellul-user-workload.slice` | kill, 80% | kill | NEW — picks heaviest unit when sustained pressure crosses 80%; protects bridge's slice from cascading pressure |
| `ellul-user-workload-previews.slice` | kill, 60% | kill | Existing — preview eviction at lower threshold than pools |
| `ellul-user-workload-sbx-<id>.slice` | (none) | (none) | Transient. Pressure handled by parent. Per-sandbox slices are soft-fence-only; killing here would lose user pool state |
| `ellul-namespaces.slice` | (none) | kill | Anchors must survive memory pressure — namespace loss = sandbox loss |

The kill action for `ellul-user-workload.slice` is the workload's "last resort" —
under sustained pressure beyond 80 %, systemd-oomd picks the largest unit inside
and SIGKILLs it. AdmissionService and DegradationController act much earlier (yellow
@ 70 %, red @ 90 %) so this kill should be vanishingly rare. When it does fire, it
correctly targets the heaviest unit rather than the kernel OOM-killer's blunt
oom_score-based pick.

## TasksMax sizing

| Slice | TasksMax | Why |
|---|---|---|
| `ellul-control-plane.slice` | 600 | Existing |
| `ellul-user-workload.slice` | 4096 | Aggregate. Each pool ≈ 50–200 tasks; 5 sandboxes × 3 adapters × 100 = 1500. 4096 leaves headroom for previews + Pro slots |
| `ellul-user-workload-previews.slice` | 800 | Existing |
| `ellul-user-workload-sbx-<id>.slice` | 512 | Per-sandbox cap. Catches one runaway adapter without taking down the host |
| `ellul-namespaces.slice` | 512 | Existing |

## Migration safety

Renames `ellul-previews.slice` → `ellul-user-workload-previews.slice`. The migration
is non-trivial because existing previews have `Slice=ellul-previews.slice` baked in.
Provisioning step (in `apps/api/src/provisioning/sections/sandboxes.ts`):

1. `systemctl stop 'ellul-preview@*.service'` (graceful — preview reconciler will
   restart them).
2. `rm -f /etc/systemd/system/ellul-previews.slice`.
3. Install:
   - `/etc/systemd/system/ellul-user-workload.slice`
   - `/etc/systemd/system/ellul-user-workload-previews.slice` (with the body that
     was `ellul-previews.slice`).
   - Updated `/etc/systemd/system/ellul-preview@.service` (template with new
     `Slice=` and `PartOf=`).
4. `systemctl daemon-reload`.
5. The preview reconciler at next tick (every 10 s per `PREVIEW_LIMITS.RECONCILE_INTERVAL_MS`)
   detects active-preview markers without a running unit and re-starts each.

**Active sessions impact**: Step 1 stops user dev servers briefly. The reconciler
re-starts them within 10 s. Browser-side preview clients reconnect via the keepalive
protocol ([12-preview-keepalive.md](12-preview-keepalive.md)) — visibility-aware,
so a tab in the foreground sees the gap, a backgrounded tab does not. UI shows
`PreviewStatusPill: Restarting after upgrade` for the gap window.

This migration step runs once per VPS during the v2 rollout. Not idempotent in the
"no-op when already migrated" sense — the absence of `ellul-previews.slice` and
presence of `ellul-user-workload.slice` is the post-condition.

## Security invariants preserved

| Invariant | How preserved |
|---|---|
| `agent-bridge.service` runs as `$SVC_USER`, not root | `User=$SVC_USER` unchanged in bundle.ts |
| `agent-bridge.service` keeps `SupplementaryGroups=shield-ipc` | Unchanged |
| `agent-bridge.service` keeps `LimitCORE=0` | Unchanged |
| New `ellul-user-workload.slice` does not introduce SUID | Slice files have no executable; only `[Slice]` directives |
| Per-sandbox transient slice creation requires elevated privilege | Goes through existing `ellul-agent-namespace` sudoers entry. New systemd-run sudoers rule scoped to slice/unit name patterns — see [03-spawn-routing.md](03-spawn-routing.md#sudoers) |
| `ellul-namespaces.slice` (anchors) keeps `ManagedOOMMemoryPressure` UNSET | Unchanged — anchor death = namespace loss = sandbox loss |
| `ellul-user-workload-previews.slice` keeps `MemorySwapMax=0` | Unchanged |
| Bridge does not gain new capabilities | Same `User=`, same `SupplementaryGroups=`, same `Protect*=` |

## Acceptance

| Criterion | How verified |
|---|---|
| `systemd-cgls` shows `ellul-user-workload.slice` with the documented children | Integration test in [03-spawn-routing.md](03-spawn-routing.md) (cgroup placement assertion) |
| `agent-bridge.service` cgroup contains only the bridge process plus immediate watchers | Same test |
| Bridge `MemoryMax` is 512 M | `bundle.ts` snapshot test |
| Per-sandbox slice gets the correct soft-hint per tier | `memory-budget.ts` unit test |
| Workload aggregate cap = phys − control-plane − kernel | `memory-budget.ts` unit test |
| Migration safely re-installs slices and template unit | Provisioning section integration test |
