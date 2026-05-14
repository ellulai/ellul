# 06 — Pro Claude Slot Manager

> Status: shipped (`packages/vps/src/services/backends/agent-bridge/src/services/pro-claude-slot.service.ts` + tests). State machine in [`pro-claude-slot.machine.ts`](../../../../packages/vps/src/services/shared/state-machines/pro-claude-slot.machine.ts).

## What this layer owns

The cap on *active Pro Claude processes* per VPS, and the protocol for swapping which thread occupies each slot. Pro Claude is slot-based, not thread-based — a user can have 100 Pro threads but only `proClaudeSlotCap(physicalMB)` slots are live at any moment (1 on $20, 3 on $50).

When a Pro thread receives a send and no warm slot is bound to it:

1. Pick a slot to use (LRU-of-2-warm cache; evict the LRU non-bound warm slot if cache full).
2. If that slot currently holds another thread's session: ask `SessionCheckpointService` to serialize the outgoing thread's session via the Claude SDK resume token, then SIGTERM the slot scope.
3. Ask `AdmissionService` to admit a `pro_claude` warmup (returns either `accept` or a typed reject).
4. Spawn the Claude process into a new `ellul-pro-claude-slot<N>.scope` via `ellul-spawn-scope`.
5. If the target thread has a checkpoint at `<vault>/sessions/<threadId>/<turn_N>.json`, hydrate it with `--resume <sessionId>`.
6. Drive the slot's state machine through `bind` → `warming` → `hydrate_done` → `warm` → `send_start` → `active`.

## Slot warmup SLO

Target P95 ≤ 4 s (serialize + hydrate). Telemetry: `pro_slot_eviction_p95` ([00-overview.md](00-overview.md#slos)).

## LRU-of-2-warm cache

If `proClaudeSlotCap = 3`, we keep up to 2 *additional* slots warm beyond the active one for quick switches. Slot manager state includes a `warmCacheLru: string[]` (thread ids ordered by `lastUseAt`). When a switch needs a slot:

- If the target thread is in `warmCacheLru` and a slot is bound to it → instant `send_start`.
- Else → evict the LRU thread's slot via the protocol above.

The cache is `protected` from AdmissionService eviction (see [05-admission.md](05-admission.md) — eviction candidates flagged `protected: true` for the LRU-of-2).

## API

```ts
export interface ProClaudeSlotManager {
  bind(threadId: string, opts: { resumeToken: string | null; sandbox: string }): Promise<BindResult>;
  releaseActive(threadId: string): void;        // mark send complete; updates lastUseAt
  evictAll(reason: string): Promise<void>;      // bridge shutdown / drain
  snapshot(): SlotSnapshot[];                   // for UI broadcast
}

type BindResult =
  | { ok: true; slotIndex: number; processPid: number; warmHit: boolean; tookMs: number }
  | { ok: false; reason: TypedRejection; details?: string };
```

`BindResult.ok=false` propagates AdmissionService rejections (`ERR_ADMISSION_TIER_CAP`, `ERR_ADMISSION_DEGRADED_RED`, `ERR_ADMISSION_PRESSURE_HIGH`) and slot-specific errors (`ERR_SLOT_HYDRATE_FAILED`, `ERR_SLOT_SPAWN_FAILED`, `ERR_SLOT_EVICT_TIMEOUT`).

## State machine integration

Per slot, one [`pro_claude_slot`](01-state-machines.md#pro_claude_slot) machine. The manager:

- `empty → bind(threadId, resumeToken)` on assign.
- `warming → hydrate_done(processPid)` when SDK reports session resumed.
- `warm → send_start` on each send begin; `active → send_complete` when SDK turn-done.
- `evict_start(nextThreadId)` when bound thread changes; `evict_done` after vault checkpoint write completes and the process exits.
- `process_died(error)` on unexpected exit (collapses to `evicted`; manager re-attempts on next bind).

Invariants enforced by the machine (`warm_has_thread_and_pid`, `active_has_thread_and_pid`) guarantee the manager can never broadcast a slot as warm without a live process pid.

## Eviction protocol (active → evicted)

```
evict(slot, reason):
  if slot.state == active:
    wait for current send to complete (or 30 s timeout → SIGTERM in-flight)
  ask SessionCheckpointService.checkpoint(slot.threadId, "claude")
  send SIGTERM to slot.processPid
  wait for exit (10 s) → on timeout, SIGKILL
  fire pro_claude_slot.evict_done
```

Brief: "Slot switching serializes the previous session via Claude SDK resume token to vault and hydrates the next from its last checkpoint." Both operations are managed by `SessionCheckpointService` ([07-session-checkpoints.md](07-session-checkpoints.md)).

## Spawn placement

Slot processes spawn via `ellul-spawn-scope` into `ellul-user-workload.slice` directly (not per-sandbox), with unit `ellul-pro-claude-slot<N>`. See [03-spawn-routing.md](03-spawn-routing.md#pro-claude-slot-scope-properties).

## Security invariants preserved

- OAT minted fresh per slot warmup via existing shield `/issue` endpoint; no cross-slot OAT reuse; OAT TTL ≤ 60 s as today.
- Slot scope spawn goes through the documented `ellul-claude-launch → ellul-claude-ns` chain wrapped by `ellul-spawn-scope`. No new sudoers entry beyond the spawn-scope wrapper already added in [03-spawn-routing.md](03-spawn-routing.md).
- Checkpoint writes to `<vault>/sessions/...` go through `SessionCheckpointService` which redacts OAT/API keys before write ([07-session-checkpoints.md](07-session-checkpoints.md)).

## Acceptance

| Criterion | How verified |
|---|---|
| Tier cap enforced (1 on $20, 3 on $50) | Unit test |
| LRU-of-2 warm cache: third bind to non-cached thread evicts LRU | Unit test |
| `ProClaudeSlotManager` integrates with state machine (no impossible transitions) | Unit test running the manager through 100 random bind/release/evict ops; asserts machine invariants hold |
| Hydrate from existing checkpoint when present | Unit test |
| `evictAll` drains every slot during bridge shutdown | Unit test |
| AdmissionService reject propagates as `BindResult.ok=false` with typed reason | Unit test |
| Slot warmup P95 ≤ 4 s | SLO dashboard (telemetry); chaos test `pro-slot-thrash` ([15-chaos-suite.md](15-chaos-suite.md)) |
