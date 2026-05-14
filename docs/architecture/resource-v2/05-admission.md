# 05 — AdmissionService

> Status: shipped (`packages/vps/src/services/backends/file-api/src/services/admission.service.ts` + tests). Replaces `preview-admission.ts` (which is removed).

## What this layer owns

The single path through which any spawn that consumes meaningful resources gets admitted: previews, Pro Claude slot warmups, opencode/cursor/codex pool acquires, and sandbox provisioning. Returns deterministic `accept | accept-after-evict | reject` with a typed reason and a typed eviction plan when applicable.

The brief's hard requirement: "A single AdmissionService is the only path for spawning anything that consumes meaningful resources. Inputs: real-time measured headroom, P95 reservation for the workload type (calibrated from telemetry). Output: deterministic accept/accept-after-evict/reject with typed reason. Heuristics like floor(budget/420) are forbidden."

## Inputs

- **Real-time headroom** from `MetricsCollector`:
  - `ellul-user-workload.slice` `memory.current` vs configured `MemoryMax` from `computeWorkloadSliceBudget(physicalMB).workloadMaxMB`.
  - Per-cgroup PSI memory `avg10` over the last 10 s.
- **P95 reservation per workload type** from MetricsCollector's 7-day window (or fallback to `frameworkMemoryProfile()` for previews / `proClaudeSlotSoftHintMB` for Pro / per-adapter steady-state for pools when telemetry is cold).
- **Tier caps** from `memory-budget.ts`: `proClaudeSlotCap`, `hotPreviewsCap`, `sidebarVisibleThreadsCap`.
- **Eviction candidates**: current evictable items (cold pool scopes, idle previews) — supplied by per-domain owners (preview lifecycle, pool managers, slot manager).

## Output

```ts
type AdmissionDecision =
  | { ok: true; tag: "accept"; reservedMB: number; admissionId: string }
  | { ok: true; tag: "accept_after_evict"; reservedMB: number; admissionId: string; evict: ReadonlyArray<EvictionPlan> }
  | { ok: false; tag: "reject"; reason: TypedRejection; required: { headroomMB: number; evictableMB: number; capRemaining: number } };

type TypedRejection =
  | "ERR_ADMISSION_NO_HEADROOM"          // not enough RAM even after eviction
  | "ERR_ADMISSION_TIER_CAP"             // tier-level cap reached (e.g. hot preview cap)
  | "ERR_ADMISSION_DEGRADED_RED"         // SystemHealth = red; admission paused
  | "ERR_ADMISSION_PRESSURE_HIGH"        // PSI avg10 above safe-spawn threshold
  | "ERR_ADMISSION_FRAMEWORK_TOO_BIG";   // single-workload reservation > available budget
```

## Decision algorithm

```
admit(req):
  budget = computeWorkloadSliceBudget(phys)
  health = systemHealth.current
  if health == red and req.kind != system: return reject(ERR_ADMISSION_DEGRADED_RED)

  cap = tierCap(req.kind, phys)
  if cap !== null and cap.current >= cap.max: return reject(ERR_ADMISSION_TIER_CAP)

  reserved = p95Reservation(req)            # measured; falls back to calibrated default
  if reserved > budget.workloadMaxMB:       # single-workload too big for tier
    return reject(ERR_ADMISSION_FRAMEWORK_TOO_BIG)

  pressure = metrics.latest("ellul-user-workload.slice").psiMem.avg10
  if pressure > 25 and req.kind != preview_demote: return reject(ERR_ADMISSION_PRESSURE_HIGH)

  used = metrics.latest("ellul-user-workload.slice").memoryCurrentBytes / MB
  headroomMB = budget.workloadMaxMB - used
  if reserved <= headroomMB: return accept(reserved)

  # need to evict
  plan = pickEviction(req, reserved - headroomMB)
  if plan.totalFreedMB >= reserved - headroomMB:
    return accept_after_evict(reserved, plan)
  return reject(ERR_ADMISSION_NO_HEADROOM, headroomMB, evictableMB=plan.totalFreedMB, capRemaining=cap?.max-cap?.current)
```

`pickEviction` orders candidates by LRU within tiers:

1. **Tier 1 — cold pool scopes** (`pool_scope` in `warm` with `refCount=0`, oldest first).
2. **Tier 2 — idle previews** (`preview` in `warm` with `lastActivityAt` past idle threshold, oldest first).
3. **Tier 3 — `warm` Pro Claude slots not bound to the request thread** (slots with `lastUseAt` oldest, excluding LRU-of-2-warm protection).

The plan returns the minimum prefix of candidates whose `freedMB` sum meets the deficit; never over-evicts.

## P95 reservation

