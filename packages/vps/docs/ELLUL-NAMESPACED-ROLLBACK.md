# `ellul-namespaced` — Rollout / Rollback Runbook

Wave 0 is **purely additive** to the existing namespace control plane:

- The legacy `sudo /usr/local/bin/ellul-agent-namespace …` path is unchanged.
- `NamespaceSpawn.ts`'s spawn flow is unchanged.
- `enter.sh` / `spawn.sh` are unchanged.
- Sudoers entries are unchanged.

The daemon ships disabled. Without the feature flag and signed manifest,
nothing happens. Rolling back is removing the flag.

## What ships

| Artifact                                      | Location on VPS                                    |
|-----------------------------------------------|----------------------------------------------------|
| Daemon binary                                 | `/usr/local/bin/ellul-namespaced` (mode 0755)      |
| Daemon C sources                              | `/opt/ellul/ellul-namespaced/*.{c,h}`              |
| systemd unit                                  | `/etc/systemd/system/ellul-namespaced.service`     |
| `ellul-ns` system group                       | `/etc/group`                                       |
| Manifest pubkey directory                     | `/etc/ellul/manifests/`                            |
| Tier manifest directory                       | `/opt/ellul/manifests/`                            |
| Feature flag directory (empty)                | `/etc/ellul/feature-flags/`                        |

The unit is `enable`d (so it would start on next boot if conditions are
met) but `ConditionPathExists=/etc/ellul/feature-flags/nsd-enabled` keeps
it dormant until a flag file is created.

The bridge-side client (`EllulNamespacedClient.ts`) checks
`/etc/ellul/feature-flags/nsd-enabled` and `manifest.pub` presence
before attempting any connection. Without those, `tryConnect()` returns
`null` and the bridge does nothing.

## Wave 1 Phase B — ENTER + INJECT_ENV cutover

After Phase A is enabled and stable, Phase B routes the per-CLI ENTER
path through the daemon. This closes H-4 (cross-project entry) and H-5
(env-file TOCTOU) by removing the `/tmp/.ns-env-*` filename surface
entirely — argv and env now travel as sealed memfds.

Enablement (after Phase A is healthy):

1. **Confirm `/usr/local/bin/ellul-fd-pass` is present** (compiled by
   the same provisioning step that builds the daemon).
2. **Set the cutover flag on a canary host** to switch the bridge's
   spawn path:
   ```bash
   ssh root@vps-canary 'echo 1 > /etc/ellul/feature-flags/nsd-cutover-enter
                        systemctl restart ellul-agent-bridge'
   ```
3. **Watch for `nsd.enter.*` events** in
   `/var/log/ellul/agent-bridge-events.jsonl`. Successful invocations
   emit `nsd.enter.done` with the child's exit code. Failures emit
   `nsd.enter.deny` (auth/seal violations) or `nsd.enter.waitpid-fail`.

Rollback Phase B without affecting Phase A:
```bash
ssh root@vps 'rm -f /etc/ellul/feature-flags/nsd-cutover-enter
              systemctl restart ellul-agent-bridge'
```

Optional Phase B follow-on: per-binary agent-side seccomp allowlist mode
(closes M-2). Set in the env injected for ENTER:
```
ELLUL_SECCOMP_MODE=allowlist
```
The `ellul-seccomp-exec` wrapper falls back to its existing denylist
when this var is absent, so the cutover is per-adapter. Roll out one
binary at a time; SIGSYS audit logs flag any missing syscalls.

## Wave 1 Phase A — operational cutover

After enabling Wave 0 (steps below), additional Phase-A enablement:

1. **Sign tier manifests** with the build-host signing key:
   ```bash
   # On a build host (NEVER on a VPS):
   ELLUL_NSD_MANIFEST_KEY="$(cat manifest.priv.b64)" \
     pnpm tsx apps/api/scripts/sign-manifests.ts
   # writes packages/vps/src/manifests/{free,paid}.cbor + manifest.pub
   ```

2. **Verify the daemon accepts the new manifests:**
   ```bash
   ssh root@vps 'systemctl restart ellul-namespaced.service
                 journalctl -u ellul-namespaced.service -n 20 --no-pager'
   # expect: nsd.startup.ready and nsd.manifest.load.ok
   ```

