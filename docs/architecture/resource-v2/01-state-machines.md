# 01 — State Machines

> Status: shipped (lib + 6 machines + property tests in `packages/vps/src/services/shared/state-machines/`).

Every load-bearing resource lifecycle is modelled by an explicit state machine.
The machines have:

- **Documented states.** Every named state appears in this document and is
  reachable in tests.
- **Documented transitions.** Each transition is one row in the machine's
  transition table — `from`, `event`, `to`, optional `guard`, optional `effect`.
- **Documented invariants.** Each machine carries a list of context predicates
  that must hold after every transition; violation throws
  `InvariantViolationError`.
- **Property tests.** A deterministic seeded random walker drives every machine
  for 1000 events × 10–20 seeds; invariants hold throughout. Reachability tests
  verify every documented state is reached on real transition paths.

The framework is hand-rolled in
[`packages/vps/src/services/shared/state-machines/lib.ts`](../../../../packages/vps/src/services/shared/state-machines/lib.ts)
(< 200 LOC, no dependencies).

## Why hand-rolled and not XState

The brief explicitly allows either, capping at 200 LOC. XState's footprint is
~50 KB; we use ≤200 LOC of plain TS plus zero deps. The framework only needs
what we actually use:

1. Typed states + events.
2. A transition table.
3. Per-transition guards and effects.
4. Per-machine invariants validated after every send.
5. A serializable trace.
6. A snapshot we can checkpoint to vault.

No hierarchical states, no parallel regions, no actor model. The cost of
complexity inside the state machine framework is paid every time someone reads
or extends a machine.

## Library surface

Authoritative types in
[`lib.ts`](../../../../packages/vps/src/services/shared/state-machines/lib.ts):

```ts
type Transition<S, E, Ctx>     = { from, event, to, guard?, effect? }
type Invariant<S, Ctx>         = { name, predicate }
type MachineDef<S, E, Ctx>     = { id, initial, transitions, invariants? }
class Machine<S, E, Ctx>       = current(), context(), trace(), send(e), sendAll(es), snapshot()
class InvariantViolationError  = { machine, invariant, state, context, trace }
function randomWalk(...)       = test helper, deterministic seeded walker
```

`Machine.send()` returns one of:

```ts
{ ok: true,  from: S, to: S, effects: string[] }
{ ok: false, reason: "no_transition" | "guard_rejected", current: S, event: string }
```

Distinguishing `no_transition` from `guard_rejected` surfaces silent intent
mismatches in tests — if a transition exists but its guard rejected the event,
the test sees that explicitly rather than a vague "didn't happen."

## Machines

### thread

> File: [`thread.machine.ts`](../../../../packages/vps/src/services/shared/state-machines/thread.machine.ts) · Tests: [`thread.machine.test.ts`](../../../../packages/vps/src/services/shared/state-machines/thread.machine.test.ts)

States: `cold`, `warming`, `warm`, `sending`, `queued`, `error_recoverable`, `error_terminal`, `archived`.

```
                 ┌──────────────── archive ─────────────┐
                 │                                       v
   cold ─open──▶ warming ──warm_done──▶ warm        archived
                                          │ ▲             │
                          ┌───── send_request(queueAccepts=false) ───┐
                          ▼                                          │
                       queued ──queue_dequeue(turnId)──▶ sending     │
                                                          │  ▲       │
                                          send_complete   │  │       │
                                                          ▼  │       │
                                                         warm        │
                          ▲                  ▲                       │
                          │                  │                       │
                send_fail_recoverable        recover                 │
                          │                  │                       │
                          ▼                  │                       │
                  error_recoverable ─────────┘                       │
                          │                                          │
                  send_fail_terminal                                 │
                          ▼                                          │
                   error_terminal ────────── archive ────────────────┘

   pool_scope_lost from {warm, sending, queued, error_recoverable} → warming
```

Key invariants (all property-tested):

