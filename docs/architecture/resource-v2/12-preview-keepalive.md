# 12 — Preview Keepalive

> Status: shipped (`packages/vps/src/services/backends/file-api/src/services/preview-keepalive.service.ts` + tests + WS protocol additions).

## What this layer owns

Visibility-driven heartbeat protocol that prevents the existing 15-min HTTP-only idle reaper from killing previews while the user is actively reading a SPA (fix for failure mode F4).

## Protocol

Client (`packages/vps-ui/src/chat/lib/preview-keepalive.ts`):

- While preview iframe is mounted AND `document.visibilityState === 'visible'`, send `preview_keepalive` WebSocket message every 60 s containing `{ appDirectory, port, at }`.
- On visibility change to `'hidden'`, stop sending immediately.
- On visibility change back to `'visible'`, send one keepalive immediately, then resume the 60 s cadence.

Server:

- On `preview_keepalive` frame, update `lastActivityAt = now()` for the matching preview unit.
- Existing HTTP-side activity observer (`ss -tnH state established sport = :<port>`) continues to update the same `lastActivityAt`.
- Idle reaper threshold: **8 minutes** since last activity (down from 15 min). Either keepalive OR HTTP activity counts; reaper takes the maximum.

## State-machine integration

Each `preview_keepalive` is delivered to the `preview` machine as `activity_observed { at }`. The machine updates `lastActivityAt` (no state change).

## Failure modes

| Failure | Behaviour |
|---|---|
| Client disconnects briefly | Server treats absence as nothing new; HTTP-side activity still counts. 8 min grace covers reconnect time |
| Client never sends keepalive (e.g. an embedded preview viewer that doesn't run our client code) | HTTP activity still counts; if no HTTP either, idle reap at 8 min — same as before |
| Two browser tabs visible at once | Both send keepalives; server treats as same activity; no duplicate counting |

## DegradationController interaction

In yellow mode, `setIdleThresholdMs(4 * 60 * 1000)` tightens the threshold to 4 min. UI shows "Auto-tidying" pill explaining why previews may evict sooner. In red mode, no preview keepalive change (red blocks new starts; existing previews continue normally to avoid surprise eviction).

## Acceptance

| Criterion | Verified by |
|---|---|
| Keepalive updates `lastActivityAt` | Unit test |
| Idle reaper picks max(HTTP, keepalive) | Unit test |
| Client visibility-driven send: stops when hidden, resumes on visible | UI unit test |
| 4-min threshold honoured in yellow mode | Unit test |
| No keepalive ⇒ behaves identically to HTTP-only path (regression cover) | Unit test |
