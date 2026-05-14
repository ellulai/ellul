# ERR_ADMISSION_TIER_CAP

## What the user sees

Banner: "Your tier's slot cap is full." For Pro Claude this means the user has 1 active Pro process on $20 (or 3 on $50). Switching to another Pro thread will evict the LRU; AdmissionService surfaces this code only when the *cap* is hit, not the *cache*.

## What the system did automatically

Returned `{ ok: false, reason: "ERR_ADMISSION_TIER_CAP" }` because `cap.current >= cap.max` for the requested workload kind. No spawn.

## What an operator should check

```sh
curl -s http://127.0.0.1:7700/api/internal/pro-slot/snapshot | jq
```

If every slot is `warm` or `active` and the user is binding a different thread, ProClaudeSlotManager would evict the LRU non-protected slot. If this code surfaces, something is off — likely:

- A bug in the slot manager not freeing a slot after a thread was archived.
- The user genuinely has more concurrent Pro intent than slots allow.

In production this is expected user-visible behaviour for the $20 tier (cap = 1) when a second Pro thread is requested while one is in-flight.

## Validating chaos scenario

[`packages/vps/test/chaos/pro-slot-thrash.test.ts`](../../../../../packages/vps/test/chaos/pro-slot-thrash.test.ts) — drives 5 threads through 1-3 slots and asserts cap.

## Past incidents

None yet.