| Invariant | Why |
|---|---|
| `sending_has_live_scope` | The brief's hard invariant: a thread in `sending` always has `poolScopeRef !== null AND activeTurnId !== null`. Property test asserts this both via the machine's invariant (which throws) and explicitly in a separate "1000 random events × 20 seeds" property. |
| `warm_has_scope` | Resource accounting: every `warm` thread is bound to a scope, so the AdmissionService's per-sandbox accounting is always consistent. |
| `cold_has_no_scope` | Inverse: `cold` threads do not appear in any pool's refcount. |
| `archived_has_no_scope_or_turn` | Pro Claude slots in archived threads must be torn down. |
| `queued_has_position_and_turn` | UI shows queue position; must always be defined when state is `queued`. |
| `errored_has_typed_code` | Every error transition records a typed error code matching a runbook. |

### sandbox

> File: [`sandbox.machine.ts`](../../../../packages/vps/src/services/shared/state-machines/sandbox.machine.ts) · Tests: [`sandbox.machine.test.ts`](../../../../packages/vps/src/services/shared/state-machines/sandbox.machine.test.ts)

States: `not_provisioned`, `provisioning`, `warm`, `cold`, `hibernated`, `reaping`.

```
   not_provisioned ─create─▶ provisioning ──provisioning_done──▶ warm
                                  │                                │ ▲
                          provisioning_failed                      │ │
                                  │                                │ │
                                  ▼                                │ │
                            not_provisioned                        │ │
                                                                   │ │
   warm ─{thread,scope}_attached/detached── (self-loop, ctx tick)──┘ │
                                                                     │
   warm ──idle_reap_due (only when warmThreads=0 AND warmPoolScopes=0)
        ──▶ reaping ──reap_done──▶ cold ──access──▶ provisioning ───┘

   {*} ─vps_hibernate──▶ hibernated ─vps_wake──▶ cold
```

Key invariants:

| Invariant | Why |
|---|---|
| `warm_has_live_resources` | `warm` ⇒ `sliceLive AND namespaceLive`. The cgroup must exist on disk when the bridge believes the sandbox is live. |
| `cold_has_no_resources` | Inverse. Prevents zombie cgroups. |
| `reap_only_when_empty` | Reaping mid-active-thread would lose user work. Guard enforces this; invariant double-checks. |
| `hibernated_has_no_live_resources` | VPS hibernation tears down all kernel state. |
| `scope_count_non_negative` | Ref-count safety: prevents negative drift on bug. |

### preview

> File: [`preview.machine.ts`](../../../../packages/vps/src/services/shared/state-machines/preview.machine.ts) · Tests: [`preview.machine.test.ts`](../../../../packages/vps/src/services/shared/state-machines/preview.machine.test.ts)

States: `disabled`, `cold`, `starting`, `hot`, `warm`, `demoting`, `promoting`, `stopping`, `failed`.

```
   disabled ─framework_detected──▶ cold ─start_admitted──▶ starting
                                                              │
                                              ┌── ready_hot ──┤
                                              ▼               ▼
                                              hot         warm (prod-mode)
                                              ▲               ▲
                                       promote_done           │
                                              │               │
                                            promoting ◀── promote
                                              │
                                            demote
                                              ▼
                                          demoting ── demote_done ──▶ warm

   {starting,hot,warm,promoting,demoting} ─stop──▶ stopping ─stop_done──▶ cold
   {*} ─framework_lost──▶ disabled
   {starting,hot,warm,promoting,demoting,stopping} ─failure──▶ failed ─recover──▶ cold

   {hot,warm,starting} ─activity_observed (self-loop, updates lastActivityAt)──▶ same
```

Key invariants:

| Invariant | Why |
|---|---|
| `active_states_have_reservation` | If unit is running, AdmissionService committed `reservedPeakMB`. Reconciliation between admission accounting and kernel reality. |
| `cold_has_no_reservation` | Inverse. |
| `framework_required_for_active` | Cannot have an admitted preview without a detected framework. |
| `unit_running_matches_active` | `unitRunning === (state ∈ active set)`. Drift between bridge state and systemd is impossible by construction. |
| `failed_has_typed_error` | Failure carries a typed code (e.g. `ERR_PORT_BIND_TIMEOUT`) matching a runbook. |

### pro_claude_slot

> File: [`pro-claude-slot.machine.ts`](../../../../packages/vps/src/services/shared/state-machines/pro-claude-slot.machine.ts) · Tests: [`pro-claude-slot.machine.test.ts`](../../../../packages/vps/src/services/shared/state-machines/pro-claude-slot.machine.test.ts)

