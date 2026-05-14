# Resource Architecture v2

This directory holds the design and runbooks for the v2 resource-management
architecture that replaces heuristic preview admission, single-cgroup spawn
placement, and the in-memory-only session model that broke under power-user load.

This is **not a parallel package tree**. It refactors the existing implementation
in `packages/vps/`, `packages/vps-ui/`, and `apps/api/`. Where this design conflicts
with existing code, the existing code is replaced — no compatibility shims, no
feature flags gating new behaviour.

This namespace sits under `docs/v2/architecture/resource-v2/` so it does not collide
with the canonical platform docs at `docs/v2/architecture/00-system-overview.md`.

## Read in order

| # | Document | Owns |
|---|---|---|
| [00](00-overview.md) | System overview | The whole, blast radii, SLOs, glossary |
| [01](01-state-machines.md) | State machines | thread, sandbox, preview, pro_claude_slot, pool_scope, system_health |
| [02](02-cgroup-topology.md) | Cgroup topology | `ellul-user-workload.slice`, `ellul-ns-<sandbox>.slice` (transient), bridge cap reduction |
| [03](03-spawn-routing.md) | Spawn routing | `systemd-run` per-sandbox slice placement for every pool / Pro-Claude spawn |
| [04](04-metrics.md) | MetricsCollector | 1 Hz cgroup + PSI + cpu, Prometheus endpoint, local TSDB |
| [05](05-admission.md) | AdmissionService | Single-source-of-truth admission for preview, Pro-Claude, pool, sandbox |
| [06](06-pro-claude-slots.md) | Pro Claude slots | Slot manager, LRU-of-2-warm cache, eviction protocol |
| [07](07-session-checkpoints.md) | SessionCheckpointService | Per-adapter resume token + transcript serialization |
| [08](08-session-compaction.md) | SessionCompactor | Periodic in-daemon turn-history drop |
| [09](09-inference-queue.md) | InferenceQueue | Bounded concurrent in-flight sends, queued state |
| [10](10-system-health.md) | SystemHealth | Green/Yellow/Red derived signal, broadcast |
| [11](11-degradation.md) | DegradationController | Action triggers per mode |
| [12](12-preview-keepalive.md) | Preview keepalive | Visibility-driven WS heartbeat protocol |
| [13](13-thread-archive.md) | ThreadArchive | Soft-archive sweep + sidebar visibility cap |
| [14](14-ui-surfaces.md) | UI surfaces | New components in `packages/vps-ui/` |
| [15](15-release-pipeline.md) | Release pipeline | SLO gate, drain protocol, canary, auto-rollback |
| [16](16-chaos-suite.md) | Chaos suite | bridge-kill, memory-fill, preview-storm, release-cascade, pro-slot-thrash |

## Runbooks

[runbooks/](runbooks/) — one per typed error code introduced. Each runbook is
validated by being executed against a chaos scenario in CI.

## Security invariants (preserve, do not weaken)

This redesign sits on top of the existing security architecture documented in:

- `docs/v2/security/` — kernel hardening, gates, passkey/PoP, namespace isolation,
  threat model.
- `docs/v2/security/06-git-push-protection.md` — the 9-layer git-push and deploy defense.

Specifically, the redesign does not:

- Extend `--dangerously-skip-permissions` beyond Lite Claude (which already has the
  documented exemption — namespace IS the boundary).
- Modify `SupplementaryGroups` for `sovereign-shield`, `caddy`, or
  `shield`-group-protected services.
- Weaken `ptrace_scope=1`, `ProtectSystem=strict`, or `LimitCORE=0`.
- Introduce paths where the agent could read shield's environ or memory.
- Add new SUID binaries; new privileged operations go through a reviewed sudoers
  entry mirroring `ellul-agent-namespace`.
- Bypass per-project namespace isolation — every per-sandbox cgroup slice and
  admission decision respects the namespace boundary.
- Introduce direct PG connections from new services — every DB access goes through
  the existing gate-enforced query proxy (`db_read` / `db_write` / `db_migrate`).

If a design constraint conflicts with the above, the security invariant wins. The
conflict is surfaced in the relevant architecture document and resolved in writing.

## Implementation style

Doc + impl + tests in the same change set. No doc-only phase. Acceptance criteria
in [00-overview.md](00-overview.md#acceptance-criteria).
