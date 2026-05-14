# ERR_QUEUE_FULL

## What the user sees

Banner: "Too many sends in flight; please wait." The composer's send button briefly enters error state; the message stays in the composer.

## What the system did automatically

`InferenceQueue.enqueue()` returned `{ ok: false, reason: "ERR_QUEUE_FULL" }` because `inflight + queued >= hardCap (16)` for the (sandbox, adapter) pair.

## What an operator should check

```sh
curl -s http://127.0.0.1:7700/api/internal/queue/snapshot | jq
```

If a sandbox has dozens of queued sends, the user is likely hitting "send" repeatedly. The queue drains at the adapter's natural pace; user just needs to wait.

## Validating chaos scenario

Unit test `inference-queue.service.test.ts > rejects past hardCap`.

## Past incidents

None yet.
