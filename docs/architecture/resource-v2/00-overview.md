# 00 — System Overview

## What this redesign is

A first-principles rebuild of how the ellul.ai VPS allocates RAM, CPU, and process
slots across user sandboxes, threads, AI adapters, and previews — replacing
heuristic budgeting and inheritance-by-accident cgroup placement with deterministic,
measured admission and explicit per-sandbox slices.

It is built to hyperscaler engineering standards on cheap EU Hetzner ARM hardware.
The standard is the rigour, not the infrastructure.

## What it is not

Not new packages. Not parallel code. Not gated behind a feature flag. Where the
existing code conflicts with this design, the existing code is removed.

## Scope and tiers

Two paid tiers, EU-only:

| Tier | Price | Host RAM | Active Pro slots | Sidebar threads | Active previews |
|---|---|---|---|---|---|
| Indie | $20/mo | 4 GB | 1 | 30 | 2 hot |
| Pro | $50/mo | 8 GB | 3 | 100 | 3 hot |

User-facing:

- **Sandboxes**: unlimited.
- **Threads**: no hard cap; sidebar shows up to N "active"; older threads soft-archive
  (still searchable, click to unarchive). Pro slots in archived threads are torn down.
- **Adapters**: Claude Lite default; Pro is freely opt-in per thread.
- **Pro Claude is slot-based, not thread-based.** Cap *active processes*. Slot
  switching serializes the previous session via Claude SDK resume token to vault and
  hydrates the next from its last checkpoint. LRU-of-2-warm cache.
- **Previews**: admission-controlled. Visibility-driven heartbeat keeps active
  previews warm; idle ones evicted at 8 min.

## Failure modes eliminated

| # | Failure | Root cause | Fix |
|---|---|---|---|
| F1 | Bridge cgroup crash loop | Pool processes inherit `agent-bridge.service`'s `MemoryMax=1024M`. One Pro Claude thread tips the cgroup; bridge SIGABRTs; pool processes cascade-die. (`packages/vps/src/services/backends/agent-bridge/bundle.ts:178-179`) | Drop bridge to `MemoryMax=512M`. Spawn pool/Pro-Claude into per-sandbox transient slice via `systemd-run`. (See [02-cgroup-topology.md](02-cgroup-topology.md), [03-spawn-routing.md](03-spawn-routing.md).) |
| F2 | Pro Claude thread RAM linear in thread count | 234 MB held per thread for thread lifetime. 8 Pro threads → 1.9 GB. | Slot model: cap concurrent Pro processes; serialize sessions via SDK resume token to vault. Slot warmup ≤2 s. (See [06-pro-claude-slots.md](06-pro-claude-slots.md).) |
| F3 | Long-session daemon state growth | opencode/cursor/codex caches per-session token context, tool history, file reads. 20 messages ≈ 70 MB inside daemon. | Periodic compaction: drop in-memory turn history older than M turns. History persists on disk for replay. (See [08-session-compaction.md](08-session-compaction.md).) |
| F4 | Preview admission heuristic | `floor(budget/420)` count cap, HTTP-only idle eviction at 15 min reaps SPA previews while user reading. (`packages/vps/src/services/backends/file-api/src/services/preview-admission.ts`, `constants.ts:117-144`) | Mathematical admission service driven by P95 reservations from telemetry. Visibility-driven heartbeat at 60 s; idle reap at 8 min after last heartbeat OR HTTP hit. (See [05-admission.md](05-admission.md), [12-preview-keepalive.md](12-preview-keepalive.md).) |
| F5 | Release cascade drops WebSockets | Every `release.mjs` publish restarts `agent-bridge.service`. Active threads disconnect. | Bridge sends `bridge_shutting_down` event before stop. UI shows "Updating, reconnecting". Client reconnects with session rehydration from checkpoints. Canary VPS observed for 1 h before fleet roll. (See [07-session-checkpoints.md](07-session-checkpoints.md), [14-release-pipeline.md](14-release-pipeline.md).) |

## Cgroup topology

Authoritative description: [02-cgroup-topology.md](02-cgroup-topology.md). Summary:

```
ellul-control-plane.slice              [EXISTS — kept; bridge cap reduced]
  agent-bridge.service                 MemoryMax=512M  [reduced from 1024M; pools no longer here]
  sovereign-shield.service             [unchanged]
  caddy.service                        [unchanged]
  file-api.service                     [hosts AdmissionService]

ellul-user-workload.slice              [NEW]
                                       MemoryMax = host - control-plane - kernel reserve
                                       MemoryHigh = 80% × MemoryMax
                                       ManagedOOMMemoryPressure=kill, Limit=80%
  ellul-ns-<sandbox>.slice             [NEW transient, per active sandbox]
                                       MemoryHigh = tier-soft-hint (1.5 G $20, 2 G $50)
                                       no MemoryMax — soft-fences only
    ellul-pool-<sandbox>-opencode.scope
    ellul-pool-<sandbox>-cursor.scope
    ellul-pool-<sandbox>-codex.scope
    ellul-pro-claude-<slotN>.scope     [Pro Claude slot processes]
  ellul-previews.slice                 [EXISTS — re-parented under user-workload]

ellul-namespaces.slice                 [EXISTS — anchors only, KB-sized]
```

