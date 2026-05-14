# 10 — SystemHealth

> Status: shipped (`packages/vps/src/services/backends/agent-bridge/src/services/system-health.service.ts` + tests). Wraps the [`system_health`](01-state-machines.md#system-health) machine.

## What this layer owns

The single derived `green | yellow | red` signal for the VPS, broadcast to every UI client and consumed by AdmissionService and DegradationController.

## Inputs

`MetricsCollector` ticks. Every tick, the service:

1. Reads `ellul-user-workload.slice` `memoryCurrentBytes` + configured `MemoryMax` → utilisation %.
2. Reads `ellul-user-workload.slice` `psiMem.avg10`.
3. Tracks sustained-pressure clock per state (how long has the current trigger been hot).
4. Sends a `metrics` event to the state machine.
5. On state change, fires subscribers.

Thresholds in [`SYSTEM_HEALTH_THRESHOLDS`](../../../../packages/vps/src/services/shared/state-machines/system-health.machine.ts).

## API

```ts
export interface SystemHealth {
  current(): SystemHealthState;
  snapshot(): SystemHealthSnapshot;
  subscribe(listener: (snap: SystemHealthSnapshot) => void): () => void;
  stop(): void;
}

interface SystemHealthSnapshot {
  state: "green" | "yellow" | "red";
  sliceUtilizationPct: number;
  psiMemAvg10: number;
  enteredAt: number;
  sustainedMs: number;
}
```

## Bridge integration

Single instance per bridge process. AdmissionService.signals() reads
`current()` via dependency injection. DegradationController subscribes.
WebSocket layer broadcasts snapshot on every state transition (no per-tick
broadcast — UI sees only state edges).

## Acceptance

| Criterion | Verified by |
|---|---|
| Transitions match thresholds in [01](01-state-machines.md#system-health) | Unit test |
| Sustained-pressure clock resets on state change | Unit test |
| Subscribers fire only on state change, not every tick | Unit test |