Per workload type, computed over the last 7 days from MetricsCollector's daily snapshots:

| Workload | Cgroup family | P95 of `memoryCurrentBytes` over its lifetime |
|---|---|---|
| preview | `ellul-preview@<inst>.service` | per `frameworkId` |
| pool/opencode | `ellul-pool-sbx-*-opencode-*.scope` | adapter-wide |
| pool/cursor | `ellul-pool-sbx-*-cursor-*.scope` | adapter-wide |
| pool/codex | `ellul-pool-sbx-*-codex-*.scope` | adapter-wide |
| pro_claude | `ellul-pro-claude-slot[1-9].scope` | global |

When telemetry has < 100 samples for a workload type, falls back to:

- preview → `frameworkMemoryProfile(frameworkId, runtime).devPeakMB`
- pool/opencode → 240 MB (calibrated from the existing pool memory note)
- pool/cursor → 200 MB
- pool/codex → 250 MB
- pro_claude → `proClaudeSlotSoftHintMB` (320 MB)

Calibration runs on a daily cron; results are written to `<vault>/admission/p95.json` so they survive bridge restarts.

## What is removed

- `packages/vps/src/services/backends/file-api/src/services/preview-admission.ts` — the heuristic `floor(budget/420)` admission. Replaced.
- `packages/vps/src/services/backends/file-api/src/services/preview-pressure.ts` — fold into MetricsCollector + AdmissionService.

The remaining preview-* files (lifecycle, units, mutex, tracking, drain) become consumers of AdmissionService rather than standalone admission logic.

## Public API

```ts
export type WorkloadKind =
  | "preview"
  | "pool"
  | "pro_claude"
  | "sandbox"
  | "system";

export interface AdmissionRequest {
  kind: WorkloadKind;
  // For previews:
  frameworkId?: string | null;
  runtime?: string | null;
  // For pools:
  adapter?: "opencode" | "cursor" | "codex" | "claude";
  sandbox?: string;
  // For Pro Claude slot warmup:
  threadId?: string;
}

export interface AdmissionService {
  admit(req: AdmissionRequest): Promise<AdmissionDecision>;
  /** Returns headroom snapshot — for UI / observability. */
  headroom(): { workloadMaxMB: number; usedMB: number; freeMB: number; psiMemAvg10: number };
}
```

## Determinism + observability

Every decision emits a single structured event:

```json
{
  "event": "admission.decision",
  "kind": "preview",
  "tag": "accept_after_evict",
  "admissionId": "01H…",
  "reservedMB": 820,
  "evicted": [{"id":"sbx-abc1234/api","kind":"preview","freedMB":520}],
  "headroomMB_before": 312,
  "psiMemAvg10": 11.2,
  "p95Source": "telemetry"
}
```

Logged JSONL to `/var/log/ellul/agent-bridge-events.jsonl` (existing path). Integration tests assert byte-for-byte determinism: same input → same decision → same event payload.

## Failure modes

| Failure | Behaviour |
|---|---|
| MetricsCollector returns null for slice | `ERR_ADMISSION_NO_HEADROOM` with `headroomMB:-1` (treat as zero); SystemHealth gets a typed event |
| P95 file missing | Use calibrated defaults; log `admission.p95.coldStart` |
| Eviction execution fails after `accept_after_evict` | Caller responsibility — the decision is advisory; AdmissionService re-evaluates on next call |
| Race: two admit() calls find same headroom | A short in-process mutex serialises decisions; first wins. Documented in module docstring |

## Security invariants preserved

- AdmissionService runs in `file-api.service`, no new privileged surface.
- DB queries (for cap state) go through the existing `db_read` query proxy. No direct PG.
- No new sudoers entry. No SUID. No new env-file reads.
- Eviction plans are *advisory*: the caller (preview lifecycle / pool manager / slot manager) is responsible for actually issuing stop/evict — AdmissionService never spawns or kills directly. This keeps the service's blast radius minimal and the privileged surfaces unchanged.

## Acceptance

| Criterion | How verified |
|---|---|
| `accept` when `reserved ≤ headroom` | Unit test |
| `accept_after_evict` when eviction plan covers deficit | Unit test |
| `reject ERR_ADMISSION_NO_HEADROOM` when no plan covers | Unit test |
| `reject ERR_ADMISSION_TIER_CAP` when hot-previews cap hit | Unit test |
| `reject ERR_ADMISSION_DEGRADED_RED` when health=red | Unit test |
| Eviction plan never over-evicts | Property test |
| Telemetry-driven P95 used when available; fallback otherwise | Unit test with two scenarios |
| Decision event written for every call | Unit test |
| Concurrent admits serialised, no double-admission | Integration test |
