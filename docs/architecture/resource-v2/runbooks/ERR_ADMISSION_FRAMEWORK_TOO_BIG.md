# ERR_ADMISSION_FRAMEWORK_TOO_BIG

## What the user sees

Banner: "This workload exceeds your tier's per-workload budget."

## What the system did automatically

Candidate framework peak exceeds the host's `perPreviewCapMB` (= previewBudget / hotPreviewsCap). Floor 1280 MB ensures Spring Boot Gradle (devPeak 1200) fits on every production tier; if this still trips, calibrated telemetry P95 climbed past expected (heap leak from a prior run, framework upgrade) — investigate via `cat /etc/ellul/memory-budget.env` and `journalctl -u ellul-file-api | grep budget-unavailable`.

## What an operator should check

```sh
cat /etc/ellul/.framework-detect.json | jq .
curl -s http://127.0.0.1:7702/metrics | grep ellul_cgroup_memory_current_bytes | grep <appDir>
```

Decisions:

- Recalibrate P95: if telemetry was skewed by a one-off leak, prune the entry from `<vault>/admission/p95.json`.
- Tier upgrade if the framework genuinely needs more than half the workload budget on the current tier.
- Switch the project to a lighter framework (e.g. Vite over Next).

## Validating chaos scenario

`preview-evict-storm.test.ts` covers this when admission attempts a too-big preview.

## Past incidents

None yet.
