# ERR_SLOT_SPAWN_FAILED

## What the user sees

Banner: "Pro Claude slot couldn't start; check the runbook."

## What the system did automatically

`ProClaudeSlotManager.bind()` failed on `spawnSlot` — the call to `ellul-claude-launch` (via `ellul-spawn-scope`) didn't produce a process. Common causes:

- `ellul-spawn-scope` not on disk (see [ERR_SPAWN_SCOPE_BINARY_MISSING](ERR_SPAWN_SCOPE_BINARY_MISSING.md))
- `ellul-claude-launch` rejected the OAT issuance (shield down)
- `ellul-claude-ns` failed to enter the namespace (sudoers / namespace anchor missing)

## What an operator should check

```sh
test -x /usr/local/bin/ellul-spawn-scope
test -x /usr/local/bin/ellul-claude-launch
test -x /usr/local/bin/ellul-claude-ns
test -x /usr/local/bin/ellul-agent-namespace
sudo -n /usr/local/bin/ellul-spawn-scope ellul-user-workload.slice ellul-pro-claude-slot1 MemoryHigh=320M -- /bin/echo ok
journalctl -u ellul-sovereign-shield -n 100 --no-pager
```

The bridge unit's `ExecStartPre=/usr/bin/test -x /usr/local/bin/ellul-spawn-scope` should catch this at boot, so seeing it at runtime usually means the binary was removed after the bridge started.

## Validating chaos scenario

Unit test `pro-claude-slot.service.test.ts > propagates spawn failure as typed BindResult`.

## Past incidents

None yet.
