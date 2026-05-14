# Post-Quantum Cloud Infrastructure Architecture

**Document**: `ELLUL-PQC-002`
**Companion to**: `ELLUL-PQC-001` (PQC Engineering Specification)
**Status**: Implementation-Ready Draft
**Date**: 2026-03-31
**Scope**: Cloud service configuration, CI/CD pipelines, artifact distribution, observability, and rollout operations for the PQC migration defined in `PQC-ENGINEERING-SPEC.md`

This document covers **infrastructure only** — cryptographic primitives, payload formats, and application-level code changes are defined in the Engineering Spec and not repeated here.

---

## Table of Contents

1. [Deployment Topology](#1-deployment-topology)
2. [Rust Binary Build Pipeline](#2-rust-binary-build-pipeline)
3. [Artifact Trust Chain](#3-artifact-trust-chain)
4. [Google Cloud Run (API)](#4-google-cloud-run-api)
5. [Cloudflare Workers (Console & Gateway)](#5-cloudflare-workers-console--gateway)
6. [VPS Provisioning Pipeline](#6-vps-provisioning-pipeline)
7. [Database Migrations (Neon PostgreSQL)](#7-database-migrations-neon-postgresql)
8. [Cloudflare R2 Storage](#8-cloudflare-r2-storage)
9. [GCP Secret Manager](#9-gcp-secret-manager)
10. [CI/CD Pipeline Changes](#10-cicd-pipeline-changes)
11. [Observability & Monitoring](#11-observability--monitoring)
12. [Binary Rollback Policy](#12-binary-rollback-policy)
13. [Canary Rollout Strategy](#13-canary-rollout-strategy)
14. [Benchmark Gate](#14-benchmark-gate)
15. [Dependency Pinning Policy](#15-dependency-pinning-policy)
16. [Phase-by-Phase Infrastructure Checklist](#16-phase-by-phase-infrastructure-checklist)
17. [Cost Impact](#17-cost-impact)

---

## 1. Deployment Topology

PQC components flow across five independent deployment lanes:

```
CONTAINER LANE (API):
  GitHub (source)
    → Cloud Build (Docker)
    → GCP Artifact Registry (europe-west1)
    → Cloud Run (ellul-ai service, 768Mi, max 10 instances)
  @noble/post-quantum included via pnpm install (pure JS, no native addons)

BINARY LANE (PQC Rust Artifacts):
  GitHub Actions (Rust cross-compile, x86_64 + aarch64)
    → minisign-signed release manifest
    → R2 private bucket (pqc-binaries/{version}/{arch}/)
    → VPS provisioning via presigned URL
    → /usr/local/bin/ellul-crypto

FRONTEND LANE (Console):
  GitHub (source)
    → Next.js build (OpenNextJS adapter)
    → Cloudflare Workers + Pages
  @noble/post-quantum bundled at build time (~80 KB gzipped)

GATEWAY LANE:
  Cloudflare Worker
    → No PQC changes (opaque server_commands.payload relay)
    → KV namespace routing unaffected

VPS LANE (Shield Daemon):
  cloud-init stager pattern
    → pnpm install @noble/post-quantum (provisioning time)
    → ellul-crypto binary (downloaded from R2)
    → /etc/ellul/node.key (hybrid JSON, vault-preserved)
```

**Key principle**: Each lane is independently deployable. Phase 0 deploys the Container and Frontend lanes first (dual-version support). The Binary lane ships in Phase 0 but is consumed only in Phase 1+ (new VPS provisioning). The VPS lane is consumed by each individual server during provisioning or rotation.

---

## 2. Rust Binary Build Pipeline

### 2.1 Problem

The PQC Engineering Spec (Section 8.2) requires four operations packaged as statically-linked Rust binaries: `keygen`, `decrypt`, `sign`, `verify`. These are consolidated into a single `ellul-crypto` binary with subcommands. No build or distribution infrastructure exists for this.

### 2.2 Build Architecture

**Trigger**: GitHub Actions workflow on tag push (`pqc-v*`) or manual dispatch.

**Matrix**: Two targets:
- `x86_64-unknown-linux-musl` (Hetzner Intel, DigitalOcean, OVHcloud)
- `aarch64-unknown-linux-musl` (Hetzner ARM — primary paid tier)

**Toolchain**: `cross` (cross-compilation from x86 GitHub runners to ARM targets).

**Post-compile gates**:
1. NIST Known Answer Tests (KAT) for FIPS 203/204/205
2. Cross-implementation interop test (Rust `pqcrypto` ↔ JS `@noble/post-quantum`)
3. Binary strip + SHA-256 checksum
4. Release manifest generation + minisign signing

**Output**: Per-version directory in R2:
```
pqc-binaries/pqc-v0.1.0/
  manifest.json
  manifest.json.minisig
  x86_64-unknown-linux-musl/ellul-crypto
  aarch64-unknown-linux-musl/ellul-crypto
```

### 2.3 Binary Specification

- Language: Rust
- Linking: Static (musl libc, zero runtime dependencies)
- Memory safety: `mlock()` all key material, `zeroize` on drop
- Size: ~3 MB stripped (single binary, all subcommands)
- Permissions: `root:root 755` at `/usr/local/bin/ellul-crypto`

---

## 3. Artifact Trust Chain

### 3.1 Release-Signing Keypair

A **dedicated release-signing keypair** is used exclusively for binary artifact signing. This is an artifact trust root, not a runtime credential.

| Property | Value |
|----------|-------|
| Tool | `minisign` (preferred over GPG — simpler operationally, smaller verification surface) |
| Private key location | GitHub Actions secret (`RELEASE_SIGNING_SECRET_KEY`) — exists ONLY in CI signing job |
| Public key location | Baked into VPS provisioning image at `/etc/ellul/release-verify.pub` |
| Public key fingerprint | Hardcoded in `crypto-keys.sh` — verified before first use |
| Trust model | No first-boot TOFU. Public key + fingerprint are embedded in the provisioning artifact. |

The release-signing private key is **NOT** stored in GCP Secret Manager. It is a CI-only credential with no runtime access path.

### 3.2 Release Manifest

Each release produces a `manifest.json` with provenance fields:

```json
{
  "version": "pqc-v0.1.0",
  "binaries": {
    "x86_64-unknown-linux-musl": {
      "name": "ellul-crypto",
      "sha256": "a1b2c3d4...",
      "size_bytes": 3145728
    },
    "aarch64-unknown-linux-musl": {
      "name": "ellul-crypto",
      "sha256": "e5f6a7b8...",
      "size_bytes": 3211264
    }
  },
  "build_timestamp": "2026-03-31T12:00:00Z",
  "git_commit": "abc123def456",
  "signer_key_id": "RWSxyz...",
  "build_workflow_run_id": "12345678",
  "target_triples": [
    "x86_64-unknown-linux-musl",
    "aarch64-unknown-linux-musl"
  ]
}
```

The manifest is signed with minisign: `manifest.json.minisig`.

### 3.3 VPS Verification Flow

During cloud-init provisioning, `crypto-keys.sh` performs:

```bash
ARCH=$(uname -m)
PQC_VERSION="$PQC_BINARY_VERSION"  # Pinned by API env var, not floating

# 1. Download signed manifest (presigned URL from API, TTL ≤ 5 min)
curl -fsSL "$MANIFEST_URL" -o /tmp/pqc-manifest.json
curl -fsSL "$MANIFEST_SIG_URL" -o /tmp/pqc-manifest.json.minisig

# 2. Verify minisign signature against baked-in public key
minisign -Vm /tmp/pqc-manifest.json -p /etc/ellul/release-verify.pub
if [ $? -ne 0 ]; then
  echo "FATAL: Release manifest signature verification FAILED" >&2
  exit 1
fi

# 3. Extract expected checksum for this architecture
EXPECTED_SHA=$(jq -r ".binaries.\"$ARCH\".sha256" /tmp/pqc-manifest.json)

# 4. Download binary (presigned URL from API, TTL ≤ 5 min)
curl -fsSL "$BINARY_URL" -o /usr/local/bin/ellul-crypto
chmod 755 /usr/local/bin/ellul-crypto

# 5. Verify SHA-256 against signed manifest
echo "$EXPECTED_SHA  /usr/local/bin/ellul-crypto" | sha256sum -c -
if [ $? -ne 0 ]; then
  echo "FATAL: Binary SHA-256 checksum FAILED" >&2
  rm -f /usr/local/bin/ellul-crypto
  exit 1
fi
```

**Trust chain**: CI private key → signed manifest → VPS public key verification → checksum → binary install. A compromised R2 bucket cannot serve a malicious binary without also compromising the CI signing key.

---

## 4. Google Cloud Run (API)

### 4.1 Docker Image Changes

`@noble/post-quantum` and `@noble/curves` are added to `apps/api/package.json` (exact version pinned). They are pure JavaScript — no native addon compilation, no multi-arch Docker concerns. Image size increase: ~2 MB uncompressed.

No `Dockerfile` structural changes required. The existing multi-stage build (`builder` → `runner`) and `pnpm install --frozen-lockfile --prod` handles the new dependency.

### 4.2 Cloud Run Configuration

**`cloudbuild.yaml` changes**:

| Parameter | Current | PQC | Rationale |
|-----------|---------|-----|-----------|
| `--memory` | `512Mi` | `768Mi` | Conservative headroom for concurrent PQC operations, JS heap growth, and existing request load. Final sizing confirmed via benchmark gate (Section 14). |
| `--set-env-vars` | (existing) | Add `PQC_BINARY_VERSION=pqc-v0.1.0` | Pinned binary version for provisioning scripts |
| `--update-secrets` | (existing) | No new secrets | PQC keys are VPS-local, not API secrets |

### 4.3 Secret Manager

- `ENTITLEMENT_PRIVATE_KEY` (ECDSA P-256) → rotated to ML-DSA-65 in Phase 3
- `ENTITLEMENT_PUBLIC_KEY` → corresponding public key
- No new secrets for core PQC migration

---

## 5. Cloudflare Workers (Console & Gateway)

### 5.1 Console (`apps/console`)

- `@noble/post-quantum` bundled by Next.js at build time → included in Cloudflare Worker bundle
- Bundle size increase: ~80 KB gzipped (acceptable for authenticated admin console)
- ML-KEM client library (`pqc-mlkem.js`) is served from the VPS Shield daemon, NOT from Workers
- **No `wrangler.jsonc` changes required**

### 5.2 Gateway (`packages/gateway`)

**No changes.** The gateway relays opaque `server_commands.payload` JSON. The `_pqc: 2` marker and larger ML-KEM ciphertext (~2.3 KB vs ~0.8 KB) are transparent to the Worker. KV namespace routing is unaffected.

---

## 6. VPS Provisioning Pipeline

### 6.1 Script Changes

| Script | Change |
|--------|--------|
| `apps/api/src/provisioning/shell/packages/crypto-keys.sh` | Download `ellul-crypto` binary via presigned URL, verify manifest + checksum, generate hybrid X25519+ML-KEM-1024 keypair |
| `apps/api/src/provisioning/shell/security.ts` | No change |
| `apps/api/src/provisioning/shell/services.ts` | Ensure `@noble/post-quantum`, `ed25519-hd-key`, `bip39` in Shield's `package.json` |
| `apps/api/src/provisioning/shell/caddy.ts` | No change |
| `apps/api/src/provisioning/shell/volume.ts` | No change (vault preserves keys by path, format-agnostic) |
| `apps/api/src/provisioning/shell/boot-config.ts` | No change (wake guard `fs.existsSync('/etc/ellul/node.key')` works for both PEM and JSON) |

### 6.2 Cloud-Init Payload

- No structural change to the stager pattern (`cloud-init.ts` → `payload.ts` → modular scripts)
- PQC binary download adds ~3 seconds to provisioning (one-time R2 fetch via presigned URL)
- New env var passed to VPS: `PQC_BINARY_VERSION` (from API's `PQC_BINARY_VERSION` env var)
- Presigned URLs for binary + manifest generated by API at provisioning time, scoped to exact object path and pinned version, TTL ≤ 5 minutes

### 6.3 Multi-Provider Considerations

| Provider | Architecture | Binary Target | Notes |
|----------|-------------|---------------|-------|
| Hetzner (paid) | ARM64 preferred | `aarch64-unknown-linux-musl` | Primary compute target |
| Hetzner (paid fallback) | x86_64 | `x86_64-unknown-linux-musl` | Intel fallback servers |
| DigitalOcean (free) | x86_64 | `x86_64-unknown-linux-musl` | Free tier only |
| OVHcloud (fallback) | x86_64 | `x86_64-unknown-linux-musl` | Middle fallback |
| BYOS (user-managed) | Either | Auto-detected via `uname -m` | User hardware varies |

The provisioning script auto-detects architecture via `uname -m` and downloads the correct binary. No provider-specific logic.

---

## 7. Database Migrations (Neon PostgreSQL)

### 7.1 Migration Policy

Migrations are **generated, committed to repo, SQL-reviewed, and applied via `pnpm drizzle-kit migrate`** (NOT `push`). Cryptographic rollout state tracked in DB columns requires version-controlled, reviewed migrations.

### 7.2 Migration: `0042_pqc_schema_adjustments.sql`

```sql
-- PQC key version tracking for dispatch
ALTER TABLE servers ADD COLUMN IF NOT EXISTS public_key_version integer DEFAULT 1;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS migration_signing_key_version integer DEFAULT 1;

-- Partial index for fleet rotation monitoring
CREATE INDEX IF NOT EXISTS idx_servers_pqc_upgraded
  ON servers (id) WHERE public_key_version = 2;
```

### 7.3 Migration: `0043_quantum_blind_wallet.sql`

```sql
-- HD wallet support
ALTER TABLE server_wallets ADD COLUMN IF NOT EXISTS wallet_version integer DEFAULT 1;
ALTER TABLE server_wallets ADD COLUMN IF NOT EXISTS derivation_index integer;
ALTER TABLE server_wallets ADD COLUMN IF NOT EXISTS hd_wallet_fingerprint text;
ALTER TABLE server_wallets ADD COLUMN IF NOT EXISTS updated_at timestamp DEFAULT now();

-- Quantum-blind transaction tracking
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS from_address text;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS change_address text;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS derivation_index integer;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS sweep_amount_lamports text;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS quantum_blind_check text;
```

**Deployment**: Zero-downtime. All columns are additive with defaults. No existing data is modified. Neon supports standard PostgreSQL DDL.

---

## 8. Cloudflare R2 Storage

### 8.1 Binary Artifacts

**Path**: `pqc-binaries/` in existing provision cache bucket.

| Property | Value |
|----------|-------|
| Access | **Private** — presigned URLs only (TTL ≤ 5 min, scoped to exact object path + version) |
| Fallback | Bootstrap-token authenticated fetch (emergency only) |
| Versioning | Per git tag (`pqc-v0.1.0`, `pqc-v0.2.0`, ...) |
| Retention | Last 5 versions retained; older versions garbage-collected |
| Integrity | minisign-signed release manifest per version |

### 8.2 Migration Archives

Existing `ellul-migrations` bucket:
- Block migration manifests gain larger dual signatures (3.3 KB ML-DSA-65 + 64 B Ed25519)
- R2 object size limit is 5 GB — no issue
- Presigned URL TTL unchanged (5 min)

---

## 9. GCP Secret Manager

### 9.1 Phase 3: Entitlement Key Rotation

| Secret | Current | PQC | Phase |
|--------|---------|-----|-------|
| `ENTITLEMENT_PRIVATE_KEY` | ECDSA P-256 | ML-DSA-65 (or hybrid) | Phase 3 |
| `ENTITLEMENT_PUBLIC_KEY` | ECDSA P-256 | ML-DSA-65 (or hybrid) | Phase 3 |

Create new versions in Secret Manager. Cloud Run references `:latest` — no deploy config change needed.

### 9.2 No New Secrets

Core PQC migration requires no new secrets in Secret Manager. VPS keypairs are generated and stored locally on each VPS. The release-signing key lives in GitHub Actions secrets, not GCP.

---

## 10. CI/CD Pipeline Changes

### 10.1 New: `rust-pqc-build.yml`

```yaml
name: Build PQC Rust Binaries
on:
  push:
    tags: ['pqc-v*']
  workflow_dispatch:

jobs:
  build:
    strategy:
      matrix:
        target: [x86_64-unknown-linux-musl, aarch64-unknown-linux-musl]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions-rust-lang/setup-rust-toolchain@v1
      - name: Install cross + minisign
        run: |
          cargo install cross
          curl -fsSL https://github.com/jedisct1/minisign/releases/latest/download/minisign-linux-x86_64 \
            -o /usr/local/bin/minisign && chmod +x /usr/local/bin/minisign
      - name: Build
        run: cross build --release --target ${{ matrix.target }}
      - name: Run KAT + interop tests
        run: cross test --release --target ${{ matrix.target }}
      - name: Strip + checksum
        run: |
          strip target/${{ matrix.target }}/release/ellul-crypto
          sha256sum target/${{ matrix.target }}/release/ellul-crypto > sha256-${{ matrix.target }}.txt
      - name: Upload binary artifact
        uses: actions/upload-artifact@v4
        with:
          name: ellul-crypto-${{ matrix.target }}
          path: |
            target/${{ matrix.target }}/release/ellul-crypto
            sha256-${{ matrix.target }}.txt

  publish:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
      - name: Generate release manifest
        run: |
          jq -n \
            --arg version "${{ github.ref_name }}" \
            --arg commit "${{ github.sha }}" \
            --arg run_id "${{ github.run_id }}" \
            --arg signer_key "$(cat $RELEASE_SIGNING_PUBLIC_KEY)" \
            --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --arg sha_x86 "$(cut -d' ' -f1 ellul-crypto-x86_64-unknown-linux-musl/sha256-*.txt)" \
            --arg sha_arm "$(cut -d' ' -f1 ellul-crypto-aarch64-unknown-linux-musl/sha256-*.txt)" \
            '{
              version: $version,
              binaries: {
                "x86_64-unknown-linux-musl": { name: "ellul-crypto", sha256: $sha_x86 },
                "aarch64-unknown-linux-musl": { name: "ellul-crypto", sha256: $sha_arm }
              },
              build_timestamp: $ts,
              git_commit: $commit,
              signer_key_id: $signer_key,
              build_workflow_run_id: $run_id,
              target_triples: ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"]
            }' > manifest.json
      - name: Sign manifest with minisign
        run: |
          echo "${{ secrets.RELEASE_SIGNING_SECRET_KEY }}" > /tmp/release.key
          minisign -Sm manifest.json -s /tmp/release.key
          rm /tmp/release.key
      - name: Upload to R2 (private bucket)
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
        run: |
          VERSION="${{ github.ref_name }}"
          for target in x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
            aws s3 cp "ellul-crypto-${target}/target/${target}/release/ellul-crypto" \
              "s3://ellul-cache/pqc-binaries/${VERSION}/${target}/ellul-crypto" \
              --endpoint-url "${{ vars.R2_ENDPOINT }}"
          done
          aws s3 cp manifest.json \
            "s3://ellul-cache/pqc-binaries/${VERSION}/manifest.json" \
            --endpoint-url "${{ vars.R2_ENDPOINT }}"
          aws s3 cp manifest.json.minisig \
            "s3://ellul-cache/pqc-binaries/${VERSION}/manifest.json.minisig" \
            --endpoint-url "${{ vars.R2_ENDPOINT }}"
```

### 10.2 Existing: `cloudbuild.yaml`

- No structural changes. `@noble/post-quantum` is a standard npm dependency included via `pnpm install`.
- Memory parameter updated to `768Mi` (Section 4.2).
- New `--set-env-vars` entry: `PQC_BINARY_VERSION=pqc-v0.1.0`.

### 10.3 Existing: `sync-to-public.yml`

No changes. PQC code lives in private packages (`apps/api`, `packages/vps`).

---

## 11. Observability & Monitoring

### 11.1 Axiom Metrics

| Metric | Description | Source |
|--------|-------------|--------|
| `pqc.key_rotation.success` | Successful key rotation count | API heartbeat handler |
| `pqc.key_rotation.failure` | Failed key rotation count | API heartbeat handler |
| `pqc.fleet_coverage` | Percentage of fleet on v2 keys | API cron job |
| `pqc.split_brain_detected` | API key version ≠ VPS reported version | API heartbeat handler |
| `pqc.envelope_version` | v1 vs v2 envelope usage distribution | API `enqueueAndWait()` |
| `pqc.hmac_pop_bind` | ML-KEM handshake success/failure | VPS Shield |
| `pqc.intent_signature_verify` | ML-DSA/SLH-DSA verification result | VPS Shield |
| `pqc.binary_verify` | Binary manifest verification pass/fail | VPS provisioning |

### 11.2 Alerts (Resend + ALERT_EMAIL)

| Alert | Condition | Severity |
|-------|-----------|----------|
| Split-brain detected | `pqc.split_brain_detected` > 0 for 3 consecutive heartbeats | Critical |
| Phase 2 stall | `pqc.fleet_coverage` < 95% after Week 8 | Warning |
| Binary download failure | `pqc.binary_verify` = fail during provisioning | Critical |
| Binary signature failure | minisign verification fails | Critical (supply chain) |
| Rotation blocked | Server marked `pqc_rotation_blocked` for >24h | Warning |

---

## 12. Binary Rollback Policy

### 12.1 Version Pinning

- `PQC_BINARY_VERSION` is **pinned per API deploy** (Cloud Run env var). Not floating.
- R2 retains last **5 versions**. Older versions garbage-collected.
- Provisioning only installs the explicitly pinned version. A VPS cannot request a different version than the API specifies.

### 12.2 Two Rollback Levels

**Soft rollback** (default — operational issues):
1. Revert `PQC_BINARY_VERSION` in Cloud Run env → redeploy API
2. Halt `rotate-to-pqc` command issuance
3. New provisions use previous binary version
4. Already-rotated hybrid servers continue running if healthy (hybrid keys work)
5. Existing VPSes unaffected (binaries already installed on disk)

**Hard rollback** (cryptographic primitive or implementation is fundamentally broken):
1. Issue `rotate-to-classical` command (Engineering Spec Section 7.7) to affected servers
2. Regenerates RSA-4096 / Ed25519 keys, bypassing PQC binary entirely
3. Only triggered if the cryptographic primitive itself is compromised, NOT for operational issues

---

## 13. Canary Rollout Strategy

Phase 2 (fleet key rotation) follows a staged canary across all cloud providers:

| Stage | Scope | Duration | Success Criteria |
|-------|-------|----------|-----------------|
| 0 | 1 internal test server | 24h | Key rotation succeeds, heartbeat reports v2, commands encrypt/decrypt round-trip |
| 1 | 5 canary servers (1 Hetzner ARM, 1 Hetzner x86, 1 DigitalOcean, 1 OVHcloud, 1 BYOS if available) | 48h | All providers succeed, zero split-brain alerts, zero command timeouts |
| 2 | 1% of fleet | 72h | `pqc.split_brain_detected` = 0, error rate unchanged from baseline |
| 3 | 10% of fleet | 1 week | Fleet-wide metrics stable, no regression in command latency |
| 4 | Remaining fleet | Paced at 50 servers/day | Complete by Week 8 |

### 13.1 Rollback Triggers (Automatic)

- `pqc.split_brain_detected` > 0 for 3 consecutive heartbeats → **halt rotation, alert**
- Command timeout rate increases >5% vs pre-rotation baseline → **halt rotation, alert**
- Binary checksum/signature mismatch during provisioning → **halt rotation, alert**

### 13.2 Split-Brain Remediation

When `pqc.split_brain_detected` fires:

1. Stop new `rotate-to-pqc` commands immediately
2. Mark affected server as `pqc_rotation_blocked` in database
3. Force heartbeat reconciliation — re-fetch authoritative key version from VPS
4. If API key version matches VPS report after forced heartbeat → clear block (false alarm)
5. If mismatch persists for 5+ heartbeats → escalate to manual intervention
6. Only retry rotation after root cause identified and fixed

---

## 14. Benchmark Gate

Before Phase 1 (new servers provisioned with PQC keys), the following benchmarks **MUST** pass:

| Metric | Target | How to Measure |
|--------|--------|----------------|
| ML-KEM-1024 encapsulate (API, Node.js) | p95 < 5 ms | Load test `encryptForVpsHybrid()` at 80 concurrent requests |
| ML-KEM-1024 decapsulate (VPS, Node.js) | p95 < 5 ms | Load test `decryptHybridEnvelope()` at 10 concurrent |
| ML-KEM-1024 decapsulate (VPS, Rust binary) | p95 < 2 ms | Benchmark `ellul-crypto decrypt` with 1000 iterations |
| HMAC-SHA256 PoP sign (browser, Web Crypto) | p95 < 1 ms | Browser DevTools performance profiling |
| Cloud Run memory under PQC load | < 700 Mi (of 768) | Load test with Axiom memory dashboard |
| ML-KEM bind handshake (end-to-end) | p95 < 200 ms | Measure `/bind/init` + `/bind/complete` round-trip |
| ML-DSA-44 intent sign (browser extension) | p95 < 5 ms | Extension performance profiling |

If any metric fails, increase Cloud Run memory or optimize the implementation before proceeding to Phase 1.

---

## 15. Dependency Pinning Policy

`@noble/post-quantum` is a critical security dependency. Strict pinning rules apply:

- **Exact version pins** in all `package.json` files:
  ```json
  "@noble/post-quantum": "0.2.0"
  ```
  NOT `">=0.2.0"`, `"^0.2.0"`, or `"~0.2.0"`.

- **Upgrade gating**: Every version bump goes through:
  1. NIST KAT test suite (all FIPS 203/204/205 vectors)
  2. Cross-implementation interop tests (Node.js `@noble` ↔ Rust `pqcrypto`)
  3. Browser bundle size check (regression if >100 KB gzipped)
  4. PR review by security-aware engineer

- **Lockfile**: `pnpm-lock.yaml` committed and frozen (`--frozen-lockfile` in all CI builds).

- Same policy applies to `ed25519-hd-key` and `bip39`.

---

## 16. Phase-by-Phase Infrastructure Checklist

| Phase | Infrastructure Action | Service | Owner |
|-------|----------------------|---------|-------|
| **0** | Create `rust-pqc-build.yml` GitHub Actions workflow | GitHub Actions | DevOps |
| **0** | Compile `ellul-crypto` for x86_64 + aarch64, sign manifest | GitHub Actions | DevOps |
| **0** | Upload signed binaries to R2 (private) | Cloudflare R2 | DevOps |
| **0** | Bake minisign public key into provisioning image | VPS provisioning | DevOps |
| **0** | Add `@noble/post-quantum` (exact pin) to API + Console + VPS `package.json` | npm | Dev |
| **0** | Generate + review Drizzle migrations 0042 + 0043, commit to repo | Neon PostgreSQL | Dev |
| **0** | Apply migrations via `drizzle-kit migrate` | Neon PostgreSQL | Dev |
| **0** | Deploy API with dual-version encryption dispatch + `PQC_BINARY_VERSION` env | Cloud Run | CI/CD |
| **0** | Deploy Console with `@noble/post-quantum` in bundle | Cloudflare Workers | CI/CD |
| **0** | Run benchmark gate (Section 14) | Load testing | Dev |
| **1** | Update `crypto-keys.sh` to download + verify binary, generate hybrid keys | Provisioning | Dev |
| **1** | New servers auto-provision with v2 keys | Hetzner/DO/OVH | Automatic |
| **2** | Stage 0: Rotate 1 internal test server | Cloud Scheduler | Dev |
| **2** | Stage 1-4: Canary rollout per Section 13 | Cloud Scheduler | DevOps |
| **2** | Monitor fleet rotation via Axiom dashboards | Axiom | DevOps |
| **2.5** | HD wallet migration for wallet-enabled servers | VPS Shield | Automatic |
| **3** | Console shows "Quantum-Vulnerable" badge for v1 servers | Cloudflare Workers | Dev |
| **3** | Rotate `ENTITLEMENT_PRIVATE_KEY` in Secret Manager | GCP Secret Manager | DevOps |
| **4** | Remove v1 encryption paths from API | Cloud Run | Dev |
| **4** | Remove v1 decryption paths from VPS (after 24h drain) | Provisioning | Dev |

---

## 17. Cost Impact

| Component | Current | PQC Delta | Notes |
|-----------|---------|-----------|-------|
| Cloud Run memory | 512Mi | +256Mi (768Mi) | Negligible at current scale; verify against billing before rollout |
| R2 storage (binaries) | — | ~10 MB total | Expected within current free/low-cost usage |
| GitHub Actions (Rust build) | — | ~5 min/build × 2 arch | Expected within current free/low-cost usage |
| Neon PostgreSQL | Unchanged | +3 columns, no size impact | No cost change |
| Cloudflare Workers | Unchanged | +80 KB bundle | Expected within current usage tier |
| VPS provisioning time | ~3 min | +3 sec (binary download) | Negligible |
