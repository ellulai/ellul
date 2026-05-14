# ERR_SLOT_HYDRATE_FAILED

## What the user sees

Banner: "Pro Claude slot couldn't resume; the session was reset."

## What the system did automatically

`SessionCheckpointService.load()` returned a checkpoint, but the Claude SDK rejected the resume — typically because the resume sessionId is server-side gone (Anthropic-side TTL) OR the redactor stripped a critical field.

The slot is reset to `evicted` → `empty`; the next user send re-warms the slot from a fresh session (no checkpoint), and the conversation continues from the user's next turn.

## What an operator should check

```sh
ls /etc/ellul/shield-data/sessions/<threadId>/
journalctl -u ellul-agent-bridge -n 200 --no-pager | grep ERR_SLOT_HYDRATE_FAILED
```

If the same thread fails repeatedly, delete the checkpoint:

```sh
rm -rf /etc/ellul/shield-data/sessions/<threadId>/
```

This forces a fresh session next time.

## Validating chaos scenario

`pro-slot-thrash.test.ts` covers normal hydration; failure path is unit-tested in `pro-claude-slot.service.test.ts`.

## Past incidents

None yet.
