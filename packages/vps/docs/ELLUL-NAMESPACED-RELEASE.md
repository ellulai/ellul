# ellul-namespaced — release pipeline

How the privileged namespace daemon ships to the fleet. The build,
verification, distribution, and rollout follow the same agent-manifest
contract every other VPS-side component uses (ellul-env, core-runtime,
ellul-crypto). Nothing daemon-specific lives outside that contract.

## Why a manifest-component, not on-VPS compile

Up to and including 2026-04-28 the daemon was compiled on each VPS at
provisioning time: the cloud-init payload wrote ~3,000 lines of C
source under `/opt/ellul/ellul-namespaced/`, then `apt-get install`-ed
build deps (libsodium-dev, libtinycbor-dev, libsystemd-dev, pkg-config),
then `gcc`'d the binary. Three problems:

1. **Distro coupling.** Ubuntu 24.04 (Noble) shipped without
   `libtinycbor-dev`. Every fresh provision fail-closed at the
   apt-install loop. See `docs/RUNBOOKS/` for the 2026-04-28 incident.
2. **Toolchain on prod.** gcc + dev headers + source tree on every VPS
   is attack surface we don't need.
3. **Reproducibility.** Per-host gcc nondeterminism, snapshot rebakes
   needed for any compile-flag change.

The daemon is now built once, off-prod, in CI; signed (via the
manifest-level KMS signature, same key core-runtime rides); shipped
through R2 with sha-pinned download; symlink-flipped at install. apt
deps and source-tree delivery are gone.

## Build

`scripts/ellul-namespaced/`:

| File | Role |
|---|---|
| `fetch-tinycbor.sh` | Vendors Intel tinycbor v0.6.0 with sha256 pin. Idempotent. Failure mode: sha mismatch → exit 1. This is the supply-chain trust boundary for the CBOR codec. |
| `Makefile` | gcc invocation for one architecture. CFLAGS/LDFLAGS exactly mirror the historical on-VPS hardening flags. tinycbor is statically linked from the vendored tree; libsodium/libseccomp/libsystemd ride dynamically against Noble runtime libs. |
| `build-multiarch.sh` | Wraps `make` for amd64 and (when toolchain present) arm64. Produces `ellul-namespaced-<version>.tar.gz` containing `amd64/` + `arm64/` subdirs. |

Tarball layout:

```
ellul-namespaced-1.2.3.tar.gz
├── amd64/
│   ├── ellul-namespaced
│   └── ellul-fd-pass
└── arm64/
    ├── ellul-namespaced
    └── ellul-fd-pass
```

A single sha256 covers both arches. The on-VPS install path picks the
matching arch via `dpkg --print-architecture`.

### Determinism

- tinycbor pinned by upstream-tarball sha256 in `fetch-tinycbor.sh`.
  Bumping requires editing both `TINYCBOR_VERSION` and
  `TINYCBOR_TARBALL_SHA256` in lockstep — never silently.
- `tar --sort=name --mtime='1970-01-01' --owner=0 --group=0
  --numeric-owner` + `gzip -n`. Bit-identical rebuilds from clean source.
- gcc version pinned by the Ubuntu 24.04 runner image. Drift is
  observable via `dpkg -l gcc` in the workflow log.

## CI

`.github/workflows/ellul-namespaced-build.yml` — the standalone build
workflow. Runs on:

- `workflow_dispatch` — explicit release builds with a `version` input
- `workflow_call` — invoked by `agent-bundles.yml` so the daemon is
  built in the same publish run as core-runtime
- `pull_request` — paths-filtered to daemon source / build infra; no
  upload to releases on PRs (build-only sanity check)

`.github/workflows/agent-bundles.yml` inlines the daemon build before
invoking `scripts/build-agent-bundles.mjs`. The build script reads
`$ELLUL_NAMESPACED_PATH` (or autodiscovers `artifacts/ellul-namespaced-*.tar.gz`)
and includes the tarball as a manifest component.

## Distribution

The tarball is uploaded to R2 via the existing `presign-upload`
flow in `scripts/publish-agent-bundles.mjs` — no new bucket, no new
credentials. The path on R2 is
`agent-bundles/ellul-namespaced/<version>.tar.gz`.

The manifest row created by `POST /api/admin/agent-manifests` carries
the component entry with `format: "tarball"`, `restartUnit:
"ellul-namespaced.service"`, `restartOrder: 2`, and the tarball's
sha256 pinned. The manifest is signed by the platform KMS key; the
fleet-side enforcer verifies that signature before applying.

