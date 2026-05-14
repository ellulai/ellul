# 03 — Spawn Routing

> Status: shipped (`namespace-spawner.ts` + `namespace-spawn.service.ts` + `ellul-spawn-scope` wrapper + sudoers + provisioning install).

## What this layer owns

The exact mechanism that places every pool process and every Pro Claude slot
process into the right cgroup. Today every adapter subprocess inherits
`agent-bridge.service`'s cgroup; that's the load-bearing change reversed here.

After this lands, `systemd-cgls` shows pool processes under
`ellul-user-workload-sbx-<sandboxId>.slice` and Pro Claude slot processes under
`ellul-user-workload.slice`; `agent-bridge.service` contains only the bridge plus
immediate watchers.

## The wrapping chain

There are three privileged binaries already in the trust path:

1. `/usr/local/bin/ellul-agent-namespace` — enters the per-sandbox mount + PID + net
   namespace. Existing. Authoritative.
2. `/usr/local/bin/ellul-claude-launch` — mints the Claude OAT, then execs
   `ellul-claude-ns`. Existing.
3. `/usr/local/bin/ellul-claude-ns` — enters namespace then execs `claude`. Existing.

The redesign adds **one** new privileged binary:

4. `/usr/local/bin/ellul-spawn-scope` — takes a validated `<slice> <unit>
   <prop=val,...>` triple and execs `systemd-run --quiet --collect --scope
   --slice=<slice> --unit=<unit> --property=<each prop> -- <cmd>`.

The chain for adapter pool spawns becomes:

```
sudo -n ellul-spawn-scope <slice> <unit> <props> -- \
  ellul-agent-namespace enter <sandbox> -- \
    <adapter-binary> <args>
```

The chain for Pro Claude slot spawns becomes:

```
sudo -n ellul-spawn-scope ellul-user-workload.slice ellul-pro-claude-slot<N> <props> -- \
  ellul-claude-launch \
    [ellul-claude-launch then execs ellul-claude-ns then execs claude]
```

Pro Claude does not go through `ellul-spawn-scope` then `ellul-agent-namespace` —
the existing `ellul-claude-launch → ellul-claude-ns` chain handles namespace entry
internally for Pro. Per-slot scope is the only addition.

## ellul-spawn-scope: the validating wrapper

Reasoning: a sudoers entry with arg patterns is brittle and easy to widen
accidentally during refactor. Instead the wrapper is a tiny script that:

- Takes exactly four positional args before `--`: slice, unit, properties, the
  literal `--`.
- Validates the slice name against an explicit allowlist of regexes:
  - `^ellul-user-workload-sbx-[a-z0-9]{7}\.slice$`
  - `^ellul-user-workload\.slice$`
- Validates the unit name against an explicit allowlist of regexes:
  - `^ellul-pool-sbx-[a-z0-9]{7}-(claude|opencode|cursor|codex)-[a-zA-Z0-9_-]{1,32}$`
  - `^ellul-pro-claude-slot[1-9]$`
- Validates each property is from the allowlist `MemoryHigh | MemoryMax |
  MemorySwapMax | TasksMax | CPUQuota` and the value matches `[0-9KMG%]+`.
- Refuses any unknown prop, malformed arg, or path-escape attempt.
- On success, execs `/bin/systemd-run --quiet --collect --scope --slice=<slice>
  --unit=<unit> --property=<each prop> -- <inner argv...>`.

This wrapper is the **only** thing in the privileged sudoers entry. Sudoers:

```
$SVC_USER ALL=(root) NOPASSWD: /usr/local/bin/ellul-spawn-scope
```

(File `/etc/sudoers.d/ellul-spawn-scope`, mode `0440`, owner `root:root`,
validated by `visudo -cf` before install.)

The wrapper itself is `root:root 0755`, sits in `ProtectSystem=strict` territory
for every other service, cannot be modified by `$SVC_USER`. The same pattern as
`ellul-agent-namespace`.

### Why this is a small new privileged surface

| Surface | Risk | Mitigation |
|---|---|---|
| New script execs `systemd-run` as root | An unvalidated slice/unit could run anywhere | Allowlists are explicit regexes; no globbing in sudoers; script execs `systemd-run` with `--scope` only (not `--service`), so the resulting cgroup is bound to the caller-provided argv, not a persistent unit |
| Properties pass through to systemd | Could set `LimitCORE=unlimited` etc. | Property allowlist hard-coded to memory/task/cpu only; values must match `[0-9KMG%]+` so no `unlimited` literal |
| Slice creation on-demand | Could create unbounded slices | Slice name regex restricts to two specific patterns; `ellul-user-workload.slice` exists; sandbox-id pattern is bounded by `isSandboxId` validation upstream |
| Wrapper invoked from agent-bridge | Could be called with attacker-chosen sandbox id | Sandbox id must match `sbx-[a-z0-9]{7}` and is set by the bridge's pool acquire site (not user-controlled) |