3. **Enable the SETUP/TEARDOWN cutover flag on a canary host:**
   ```bash
   ssh root@vps-canary 'echo 1 > /etc/ellul/feature-flags/nsd-cutover-setup
                        systemctl restart ellul-agent-bridge'
   ```
   Once the flag is present, the bridge routes `setupNamespace` and
   `teardownNamespace` through the daemon's admin socket. On any
   daemon-route failure (connect timeout, auth deny, exec error) the
   bridge automatically falls back to the legacy `sudo
   ellul-agent-namespace` path; nsd.setup.nsd-fail / nsd.teardown.nsd-fail
   events surface the daemon-side failure.

4. **Roll out fleet-wide** by setting the flag in the provisioning payload
   for new hosts and invoking the same `echo 1 > .../nsd-cutover-setup`
   for existing hosts during the next bridge restart cycle.

To roll back the cutover (keep daemon running, route via sudo again):
```bash
ssh root@vps 'rm -f /etc/ellul/feature-flags/nsd-cutover-setup
              systemctl restart ellul-agent-bridge'
```

## Enabling on a host (Wave 0 dry-run)

Prerequisites:
- Kernel 6.5+ (Ubuntu 24.04 LTS satisfies; older hosts will exit 78).
- `agent-bridge.service` user is in the `ellul-ns` group (provisioning
  handles this; for an in-place upgrade run `gpasswd -a $SVC_USER ellul-ns`
  followed by `systemctl restart ellul-agent-bridge` so the supplementary
  group takes effect at exec).

Steps:

1. **Generate the manifest signing keypair on a build host** (NOT on the
   VPS):
   ```bash
   # Once, off-VPS:
   node -e '
     const { generateKeyPairSync } = require("crypto");
     const { publicKey, privateKey } = generateKeyPairSync("ed25519");
     require("fs").writeFileSync("manifest.priv.der",
       privateKey.export({ format: "der", type: "pkcs8" }));
     require("fs").writeFileSync("manifest.pub.raw",
       publicKey.export({ format: "der", type: "spki" }).slice(-32));
   '
   ```
   Store `manifest.priv.der` in your build secret manager. Never copy it
   to a VPS.

2. **Author the tier manifests** as JSON sources and sign them. This
   ships in a follow-up — for the initial Wave 0 dry-run, hand-author
   a CBOR manifest covering the load-bearing security mounts:
   - `/etc/ellul/shield-data` (kind=blackhole, EMPTY flag)
   - `/var/lib/ellul-shielded` (kind=blackhole, EMPTY flag)
   - `/run/shield` (kind=blackhole, EMPTY flag)
   - `/proc` (kind=proc, options_required=`hidepid=2`)
   - `/home/{home}/projects` (kind=tmpfs)

3. **Ship the public key + signed manifest to the VPS:**
   ```bash
   scp manifest.pub.raw root@vps:/etc/ellul/manifests/manifest.pub
   scp signed-free.cbor  root@vps:/opt/ellul/manifests/free.cbor
   scp signed-paid.cbor  root@vps:/opt/ellul/manifests/paid.cbor
   ssh root@vps 'chmod 0444 /etc/ellul/manifests/manifest.pub /opt/ellul/manifests/*.cbor'
   ```

4. **Enable the daemon:**
   ```bash
   ssh root@vps 'echo 1 > /etc/ellul/feature-flags/nsd-enabled
                 systemctl start ellul-namespaced.service
                 systemctl status ellul-namespaced.service --no-pager'
   ```

5. **Enable the bridge client (optional; daemon is harmless without it):**
   ```bash
   ssh root@vps 'echo 1 > /etc/ellul/feature-flags/nsd-enabled
                 systemctl restart ellul-agent-bridge'
   ```

6. **Verify shadow attest is firing:**
   ```bash
   ssh root@vps 'tail -n 20 /var/log/ellul/agent-bridge-events.jsonl | grep nsd.attest'
   ```
   You should see `nsd.attest.ok` lines per project. `nsd.attest.mismatch`
   is also acceptable in Wave 0 — it surfaces a manifest-vs-namespace
   discrepancy without blocking; investigate the manifest authoring.

## Rollback

