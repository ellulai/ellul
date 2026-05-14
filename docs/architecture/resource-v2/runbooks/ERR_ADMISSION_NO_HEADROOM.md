# ERR_ADMISSION_NO_HEADROOM

## What the user sees

Banner: "Not enough memory to start this — try again in a moment." with a "Runbook" link to this page. The user's send is **not lost** — it stays in the composer's optimistic buffer and the user can retry.

## What the system did automatically

`AdmissionService.admit()` returned `{ ok: false, reason: "ERR_ADMISSION_NO_HEADROOM" }` because:

1. `reserved > headroomMB`
2. The eviction plan from cold pool scopes + idle previews + non-protected Pro slots could not free enough RAM (`evictableMB < deficit`).

No spawn, no eviction, no state change.

## What an operator should check

```sh
ssh dev@<host>
systemd-cgls
cat /sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/memory.current
cat /sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/memory.max
curl -s http://127.0.0.1:7702/metrics | grep ellul_cgroup_memory_current_bytes | head -10
```

If utilisation is near `memory.max` and there are no obvious eviction candidates, this is the tier limit being hit. Decisions:

- One workload using almost all of `workloadMaxMB` → it's a heavy framework that fits poorly on this tier; consider tier upgrade.
- Many small pool processes → the soft-tidy isn't keeping up; check `compactor.run` events in `/var/log/ellul/agent-bridge-events.jsonl`.
- Pressure spike from a runaway preview → check per-preview RSS in the metrics dump; restart the offender.

## Validating chaos scenario

[`packages/vps/test/chaos/memory-fill.test.ts`](../../../../../packages/vps/test/chaos/memory-fill.test.ts) — drives the slice over capacity and asserts admission rejects with this code (no OOM kill outside designed scopes).

## Past incidents

None yet (resource-v2 introduces this code).
