# 08 — SessionCompactor

> Status: shipped (`packages/vps/src/services/backends/agent-bridge/src/services/session-compactor.service.ts` + tests).

## What this layer owns

Periodic compaction of in-daemon session state. opencode/cursor/codex daemons cache per-session token context, tool history, and file reads in-process; ~70 MB per 20-message opencode session is the failure mode being eliminated.

The compactor drops in-memory turn history older than `M = 8` turns per session; the full transcript stays on disk in the adapter's session export (replayable via `--resume <sessionId>` if needed).

## Algorithm

Every 60 s (jittered ± 10 s to avoid sync with metrics ticks):

1. List sessions per adapter pool (`opencodePool.listSessions()` etc.).
2. For each session, check `turnCount > M`.
3. Call adapter's `compactSession(sessionId, keepLastN)` — drops in-memory turn history beyond the last N.
4. Emit `compactor.run` event with counts.

Threshold `M = 8` and run interval are configurable via `compactor.config.json` in the vault.

## Adapter hook contract

```ts
export interface CompactableAdapter {
  listSessions(): Promise<ReadonlyArray<{ sessionId: string; turnCount: number; sandbox: string }>>;
  compactSession(sessionId: string, keepLastN: number): Promise<{ droppedTurns: number; freedBytesEst: number }>;
}
```

For opencode, `compactSession` calls `client.session.compact(sessionId, { keepLastN })` (an existing endpoint in opencode-server). For cursor ACP, it calls `session/compact` with the same shape. For codex, the helper drops local history pointer cache.

For Lite Claude (one-shot): no compaction needed (process exits per turn).

For Pro Claude SDK: SDK already manages its own context window. Compactor sets the SDK helper's `transcriptKeepLast = 8` knob via setter.

## Triggers beyond periodic

- DegradationController in yellow mode invokes `compactor.runNow({ keepLastN: 4 })` to be more aggressive.
- AdmissionService eviction flag: when an `accept_after_evict` decision is in flight, the compactor runs first to potentially avoid the evict.

## Failure modes

| Failure | Behaviour |
|---|---|
| Adapter `compactSession` throws | Logged; session stays uncompacted; next tick retries |
| Pool unreachable (daemon dead) | Skip; the pool will be re-spawned on next acquire |
| Disk write of compactor.config.json fails | Run with built-in defaults |

## Acceptance

| Criterion | Verified by |
|---|---|
| Compactor runs every 60 s ± 10 s | Unit test |
| Drops history beyond `keepLastN` per session | Unit test with stub adapter |
| `runNow` triggers immediate compaction | Unit test |
| Errors per-adapter don't stop other adapters | Unit test |
| Emits `compactor.run` event with counts | Unit test |
