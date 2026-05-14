# 11 — DegradationController

> Status: shipped (`packages/vps/src/services/backends/agent-bridge/src/services/degradation-controller.service.ts` + tests).

## What this layer owns

The action layer for [`SystemHealth`](10-system-health.md). On state changes, runs the actions from the brief's degradation table:

| From | To | Actions |
|---|---|---|
| green | yellow | `compactor.runNow({ keepLastN: 4 })`, evict cold pool scopes (LRU, refCount=0), tighten preview keepalive idle threshold from 8 min → 4 min |
| yellow | red | Set `inferenceQueue` advisory: refuse new sends with `ERR_ADMISSION_DEGRADED_RED`. Refuse new previews. Refuse new Pro slot warmups. Existing in-flight work continues |
| yellow | green | Reset all yellow-mode actions to defaults |
| red | yellow | Reset all red-mode actions; resume admission |

Actions are issued via injected dependencies — controller does not own pools, queues, or the compactor; it just fires their methods.

## API

```ts
export interface DegradationController {
  start(): void;
  stop(): void;
}

export interface DegradationDeps {
  health: { subscribe(l: (snap: SystemHealthSnapshot) => void): () => void; current(): SystemHealthState };
  compactor: { runNow(opts: { keepLastN: number; reason: "yellow_mode" }): Promise<unknown> };
  poolManager: { evictColdScopes(reason: string): Promise<void> };
  previewKeepalive: { setIdleThresholdMs(ms: number): void };
  admission: { setRedMode(on: boolean): void };
  defaults?: { previewIdleMs: number };
}
```

## Acceptance

| Criterion | Verified by |
|---|---|
| green→yellow fires compactor + evict + tighten | Unit test |
| yellow→red fires admission red mode | Unit test |
| Reverse transitions reset actions | Unit test |
| No actions fired on same-state ticks | Unit test |
