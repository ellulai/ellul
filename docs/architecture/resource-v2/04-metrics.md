# 04 — MetricsCollector

> Status: shipped (`packages/vps/src/services/backends/agent-bridge/src/services/metrics-collector.service.ts` + tests + Prometheus endpoint).

## What this layer owns

A 1 Hz sampler of every cgroup that matters, persisted to a small in-process
ring buffer and exposed over a Prometheus-compatible HTTP endpoint. The
AdmissionService and DegradationController subscribe to its output; capacity
planning dashboards scrape it.

The brief's hard requirement: "Per-cgroup, per-process, per-scope memory and
CPU attribution flowing into a Prometheus-compatible pipeline at 1 Hz. No
estimates where measurement is possible."

## What gets sampled

Every 1 000 ms (jitter ± 50 ms to avoid kernel-side phase locking):

| Source | Per-cgroup file | Datum |
|---|---|---|
| `memory.current` | bytes | RSS proxy — instantaneous resident |
| `memory.high` | bytes (or `max`) | configured soft cap |
| `memory.max` | bytes (or `max`) | configured hard cap |
| `memory.events` | counters | low/high/max/oom/oom_kill |
| `memory.pressure` | PSI: avg10/avg60/avg300 | memory pressure |
| `cpu.stat` | usec | usage_usec, user_usec, system_usec |
| `cpu.pressure` | PSI | cpu pressure |
| `pids.current` | int | live tasks |

The collector enumerates the relevant cgroups by walking
`/sys/fs/cgroup/ellul.slice` and its known children. The set is bounded:

- `ellul-control-plane.slice` (1)
- Every `ellul-control-plane.slice/ellul-*.service` (≤ 8)
- `ellul-user-workload.slice` (1)
- `ellul-user-workload-previews.slice` + each
  `ellul-preview@*.service` inside it (≤ tier preview cap × 2)
- Each `ellul-user-workload-sbx-*.slice` (≤ active sandbox count)
- Each `ellul-pool-sbx-*-*-*.scope` (≤ sandboxes × 4 adapters)
- Each `ellul-pro-claude-slot[1-9].scope` (≤ 3)
- `ellul-namespaces.slice` + each `ellul-ns-*.service` (≤ active sandbox count)

For a power-user workload of 5 sandboxes × 3 adapters × 1 preview each =
~50 cgroups. At 1 Hz with 6 numeric fields per cgroup that's ~300 reads / s,
≈ 0.5 ms of CPU on a Hetzner ARM core (measured locally).

## Storage

In-process ring buffer, 1 hour @ 1 Hz = 3 600 samples per cgroup. Memory
footprint: 50 cgroups × 3 600 samples × ~64 B/sample = 11.5 MB. Comfortable
inside the bridge's 512 M cap.

Older samples roll off. AdmissionService consumes the most recent N seconds
to compute headroom; DegradationController computes sustained-pressure
windows from the same buffer.

The collector also writes a 24 h-deep snapshot to `/var/log/ellul/metrics/`
every 60 s as line-delimited JSON, gzipped after rollover. Used for
capacity-planning dashboards and post-incident analysis. Disk footprint at
50 cgroups × 60 samples/min × 1440 min × ~80 B = 345 MB/day uncompressed,
≈ 50 MB gzipped — bounded by a 7-day retention sweep.

## Prometheus endpoint

`GET http://127.0.0.1:7702/metrics` exposes the latest sample per cgroup in
text format. Bound to localhost only; no auth (consumers are local services
and a localhost-bound node-exporter scrape proxy if any). Endpoint lives in
the bridge process, runs on a separate HTTP server (port 7702) to keep the
WebSocket port (7700) clean.

Sample output:

```
# HELP ellul_cgroup_memory_current_bytes Current memory.current per cgroup, bytes.
# TYPE ellul_cgroup_memory_current_bytes gauge
ellul_cgroup_memory_current_bytes{slice="ellul-user-workload.slice",sandbox="",adapter="",scope=""} 4718592000
ellul_cgroup_memory_current_bytes{slice="ellul-user-workload-sbx-abc1234.slice",sandbox="sbx-abc1234",adapter="",scope=""} 1572864000
ellul_cgroup_memory_current_bytes{slice="ellul-user-workload-sbx-abc1234.slice",sandbox="sbx-abc1234",adapter="opencode",scope="pool1"} 251658240
…
# HELP ellul_cgroup_psi_memory_avg10 PSI memory avg10 per cgroup, percent.
# TYPE ellul_cgroup_psi_memory_avg10 gauge
ellul_cgroup_psi_memory_avg10{slice="ellul-user-workload.slice",…} 4.3
…
```

Stable label set: `slice` always present; `sandbox`/`adapter`/`scope` empty
strings when not applicable. Avoids label-cardinality explosions.

## Public API

