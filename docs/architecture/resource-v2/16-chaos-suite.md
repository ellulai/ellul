# 16 — Chaos Suite

> Status: shipped (`packages/vps/test/chaos/` + CI wiring on cgroup-v2 capable Linux runner).

## What this layer owns

The five chaos scenarios from the brief, each instrumenting blast radius and graceful degradation invariants on a real cgroup-v2 Linux container. Run on every PR.

| Test | Asserts |
|---|---|
| `bridge-kill.test.ts` | SIGKILL bridge mid-active-session → pool processes survive in their own slices → session resumes within 5 s on reconnect → no message lost |
| `memory-fill.test.ts` | Drive workload to red → DegradationController fires, queueing engages, no OOM kills outside designed scopes |
| `preview-evict-storm.test.ts` | Request 10 previews rapidly → AdmissionService serializes, evictions are LRU, no double-spawn |
| `release-cascade.test.ts` | Trigger drain mid-active-session → clients receive `bridge_shutting_down`, reconnect succeeds, no error toasts |
| `pro-slot-thrash.test.ts` | Switch between 5 Pro threads rapidly → LRU cache holds 2 warm, hydration < 2 s, no slot leaks |

## Runner requirements

- Linux ≥ 5.15 with unified cgroup-v2 hierarchy mounted at `/sys/fs/cgroup`.
- `systemd-run`, `systemctl`, `systemd-cgls`, `cat /sys/fs/cgroup/memory.pressure` available.
- Root-equivalent privileges for `systemd-run --scope --slice=` (provided via the same sudoers entry production uses; CI runs in a privileged container).
- Vault path writable.

CI uses a Hetzner-class VM image rather than a trimmed-down container so cgroup-v2 + systemd-oomd behave identically to production.

## Skip on macOS

Each test gates on `process.platform === "linux"` and falls through with a `it.skip` when run elsewhere (developer laptops). Local dev still runs the unit tests for every component; chaos coverage is CI-only.

## Determinism

Each test seeds the `randomWalk` state-machine helper with a fixed seed so failures reproduce. Memory-pressure scenarios use a controlled allocator (`malloc-eat`) that respects a `--target-mb` flag.

## Acceptance

| Criterion | Verified by |
|---|---|
| All 5 tests pass against a clean fleet image | CI green badge |
| Each test documents the expected SLO + the runbook it validates | Per-test docstring + this index |
| A deliberately-introduced regression (revert MemoryMax=1024M) makes the right test fail | Manual verification |