The new privileged surface is **one script, two allowlist regexes, and four
property names**. Reviewable in 50 lines of bash.

## Effect-layer spawner change

`packages/vps/src/services/backends/agent-bridge/src/shared/namespace-spawner.ts`
gains three additional env reads:

- `ELLUL_NS_ADAPTER` — `claude | opencode | cursor | codex`. Required for slice
  routing.
- `ELLUL_NS_SCOPE_ID` — short id (≤32 chars, `[a-zA-Z0-9_-]`). Required for unit
  uniqueness across pool entries within one (sandbox, adapter).
- `ELLUL_NS_SOFT_HINT_MB` — soft `MemoryHigh` for the per-sandbox slice. Required
  for the first scope under a fresh sandbox slice; subsequent scopes inherit.

When `ELLUL_NS_PROJECT` and the three above are all set, the spawner wraps with
the full chain. When only `ELLUL_NS_PROJECT` is set, it falls back to the existing
namespace-enter wrapper (used for ad-hoc commands not part of a pool).

```ts
// Compose wrapper argv
const slice = `ellul-user-workload-sbx-${project}.slice`;
const unit  = `ellul-pool-sbx-${project}-${adapter}-${scopeId}`;
const props = [
  `MemoryHigh=${softHintMB}M`,
  `MemorySwapMax=0`,
  `TasksMax=512`,
].join(',');

const wrapperCommand = "sudo";
const wrapperArgs    = [
  "-n", "/usr/local/bin/ellul-spawn-scope",
  slice, unit, props, "--",
  "/usr/local/bin/ellul-agent-namespace", "enter", project, "--",
];
const wrapped = ChildProcess.prefix(command, wrapperCommand, wrapperArgs);
```

Validation in the spawner mirrors the wrapper's: project must match
`isSandboxId`; adapter must be in the allowlist; scope id must match
`/^[a-zA-Z0-9_-]{1,32}$/`; soft hint must be a positive integer ≤ 8192. On any
violation, fail closed (PlatformError) — same pattern as the existing missing-
project check.

## Direct-spawn path change

`packages/vps/src/services/backends/agent-bridge/src/services/namespace-spawn.service.ts`
gains a new `NamespaceSpawnOptions` field:

```ts
interface AdapterScope {
  adapter: "claude" | "opencode" | "cursor" | "codex";
  scopeId: string;        // [a-zA-Z0-9_-]{1,32}
  softHintMB: number;     // > 0
}
interface NamespaceSpawnOptions {
  // ... existing fields
  adapterScope?: AdapterScope;
}
```

When `adapterScope` is set, the spawn wraps the same way as the Effect spawner.
Without it, the direct-spawn path keeps its existing behavior (just namespace
enter) — used by health probes and other ad-hoc paths.

## Sandbox slice properties

The sandbox slice (`ellul-user-workload-sbx-<id>.slice`) is created on-demand by
`systemd-run`. The properties on the FIRST `--scope` create the slice with those
properties; subsequent scopes inherit. We pass:

| Property | Value | Why |
|---|---|---|
| `MemoryHigh=<softHint>M` | 1536 ($20) / 2048 ($50) | Soft fence; pressure surfaces at parent (`ellul-user-workload.slice`) for systemd-oomd to act |
| `MemorySwapMax=0` | 0 | No swap, ever, for user workload |
| `TasksMax=512` | 512 | Catches one runaway adapter without taking down the host |

We deliberately do **not** set `MemoryMax` on the per-sandbox slice. The aggregate
cap belongs to `ellul-user-workload.slice`. Per-sandbox `MemoryMax` would risk
killing one sandbox's pool while the host had plenty of RAM — bad UX.

## Pro Claude slot scope properties

| Property | Value | Why |
|---|---|---|
| `MemoryHigh=<softHint>M` | 320 (single Pro session peak ≈ 234 MB; padding) | Soft fence per slot |
| `MemorySwapMax=0` | 0 | Same |
| `TasksMax=256` | 256 | Pro Claude is single-process plus tool subprocesses; 256 is comfortable |

Pro Claude slots land directly under `ellul-user-workload.slice` (slot-based, not
per-sandbox).