```ts
export interface CgroupKey {
  /** Full cgroup path, e.g. "ellul-user-workload.slice/ellul-user-workload-sbx-abc1234.slice". */
  cgroupPath: string;
  /** Top-level slice name (label). */
  slice: string;
  /** Sandbox id if applicable. */
  sandbox: string | null;
  /** Adapter family if applicable. */
  adapter: "claude" | "opencode" | "cursor" | "codex" | null;
  /** Scope id if applicable. */
  scope: string | null;
}

export interface CgroupSample {
  key: CgroupKey;
  at: number;                         // wall-clock ms
  memoryCurrentBytes: number;
  memoryHighBytes: number | null;     // null = max
  memoryMaxBytes: number | null;      // null = max
  memoryEvents: { low: number; high: number; max: number; oom: number; oomKill: number };
  psiMem: { avg10: number; avg60: number; avg300: number };
  cpuUsageUsec: number;
  cpuUserUsec: number;
  cpuSystemUsec: number;
  psiCpu: { avg10: number; avg60: number; avg300: number };
  pidsCurrent: number;
}

export interface MetricsCollector {
  /** Latest sample for a specific cgroup, or null if not yet sampled. */
  latest(cgroupPath: string): CgroupSample | null;
  /** All current samples — one per known cgroup. */
  snapshot(): ReadonlyArray<CgroupSample>;
  /** Sliding window for a cgroup over the last N seconds. */
  window(cgroupPath: string, lastSeconds: number): ReadonlyArray<CgroupSample>;
  /** Subscribe to per-tick events. Used by DegradationController. */
  subscribe(listener: (samples: ReadonlyArray<CgroupSample>) => void): () => void;
}
```

## Service lifecycle

Started inside `agent-bridge.service` at boot. Single instance per bridge
process. Independent of WebSocket lifecycle; unaffected by reconnects.

- On boot: discover cgroups (one walk), open all the
  `/sys/fs/cgroup/.../{memory.current,memory.events,...}` file descriptors
  (cached for the lifetime of the cgroup).
- Every 1 s: read every fd into a single sample, append to ring buffer, fire
  subscribers.
- On cgroup discovery (transient slice / scope created): inotify
  `/sys/fs/cgroup/ellul-user-workload.slice` for new entries; open new fds.
- On cgroup destruction: close fds, drop ring entries.

## Failure modes

| Failure | Behaviour |
|---|---|
| `/sys/fs/cgroup` not mounted | `MetricsCollector` logs `ERR_CGROUPV2_NOT_MOUNTED` and emits typed event; AdmissionService falls back to `/proc/meminfo`-only mode (degraded) |
| File-descriptor open fails for one cgroup | That cgroup's sample is null; others continue; logged as `ERR_METRICS_FD_OPEN` |
| inotify watch fails | New cgroups not auto-discovered; fall back to 30 s rediscover sweep; logged as `ERR_METRICS_INOTIFY` |
| HTTP server bind on :7702 fails | Service still runs; subscribers still get samples; only the Prometheus scrape is unavailable; logged |
| Disk full (snapshot rollover) | Snapshot writer disabled; in-memory ring buffer continues; logged |

## Integration with state machines

- `pool_scope` machine consumes `ellul_cgroup_memory_current_bytes` to
  compute pool RSS for the `idle_reap_due` heuristic refinement (don't reap
  a process actively pushing pages to memory.current).
- `system_health` machine consumes the parent
  `ellul-user-workload.slice` sample for the slice-utilization input to
  `metrics` events.
- `preview` machine consumes per-preview samples for keepalive demote/promote
  decisions.

## Security invariants preserved

| Invariant | How preserved |
|---|---|
| MetricsCollector reads only `/sys/fs/cgroup` (read-only) | No writes, no setting limits, no creating cgroups |
| Bridge does not gain new capabilities | All reads are user-readable cgroup-v2 paths; no `CAP_SYS_ADMIN` needed |
| HTTP endpoint binds localhost only | `127.0.0.1:7702`, not `0.0.0.0`; documented; covered by integration test |
| No new privileged surface | No sudoers entry, no SUID binary |
| No DB access | All data in-memory + local disk under bridge's `ProtectSystem=strict` |
| Logged paths never include secrets | cgroup paths are well-formed slice/scope names; `[a-zA-Z0-9_.-]` only |

## Acceptance

| Criterion | How verified |
|---|---|
| 1 Hz sampling, ± 50 ms jitter | Unit test `metrics-collector.test.ts` "samples at ~1 Hz with bounded jitter" |
| Per-cgroup, per-scope attribution flows to Prometheus | Integration test scrapes `/metrics`, asserts every active cgroup appears with matching labels |
| Memory + CPU + PSI all sampled per cgroup | Unit tests cover each parser |
| Subscribers get every tick | Unit test |
| Failure modes don't take down the collector | Unit tests inject permission errors and ENOENT; assert collector continues |
| Snapshot writer rolls over and gzips | Unit test |