## VPS-side install (the part that replaced apt+gcc)

When the enforcer applies a manifest with an `ellul-namespaced` entry
(`packages/vps/src/services/daemons/enforcer/lib/agent-sync.sh`):

1. Tarball downloaded from
   `/api/servers/{id}/agent-packages/ellul-namespaced/<version>` via
   the signed-API-request path.
2. SHA-256 verified against the manifest's pin **before** any bytes
   land in `/opt/ellul/releases/`. Mismatch → fail-closed,
   never-staged.
3. Tarball extracted into
   `/opt/ellul/releases/ellul-namespaced/<version>/`. Entries are
   `amd64/...`, `arm64/...`.
4. `current` symlink atomically swung to the new version dir.
5. `ensure_bin_symlink "ellul-namespaced"` picks the matching arch via
   `dpkg --print-architecture`, runs the binary's `--version`
   self-test, and only then flips
   `/usr/local/bin/ellul-namespaced` and `/usr/local/bin/ellul-fd-pass`
   to point at the new release dir. A failed self-test leaves the old
   symlink in place — bad release ≠ tear down running daemon.
6. `restartUnit: "ellul-namespaced.service"` triggers a `systemctl
   restart`. The unit's `ConditionPathExists` gate keeps it from
   restart-looping if the feature flag is absent.

The provisioning shell at
`apps/api/src/provisioning/shell/packages/ellul-namespaced.sh` does
**not** download or compile. It writes the systemd unit, seeds
`byok-master.key` and the `nsd-enabled` feature flag, and — if a
binary is already on disk (e.g. carried forward from snapshot) —
flips the symlinks. Otherwise it leaves the unit installed-but-quiet
for the enforcer's first manifest sync to populate.

## Rollback

Same as any other manifest component:

```bash
curl -X POST "$API_URL/api/admin/agent-manifests/<previous-id>/rollback" \
  -H "Authorization: Bearer $CI_DEPLOY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "..."}'
```

The fleet's enforcer picks up the rollback on the next heartbeat,
re-stages the prior tarball (already cached in
`/opt/ellul/releases/ellul-namespaced/<old-version>/`), and flips the
symlink. No rebuilds, no R2 round-trip.

## Threat model

| Threat | Mitigation |
|---|---|
| Compromised CI publishing a malicious binary | Manifest-level KMS signature; CI doesn't hold the signing key. Unsigned or mis-signed manifests are rejected fleet-side. |
| MitM on the binary download | Manifest carries the sha256; agent-sync verifies before staging. R2 + TLS is just transport. |
| R2 outage | Manifest API can serve from a mirror origin (GCS) with the same sha — caller doesn't notice. (Phase: future, not implemented yet.) |
| Compromised tinycbor upstream | Fetch script pins sha256. A poisoned release.gz fails verification; build aborts. Bumping requires explicit, reviewed PR touching both version + sha. |
| Local rebuild on VPS | gcc no longer present on prod (post-snapshot-rebuild). Even if it were, the manifest pin + `ensure_bin_symlink`'s self-test path means a hand-rolled binary isn't trusted by the fleet. |
| Stale binary on a snapshot | Enforcer re-stages on every manifest version bump; sha mismatch with cached version forces re-download. |

## Bumping the daemon

1. Edit C sources under `packages/vps/src/shell/helpers/ellul-namespaced/`.
2. (If needed) bump `NSD_PROTOCOL_VERSION` in headers.
3. Bump `packages/vps/core-runtime-bundle/package.json` version (the
   manifest version source of truth — daemon rides the same number).
4. PR. CI's `ellul-namespaced-build.yml` job runs on the path filter,
   verifies the build still passes.
5. After merge, run `scripts/release.mjs publish` (or trigger
   `agent-bundles.yml` from the Actions UI). The build inlines the
   daemon, the publish creates the manifest row.
6. Promote canary → stable per the standard release.mjs flow.

## Bumping vendored tinycbor

1. Edit `scripts/ellul-namespaced/fetch-tinycbor.sh`: bump
   `TINYCBOR_VERSION` and recompute `TINYCBOR_TARBALL_SHA256`.
2. Run `scripts/ellul-namespaced/fetch-tinycbor.sh
   /tmp/tinycbor-test` locally to confirm the new sha resolves.
3. Audit the upstream changelog. tinycbor is small but it's parsing
   untrusted CBOR — review the diff.
4. PR. CI rebuilds from the new sha; if upstream is compromised,
   sha verification fails and the PR can't merge a green build.
