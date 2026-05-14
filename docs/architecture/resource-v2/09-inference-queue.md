# 09 — InferenceQueue

> Status: shipped (`packages/vps/src/services/backends/agent-bridge/src/services/inference-queue.service.ts` + tests).

## What this layer owns

Per-(sandbox, adapter) bounded concurrency on in-flight sends. When a thread sends and the adapter is at capacity, the queue holds the request and emits `queued` state to the UI with an ETA.

Maps directly to the `thread` state machine `queued` state and the `system_at_capacity` typed error in the [00-overview.md](00-overview.md) degradation table.

## Sizing

Default per-(sandbox, adapter): **2** in-flight. Rationale: most adapters batch work and a single in-flight is the common case; allowing two enables overlap (e.g. one tool execution while another text-streaming) without sliding into thrash.

Configurable per-adapter via `inferenceQueue.config.json` in the vault.

## API

```ts
export interface InferenceQueue {
  /**
   * Try to enqueue a send. Returns either `accepted` (run immediately),
   * `queued` (will run when a slot frees, with ETA estimate), or `rejected`
   * (queue at hard cap).
   */
  enqueue(key: { sandbox: string; adapter: Adapter }, turnId: string): EnqueueResult;
  /** Mark a turn complete; releases a slot. */
  complete(key: { sandbox: string; adapter: Adapter }, turnId: string): void;
  /** For UI broadcast. */
  snapshot(): ReadonlyArray<QueueSnapshot>;
  /** Subscribe to queue state changes. */
  subscribe(listener: (snap: ReadonlyArray<QueueSnapshot>) => void): () => void;
}

type EnqueueResult =
  | { ok: true; tag: "accepted" }
  | { ok: true; tag: "queued"; position: number; etaMs: number }
  | { ok: false; tag: "rejected"; reason: "ERR_QUEUE_FULL" };
```

## ETA estimation

Median turn duration over the last 100 completed turns of the same (sandbox, adapter), computed from MetricsCollector's per-scope CPU usage delta or from a small in-memory sample window. Fallback to 10 s when no samples exist.

`etaMs = position * medianTurnMs`

## Hard cap

`hardCap = 16` per (sandbox, adapter). Beyond this, `enqueue` returns `rejected` with typed reason `ERR_QUEUE_FULL`. UI surfaces this as a typed error banner with a runbook link ([../runbooks/ERR_QUEUE_FULL.md](runbooks/ERR_QUEUE_FULL.md)).

## Backpressure interaction

- DegradationController in `red` mode: SystemHealth integration. AdmissionService rejects new sends with `ERR_ADMISSION_DEGRADED_RED` BEFORE they reach the queue. Queued items continue to drain.
- DegradationController in `yellow` mode: queue still accepts; UI shows the `auto-tidying` pill.
- Bridge restart: queue state is in-memory only; on restart, the WS protocol replays the queued turns from the client's optimistic message buffer (UI side).

## Acceptance

| Criterion | Verified by |
|---|---|
| `accepted` when in-flight < concurrency | Unit test |
| `queued` with correct position when in-flight ≥ concurrency | Unit test |
| FIFO order preserved across releases | Unit test |
| `complete` releases a slot and dequeues next | Unit test |
| `rejected` when queue exceeds hardCap | Unit test |
| ETA = position × median turn ms (fallback to default) | Unit test |
| Independent queues per (sandbox, adapter) | Unit test |
| Subscribers fire on every state change | Unit test |