States: `empty`, `warming`, `warm`, `active`, `evicting`, `evicted`.

```
   empty ─bind(threadId, resumeToken)──▶ warming ─hydrate_done(pid)──▶ warm
                                                                       │ ▲
                                                  send_start           │ │
                                                       │  send_complete│ │
                                                       ▼               │ │
                                                     active ───────────┘ │
                                                                         │
   {warm,active} ─evict_start(nextThreadId?)──▶ evicting ─evict_done──▶ evicted
                                                                       │
                                                            reset      │
                                                                       ▼
                                                                     empty

   {warming,warm,active,evicting} ─process_died(error)──▶ evicted
```

Key invariants:

| Invariant | Why |
|---|---|
| `warm_has_thread_and_pid` | `warm` ⇒ `threadId !== null AND processPid !== null`. |
| `active_has_thread_and_pid` | Same for `active`. |
| `empty_has_no_thread_or_pid` | Slot accounting integrity. |
| `evicted_has_no_pid` | Slot may be queried for cleanup; pid is gone. |

The brief's policy "evict_start on `active` waits for `send_complete` first" is
**enforced by the manager**, not the machine: the machine accepts `evict_start`
on either state because it models kernel reality. The manager observes
`send_complete` first then issues `evict_start`. This separation lets us reason
about the machine without a policy detour.

### pool_scope

> File: [`pool-scope.machine.ts`](../../../../packages/vps/src/services/shared/state-machines/pool-scope.machine.ts) · Tests: [`pool-scope.machine.test.ts`](../../../../packages/vps/src/services/shared/state-machines/pool-scope.machine.test.ts)

States: `cold`, `spawning`, `warm`, `inferring`, `reaping`.

```
   cold ─acquire──▶ spawning ─spawn_done(pid)──▶ warm
                                                  │ ▲
                                  acquire/release │ │ refcount tick
                                                  │ │
                                  session_send_start  ─▶ inferring
                                                       │ ▲
                            session_send_start (n>1)   │ │ inflight tick
                                                       │ │
                                  session_send_complete (last) ──▶ warm

   warm ─idle_reap_due (refCount=0 AND inflight=0)──▶ reaping ─reap_done──▶ cold
   {warm,inferring,spawning,reaping} ─process_died──▶ cold
```

Key invariants:

| Invariant | Why |
|---|---|
| `warm_has_pid` | A warm scope is, by definition, a live daemon. |
| `inferring_has_pid_and_inflight` | Inflight count ≥ 1 in inferring. |
| `cold_has_no_pid` | Reverse. |
| `refcount_non_negative` | Catches double-release. |
| `inflight_non_negative` | Catches double-complete. |
| `warm_inflight_zero` | If state is `warm`, no in-flight inferences. (`inferring` is the in-flight state.) |
| `reap_only_when_idle` | Cannot reap with active sessions. |

### system_health

> File: [`system-health.machine.ts`](../../../../packages/vps/src/services/shared/state-machines/system-health.machine.ts) · Tests: [`system-health.machine.test.ts`](../../../../packages/vps/src/services/shared/state-machines/system-health.machine.test.ts)

States: `green`, `yellow`, `red`. Driven by `metrics` events from
`MetricsCollector` via `DegradationController`.

```
                       enter when sustained
                         (util ≥ 70 OR psi ≥ 10) for 30 s
   green ────────────────────────────▶ yellow
                                          │
                       enter when sustained│
                  (util ≥ 90 OR psi ≥ 25) for 15 s
                                          ▼
                                        red
                                          │
                       hysteresis: util < 85 AND psi < 18 for 30 s
                                          ▼
                                        yellow
                                          │
                       hysteresis: util < 65 AND psi < 6 for 60 s
                                          ▼
                                        green
```

The threshold table is exported as `SYSTEM_HEALTH_THRESHOLDS`:

