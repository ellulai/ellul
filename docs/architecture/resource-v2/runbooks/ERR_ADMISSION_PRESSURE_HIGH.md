# ERR_ADMISSION_PRESSURE_HIGH

## What the user sees

Banner: "Memory pressure high — please wait a few seconds."

## What the system did automatically

PSI memory `avg10` > 25% at admission time → reject. Distinct from `ERR_ADMISSION_DEGRADED_RED`: this code fires on a single high-pressure tick; `RED` requires sustained pressure. A user who waits a few seconds and retries will usually get through.

## What an operator should check

```sh
cat /sys/fs/cgroup/ellul.slice/ellul-user-workload.slice/memory.pressure
```

If pressure is sustained, the system will transition to yellow/red and the relevant runbook applies.

## Validating chaos scenario

`memory-fill.test.ts` covers the transient case as well.

## Past incidents

None yet.
