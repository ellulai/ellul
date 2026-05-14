# 15 — Release Pipeline Hardening

> Status: shipped (`scripts/release-slo-gate.mjs` + `scripts/release-canary-wait.mjs` + drain handler in `agent-bridge` + UI handler).

## What this layer owns

The end-to-end change to `scripts/release.mjs` flow that turns an active-session-killing publish into a graceful, reversible rollout.

## Today vs new pipeline

Today: `release.mjs publish` → bumps version → publishes manifest → promotes → enforcer pulls on next heartbeat → `systemctl restart ellul-agent-bridge.service` → every WebSocket disconnects.

New flow:

```
release.mjs publish
  → SLO pre-flight (last 24 h on canary cohort)         ← NEW (--gate)
  → bump + build (existing)
  → publish manifest (existing)
  → promote canary cohort first (10% of fleet)          ← NEW (--canary)
  → wait 60 min, watch SLO dashboards on canary         ← NEW
  → if canary regressed → auto-rollback                 ← NEW
  → promote full fleet (existing)
```

For each agent-bridge restart on a host:

```
enforcer pulls new manifest
  → POST /api/internal/bridge/drain (bridge endpoint)   ← NEW
  → bridge broadcasts bridge_shutting_down to WS clients
  → bridge stops new ws connection accepts
  → bridge SessionCheckpointService flushes pending writes
  → bridge ProClaudeSlotManager.evictAll("release")
  → bridge process exits (Restart=on-failure → systemd respawns)
  → UI handles bridge_shutting_down: shows "Updating, reconnecting"
  → UI reconnects within 1-5 s; thread state rehydrated from checkpoints
```

## Drain protocol (server side)

`agent-bridge` exposes `POST /api/internal/bridge/drain` (UNIX socket, gated by shield-ipc group like other internal endpoints):

1. Broadcast `{ event: "bridge_shutting_down", drainStart: now, drainEnd: now+5000 }` to every WS client.
2. Stop accepting new WS upgrades (HTTP 503 with `Retry-After: 5`).
3. Call `proClaudeSlotManager.evictAll("release_drain")` — checkpoints + SIGTERM each slot.
4. Call `pools.flushIdle("release_drain")` — reaps any cold pool scope.
5. Wait `min(activeInflightSends.allSettled, 30s)`.
6. Process exits 0; systemd restarts.

`enforcer` waits for the drain endpoint to return before issuing `systemctl restart`. If the endpoint is unreachable (bridge already dead) it falls back to plain restart.

## Drain protocol (client side)

`packages/vps-ui/src/chat/lib/ws-rpc-client.ts` adds:

- On receiving `bridge_shutting_down`: surface a `ConnectionStatusBanner` with state `"reconnecting"` and message "Updating server, reconnecting in 5 s…"; mark every pending RPC as `system_at_capacity` rather than `error`.
- On socket close after `bridge_shutting_down`: skip the normal exponential backoff; reconnect after `drainEnd - now + 1s`.
- After reconnect: re-issue `subscribe_thread` for every visible thread; bridge replays state from `SessionCheckpointService` (existing path).

## SLO gate

`scripts/release-slo-gate.mjs` (new):

- Inputs: list of canary host IPs.
- For each host, scrape `http://<ip>:7702/metrics` (the MetricsCollector Prometheus endpoint).
- Compute over the last 24 h:
  - `bridge_restart_count_per_day` (target: 0 unintended)
  - `pro_slot_eviction_p95` (target: < 4 s)
  - `admission_decision_latency_p99` (target: < 50 ms)
- Compare against SLO thresholds. Exit non-zero if any SLO is regressed.

`release.mjs` calls this before `promote` for the canary cohort.

## Canary wait + auto-rollback

`scripts/release-canary-wait.mjs` (new):

- After canary promote, polls `release-slo-gate.mjs` once a minute for 60 minutes.
- If SLO breaches (sustained, two consecutive samples to avoid flap), invoke `release.mjs rollback <previous-uuid>`.

## Acceptance

| Criterion | Verified by |
|---|---|
| Active WebSockets receive `bridge_shutting_down` before bridge exits | Chaos test `release-cascade` (15-chaos-suite.md) |
| UI handles `bridge_shutting_down` → reconnects → no error toast | UI integration test |
| Threads rehydrate from checkpoint on reconnect | Chaos test `release-cascade` |
| Canary fleet receives release first, full fleet promoted only after 60 min | Manual + dashboard verification |
| Auto-rollback fires on deliberately-introduced SLO regression | Chaos test |
