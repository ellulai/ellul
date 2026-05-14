# 07 — SessionCheckpointService

> Status: shipped (`packages/vps/src/services/backends/agent-bridge/src/services/session-checkpoint.service.ts` + tests).

## What this layer owns

Per-adapter serialization of session state to the vault so a bridge restart, slot switch, or hibernation cycle never loses a thread's conversation. The brief's hard SLO: `session_loss_rate = 0`.

## Vault layout

```
/etc/ellul/shield-data/sessions/
  <threadId>/
    meta.json                # adapter, sandboxId, lastTurn, vaultVersion
    <turn_n>.json            # one per turn; latest is authoritative
    <turn_n>.json.tmp        # in-flight write
```

Owner `$SVC_USER:shield 0750`; under the existing vault that is bound from `/etc/ellul/`. Survives hibernation/wake.

Retention: keep the last `MAX_TURN_CHECKPOINTS = 16` per thread; older numbered files are GC'd after a successful newer write. `meta.json` is rewritten on every checkpoint.

## Per-adapter serializers

```ts
export interface AdapterCheckpoint {
  adapter: "claude" | "opencode" | "cursor" | "codex";
  /** Adapter session id usable with `--resume` / `session/load`. */
  sessionId: string;
  /** Most recent assistant turn number. Monotonic. */
  turn: number;
  /** Adapter-specific resume primitive (token, snapshot bytes, etc). */
  payload: unknown;
  /** Wall-clock ms when this checkpoint was created. */
  createdAt: number;
}
```

Per-adapter serialize/restore:

| Adapter | Serialize | Restore |
|---|---|---|
| claude | Persist `{ resumeSessionId, transcript[] }` from the SDK helper's `resumeSessionAt` cursor + the slot's in-memory transcript window | Spawn `claude --resume <sessionId>` and re-attach via SDK |
| opencode | `client.session.export(sessionId)` returns a JSON blob | `client.session.create({ import: blob })` |
| cursor | ACP `session/save` (or stash the latest `session/new` capability + tool history snapshot) | ACP `session/load` |
| codex | Persist `sessionId` + history pointer | `codex --resume <sessionId>` |

Each serializer is a single function that returns `AdapterCheckpoint`. The dispatch is keyed on the adapter family; unknown families fail closed.

## Redaction

Before write:

- Strip every key matching `/(api[_-]?key|token|secret|oat|password|cookie|authorization)/i` from arbitrary JSON shapes (recursive replace value with `"[redacted]"`).
- Strip Anthropic OAT prefixes `sk-ant-oat01-...` and `sk-ant-api...` and `sk-ant-...` regex matches in any string field.
- The redactor is exported and unit-tested (the same regex set is used by the event-log redactor — see `event-log.ts`).

If a checkpoint payload contains a redacted token, restore will fail and the thread reverts to a `cold` state, requiring re-auth. This is the correct outcome — checkpoints must never become a credential-exfil vector.

## API

```ts
export interface SessionCheckpointService {
  checkpoint(threadId: string, adapter: AdapterCheckpoint["adapter"], payload: unknown, sessionId: string, turn: number): Promise<void>;
  load(threadId: string): Promise<AdapterCheckpoint | null>;
  forget(threadId: string): Promise<void>;
  /** For UI / observability. */
  list(): Promise<ReadonlyArray<{ threadId: string; adapter: string; turn: number; updatedAt: number }>>;
}
```

`checkpoint()` is best-effort and idempotent. Caller should not block a user-visible reply on it; a small `setImmediate` queue holds checkpoints if the disk is briefly slow.

## Failure modes

| Failure | Behaviour |
|---|---|
| Disk full | Log `ERR_CHECKPOINT_DISK_FULL`; retain in-memory checkpoint; SystemHealth gets a typed signal |
| Permission denied on vault path | Log `ERR_CHECKPOINT_PERMISSION`; fall back to `/run/ellul/checkpoints/` (tmpfs, lost on reboot) |
| Adapter serializer throws | Log `ERR_CHECKPOINT_ADAPTER_FAILED`; the thread can still continue, but next bridge restart will require user to re-send last turn |
| Restore: payload is `[redacted]` for a critical field | Return null (treat as no checkpoint); thread re-warms via fresh session |
| Restore: checkpoint file corrupt | Delete file; try previous turn; if all fail return null |

## Bridge restart rehydration

On bridge boot:

1. `SessionCheckpointService.list()` returns all known threads with checkpoints.
2. Bridge announces "rehydrating N threads" event to UI.
3. For each active client connection, on first `subscribe_thread` for a known thread, the bridge restores the adapter session lazily (don't pre-warm everything — that defeats the cap).
4. Pro Claude threads with a checkpoint do **not** auto-warm a slot; they wait for a `send_request` (consistent with the slot model).

## Security invariants preserved

- Vault path `/etc/ellul/shield-data/sessions/` already restricted to `$SVC_USER:shield 0750`.
- Redactor runs before every write — covered by tests against known token formats including OATs from past leak incidents (see MEMORY.md "Active Bugs").
- No new sudoers entry; service runs in the bridge process under `$SVC_USER`.
- `LimitCORE=0` on the bridge unit (existing) prevents credential leak via crash dumps.

## Acceptance

| Criterion | How verified |
|---|---|
| Round-trip checkpoint+load preserves `AdapterCheckpoint` byte-for-byte | Unit test per adapter |
| Redactor strips OAT, API key, and known token formats | Unit test with token corpus |
| Restore returns null for redacted-critical-field checkpoints | Unit test |
| Concurrent checkpoint() for same threadId never corrupts vault file | Property test |
| `forget(threadId)` removes the entire thread directory | Unit test |
| `list()` returns every persisted thread with current adapter + turn | Unit test |
| Disk-full / permission-denied failures don't crash the bridge | Unit test with stub fs |