| Threshold | Value | Source |
|---|---|---|
| yellowEnterUtilPct | 70 | brief: yellow at ≥ 70 % |
| yellowEnterPsiPct | 10 | brief: PSI > 10 % avg10 |
| yellowEnterSustainedMs | 30 000 | brief: 30 s sustained |
| redEnterUtilPct | 90 | brief: red at ≥ 90 % |
| redEnterPsiPct | 25 | brief: PSI > 25 % |
| redEnterSustainedMs | 15 000 | brief: 15 s sustained |
| yellowExitUtilPct | 85 | hysteresis (–5 pp) |
| yellowExitPsiPct | 18 | hysteresis (–7 pp) |
| yellowExitSustainedMs | 30 000 | sustained for symmetric stability |
| greenExitUtilPct | 65 | hysteresis (–5 pp) |
| greenExitPsiPct | 6 | hysteresis (–4 pp) |
| greenExitSustainedMs | 60 000 | conservative — recovery should be sustained |

Key invariants:

| Invariant | Why |
|---|---|
| `utilization_in_range` | `0 ≤ sliceUtilization ≤ 100` |
| `psi_in_range` | `0 ≤ psiMemAvg10 ≤ 100` |
| `no_red_to_green_direct` | Property-tested by the random metric walker; the transition table makes this structurally impossible — there is no `red → green` transition. The property test still asserts it on every observed transition for defense-in-depth. |

## Snapshots and checkpointing

`Machine.snapshot()` returns `{ state, ctx, history }` deep-cloned. Used by
[`07-session-checkpoints.md`](07-session-checkpoints.md) to persist relevant
machine state to the vault. Restore is straightforward: a new
`Machine(def, snapshot.ctx)` plus an optional history seed (currently we don't
restore history because it's append-only telemetry, not authoritative state).

## Where these machines live

| Machine | Owner process | Persisted? |
|---|---|---|
| `thread` | `agent-bridge.service` | Last `state` + `ctx` per (sandbox, threadId) checkpointed every turn |
| `sandbox` | `agent-bridge.service` | Last `state` + `ctx` per sandbox checkpointed on transition |
| `preview` | `file-api.service` | `state` + `ctx` per appDirectory checkpointed on transition |
| `pro_claude_slot` | `agent-bridge.service` | Per slot; persisted across bridge restarts |
| `pool_scope` | `agent-bridge.service` | Not persisted — recomputed from systemd reality on bridge boot. (Reconciler in `namespace-lifecycle.service.ts` reads `systemctl list-units` and seeds machines.) |
| `system_health` | `agent-bridge.service` | Not persisted — recomputed within seconds of bridge boot from `MetricsCollector`. |

Persistence is described in [07-session-checkpoints.md](07-session-checkpoints.md).

## Test methodology

Each machine ships with at minimum:

1. **Happy-path test** — the canonical user flow.
2. **Guard-rejection tests** — events that should be guard-rejected, not no-op'd.
3. **Failure-path tests** — every typed error transition.
4. **Property test** — `randomWalk(machine, ALL_EVENTS, 1000, seed)` for 10+
   seeds. Invariants throw on violation, so the test simply asserts no throw,
   plus explicit re-checks of the load-bearing invariants on the post-walk
   state.
5. **Reachability test** — drive 50+ seeds for 200 steps each, collect the
   union of visited states, assert every documented state appears.

The seeded random walker is deterministic, so any failure reproduces from the
seed printed in the failure message. The walker uses a 32-bit LCG (Numerical
Recipes constants) — sufficient entropy for state-machine event drivers,
trivially seedable.

## Acceptance

| Criterion | Status |
|---|---|
| State machine framework ≤ 200 LOC, no deps | ✅ `lib.ts` is 180 LOC including comments and a deterministic-walker test helper |
| Six documented machines | ✅ thread, sandbox, preview, pro_claude_slot, pool_scope, system_health |
| Every state has a documented transition path | ✅ Reachability tests assert this for every machine |
| Every invariant is enforced via `assertInvariants()` after every transition | ✅ Built into `Machine.send()` |
| Property tests for every invariant | ✅ `randomWalk` × 10–20 seeds × 1000 steps per machine |
| The brief's hard invariant ("a thread in `sending` always has a live scope") is property-tested | ✅ `thread.machine.test.ts` "property: a thread in `sending` always has a live scope" |
