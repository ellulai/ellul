# ERR_SLOT_EVICT_TIMEOUT

## What the user sees

Banner: "Switching slot timed out; retried."

## What the system did automatically

`ProClaudeSlotManager.evictSlot()` waited up to 30 s for an `active` slot's send to complete; the slot was still `active`. Manager bailed out with this code; the retry on next bind fires SIGTERM → SIGKILL via `evictAll()` semantics.

## What an operator should check

```sh
curl -s http://127.0.0.1:7700/api/internal/pro-slot/snapshot | jq
ps -ef | grep ellul-pro-claude-slot
```

A genuinely-stuck Claude SDK send is rare. If recurrent, Anthropic-side latency or a hung tool call is the usual cause. Force-kill the pid as a last resort.

## Validating chaos scenario

Unit test `pro-claude-slot.service.test.ts` covers the timeout path with a stub `waitExit` that returns `"timeout"`.

## Past incidents

None yet.