The load-bearing change is **process placement**. Today every CLI subprocess
inherits `agent-bridge.service`'s cgroup. The new spawn path wraps every pool /
Pro-Claude spawn with:

```
systemd-run --quiet --collect --scope \
  --slice=ellul-ns-<sandbox>.slice \
  --unit=ellul-pool-<sandbox>-<adapter>-<scopeId> \
  -- ellul-agent-namespace enter <sandbox> -- <cmd> <args...>
```

After this change `systemd-cgls` shows pool processes under their sandbox slice;
`agent-bridge.service` contains only the bridge process plus immediate watchers.

## Blast radius enforcement

Each component has a documented blast radius enforced by **cgroup hierarchy + supervision
tree + state externalization**.

| Component | Blast radius | Enforcement |
|---|---|---|
| `agent-bridge.service` | Bridge process only | `MemoryMax=512M`, no pool inheritance |
| Pool process (`opencode serve`, etc.) | One sandbox + one adapter | Lives in `ellul-ns-<sandbox>.slice`. Sandbox slice has soft `MemoryHigh` only — pool death stays local |
| Pro Claude slot | One slot (1 of N) | Lives in dedicated `ellul-pro-claude-<slotN>.scope` |
| Preview | One preview unit | Per-unit `MemoryMax`, slice-level `ManagedOOMMemoryPressure=kill` |
| Sandbox namespace | One sandbox | Mount + PID namespace, anchor in `ellul-namespaces.slice` |
| `sovereign-shield.service` | Auth / secrets | `LimitCORE=0`, `SupplementaryGroups=shield caddy`, separate from user-workload slice |

Property tests in [01-state-machines.md](01-state-machines.md) prove these radii hold
under concurrent transitions and chaos injection.

## SLOs

Wired into dashboards. Used as gates by `release.mjs` (see
[14-release-pipeline.md](14-release-pipeline.md)).

| SLO | Target | Window |
|---|---|---|
| `thread_send_latency_p99` | < 12 s for warm slot, < 30 s for cold slot | 5 min |
| `preview_cold_start_p95` | < 25 s (Node), < 60 s (JVM/Rust) | 5 min |
| `session_loss_rate` | 0 sessions lost per 1000 bridge restarts | 1 day |
| `bridge_restart_count_per_day` | 0 unintended | 1 day |
| `pro_slot_eviction_p95` | < 4 s (serialize + hydrate) | 5 min |
| `preview_keepalive_false_evictions` | < 1% of evictions evict a visible preview | 1 day |
| `admission_decision_latency_p99` | < 50 ms | 5 min |

The release pipeline auto-rolls-back on canary SLO regression. Definitions in
[14-release-pipeline.md](14-release-pipeline.md).

## System health and degradation modes

[10-system-health.md](10-system-health.md) and [11-degradation.md](11-degradation.md).

| Mode | Trigger | Actions | UI |
|---|---|---|---|
| **Green** | < 70 % slice utilization, all PSI < 5 % avg10 | Normal operation | No banner |
| **Yellow** | ≥ 70 % slice utilization OR PSI > 10 % avg10 sustained 30 s | Evict cold pool scopes, compact long sessions, lower preview keepalive aggressiveness | "Auto-tidying" pill on sidebar |
| **Red** | ≥ 90 % slice utilization OR PSI > 25 % avg10 sustained 15 s | Queue new sends (typed `system_at_capacity`), refuse new previews (typed `degraded_red_preview_blocked`), refuse Pro slot warmup | Banner: "System at capacity. New work queued." |

Each transition has triggers, exit conditions, and integration tests.

## State machines

Six explicit state machines, hand-rolled (≤200 LOC framework), property-tested.
Authoritative: [01-state-machines.md](01-state-machines.md).

| Machine | States | Lives in |
|---|---|---|
| `thread` | cold, warming, warm, sending, queued, error_recoverable, error_terminal, archived | bridge per thread |
| `sandbox` | not_provisioned, provisioning, warm, cold, hibernated, reaping | bridge per sandbox |
| `preview` | disabled, cold, starting, hot, warm, demoting, promoting, stopping, failed | file-api per preview |
| `pro_claude_slot` | empty, warming, warm, active, evicting, evicted | bridge per slot |
| `pool_scope` | cold, spawning, warm, inferring, reaping | bridge per (sandbox, adapter) |
| `system_health` | green, yellow, red | bridge global |

## Idempotency and resumability