## Verification: `systemd-cgls` integration test

`packages/vps/src/services/backends/agent-bridge/src/shared/namespace-spawner.test.ts`
has a unit test that asserts the spawner produces the correct argv shape (no
shell-out — it inspects the `ChildProcess.Command` after `prefix`).

`packages/vps/test/integration/cgroup-placement.test.ts` (added by
[15-chaos-suite.md](15-chaos-suite.md)) is a real `systemd-cgls` test that runs
on a cgroup-v2 capable Linux runner: it spawns one fake pool process per adapter
across two sandboxes and asserts each process's cgroup matches the expected
`ellul-user-workload-sbx-<id>.slice/ellul-pool-sbx-<id>-<adapter>-<scope>.scope`
path.

## Rollback safety

If `ellul-spawn-scope` is missing on a host (e.g. a botched migration), the new
spawner detects the absence at first use and **fails the spawn** with typed
error `ERR_SPAWN_SCOPE_BINARY_MISSING`. The pool acquire site retries with
plain namespace-enter (degraded mode — pool runs in bridge's cgroup as before)
and emits a `degraded_mode_yellow` system health signal. This is the only path
that uses degraded behaviour as a fallback; it exists so a botched provisioning
push doesn't wedge every sandbox until the next deploy.

The bridge `bundle.ts` adds `ExecStartPre=/usr/bin/test -x
/usr/local/bin/ellul-spawn-scope` so the bridge fails to start at boot if the
binary is missing — surfacing the migration drift loudly.

## Security invariants preserved

| Invariant | How preserved |
|---|---|
| Agent cannot escape namespace | `ellul-agent-namespace enter` still in the chain. Wrapper does not bypass namespace |
| Agent cannot read shield's environ | Wrapper runs as root, drops to `$SVC_USER` via systemd-run scope inheritance + namespace enter; same boundary as today |
| `ptrace_scope=1` preserved | Wrapper does not modify sysctl |
| `LimitCORE=0` preserved on shield + bridge | Wrapper sets only the documented per-scope properties; bridge's own `LimitCORE=0` unchanged |
| `safeGitCmd` preserved | Wrapper does not touch git config; git operations remain in shield-owned subprocesses |
| New SUID binary? | NO — wrapper is `root:root 0755` invoked via existing sudoers pattern |
| Sudoers entry locked | `$SVC_USER ALL=(root) NOPASSWD: /usr/local/bin/ellul-spawn-scope` (single binary; no arg matching needed because validation is in-script) |
| Slice/unit names cannot escape allowlist | Two regex patterns, both anchored, both excluding `..` and `/` |
| Property allowlist | Four names; values match `[0-9KMG%]+`; no `unlimited`, no path properties |
| Wrapper itself | Cannot be modified by agent (root-owned, `ProtectSystem=strict`) |
| Pro Claude OAT chain unchanged | `ellul-claude-launch` still mints OAT; `ellul-claude-ns` still enters namespace; only the cgroup placement is added by `ellul-spawn-scope` wrapper around the chain |

## Acceptance

| Criterion | How verified |
|---|---|
| Pool processes appear under per-sandbox slices in `systemd-cgls` | Integration test in `packages/vps/test/integration/cgroup-placement.test.ts` |
| `agent-bridge.service` cgroup contains only the bridge process plus watchers | Same test, plus runtime hygiene assertion (Phase D) |
| `ellul-spawn-scope` rejects malformed slice / unit / property | Unit test in `packages/vps/src/scripts/workflow/spawn-scope.test.ts` (validates the embedded shell script's regex behaviour by running it) |
| Spawner fails closed on missing `ELLUL_NS_PROJECT` | Existing test, kept |
| Spawner falls back to namespace-only-wrap when adapter/scope/hint not all set | New unit test in `namespace-spawner.test.ts` |
| Bridge `ExecStartPre` blocks startup if `ellul-spawn-scope` missing | Manual verification on rolled host; covered by chaos test "release-cascade" |

---

# Host-mode probe routing (extension)

> Status: shipped (`namespace-spawner.ts` host-bypass branch + per-adapter probe callsites + `ellul-probe-<adapter>-<scope>` unit allowlist).

## Why this extension exists

The original spec routed **per-sandbox pool** spawns through `ellul-spawn-scope` so they land outside the bridge cgroup. It did not route **host-mode inventory probes** — `opencode serve` for `checkOpenCodeProviderStatus`, `cursor-agent acp` for the cursor inventory + capability probes, `codex app-server` for `checkCodexProviderStatus`. Those run in `host-bypass` (no namespace; probe needs host network for upstream provider RPCs).

In production we observed the chronic failure mode: every host-bypass `serve` / `acp` / `app-server` was a **direct child of the bridge process** and therefore inherited the bridge cgroup. On a 4 GB box, one ~270 MB `opencode serve` plus the 170 MB bridge node consistently sat over `MemoryHigh=384M`, and `memory.events.high` accumulated tens of thousands of throttle events per minute. First-message turns timed out because the bridge was constantly parked in `mem_cgroup_handle_over_high`.

The fix: host-mode probes carry the same routing trio (`ELLUL_NS_ADAPTER` / `ELLUL_NS_SCOPE_ID` / `ELLUL_NS_SOFT_HINT_MB`) the pool uses. The spawner detects host-mode + routing and wraps with `ellul-spawn-scope` against `ellul-user-workload.slice` — without the namespace nest (probe needs host network).

## The host-mode wrapping chain

```
sudo -n ellul-spawn-scope ellul-user-workload.slice ellul-probe-<adapter>-<scopeId> <props> -- \
  <adapter-binary> <args>
```

Differs from the pool chain in two ways:
1. **Slice is the shared host-mode slice** (`ellul-user-workload.slice`), not a per-sandbox slice. Probes are not bound to any sandbox.
2. **No `ellul-agent-namespace enter` step.** Probes need the host's network namespace to reach `chatgpt.com`, `cursor.sh`, etc. The cgroup wrap is the only confinement added by this hop; seccomp / AppArmor / iptables egress allowlist apply at host scope unchanged.

## Unit allowlist extension

`ellul-spawn-scope` validates a third unit pattern in addition to the two existing ones:

```
^ellul-probe-(claude|opencode|cursor|codex)-[a-zA-Z0-9_-]{1,32}$
```

The slice allowlist is unchanged. Sudoers entry is unchanged. Property allowlist is unchanged. Net new privileged surface: zero — the wrapper is the same script with one additional regex alternative.

## Spawner branches

`namespace-spawner.ts` adds a third branch under `project === NAMESPACE_HOST_SENTINEL`:

| Routing trio | Argv | Action | Event |
|---|---|---|---|
| Absent | short host command (`--version`, `--help`, `about`) | Pure host bypass — direct spawn | `ns.spawner.hostBypass` |
| Absent | argv contains `serve` / `acp` / `app-server` | **Fail closed** — bridge cgroup leak forbidden | `ns.spawner.uncontainedLongLivedHost` |
| Present | any | Wrap with `ellul-spawn-scope` against `ellul-user-workload.slice` / `ellul-probe-<adapter>-<scope>` | `ns.spawner.hostScope` |
| Mixed (1–2 of 3 set) | any | **Fail closed** | `ns.spawner.malformedScopeRouting` |

The fail-closed for uncontained `serve` / `acp` / `app-server` (Phase E) is the lockdown rail: future code that accidentally does a host-bypass spawn for a long-lived adapter mode trips at compile-grep (per-adapter `security-invariants.test.ts`) AND at runtime (the spawner refuses with a remediation hint pointing at this doc).

## Probe scope-id format

Adapters generate scope IDs with a process-boot timestamp prefix and a per-adapter monotonic counter:

```
p<base36(Date.now())>-<n>
```

This guarantees uniqueness across bridge restarts: a slow probe surviving a bridge restart cannot collide with a fresh probe in the new process. The trailing counter is reset on each module load, so test-friendly determinism is preserved within a process.

## Tier-aware probe soft hints

Probes don't get the full per-sandbox budget — they're short-lived and run a smaller subset of the adapter. `computeWorkloadSliceBudget` returns a new field `probeSoftHintMB`, sized by physical RAM:

| Tier | `probeSoftHintMB` |
|---|---|
| ≤2 GB | 384 |
| 4 GB ($20) | 512 |
| 8 GB ($50) | 768 |
| larger | 1024 |

Adapters consume this from `computeWorkloadSliceBudget(os.totalmem() / MB).probeSoftHintMB` at module load. **Never inline a constant in the probe callsite.**

## Durable inventory cache (Phase C)

Probes are expensive (a fresh `opencode serve` is ~5 s wall and ~270 MB resident). Without persistence, every bridge restart re-pays that cost on the next reconciler tick. The disk layer at `packages/vps/src/services/backends/agent-bridge/src/shared/inventory-cache-disk.ts` adds:

- L2 file: `/etc/ellul/agent-bridge/inventory/<adapter>.json`, mode `0o640`, owner bridge user.
- Atomic writes via tmp+rename (crash-safe; no half-written state observable to readers).
- Schema-validated read; corruption → cache miss, file untouched.
- Adapter-supplied cache key (typically `sha256(binaryPath:mtime:size)` — binary upgrades invalidate without an explicit version compare).
- Optional `maxAgeMs` TTL guard at load (belt-and-suspenders against older bundles having written longer-lived entries).

Boot path: each adapter's provider module calls `loadInventoryCacheFromDisk` at module load to hydrate L1 immediately. The first probe after restart runs `--version` (cheap host bypass), and if the version matches the L1 entry, the expensive `serve` step is skipped entirely. Probe storms after fleet restart are eliminated.

Cache contents are public CLI inventory data only (model names, version strings, agent definitions); never auth tokens, never user data.

## Cgroup hygiene assertion (Phase D)

`packages/vps/src/services/backends/agent-bridge/src/application/runtime-control/CgroupHygieneAssertion.ts` reads `cgroup.procs` of the bridge service every reconciler tick (30 s). The allowlist is:
1. The bridge node main process itself (`process.pid`).
2. Transient `sudo` / `bash` / `systemd-run` / `ellul-spawn-scope` wrappers younger than the grace window (default 2 s) whose `cmdline` references `ellul-spawn-scope` — the moving window between fork and the new scope's cgroup migration.

Anything else is a violation:
- WARN on first detection, with `pid`, `comm`, `cmdline`, `ageMs`, `firstSeenAt`, `severity`, `cgroupAbsolutePath` in the event payload.
- Sustained > 30 s (across consecutive ticks) escalates to CRITICAL.
- Per-tick rate limit: 32 violations max.
- The check is **read-only** — observation, not enforcement. Migrating foreign PIDs out of the bridge cgroup risks breaking them; we surface the violation and rely on the upstream contract (every adapter spawn carries the routing trio) for correctness. The hygiene assertion is the runtime tripwire that catches any regression that gets through code review.

The reconciler logs `ns.lifecycle.reconcile` with `hygieneViolations` and `hygieneCritical` counts so a dashboard can graph the trend.

## Events emitted

| Event | When | Severity |
|---|---|---|
| `ns.spawner.hostScope` | Host-mode + routing-trio spawn wraps successfully through `ellul-spawn-scope` | INFO |
| `ns.spawner.hostScopeSpawnError` | Host-scope spawn failed at the systemd-run boundary | WARN |
| `ns.spawner.uncontainedLongLivedHost` | Phase E lockdown tripped — long-lived argv without routing | ERROR (also fails the Effect) |
| `ns.spawner.malformedScopeRouting` | 1–2 of 3 routing vars set — programming error | ERROR |
| `bridge.cgroup.violation` | Hygiene assertion saw an out-of-allowlist PID in bridge cgroup | WARN or CRITICAL |
| `bridge.cgroup.checkError` | Hygiene tick failed (rare; e.g. `/sys/fs/cgroup` unreadable) | WARN |
| `inventory.cache.loadHit` / `inventory.cache.persistOk` | Disk cache hit / wrote successfully | INFO |
| `inventory.cache.loadCorrupt` / `loadStale` / `loadRejected` / `loadError` | Disk cache rejected on read | WARN |
| `inventory.cache.persistError` | Disk cache write failed (best-effort; never blocks live path) | WARN |

## Acceptance — host-mode extension

| Criterion | How verified |
|---|---|
| Probe spawns appear under `ellul-user-workload.slice / ellul-probe-<adapter>-<scope>.scope` | Static security-invariant tests in `adapters/{opencode,cursor,codex}/security-invariants.test.ts` (grep-asserts routing trio); runtime hygiene assertion confirms no probe lands in bridge cgroup |
| Long-lived host-bypass without routing fails closed | `namespace-spawner.test.ts` (Phase E lockdown branch) + per-adapter security invariants |
| Cgroup hygiene assertion catches foreign PIDs | `CgroupHygieneAssertion.test.ts` covers allowlist behaviour, severity escalation, rate limiting, payload shape |
| Disk cache hydrates L1 on bridge boot | `inventory-cache-disk.test.ts` round-trips a payload through atomic write + schema-validated read across simulated restarts |
| Probe scope IDs don't collide across bridge restarts | Module-level `PROBE_SCOPE_BOOT_ID = Date.now().toString(36)` prefix; counter resets per process |
| Probe soft hints scale with tier | `memory-budget.test.ts` covers the new `probeSoftHintMB` field at every breakpoint |
