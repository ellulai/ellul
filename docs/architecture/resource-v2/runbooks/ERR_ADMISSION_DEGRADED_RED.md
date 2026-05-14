# ERR_ADMISSION_DEGRADED_RED

## What the user sees

Banner from `DegradationModeBanner`: "System at capacity — new sends are queued; new previews paused until pressure eases." Then per-send: `ERR_ADMISSION_DEGRADED_RED`.

## What the system did automatically

`SystemHealth` transitioned to `red` (sustained ≥90% slice utilization or PSI > 25% for 15s). DegradationController:

- Set `admission.setRedMode(true)` → AdmissionService rejects all new sends/previews with this code.
- (Existing Pro Claude slots, pool processes, and previews continue running — only NEW work is paused.)

The state will exit when utilisation drops below 85% and PSI < 18% sustained 30s.

## What an operator should check

```sh
curl -s http://127.0.0.1:7702/metrics | grep -E 'memory_current|psi_memory_avg10' | head
journalctl -u ellul-agent-bridge -n 50 --no-pager | grep degradation
```

If the system is stuck in red, find the largest pool/preview cgroup and investigate. Often a single runaway dev server pushes the slice over.

## Validating chaos scenario

[`packages/vps/test/chaos/memory-fill.test.ts`](../../../../../packages/vps/test/chaos/memory-fill.test.ts).

## Past incidents

None yet.