Every operation is safe to retry. Adapters checkpoint session state to
`<vault>/sessions/<thread_id>/<turn_n>.json` after every turn. Bridge restart
triggers transparent rehydration. **Threads do not lose messages, ever.** That is a
hard SLO target measured by `session_loss_rate`.

| Adapter | Resume primitive |
|---|---|
| Claude (SDK) | `--resume <session_id>` with stored `resume_session_at` cursor and transcript |
| opencode | Session export via `client.session.export` + replay on `client.session.create` |
| cursor (ACP) | ACP `session/load` with stored ACP state snapshot |
| codex | Session ID + history pointer (codex resume) |

Specifics: [07-session-checkpoints.md](07-session-checkpoints.md).

## Capacity planning

Per-tier dashboards updated nightly from real fleet data:

- P50/P95 RSS per pool process (per adapter version).
- P50/P95 cold-start time per framework (per preview version).
- P50/P95 turn duration per Pro Claude slot.
- P95 sandbox count per active VPS, peak concurrent threads, peak concurrent previews.

The MetricsCollector ([04-metrics.md](04-metrics.md)) emits these. Tier sizing
becomes arithmetic: required headroom = ΣP95(workloads) + safety margin. If a tier
fails the arithmetic for the documented power-user workload, it gets resized
(host or budgets), not papered over with heuristics.

## Operations

Every typed error code introduced has a runbook in [runbooks/](runbooks/). The
runbook includes:

1. What the user sees.
2. What the system did automatically.
3. What an operator should check.
4. What chaos scenario validates the runbook.
5. Past incidents (if any).

CI executes each runbook against its chaos scenario on every PR.

## Security invariants preserved

This redesign is layered above the existing 9-layer git-push protection
(`docs/v2/security/06-git-push-protection.md`), Caddy directory isolation, per-project namespace
isolation (Phase 5), database gates (`db_read`/`db_write`/`db_migrate`), vault
layout, and `ptrace_scope=1`.

Specific points where this design touches security boundaries — and how it preserves
them:

| Touch point | Risk | Resolution |
|---|---|---|
| New `systemd-run --scope --slice=` calls from agent-bridge | Privilege escalation; new sudoers entry | Reuse existing `ellul-agent-namespace` sudoers entry pattern: `$SVC_USER ALL=(root) NOPASSWD: /usr/local/bin/ellul-agent-namespace *`. Extend with: `$SVC_USER ALL=(root) NOPASSWD: /bin/systemd-run --quiet --collect --scope --slice=ellul-ns-* --unit=ellul-pool-* --` (path + arg pattern locked). Reviewed equivalently. |
| AdmissionService DB queries | Bypass of gate-enforced query proxy | All DB access goes through the existing `POST /api/internal/db/query` proxy with `db_read` / `db_write`. No direct PG connections. |
| MetricsCollector reads `/sys/fs/cgroup` | None — metrics are read-only | Read-only mounts. No new caps. |
| Session checkpoints written to `<vault>/sessions/` | Could leak credentials in checkpoints | Checkpoints redact OAT / API keys before serialization. Redaction is an explicit serializer responsibility tested in [07-session-checkpoints.md](07-session-checkpoints.md). Vault path `/etc/ellul/shield-data/sessions/` is `$SVC_USER:shield 0750`. Unit `LimitCORE=0` preserved. |
| Pro Claude slot manager | Could leak OAT to wrong slot | Slot manager mints fresh OAT per slot warmup via existing shield `/issue` endpoint; no cross-slot OAT reuse. OAT TTL ≤ 60 s as today. |
| Bridge `bridge_shutting_down` WS event | Could be forged | Sent only by bridge; client treats it as advisory; reconnect path is the same as for any disconnect. |
| Per-sandbox slice writes (`systemd-run --slice=`) | Could be abused to write outside sandbox | sudoers pattern locks the slice name regex to `ellul-ns-sbx-[a-z0-9]{7}` and the unit name regex to `ellul-pool-sbx-[a-z0-9]{7}-(claude|opencode|cursor|codex)-[A-Za-z0-9_-]+`. Pre-validated in `namespace-spawner.ts` before exec. |

Each architecture document repeats and extends this table for its own surface.

## Acceptance criteria

The system passes all of the following on both 4 GB and 8 GB tiers (provisioned via
the existing API to a clean Hetzner VPS):

1. Power-user workload (5 sandboxes; 50 threads; 8 Pro Claude threads on $50, 3 on
   $20; 3 active previews on $50, 2 on $20) runs 24 h with **zero bridge restarts,
   zero session losses, zero user-visible OOM events.**
2. All chaos tests pass.
3. All SLOs green for 7 days on canary fleet.
4. Every typed error code has a runbook validated by chaos scenario.
5. `systemd-cgls` shows the designed cgroup hierarchy; pool processes appear under
   per-sandbox slices; bridge cgroup contains only bridge + immediate watchers.
6. Property tests pass for every state machine invariant.
7. Release pipeline detects and rolls back a deliberately-introduced SLO regression
   on canary.