The daemon is observation-only in Wave 0; the legacy bash path remains the
sole control plane for write operations. Rollback removes the daemon's
ability to receive any traffic; nothing else changes.

```bash
# Disable the bridge client immediately (no restart needed — flag check
# is on every tryConnect()):
ssh root@vps 'rm -f /etc/ellul/feature-flags/nsd-enabled'

# Stop and disable the daemon:
ssh root@vps 'systemctl stop ellul-namespaced.service
              rm -f /etc/ellul/feature-flags/nsd-enabled
              systemctl disable ellul-namespaced.service'

# Optional: remove the binary itself.
ssh root@vps 'rm -f /usr/local/bin/ellul-namespaced'
```

Restart the bridge to clear any cached client state (not strictly needed
since the client opens a new connection per attest; do it for cleanliness):

```bash
ssh root@vps 'systemctl restart ellul-agent-bridge'
```

## Failure modes and observability

| Symptom                                 | Cause                                                    | Mitigation                                                |
|-----------------------------------------|----------------------------------------------------------|-----------------------------------------------------------|
| Daemon exits with status 78             | Kernel < 6.5 (no SO_PEERPIDFD)                           | Upgrade kernel; daemon won't restart-loop (`SuccessExitStatus=78`). |
| `nsd.startup.kernel-too-old` event      | Same as above                                            | See above.                                                |
| `nsd.manifest.load.fail`                | Pubkey/manifest mismatch, expired manifest, tier mismatch| Re-sign with current key; check `/etc/ellul/billing-tier`.|
| `nsd.attest.unreachable`                | Bridge can't reach the per-project socket                 | Check daemon is up and project socket is bound.           |
| `nsd.attest.mismatch`                   | Observed namespace differs from manifest                  | Investigate which mount differs in event payload.         |
| `nsd.auth.deny` reason=cgroup-mismatch  | Process outside agent-bridge cgroup connected            | Expected for non-bridge connectors; investigate if from bridge. |
| Daemon SIGSYS / KILL                    | Daemon hit a syscall outside its seccomp allowlist       | Add the syscall to `nsd_allowed[]` in `daemon_seccomp.c`. |

## Wave-1 prerequisites

Wave 0 explicitly does **not** include:

- Cutover of `setupNamespace` / `enter` / `spawn` / `teardown` from sudo
  to daemon RPC. The daemon advertises `wave=0` in `HELLO` and refuses
  write opcodes with `EWAVE_READONLY`.
- env-file injection via daemon (Wave 1 closes H-5 TOCTOU).
- Cross-project mount staging via daemon-controlled namespace root FDs.
- Per-project transient `.socket` units (current design is daemon-internal
  bind/unlink — simpler operationally).

The protocol shape supports all of the above; flipping the bit requires
new handlers and feature flag bumps, not a re-design.

## Wave 1 Phase C — session 2 — completed

- **adapterScope plumbing — RESOLVED.** ENTER body now carries CBOR
  key 11 (target_cgroup, text). Daemon's enter.c validates the path
  against a regex that binds `<short>` (project[4..]) into both the
  per-sandbox slice name and the pool unit name; symlink redirection
  defended by O_DIRECTORY|O_NOFOLLOW + fstatfs(CGROUP2_SUPER_MAGIC).
  Bridge materializes the per-pool transient scope via
  `sudo /usr/local/bin/ellul-spawn-scope <slice> <unit> <props> --
  /usr/bin/sleep infinity` (detached, --collect), passes the cgroup
  path to `EllulNamespacedClient.enter(targetCgroup: ...)`, and
  SIGKILLs the sleeper process group on EXIT_NOTIFY. The `throw` in
  spawnInNamespace for adapterScope+nsd-cutover-enter is gone.
  Source: enter.c::join_target_cgroup, NamespaceSpawn.ts::
  spawnAdapterScopeAnchor, test_target_cgroup.c (16 cases).
- **BYOK Phases 1–3 — SHIPPED.** Per-host master at
  `/etc/ellul/byok-master.key`, per-project secret lifecycle in ops.c,
  HKDF-SHA256 subkey derivation, libsodium secretbox WRAP/UNWRAP
  opcodes (0x60/0x62), and ENTER inline unwrap of `__byok-v1:` env
  markers. Bridge SDK ships
  `EllulNamespacedClient.byokWrap(project, provider, plaintext)` for
  the user-add UX flow; daemon-inline unwrap is the spawn-time path.
  Plaintext never lands on disk on bridge or daemon.
- **BYOK Phases 4–5 — DEFERRED** per BYOK-DESIGN §10 sign-off. Phase 4
  (BYOK_REWRAP for master rotation) ships when first rotation needed;
  Phase 5 (BYOK_REKEY_PROJECT) ships on operator demand.
- **Sudoers — REMOVED.** Per user telemetry confirmation (≥7 days of
  zero `ns.{setup,teardown,enter}.daemon-required` events fleet-wide),
  the four `ellul-agent-namespace` sudoers lines are deleted from
  `firewall-{relaxed,partial-ironclad,full-ironclad}.sh`. Bridge's
  legacy sudo fallback paths in NamespaceSpawn.ts now fail closed if
  reached — every host MUST have nsd-cutover-{setup,enter} flags set.
  The bash control-plane wrapper (`/usr/local/bin/ellul-agent-namespace`)
  remains in place — it's still invoked by the daemon's ops.c
  fork+execve under nsd-cutover-setup, just not via sudo from the
  bridge anymore. C4 done.

## Wave 1 Phase C — session 1 — completed

- **End-to-end VM CI** (`.github/workflows/ellul-namespaced-vm.yml`).
  ubuntu-24.04 runner, hard kernel-floor assertion (no `SO_PEERPIDFD`
  skip-guard), real systemd unit, real cgroup hierarchy via
  `systemd-run --slice=ellul-control-plane.slice --unit=ellul-agent-bridge`.
  Stub bridge is the production `EllulNamespacedClient`; harness drives
  HEALTH / CREATE_PROJECT / SETUP / ATTEST / ENTER / TEARDOWN /
  DROP_PROJECT and asserts on event-log shape. Adversarial port covers
  out-of-cgroup, malformed CBOR, oversize frame, bad HMAC, replay,
  wrong fingerprint. Daemon liveness asserted after every attack.
  Source: `packages/vps/test/integration/nsd-vm/`.
- **Bridge no-fallback (C4-bridge).**
  `setupNamespace` / `teardownNamespace`: when `nsd-cutover-setup`
  is set, the daemon admin socket is mandatory. Any failure throws
  `Namespace setup failed for <slug>: …` with explicit reason
  surfaced in the new `ns.{setup,teardown}.daemon-required` event.
  No silent fall-through to `sudo ellul-agent-namespace`.
  `spawnInNamespace`: when `nsd-cutover-enter` is set AND the
  namespace is pre-warmed, `EllulNamespacedClient.enter()` is the
  spawn path. Logs `cli.spawn` with `mode: "enter-nsd"`. Hard error
  if the daemon connection drops. Two known gaps surfaced explicitly
  (see §"Phase D follow-ups"); no fallback in either case.
- **Sudoers — telemetry-gated removal.** Deprecation comments added
  to `firewall-{relaxed,partial-ironclad,full-ironclad}.sh` marking
  the four `ellul-agent-namespace` lines for removal. Exit criteria
  in §"Sudoers removal exit criteria" below.
- **BYOK per-project key sealing — design strawman.**
  `packages/vps/docs/ELLUL-NAMESPACED-BYOK-DESIGN.md`. Implementation
  blocked on sign-off of the eight open questions (A–H) in that
  document. No code shipped this session.

## Sudoers removal exit criteria

The four `ellul-agent-namespace` sudoers entries in
`apps/api/src/provisioning/shell/security/firewall-*.sh` are removable
once **all** of the following are simultaneously true for ≥7 consecutive
days, fleet-wide:

1. `nsd-cutover-setup` and `nsd-cutover-enter` flag files are present
   on every active host (provisioning bake-in, not per-host opt-in).
2. The bridge emits zero `ns.setup.daemon-required` events with reason
   != `nsd-rejected` (i.e. the daemon admin socket has never been
   unreachable).
3. The bridge emits zero `ns.teardown.daemon-required` events with
   reason != `nsd-rejected`.
4. The bridge emits zero `cli.spawn` events with `mode: "spawn"`
   for projects that have a live anchor (a stale `mode: "spawn"`
   indicates the lifecycle reconciler missed a teardown — independent
   bug, not a fallback).

Telemetry queries (Cloudflare Analytics or whatever the fleet-side
log aggregator is) are an operator concern; the daemon's
`/var/log/ellul/agent-bridge-events.jsonl` carries every required
event tag. Once the criteria are met, a single follow-up commit
deletes lines tagged `Phase C — pending removal` in the three
firewall scripts.

## Phase D follow-ups

- **Anchor cgroup placement on daemon-routed ENTER — RESOLVED.**
  `enter.c::join_anchor_cgroup` now reads the anchor's cgroup-v2 path
  via `/proc/self/fd/<pidfd>/cgroup`, validates it contains
  `/ellul-ns-<project>.service` as a path component (defeats foreign-
  cgroup redirection), and writes the worker's host PID into the
  resolved cgroup's `cgroup.procs` before `setns`. `fstatfs` confirms
  the cgroup directory is on cgroup2-fs (defeats symlink redirection).
  Children are now billed to the anchor's cgroup, not
  `ellul-namespaced.service`. Harness asserts the placement via
  `/proc/self/cgroup` readback inside the spawned shell.
- **Latent fix bundled.** The same change skips the worker's anchor
  pidfd in the close-fds-above-2 loop; the prior implementation
  closed it before `setns` consumed it, which would have produced
  exit code 126 on the first real ENTER. Caught and fixed before any
  fleet exposure.
- **adapterScope plumbing — RESOLVED in Phase C session 2.** ENTER
  body key 11 carries the target cgroup; daemon validates via the
  same project-bound regex shape that drives anchor placement. Bridge
  spawns ellul-spawn-scope sleeper to materialize the unit, kills the
  pgrp on EXIT_NOTIFY, scope auto-collects. See Phase C session 2
  notes above.

## Outstanding follow-ups (still deferred)

- **BYOK Phase 4 — `BYOK_REWRAP` for master rotation.** Master
  rotation is operator-driven and rare; ship when first rotation
  needed. Daemon-side: dual-master state (~30 lines C) + opcode
  0x64. Bridge-side: rewrap-all loop over stored ciphertexts.
- **BYOK Phase 5 — `BYOK_REKEY_PROJECT`.** Explicit per-project
  rotation without drop+recreate. The implicit drop+recreate path
  already provides this functionality; ship Phase 5 only on
  operator demand. New opcode 0x66 (TBD).
- **Bridge BYOK store integration.** SDK ships in Phase 3
  (`EllulNamespacedClient.byokWrap`). The bridge's user-facing BYOK
  config UX flow needs to migrate plaintext storage to ciphertext
  storage (per BYOK-DESIGN §5). Per-bridge-feature work; not part of
  the namespace track.

## Wave 1 Phase B — completed

- ENTER handler (daemon: enter.c/h) — recvmsg cmsg, F_GET_SEALS
  validation, fork → setns → drop privs → execve via ellul-seccomp-exec.
- INJECT_ENV handler — daemon-controlled namespace inode, sealed env
  memfd, no path strings on the trust boundary.
- EXIT_NOTIFY (server-initiated frame on same connection).
- `ellul-fd-pass` helper binary (300+ lines C) + provisioning install
  step. Builds memfds, applies seals, sendmsg() with ancillary FDs.
- Bridge `EllulNamespacedClient.enter()` returns a ChildProcess-shaped
  `NsdChildProcess` so existing spawn callers can drop in.
- Sudoers tightening: wildcard pattern replaced by per-subcommand
  patterns in firewall-relaxed/partial/full-ironclad scripts.
- Agent-side seccomp allowlist mode (additive, env-var-gated). Default
  remains denylist; per-binary opt-in.

## Wave 1 Phase A — completed

- Manifest signing pipeline (`apps/api/scripts/sign-manifests.ts`).
- C unit tests for the cgroup matcher and path-substitution / option
  helpers (run via `cc -o /tmp/test-... && /tmp/test-...`).
- SETUP / TEARDOWN / CREATE_PROJECT / DROP_PROJECT daemon handlers; bridge
  feature-flag cutover with automatic fallback to the legacy sudo path.
