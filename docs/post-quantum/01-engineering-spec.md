# Post-Quantum Engineering Specification

**Document**: `ELLUL-PQC-001`
**Status**: Implementation-Ready Draft
**Date**: 2026-03-31
**Scope**: Asymmetric transit and identity layers — E2EE command channel, Class A migration manifest signatures, AI gate authorization tokens
**Standards**: NIST FIPS 203 (ML-KEM), FIPS 204 (ML-DSA), FIPS 205 (SLH-DSA)

---

## Table of Contents

1. [Primitive Selection Matrix](#1-primitive-selection-matrix)
2. [Hybrid KEM: Command Channel (SNDL Fix)](#2-hybrid-kem-command-channel-sndl-fix)
3. [ML-DSA: Migration Manifest Signatures](#3-ml-dsa-migration-manifest-signatures)
4. [Quantum-Resilient Authentication & Authorization](#4-quantum-resilient-authentication--authorization)
5. [Quantum-Blind Transaction Enforcement (Blockchain Defense)](#5-quantum-blind-transaction-enforcement-blockchain-defense)
6. [Fat Key Reality Check: Architectural Adjustments](#6-fat-key-reality-check-architectural-adjustments)
7. [Migration Strategy](#7-migration-strategy)
8. [Cryptographic Inventory Crosswalk](#8-cryptographic-inventory-crosswalk)

---

## 1. Primitive Selection Matrix

| Layer | Current | Replacement | FIPS | Rationale |
|-------|---------|-------------|------|-----------|
| E2EE Command Channel (KEM) | RSA-4096 (RSA-OAEP-SHA256) | **X25519 + ML-KEM-1024** (hybrid) | 203 | SNDL-critical. Hybrid provides IND-CCA2 security if *either* primitive holds. ML-KEM-1024 matches NIST Level 5 (AES-256 equivalent). X25519 is retained as classical fallback — if ML-KEM is broken classically, X25519 still holds; if quantum breaks X25519, ML-KEM still holds. |
| Migration Manifest Signing | Ed25519 | **ML-DSA-65** (PQ-only) | 204 | High-throughput signing of large manifests (64 MiB chunk Merkle trees). ML-DSA-65 gives NIST Level 3 (128-bit PQ security) with 3.3 KB signatures — acceptable for the single-manifest-per-migration use case. Greenfield system — no Ed25519 hybrid needed (no legacy keys to support). |
| Session Integrity (PoP) | ECDSA P-256 | **ML-KEM-1024 + HMAC-SHA256** | 203 | Symmetric session MAC via PQ key exchange. ML-KEM establishes `K_pop` at bind time; every request signed with HMAC-SHA256. ~40x faster than ECDSA. No SNDL vector (ephemeral, session-scoped). |
| User Intent Signatures | N/A (new layer) | **ML-DSA-44** (+ **SLH-DSA-SHA2-128s** for critical) | 204/205 | Cryptographic proof of session-holder authorization for high-value actions (wallet, deploy, destructive DB). Private key never leaves client. SLH-DSA required for financial/irreversible operations. |
| AI Gate Operator Signatures | ECDSA P-256 (operator key) | **SLH-DSA-SHA2-128s** | 205 | Stateless hash-based signatures — zero structured-lattice assumptions. Gate approvals are high-value (human→agent authorization boundary). SLH-DSA's conservative security posture (hash-only) justifies the larger signature size for this low-frequency, high-stakes operation. |
| Sync Receipts (HMAC-SHA256) | HMAC-SHA256 | **No change** | — | Symmetric. 256-bit HMAC keys derived via HKDF-SHA256 from `/etc/ellul/jwt-secret`. Already quantum-resilient (Grover's reduces to 128-bit security, sufficient). |
| STS Tokens (HMAC-SHA256) | HMAC-SHA256 | **No change** | — | Symmetric. Same as above. |
| Data at Rest (AES-256-GCM, LUKS2) | AES-256-GCM | **No change** | — | Already quantum-resilient. |

### Parameter Sets (Exact)

| Primitive | Parameter Set | Public Key | Private Key | Ciphertext/Signature | Security Level |
|-----------|--------------|------------|-------------|---------------------|----------------|
| ML-KEM-1024 | FIPS 203 Level 5 | 1,568 B | 3,168 B | 1,568 B (ciphertext) | NIST 5 |
| X25519 | RFC 7748 | 32 B | 32 B | 32 B (ephemeral pub) | ~128-bit classical |
| ML-DSA-65 | FIPS 204 Level 3 | 1,952 B | 4,032 B | 3,309 B (signature) | NIST 3 |
| Ed25519 | RFC 8032 | 32 B | 64 B | 64 B (signature) | ~128-bit classical |
| ML-DSA-44 | FIPS 204 Level 2 | 1,312 B | 2,560 B | 2,420 B (signature) | NIST 2 |
| SLH-DSA-SHA2-128s | FIPS 205 Level 1 | 32 B | 64 B | 7,856 B (signature) | NIST 1 (hash-based) |

> **Why ML-KEM-1024 and not ML-KEM-768**: The command channel protects data that may be stored encrypted for years (serverless hibernate volumes, backup identities). SNDL threat model requires maximum lattice security. The 1,568-byte public key/ciphertext overhead is acceptable for a channel that moves <10 commands/minute.

> **Why SLH-DSA-128s ("small") and not 128f ("fast")**: Gate token signing is infrequent (<1/sec peak). The `s` parameter set produces 7,856-byte signatures vs. 17,088 bytes for `f`. The 10x slower signing (~100ms vs ~10ms) is irrelevant at our call rate, and the smaller signature reduces DB/transit pressure.

---

## 2. Hybrid KEM: Command Channel (SNDL Fix)

### 2.1 Threat Model

The current RSA-4096 OAEP encapsulation of AES-256-GCM keys in `server_commands.payload` is the primary SNDL vulnerability. An adversary recording `{ encryptedKey, iv, encryptedData }` envelopes today can decrypt them with a future CRQC. The command channel carries:

- LUKS passphrases (volume mount/flush)
- Identity backup keys
- Entitlement updates
- Agent adapter execution payloads
- Block migration credentials

All of these are high-value, long-lived secrets.

### 2.2 Hybrid KEM Construction

We use a **KEM combiner** (not hybrid encryption). The construction is:

```
SharedSecret = HKDF-SHA256(
  IKM  = X25519_SS || ML-KEM_SS,
  salt = SHA-256(X25519_eph_pub || ML-KEM_ct),
  info = "ellul-hybrid-kem-v1",
  L    = 32
)
```

This follows the "dual-PRF" combiner approach from [Bindel et al., 2019]. If either KEM is broken, the combined shared secret retains the security of the surviving component, provided the broken component does not degrade HKDF's PRF property (which SHA-256 guarantees for up to 256-bit inputs even under quantum attack via Grover).

### 2.3 Key Generation (VPS-Side)

**File to modify**: `apps/api/src/provisioning/shell/packages/crypto-keys.sh`

Replace RSA-4096 keypair generation with:

```bash
#!/bin/bash
# POST-QUANTUM HYBRID KEYPAIR GENERATION
# Generates X25519 + ML-KEM-1024 keypair for E2EE command channel.

ELLUL_DIR="/etc/ellul"
NODE_KEY="$ELLUL_DIR/node.key"
NODE_PUB="$ELLUL_DIR/node.pub"

groupadd -f shield 2>/dev/null || true

if [ ! -f "$NODE_KEY" ]; then
  log "Generating hybrid X25519 + ML-KEM-1024 keypair"

  # Use the ellul-keygen binary (compiled from Rust, statically linked)
  # Outputs: node.key (JSON: { version, x25519_sk, mlkem_dk }) — 3,232 bytes
  #          node.pub (JSON: { version, x25519_pk, mlkem_ek }) — 1,632 bytes
  /usr/local/bin/ellul-keygen hybrid \
    --private-out "$NODE_KEY" \
    --public-out "$NODE_PUB"

  chown root:shield "$NODE_KEY"
  chmod 640 "$NODE_KEY"
  chmod 644 "$NODE_PUB"
else
  log "Hybrid keypair exists (vault) -- skipping generation"
  # Re-derive public key from private key (idempotent)
  /usr/local/bin/ellul-keygen derive-pub \
    --private-in "$NODE_KEY" \
    --public-out "$NODE_PUB"
  chmod 644 "$NODE_PUB"
fi
```

### 2.4 Key File Formats

**`/etc/ellul/node.key`** (private, `root:shield 640`):
```json
{
  "version": 2,
  "algorithm": "X25519+ML-KEM-1024",
  "x25519_sk": "<base64, 32 bytes>",
  "mlkem_dk": "<base64, 3168 bytes>",
  "created_at": "2026-03-31T00:00:00Z"
}
```
Total file size: ~4,320 bytes (base64 overhead).

**`/etc/ellul/node.pub`** (public, `644`):
```json
{
  "version": 2,
  "algorithm": "X25519+ML-KEM-1024",
  "x25519_pk": "<base64, 32 bytes>",
  "mlkem_ek": "<base64, 1568 bytes>",
  "created_at": "2026-03-31T00:00:00Z"
}
```
Total file size: ~2,180 bytes (base64 overhead).

**`servers.publicKey`** (DB column, `text`): Stores the full JSON of `node.pub`. Version field allows the API to dispatch to the correct encryption path.

### 2.5 Encapsulation (API-Side)

**File to modify**: `apps/api/src/security/crypto/vps-encrypt.ts`

```typescript
import crypto from "crypto";
import { ml_kem1024 } from "@noble/post-quantum/ml-kem";
import { x25519 } from "@noble/curves/ed25519";

interface HybridPublicKey {
  version: 2;
  algorithm: "X25519+ML-KEM-1024";
  x25519_pk: string; // base64
  mlkem_ek: string;  // base64
}

interface HybridEnvelope {
  version: 2;
  x25519_eph_pub: string;  // base64, 32 bytes
  mlkem_ct: string;         // base64, 1568 bytes
  iv: string;               // base64, 12 bytes
  encryptedData: string;    // base64, AES-256-GCM ciphertext + 16-byte tag
}

export function encryptForVpsHybrid(
  publicKeyJson: string,
  plaintext: string
): HybridEnvelope {
  const pub: HybridPublicKey = JSON.parse(publicKeyJson);
  if (pub.version !== 2) throw new Error("Unsupported key version");

  const x25519_pk = Buffer.from(pub.x25519_pk, "base64");
  const mlkem_ek = new Uint8Array(Buffer.from(pub.mlkem_ek, "base64"));

  // 1. X25519 ECDH
  const x25519_eph_sk = crypto.randomBytes(32);
  const x25519_eph_pub = Buffer.from(x25519.scalarMultBase(x25519_eph_sk));
  const x25519_ss = Buffer.from(
    x25519.scalarMult(x25519_eph_sk, x25519_pk)
  );

  // 2. ML-KEM-1024 Encapsulate
  const { cipherText: mlkem_ct, sharedSecret: mlkem_ss } =
    ml_kem1024.encapsulate(mlkem_ek);

  // 3. Combine shared secrets via HKDF
  const ikm = Buffer.concat([x25519_ss, Buffer.from(mlkem_ss)]);
  const salt = crypto
    .createHash("sha256")
    .update(Buffer.concat([x25519_eph_pub, Buffer.from(mlkem_ct)]))
    .digest();
  const aesKey = crypto.hkdfSync(
    "sha256", ikm, salt, "ellul-hybrid-kem-v1", 32
  );

  // 4. AES-256-GCM encrypt
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm", Buffer.from(aesKey), iv
  );
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]);

  // 5. Zeroize sensitive material
  x25519_eph_sk.fill(0);
  ikm.fill(0);

  return {
    version: 2,
    x25519_eph_pub: x25519_eph_pub.toString("base64"),
    mlkem_ct: Buffer.from(mlkem_ct).toString("base64"),
    iv: iv.toString("base64"),
    encryptedData: ciphertext.toString("base64"),
  };
}
```

### 2.6 Decapsulation (VPS-Side)

**File to modify**: `packages/vps/src/services/auth/sovereign-shield/src/services/secrets.service.ts`

```typescript
import crypto from "crypto";
import { ml_kem1024 } from "@noble/post-quantum/ml-kem";
import { x25519 } from "@noble/curves/ed25519";

interface HybridPrivateKey {
  version: 2;
  x25519_sk: string; // base64
  mlkem_dk: string;  // base64
}

interface HybridEnvelope {
  version: 2;
  x25519_eph_pub: string;
  mlkem_ct: string;
  iv: string;
  encryptedData: string;
}

export function decryptHybridEnvelope(
  envelope: HybridEnvelope,
  privateKeyJson: string
): string {
  const priv: HybridPrivateKey = JSON.parse(privateKeyJson);

  const x25519_sk = Buffer.from(priv.x25519_sk, "base64");
  const x25519_eph_pub = Buffer.from(envelope.x25519_eph_pub, "base64");
  const mlkem_ct = new Uint8Array(Buffer.from(envelope.mlkem_ct, "base64"));
  const mlkem_dk = new Uint8Array(Buffer.from(priv.mlkem_dk, "base64"));

  // 1. X25519 ECDH
  const x25519_ss = Buffer.from(
    x25519.scalarMult(x25519_sk, x25519_eph_pub)
  );

  // 2. ML-KEM-1024 Decapsulate
  const mlkem_ss = ml_kem1024.decapsulate(mlkem_ct, mlkem_dk);

  // 3. Combine shared secrets via HKDF (must match encapsulation)
  const ikm = Buffer.concat([x25519_ss, Buffer.from(mlkem_ss)]);
  const salt = crypto
    .createHash("sha256")
    .update(
      Buffer.concat([x25519_eph_pub, Buffer.from(mlkem_ct)])
    )
    .digest();
  const aesKey = crypto.hkdfSync(
    "sha256", ikm, salt, "ellul-hybrid-kem-v1", 32
  );

  // 4. AES-256-GCM decrypt
  const data = Buffer.from(envelope.encryptedData, "base64");
  const authTag = data.subarray(-16);
  const ciphertext = data.subarray(0, -16);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm", Buffer.from(aesKey), Buffer.from(envelope.iv, "base64")
  );
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");

  // 5. Zeroize
  x25519_sk.fill(0);
  ikm.fill(0);

  return plaintext;
}
```

### 2.7 Bash Decryption Path (Enforcer)

**File to replace**: `packages/vps/src/shell/security/decrypt.sh`

The current Bash script pipes RSA decryption through `openssl pkeyutl`. OpenSSL 3.x does not yet ship ML-KEM. We replace the Bash decryption path with a statically-linked Rust binary (`ellul-decrypt`) that handles the full hybrid decapsulation:

```bash
#!/bin/bash
# POST-QUANTUM HYBRID DECRYPTION
# Replaces RSA-OAEP + AES-256-GCM with X25519+ML-KEM-1024 + AES-256-GCM.
#
# Input: Base64 JSON envelope on stdin (or as $1)
# Output: Decrypted plaintext on stdout
# Private key: /etc/ellul/node.key (root:shield 640)

set -e

PRIVATE_KEY="/etc/ellul/node.key"
ENVELOPE_JSON="${1:--}"  # Read from arg or stdin

if [ ! -f "$PRIVATE_KEY" ]; then
  echo "Error: Private key not found" >&2
  exit 1
fi

# ellul-decrypt handles:
# 1. JSON parse of envelope (version dispatch)
# 2. X25519 ECDH + ML-KEM-1024 decapsulate
# 3. HKDF-SHA256 key combination
# 4. AES-256-GCM decrypt
# 5. Memory zeroization
#
# Version 1 envelopes (legacy RSA): rejected with exit code 2
# Version 2 envelopes (hybrid PQC): decrypted
exec /usr/local/bin/ellul-decrypt \
  --key "$PRIVATE_KEY" \
  --envelope "$ENVELOPE_JSON"
```

**`ellul-decrypt` binary specification**:
- Language: Rust (using `pqcrypto-mlkem` crate + `x25519-dalek`)
- Static linking: musl target (`x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`)
- Memory: `mlock()` all key material, `zeroize` on drop
- Size: ~2 MB stripped
- Install path: `/usr/local/bin/ellul-decrypt`
- Permissions: `root:root 755`

### 2.8 Browser-Side Encryption (Console)

**File to modify**: `apps/console/src/lib/crypto.ts`

The browser must also perform hybrid encapsulation for user-initiated secret injection. Since Web Crypto API does not support ML-KEM, we use `@noble/post-quantum/ml-kem` (pure JS, audited, no WASM dependency):

```typescript
import { ml_kem1024 } from "@noble/post-quantum/ml-kem";
import { x25519 } from "@noble/curves/ed25519";

export async function encryptSecretPQC(
  publicKeyJson: string,
  secret: string
): Promise<HybridEnvelope> {
  // Identical logic to server-side encryptForVpsHybrid
  // Uses Web Crypto for AES-256-GCM, @noble for X25519 + ML-KEM
  // ...
}
```

Bundle size impact: `@noble/post-quantum` adds ~45 KB gzipped. This is acceptable for a security-critical admin console.

### 2.9 Envelope Wire Format (in `server_commands.payload`)

**Version 1 (legacy, deprecated)**:
```json
{
  "_e2ee": true,
  "encryptedKey": "base64(RSA-OAEP(AES-256-key))",
  "iv": "base64(12 bytes)",
  "encryptedData": "base64(AES-GCM ciphertext + tag)"
}
```
Size: ~800 bytes for a 100-byte payload.

**Version 2 (post-quantum hybrid)**:
```json
{
  "_e2ee": true,
  "_pqc": 2,
  "x25519_eph_pub": "base64(32 bytes)",
  "mlkem_ct": "base64(1568 bytes)",
  "iv": "base64(12 bytes)",
  "encryptedData": "base64(AES-GCM ciphertext + tag)"
}
```
Size: ~2,300 bytes for a 100-byte payload. Breakdown:
- `x25519_eph_pub`: 44 chars (base64)
- `mlkem_ct`: 2,092 chars (base64 of 1,568 bytes)
- `iv`: 16 chars
- `encryptedData`: ~150 chars (100-byte payload + 16-byte tag)
- JSON framing: ~80 chars

**Dispatch logic**: The VPS decryption path checks `_pqc` field:
- `_pqc: 2` → hybrid decapsulation
- `_pqc` absent, `_e2ee: true` → legacy RSA (rejected after migration window closes)
- `_platformEncrypted: true` → bootstrap fallback (unchanged, symmetric)

---

## 3. ML-DSA: Migration Manifest Signatures

### 3.1 Current Architecture

The Class A block migration system signs manifests with Ed25519 via `openssl pkeyutl -sign` on the VPS and verifies with Node.js `crypto.verify("Ed25519", ...)` on the API. The manifest is a canonical JSON object (~2-10 KB depending on chunk count) containing the Merkle root of a volume snapshot.

Key files:
- Generation: `packages/vps/src/services/daemons/enforcer/lib/block-migrate.sh` (lines 66-77)
- Signing: `block-migrate.sh` (lines 593-645)
- Verification (API): `apps/api/src/services/migration-manifest.ts` (lines 170-202)
- Verification (VPS Phase 2): `block-migrate.sh` (lines 958-1022)

### 3.2 Signature Construction

> **Implementation note (2026-04-01)**: The original spec described a dual Ed25519+ML-DSA-65 hybrid signature. The implementation uses **ML-DSA-65 only** because this is a greenfield system with no legacy keys or verifiers. Ed25519 was removed to eliminate unnecessary classical crypto from the signing path. The KEM layer retains X25519 as defense-in-depth (SNDL protection for recorded ciphertexts), but signatures don't face SNDL risk — they're verified immediately.

The manifest carries a single ML-DSA-65 signature. Verification is fail-closed: any library error throws (not return false), and callers must not catch and downgrade.

### 3.3 Key Generation

**File to modify**: `block-migrate.sh` (`ensure_migration_signing_key`)

```bash
ensure_migration_signing_key() {
  local SIGN_KEY="/etc/ellul/migration-sign.key"
  local SIGN_PUB="/etc/ellul/migration-sign.pub"

  if [ -f "$SIGN_KEY" ]; then
    # Check if already PQC (version 2)
    if head -c 1 "$SIGN_KEY" | grep -q '{'; then
      log "PQC migration signing key exists -- skipping"
      return 0
    fi
    # Legacy Ed25519 PEM — will be rotated by migration procedure
    log "Legacy Ed25519 migration key detected -- PQC rotation pending"
    return 0
  fi

  log "Generating ML-DSA-65 migration signing keypair"

  # ellul-crypto outputs JSON key files
  /usr/local/bin/ellul-crypto keygen sign \
    --private-out "$SIGN_KEY" \
    --public-out "$SIGN_PUB"

  chmod 600 "$SIGN_KEY"
  chmod 644 "$SIGN_PUB"
  chown root:root "$SIGN_KEY" "$SIGN_PUB"
}
```

### 3.4 Key File Formats

**`/etc/ellul/migration-sign.key`** (private, `root:root 600`):
```json
{
  "version": 2,
  "algorithm": "ML-DSA-65",
  "mldsa_sk": "<base64, 4032 bytes>",
  "created_at": "2026-03-31T00:00:00Z"
}
```
Total: ~5,500 bytes.

**`/etc/ellul/migration-sign.pub`** (public, `644`):
```json
{
  "version": 2,
  "algorithm": "ML-DSA-65",
  "mldsa_pk": "<base64, 1952 bytes>",
  "created_at": "2026-03-31T00:00:00Z"
}
```
Total: ~2,700 bytes.

**`servers.migrationSigningPublicKey`** (DB column): Stores full JSON. Version field enables dispatch.

### 3.5 Manifest Signature Fields

The manifest structure gains two signature fields:

```typescript
interface BlockMigrationManifest {
  // ... existing fields (version, serverId, chunks, merkleRootHash, etc.) ...

  signedBy: "vps-migration-key-v2";  // Updated identifier
  signature_ed25519: string;          // Base64, 64 bytes (88 chars)
  signature_mldsa65: string;          // Base64, 3309 bytes (~4,412 chars)
}
```

**Signing payload**: Canonical JSON (`jq -cS`) of all fields EXCEPT `signature_ed25519` and `signature_mldsa65`. This is identical to the current approach but excludes both signature fields instead of one.

### 3.6 Signing (VPS Bash)

```bash
sign_manifest_hybrid() {
  local MANIFEST_FILE="$1"
  local SIGN_KEY="/etc/ellul/migration-sign.key"

  # ellul-sign reads canonical JSON from file, produces dual signatures
  # Output: JSON { "ed25519": "base64...", "mldsa65": "base64..." }
  /usr/local/bin/ellul-crypto sign \
    --key "$SIGN_KEY" \
    --input "$MANIFEST_FILE" \
    --algorithm mldsa65
}
```

### 3.7 Verification (API-Side, Phase 1)

**File to modify**: `apps/api/src/services/migration-manifest.ts`

```typescript
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa";

export function verifyManifestSignature(
  manifest: BlockMigrationManifest,
  publicKeyJson: string
): boolean {
  const pub = JSON.parse(publicKeyJson);

  // Reconstruct signing payload (exclude both signatures)
  const { signature_ed25519, signature_mldsa65, ...unsigned } = manifest;
  const payload = Buffer.from(
    JSON.stringify(unsigned, Object.keys(unsigned).sort()), "utf8"
  );

  if (pub.version === 2) {
    // Hybrid: BOTH signatures must verify
    const ed25519_pk = crypto.createPublicKey({
      key: Buffer.from(pub.ed25519_pk, "base64"),
      format: "der",
      type: "spki",
    });
    const ed25519_valid = crypto.verify(
      null, payload, ed25519_pk,
      Buffer.from(signature_ed25519, "base64")
    );

    const mldsa_pk = new Uint8Array(Buffer.from(pub.mldsa_pk, "base64"));
    const mldsa_valid = ml_dsa65.verify(
      mldsa_pk,
      new Uint8Array(payload),
      new Uint8Array(Buffer.from(signature_mldsa65, "base64"))
    );

    return ed25519_valid && mldsa_valid;
  }

  // Legacy v1: Ed25519 only (during migration window)
  if (pub.version === 1 || !pub.version) {
    return verifyLegacyEd25519(manifest, publicKeyJson);
  }

  return false;
}
```

### 3.8 Verification (VPS-Side, Phase 2)

```bash
verify_manifest_phase2() {
  local MANIFEST_FILE="$1"
  local SIGN_PUB="/etc/ellul/migration-sign.pub"

  # ellul-crypto verifies ML-DSA-65 signature on manifest canonical JSON
  /usr/local/bin/ellul-crypto verify \
    --key "$SIGN_PUB" \
    --manifest "$MANIFEST_FILE" \
    --algorithm mldsa65

  return $?
}
```

### 3.9 Performance Characteristics

| Operation | Ed25519 (current) | ML-DSA-65 | Hybrid (both) |
|-----------|-------------------|-----------|---------------|
| Key generation | 0.03 ms | 0.15 ms | 0.18 ms |
| Sign (10 KB manifest) | 0.05 ms | 0.8 ms | 0.85 ms |
| Verify | 0.1 ms | 0.4 ms | 0.5 ms |
| Signature size | 64 B | 3,309 B | 3,373 B |
| Public key size | 32 B | 1,952 B | 1,984 B |

Impact: Negligible. Migrations are infrequent (minutes between operations) and the manifest JSON itself is already multi-KB.

---

## 4. Quantum-Resilient Authentication & Authorization

### 4.1 Current Architecture

The authentication system uses two distinct ECDSA P-256 signing operations:

1. **PoP (Proof of Possession)**: Browser signs every HTTP request with a session-bound ECDSA P-256 key via Web Crypto. The signature payload is `timestamp|METHOD|path|bodyHash|nonce`. Verified server-side in `pop.ts`.

2. **Operator Signature**: The browser extension/REPL daemon signs gate approval/denial decisions with a separate ECDSA P-256 key stored in volatile RAM. Verified in `gate-api.routes.ts`.

Both are vulnerable to a real-time CRQC that observes the public key (sent at bind time or during registration) and derives the private key via Shor's algorithm.

### 4.2 Layered Authentication Model

Ellul.ai replaces both ECDSA operations with a **dual-layer model** that separates session integrity from user authorization:

| Layer | Primitive | Purpose | Frequency | Latency |
|-------|-----------|---------|-----------|---------|
| **Session Integrity** | ML-KEM-1024 + HMAC-SHA256 | Request integrity, anti-replay, session binding | Every request | ~0.05 ms |
| **User Intent** | ML-DSA-44 / SLH-DSA-SHA2-128s | Cryptographic proof that session holder authorized the action | High-value actions only | ~1–100 ms |

**Layer interaction rule**: For high-value actions, **BOTH** Session MAC AND Intent Signature MUST validate. Neither layer is a substitute for the other. Intent signatures do not bypass HMAC; HMAC does not satisfy intent requirements.

**Why two layers, not one?**

- HMAC-SHA256 on every request is ~40x faster than any PQ signature scheme. Signing ~100 requests/sec with ML-DSA-44 (~0.8 ms/sign) would add 80 ms/sec of CPU overhead; HMAC adds ~5 ms/sec.
- HMAC is a symmetric primitive — the server also holds `K_pop`, so it cannot prove *who* authorized an action. PQ signatures use asymmetric keys where the private key never leaves the client, providing cryptographic proof of session-holder authorization.
- Combining both gives quantum-resilient session integrity (HMAC) AND quantum-resilient authorization (PQ signatures) without latency regression on the hot path.

### 4.3 Session Integrity Layer: Symmetric PoP via ML-KEM

#### 4.3.1 Purpose

The Session Integrity Layer provides:
- **Request integrity**: Payload cannot be tampered with in transit.
- **Anti-replay**: Server-issued nonces prevent replay of captured requests.
- **Session binding**: HMAC key is unique per session; requests cannot be replayed across sessions.

The Session Integrity Layer does **NOT** provide:
- Non-repudiation or proof of user intent (server also holds `K_pop`).
- Authentication of the user's identity (that is the passkey/FIDO2 layer).

#### 4.3.2 ML-KEM-1024 Session Handshake

The ECDSA key generation + single-POST bind is replaced with a two-phase ML-KEM handshake.

**Phase 1: Key Exchange Initiation**

```
POST /_auth/pop/bind/init
Cookie: shield_session=<sessionId>

Response 200:
{
  "mlkem_ek": "<base64, 1568-byte encapsulation key>",
  "bind_challenge": "<32-byte hex nonce>",
  "expires_at": <timestamp, 30 seconds from now>
}
```

Server logic:
1. Validate session exists and is not already PoP-bound.
2. Generate ephemeral ML-KEM-1024 keypair: `(ek, dk) = ml_kem1024.keygen()`.
3. Generate 32-byte random `bind_challenge`.
4. Store `{ dk, bind_challenge, expires_at }` in in-memory `Map<sessionId, PendingBind>` (volatile RAM only — `dk` never touches SQLite).
5. Return `ek` and `bind_challenge`.

**Phase 2: Key Exchange Completion**

```
POST /_auth/pop/bind/complete
Cookie: shield_session=<sessionId>
Body: {
  "mlkem_ct": "<base64, 1568-byte ciphertext>",
  "bind_proof": "<base64, HMAC-SHA256(K_pop_final, 'pop-bind|' + bind_challenge)>",
  "intent_public_key": "<base64, ML-DSA-44 public key, 1312 bytes>",
  "prf_envelope": "<optional: base64, AES-256-GCM(K_pop_mlkem, prf_output)>",
  "prf_iv": "<optional: base64, 12-byte IV>"
}

Response 200:
{
  "bound": true,
  "pop_version": 2,
  "intent_nonce_endpoint": "/_auth/intent/nonce"
}
```

Server logic:
1. Retrieve pending bind from in-memory map. Reject if expired or absent.
2. Decapsulate: `K_pop_mlkem = ml_kem1024.decapsulate(ct, dk)` → 32-byte shared secret.
3. If `prf_envelope` present: decrypt with AES-256-GCM under `K_pop_mlkem` to recover `prf_output`. Compute `K_pop_final = HKDF-SHA256(K_pop_mlkem || prf_output, SHA-256(session_id), 'ellul-pop-hmac-v2', 32)`.
4. If `prf_envelope` absent: `K_pop_final = K_pop_mlkem`.
5. Verify `bind_proof`: `HMAC-SHA256(K_pop_final, 'pop-bind|' + bind_challenge)` with timing-safe comparison.
6. Store `K_pop_final` in `sessions.pop_hmac_key` and `intent_public_key` in `sessions.intent_public_key`.
7. Delete pending bind entry. Zeroize `dk`.

**Why browser encapsulates**: The server holds `dk` (3,168 bytes, expensive to transmit). The browser receives `ek` (1,568 bytes) and encapsulates. This matches the pattern in Section 2 where the browser encapsulates against the server's public key.

#### 4.3.3 HMAC-SHA256 Per-Request Signing

The payload format is unchanged from classical PoP:

```
payload = timestamp | METHOD | path | bodyHash | nonce
```

The signing operation changes from ECDSA to HMAC:

```
mac = HMAC-SHA256(K_pop, payload)    // 32 bytes → 44 base64 chars
```

**Headers**:

| Header | Value |
|--------|-------|
| `X-PoP-Timestamp` | Unix milliseconds (unchanged) |
| `X-PoP-Nonce` | UUIDv4 (unchanged) |
| `X-PoP-MAC` | Base64 HMAC-SHA256 tag (44 chars, replaces `X-PoP-Signature`) |
| `X-PoP-Version` | `2` (new — enables migration dispatch) |

**Server verification** in `pop.ts`:

```typescript
export function verifyPopHmac(
  kPopBase64: string, payload: string, macBase64: string
): boolean {
  const kPop = Buffer.from(kPopBase64, "base64");
  const expected = crypto.createHmac("sha256", kPop).update(payload).digest();
  const actual = Buffer.from(macBase64, "base64");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
```

> **Critical**: Symmetric MAC verification MUST use `timingSafeEqual`. The ECDSA path did not need this because asymmetric verification is not timing-sensitive.

#### 4.3.4 K_pop Storage

**Server-side**: `sessions.pop_hmac_key` column (`TEXT`, base64-encoded 32-byte key) in SQLite on LUKS2-encrypted volume. This matches the current security posture of `pop_public_key`. The key is session-scoped (4-hour idle TTL, 24-hour absolute expiry) and deleted with the session.

**Browser-side**: The raw `K_pop` bytes are imported as a **non-extractable `CryptoKey`**:

```javascript
const hmacKey = await crypto.subtle.importKey(
  "raw", kPopBytes,
  { name: "HMAC", hash: "SHA-256" },
  false,  // NON-EXTRACTABLE — matches current ECDSA non-extractability
  ["sign"]
);
```

Stored in IndexedDB (`sovereign-shield` database, `session-keys` store). The Service Worker holds a volatile reference to this `CryptoKey` in its global scope, repopulated from IndexedDB on restart.

#### 4.3.5 Service Worker

The Service Worker uses native `crypto.subtle.sign("HMAC", hmacKey, data)` — **zero external dependencies**. ML-KEM code is NOT loaded in the SW; it exists only in the main page context during the one-time bind handshake.

**Intent-required endpoint handling**: The SW maintains a static list of intent-required path prefixes (synced from server config). When intercepting a request to such an endpoint:
- If `X-Intent-Signature` header is already present → pass through (main thread/extension attached it).
- If absent → **route the request back to the main thread** via `postMessage` for intent signing, rather than sending it unsigned. This prevents accidentally sending unsigned high-risk requests while not breaking legitimate flows.

#### 4.3.6 CLI Path

**File to modify**: `packages/auth-proxy/src/pop-signer.ts`

`generatePopKeyPair()` is replaced by `performPopHandshake()`:

```typescript
import { ml_kem1024 } from "@noble/post-quantum/ml-kem";

export async function performPopHandshake(
  baseUrl: string,
  sessionCookie: string
): Promise<{ kPop: Buffer; intentKeyPair: IntentKeyPair }> {
  // Phase 1: Get ML-KEM encapsulation key
  const { mlkem_ek, bind_challenge } = await fetchJson(
    `${baseUrl}/_auth/pop/bind/init`,
    { cookie: `shield_session=${sessionCookie}` }
  );

  // Encapsulate
  const ek = new Uint8Array(Buffer.from(mlkem_ek, "base64"));
  const { cipherText, sharedSecret } = ml_kem1024.encapsulate(ek);
  const kPop = Buffer.from(sharedSecret);

  // Generate intent keypair (ML-DSA-44)
  const { publicKey, secretKey } = ml_dsa44.keygen();

  // Compute bind proof
  const proof = crypto.createHmac("sha256", kPop)
    .update("pop-bind|" + bind_challenge).digest();

  // Phase 2: Complete
  await fetchJson(`${baseUrl}/_auth/pop/bind/complete`, {
    cookie: `shield_session=${sessionCookie}`,
    body: {
      mlkem_ct: Buffer.from(cipherText).toString("base64"),
      bind_proof: proof.toString("base64"),
      intent_public_key: Buffer.from(publicKey).toString("base64"),
    },
  });

  return { kPop, intentKeyPair: { publicKey, secretKey } };
}
```

`signRequest()` changes to HMAC:

```typescript
export function signRequest(
  kPop: Buffer, method: string, path: string, body?: string | Buffer | null
): PopHeaders {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID();
  const bodyHash = body
    ? crypto.createHash("sha256").update(body).digest("base64") : "";
  const payload = `${timestamp}|${method.toUpperCase()}|${path}|${bodyHash}|${nonce}`;
  const mac = crypto.createHmac("sha256", kPop).update(payload).digest("base64");

  return {
    "X-PoP-Timestamp": timestamp,
    "X-PoP-Nonce": nonce,
    "X-PoP-MAC": mac,
    "X-PoP-Version": "2",
  };
}
```

No PRF for CLI — device trust is a separate authentication layer.

#### 4.3.7 Defense-in-Depth: FIDO2 PRF HKDF Combiner

FIDO2 authenticators internally use ECDSA for assertion signatures. A real-time CRQC could forge the assertion. However, the authenticator's PRF (hmac-secret) extension computes a symmetric secret inside the hardware that never leaves the device — Shor's algorithm cannot extract it.

When the authenticator supports PRF, the browser combines the ML-KEM shared secret with the PRF output:

```
K_pop_final = HKDF-SHA256(
  IKM  = K_pop_mlkem || prf_output,
  salt = SHA-256(session_id),
  info = "ellul-pop-hmac-v2",
  L    = 32
)
```

The PRF output is encrypted with AES-256-GCM under `K_pop_mlkem` and sent in the `prf_envelope` field of the bind/complete request. The server decrypts it, computes `K_pop_final`, and stores the combined key.

**Graceful degradation**: If the authenticator does not support PRF, `K_pop_mlkem` is used directly. The server records `pop_prf_bound = 0|1` for audit visibility.

#### 4.3.8 Performance

| Operation | ECDSA P-256 (current) | HMAC-SHA256 (new) | Change |
|-----------|----------------------|-------------------|--------|
| Sign (per request) | ~2 ms | ~0.05 ms | **40x faster** |
| Verify (per request) | ~2 ms | ~0.05 ms | **40x faster** |
| Output size | 72 B (96 base64 chars) | 32 B (44 base64 chars) | **2.2x smaller** |
| Bind overhead | 0 ms (single POST) | ~5 ms (ML-KEM encapsulate, one-time) | Negligible |

#### 4.3.9 Security Properties

- **Quantum-resilient**: HMAC-SHA256 is a symmetric primitive. Shor's algorithm does not apply. Grover's algorithm reduces security to 128-bit, which is sufficient.
- **Symmetric trust model**: The server also holds `K_pop`. A compromised server can forge session MACs. This is an accepted property — the Session Integrity Layer protects the transport, not the authorization boundary.
- **Session-scoped**: `K_pop` is ephemeral (4-hour idle TTL, 24-hour absolute expiry). No SNDL vector.
- **Non-extractable**: Browser-side `K_pop` is a non-extractable `CryptoKey` — JavaScript cannot read the raw bytes after import.

### 4.4 User Intent Layer: Post-Quantum Signatures

#### 4.4.1 Purpose

The User Intent Layer provides:
- **Cryptographic proof that the session holder authorized the action** — not "non-repudiation" in the legal sense, since keys are session-bound without external identity binding or hardware attestation guarantee.
- **Sovereign control**: The server CANNOT forge intent signatures (it only holds the public key). A compromised server can manipulate requests and replay attempts, but it cannot forge user-approved actions.
- **Post-quantum security**: ML-DSA and SLH-DSA resist Shor's algorithm.

The User Intent Layer does **NOT**:
- Sign every HTTP request (that would be too slow).
- Replace the Session Integrity Layer (both are required for high-value actions).

#### 4.4.2 When Required

Intent signatures are **MANDATORY** for actions classified as high-value. The classification is **server-defined and not client-controllable**.

```typescript
const REQUIRES_INTENT_SIGNATURE = {
  wallet_spend:      "slhdsa128s",  // Financial — SLH-DSA required
  deploy:            "slhdsa128s",  // Cross-system — SLH-DSA required
  db_migrate:        "slhdsa128s",  // Irreversible schema — SLH-DSA required
  db_write:          "mldsa44",     // Destructive (DROP/TRUNCATE) classified at gate time
  git_push_external: "mldsa44",     // Push to external remotes only
  exec:              "mldsa44",     // Arbitrary shell execution — always required
} as const;
// Permission escalation (changing gate policies) also requires intent signature,
// enforced in the permissions update handler separately.
```

**SLH-DSA-SHA2-128s is REQUIRED** (not optional) for:
- Financial operations (`wallet_spend`)
- Irreversible state changes (`db_migrate` with destructive DDL)
- Cross-system effects (`deploy`)

Engineers MUST NOT default to ML-DSA for SLH-DSA-classified actions.

**NOT required** for: reads, polling, standard API calls, low-risk mutations.

**Downgrade protection**: A request sent with only HMAC to an intent-required endpoint receives a hard **403 Forbidden**. The server does not fall back.

#### 4.4.3 Primitive Selection

| Primitive | Use Case | Signature Size | Sign Time | Security |
|-----------|----------|---------------|-----------|----------|
| **ML-DSA-44** | Interactive approvals, gate responses, permission changes | 2,420 B | <1 ms | NIST Level 2 |
| **SLH-DSA-SHA2-128s** | Financial, irreversible, cross-system operations | 7,856 B | ~100 ms | NIST Level 1 (hash-only, zero lattice assumptions) |

ML-DSA-44 is chosen over ML-DSA-65 for the intent layer because:
- Intent signatures are interactive (human-triggered), so NIST Level 2 is sufficient.
- The 2,420-byte signature (vs 3,309 for ML-DSA-65) reduces wire overhead for operations that may be frequent (e.g., multiple `exec` gates in a development session).
- The operator gate signatures (Section 4.5+) already use SLH-DSA for the highest-assurance operations.

#### 4.4.4 Signing Flow

**Client** (browser extension or CLI):

```typescript
const payload = [
  action,             // e.g., "wallet_spend"
  resource,           // e.g., "app:myapp"
  parametersHash,     // SHA-256 of action-specific parameters
  sessionId,
  sessionKeyId,       // HMAC-SHA256(K_pop, "intent-binding")[:16] (hex)
  origin,             // server_id or project_id
  nonce,              // Server-issued, challenge-scoped
  timestamp,          // Unix milliseconds
].join("|");

const signature = ml_dsa44.sign(secretKey, new TextEncoder().encode(payload));
// Or for SLH-DSA-classified actions:
const signature = slh_dsa_sha2_128s.sign(secretKey, new TextEncoder().encode(payload));
```

`session_key_id` is a compact session-binding identifier derived from `K_pop`, used to prevent cross-session replay. It is NOT itself an authentication secret or trust anchor.

**Server** verifies `origin` against authoritative server-side state (the session's bound server/project), not trusting it as just another signed client field.

**Headers**:

| Header | Value |
|--------|-------|
| `X-Intent-Signature` | Base64 ML-DSA-44 (2,420 B) or SLH-DSA (7,856 B) signature |
| `X-Intent-Type` | `mldsa44` or `slhdsa128s` |

#### 4.4.5 Key Storage

- **Private key**: Browser IndexedDB (non-extractable `CryptoKey`) or CLI process memory. **NEVER sent to server.**
- **Public key**: `sessions.intent_public_key` (TEXT, base64). Bound to the authenticated session ID. Invalidated on logout/expiry. Never reused across sessions.
- **Session-scoped**: Intent keypair is generated per session and discarded on logout/expiry. Fresh keypair = fresh public key each session. Session compromise does not carry forward.

#### 4.4.6 Key Generation

Keys MUST be generated inside a **secure execution context**:
- **Browser**: Extension background script or trusted `/_auth/setup` page with CSP `script-src 'self'`. NEVER in arbitrary page JavaScript. XSS in page context MUST NOT reach intent signing keys.
- **CLI**: Node.js process memory via `@noble/post-quantum/ml-dsa`.

Public key is sent to server during the `bind/complete` phase (Section 4.3.2) alongside the ML-KEM ciphertext.

#### 4.4.7 Enforcement

**File to modify**: `packages/vps/src/services/auth/sovereign-shield/src/routes/gate-api.routes.ts`

```typescript
// Intent signature verification (called before any privileged side effect)
function verifyIntentSignature(
  session: Session,
  action: string,
  resource: string,
  parametersHash: string,
  headers: Record<string, string>
): { valid: boolean; reason?: string } {
  const sig = headers["x-intent-signature"];
  const type = headers["x-intent-type"];
  if (!sig || !type) return { valid: false, reason: "missing_intent_signature" };

  // Verify required type matches classification
  const required = REQUIRES_INTENT_SIGNATURE[action];
  if (required && required !== type) {
    return { valid: false, reason: `action_requires_${required}_not_${type}` };
  }

  // Reconstruct and verify payload
  const nonce = headers["x-intent-nonce"];
  const timestamp = headers["x-intent-timestamp"];

  // Clock skew: reject if >30s old or >5s in the future
  const drift = Date.now() - parseInt(timestamp, 10);
  if (drift > 30_000 || drift < -5_000) {
    return { valid: false, reason: "intent_timestamp_expired" };
  }

  // Nonce: must be server-issued, challenge-scoped, single-use
  if (!consumeIntentNonce(nonce, session.id, action, resource)) {
    return { valid: false, reason: "invalid_or_reused_nonce" };
  }

  // Verify signature
  const payload = [action, resource, parametersHash, session.id,
    deriveSessionKeyId(session.pop_hmac_key),
    session.bound_origin, nonce, timestamp].join("|");
  const message = new TextEncoder().encode(payload);
  const sigBytes = new Uint8Array(Buffer.from(sig, "base64"));
  const pk = new Uint8Array(Buffer.from(session.intent_public_key, "base64"));

  if (type === "slhdsa128s") {
    return { valid: slh_dsa_sha2_128s.verify(pk, message, sigBytes) };
  } else if (type === "mldsa44") {
    return { valid: ml_dsa44.verify(pk, message, sigBytes) };
  }
  return { valid: false, reason: "unknown_intent_type" };
}
```

**Nonce rules**: Intent nonces are server-issued via `POST /_auth/intent/nonce` and challenge-scoped — bound to session ID, action type, intended resource, and expiry. Generic nonces reusable across different actions are NOT permitted. Single-use, invalidated after verification. Client-generated nonces are NOT accepted.

#### 4.4.8 Security Properties

- **Server CANNOT forge** intent signatures (only holds public key).
- **Resistant to CRQC**: ML-DSA-44 (NIST Level 2) and SLH-DSA-SHA2-128s (hash-only) resist Shor's algorithm.
- **Provides cryptographic proof** that the session holder authorized the action.
- **Fail-closed**: Intent verification MUST occur BEFORE any privileged side effect is executed. No partial execution followed by late verification.
- **Server compromise allows**: request manipulation, replay attempts, denial of service. **BUT does NOT allow**: forging user-approved actions.
- **Session binding**: `session_key_id` (derived via `HMAC-SHA256(K_pop, "intent-binding")[:16]`) prevents cross-session replay. `origin` prevents cross-project replay.

### 4.5 Operator Key Generation

The operator key is generated in the browser extension / REPL daemon and bound to a Sovereign Shield session via nonce exchange. We replace the Web Crypto ECDSA key generation with SLH-DSA:

```typescript
// Browser extension / REPL daemon
import { slh_dsa_sha2_128s } from "@noble/post-quantum/slh-dsa";

function generateOperatorKeypair(): {
  publicKey: Uint8Array;  // 32 bytes
  secretKey: Uint8Array;  // 64 bytes
} {
  return slh_dsa_sha2_128s.keygen();
}
```

> **Note**: SLH-DSA-SHA2-128s has a 32-byte public key — same size as the current ECDSA P-256 compressed public key (33 bytes). No DB/protocol changes needed for the public key field.

### 4.6 Operator Signing

**File to modify**: Browser extension gate response handler

```typescript
import { slh_dsa_sha2_128s } from "@noble/post-quantum/slh-dsa";

function signGateResponse(
  secretKey: Uint8Array,
  payload: string,
  timestamp: string
): string {
  const fullPayload = `${payload}|${timestamp}`;
  const message = new TextEncoder().encode(fullPayload);
  const signature = slh_dsa_sha2_128s.sign(secretKey, message);
  // signature is 7,856 bytes → base64 ≈ 10,476 chars
  return Buffer.from(signature).toString("base64");
}
```

### 4.7 Operator Verification

**File to modify**: `packages/vps/src/services/auth/sovereign-shield/src/routes/gate-api.routes.ts`

```typescript
import { slh_dsa_sha2_128s } from "@noble/post-quantum/slh-dsa";

async function verifyOperatorSignature(
  sessionId: string,
  signedPayload: string,
  body: { operatorSignature?: string; operatorTimestamp?: string },
  ip: string
): Promise<string | null> {
  const session = getSession(sessionId);
  if (!session?.operatorPublicKey) return "no_operator_key";

  const timestamp = body.operatorTimestamp;
  if (!timestamp) return "missing_timestamp";

  const drift = Math.abs(Date.now() - parseInt(timestamp, 10));
  if (drift > OPERATOR_TIMESTAMP_TOLERANCE_MS) return "timestamp_drift";

  const fullPayload = `${signedPayload}|${timestamp}`;
  const message = new TextEncoder().encode(fullPayload);
  const signature = new Uint8Array(
    Buffer.from(body.operatorSignature!, "base64")
  );

  // Version dispatch based on signature size
  if (signature.length === 7856) {
    // SLH-DSA-SHA2-128s (post-quantum)
    const pk = new Uint8Array(
      Buffer.from(session.operatorPublicKey, "base64")
    );
    const valid = slh_dsa_sha2_128s.verify(pk, message, signature);
    if (!valid) {
      auditLog("operator_sig_verify_failed_slhdsa", { sessionId, ip });
      return "signature_invalid";
    }
  } else if (signature.length === 64) {
    // Legacy ECDSA P-256 (migration window only)
    const valid = await verifyLegacyEcdsaOperator(
      session.operatorPublicKey, fullPayload, body.operatorSignature!
    );
    if (!valid) return "signature_invalid";
  } else {
    return "unknown_signature_format";
  }

  return null; // Success
}
```

### 4.8 Performance and Size Impact

| Property | ECDSA P-256 (current) | SLH-DSA-SHA2-128s |
|----------|----------------------|-------------------|
| Public key | 33 B (compressed) | 32 B |
| Secret key | 32 B | 64 B |
| Signature | 64 B | 7,856 B |
| Sign time | <1 ms | ~100 ms |
| Verify time | <1 ms | ~10 ms |
| Gate approvals/sec (peak) | N/A | ~10/sec (sufficient) |

The 7,856-byte signature is the primary architectural impact. See Section 6 for required adjustments.

### 4.9 Why Not ML-DSA for Gate Tokens?

ML-DSA-65 would produce 3,309-byte signatures (vs 7,856 for SLH-DSA) and sign in <1ms. However:

1. **Security assumption diversity**: ML-DSA is lattice-based (Module-LWE). ML-KEM (command channel) is also lattice-based (Module-LWE). If lattice problems fall to a novel algorithm, both layers break simultaneously. SLH-DSA is hash-based — its security relies only on SHA-256 preimage/collision resistance, which is the most conservative assumption in cryptography.

2. **Gate tokens are the authorization root**: The command channel (KEM) protects data confidentiality, but the gate system protects authorization integrity. A forged gate token means an agent can self-approve destructive actions. This justifies the most conservative primitive available.

3. **Frequency tolerance**: Gate approvals are human-interactive operations. The 100ms signing overhead and 8 KB signature are invisible to a human clicking "Approve" in a browser extension.

---

## 5. Quantum-Blind Transaction Enforcement (Blockchain Defense)

### 5.1 Threat Model

While the Ellul.ai infrastructure is being upgraded to post-quantum primitives (Sections 2-4), the **external cryptocurrency networks** mediated by AI agents rely on classical ECDSA/Ed25519 cryptography that cannot be upgraded unilaterally.

Solana uses Ed25519 for transaction signing. An Ed25519 public key is generally hidden behind an address hash until the first time a transaction is **sent from** that address. Once a transaction is broadcast, the full public key is exposed on the public ledger, giving a CRQC the data it needs to compute the private key via Shor's algorithm.

**Current vulnerability**: Ellul.ai's Sovereign Shield uses a **single static Solana keypair per VPS** (`wallet-keypair.service.ts`). After the first outbound transaction, the Ed25519 public key is permanently exposed. All remaining funds — including future deposits — sit in a quantum-vulnerable account indefinitely.

**Three attack surfaces**:

| Attack | Mechanism | Impact |
|--------|-----------|--------|
| **SNDL on exposed pubkey** | Adversary records pubkey from blockchain today, derives private key with future CRQC | Complete wallet drain |
| **Rent-exempt dust accumulation** | Naive sweep leaves ~0.002 SOL rent reserve per address. 1,000 agents × 10 tx/day = millions in aggregate dust | Fleet-wide quantum bounty on public ledger |
| **Concurrent signing race (TOCTOU)** | Two parallel agent requests both pass `isAddressUsed()` before either records the signing | Double-sign from same address, broken wallet state |

### 5.2 Single-Use Address Invariant

**Rule**: The Sovereign Shield proxy MUST refuse to sign any outbound transaction from an address that has a prior outbound transaction recorded in the local signing ledger.

**Enforcement**: Local SQLite lookup — `SELECT 1 FROM used_signing_addresses WHERE address = ?`. This is a **complete record** because Shield is the sole custodian of the private keys. No Solana RPC call is needed.

**Fail-closed**: Even if the agent fails to broadcast a signed transaction (network error, blockhash expiry), the address is conservatively marked as used. Rationale: the agent could have broadcast the transaction to a colluding node that recorded the public key without propagating the transaction to the main network. Paranoid-by-default.

**Zero-Lamport Invariant**: Every outbound transaction MUST leave the origin account at exactly **0 lamports**. No rent-exempt dust may remain. The proxy MUST reject any transaction construction that would leave a non-zero balance in the signing account. See Section 5.8 for the enforcement mechanism.

### 5.3 HD Wallet Provisioning (BIP-44)

The single-keypair model is replaced with a Hierarchical Deterministic (HD) wallet rooted in a BIP-39 mnemonic seed.

**Derivation path**: `m/44'/501'/{account_index}'/0'`

- Coin type `501` = Solana (SLIP-44 registered)
- **ALL levels are hardened** (denoted by `'`). This is cryptographically critical: non-hardened Ed25519 derivation allows an attacker who compromises a child private key to compute the parent private key, compromising the entire wallet tree.
- The implementation MUST assert that every path component includes the hardened suffix. A derivation request for `m/44'/501'/0/0'` (non-hardened account index) MUST be rejected at the code level.
- Compatible with Phantom, Solflare, and other standard Solana wallets for recovery.

**Provisioning flow**:

1. Shield generates a 24-word BIP-39 mnemonic (256-bit entropy).
2. Mnemonic is converted to a 64-byte seed via PBKDF2-HMAC-SHA512 (BIP-39 standard, 2048 iterations).
3. Seed is encrypted and written to `wallet-seed.json` (see Section 5.4).
4. Mnemonic is displayed to the operator **once** via a secure one-time SSE event (`wallet_seed_backup` type) for offline backup.
5. Mnemonic is **never stored** on disk or in the platform database.
6. First receive address is derived at index 0: `m/44'/501'/0'/0'`.
7. HD state file initialized with `nextDerivationIndex: 1`, `currentReceiveIndex: 0`.

### 5.4 Seed File Format & Encryption

**File**: `/etc/ellul/shield-data/wallet-seed.json` (`root:shield 640`)

The seed is encrypted using the hybrid KEM from Section 2 (X25519 + ML-KEM-1024 + AES-256-GCM), ensuring quantum-safety at rest from day one:

```json
{
  "version": 2,
  "algorithm": "X25519+ML-KEM-1024+AES-256-GCM",
  "x25519_eph_pub": "<base64, 32 bytes>",
  "mlkem_ct": "<base64, 1568 bytes>",
  "iv": "<base64, 12 bytes>",
  "encryptedData": "<base64, AES-GCM(64-byte BIP-39 seed) + 16-byte auth tag>"
}
```

Total file size: ~2,200 bytes. For VPS instances still on RSA-4096 (pre-PQC migration from Section 7), the seed falls back to version 1 RSA-OAEP envelope, with automatic re-encryption to version 2 during PQC key rotation.

**HD State File**: `/etc/ellul/shield-data/wallet-hd-state.json` (`root:shield 640`)

```json
{
  "version": 2,
  "nextDerivationIndex": 42,
  "currentReceiveAddress": "7xKXt...3mPq",
  "currentReceiveIndex": 41,
  "createdAt": "2026-03-31T00:00:00Z",
  "updatedAt": "2026-03-31T12:00:00Z"
}
```

### 5.5 Address Derivation

**Implementation**: SLIP-10 derivation for Ed25519 via the `ed25519-hd-key` package (same library used by Phantom and Solflare). Pure JS, no native addons.

```typescript
import { derivePath } from "ed25519-hd-key";
import { Keypair } from "@solana/web3.js";

const SOLANA_BIP44_PREFIX = "m/44'/501'";

function deriveKeypairAtIndex(seed: Buffer, index: number): Keypair {
  // Enforce hardened-only derivation
  const path = `${SOLANA_BIP44_PREFIX}/${index}'/0'`;

  // Defense-in-depth: verify all components are hardened
  const components = path.split("/").slice(1); // skip 'm'
  for (const component of components) {
    if (!component.endsWith("'")) {
      throw new Error(
        `SECURITY: Non-hardened derivation component "${component}" in path "${path}". ` +
        `Ed25519 HD wallets MUST use hardened derivation at all levels.`
      );
    }
  }

  const derived = derivePath(path, seed.toString("hex"));
  return Keypair.fromSeed(derived.key); // derived.key is 32-byte Ed25519 seed
}
```

**Index exhaustion**: With 2^31 hardened indices, at 1 transaction per second, exhaustion takes ~68 years. At the maximum observed rate of 10 tx/min (wallet rate limit), exhaustion takes ~408 years. The implementation MUST reject derivation at `index >= 2^31` and alert the operator.

### 5.6 SQLite Schema: Used Address Registry + Signing Mutex

**New table** in `local-auth.db`:

```sql
CREATE TABLE IF NOT EXISTS used_signing_addresses (
  address TEXT PRIMARY KEY,                          -- Base58 Solana address
  derivation_index INTEGER NOT NULL,                 -- HD wallet derivation index
  first_signed_at INTEGER NOT NULL,                  -- Epoch milliseconds
  tx_id TEXT NOT NULL,                               -- References wallet_transactions.tx_id
  swept_to TEXT,                                     -- Base58 change address (NULL if full drain)
  drain_verified INTEGER NOT NULL DEFAULT 1          -- 1 = zero-lamport drain confirmed
);

CREATE INDEX IF NOT EXISTS idx_used_addr_index
  ON used_signing_addresses(derivation_index);
```

**New columns** on `wallet_transactions`:

```sql
ALTER TABLE wallet_transactions ADD COLUMN from_address TEXT;
ALTER TABLE wallet_transactions ADD COLUMN change_address TEXT;
ALTER TABLE wallet_transactions ADD COLUMN derivation_index INTEGER;
ALTER TABLE wallet_transactions ADD COLUMN sweep_amount_lamports INTEGER;
ALTER TABLE wallet_transactions ADD COLUMN quantum_blind_check TEXT;  -- 'PASSED' | 'FAILED' | 'LEGACY'
```

**In-memory signing mutex** (NOT in SQLite — Shield is a single Node.js process):

```typescript
const signingLocks = new Map<number, { resolve: () => void }>();

function tryAcquireSigningLock(index: number): (() => void) | null {
  if (signingLocks.has(index)) return null; // Already locked

  let releaseFn!: () => void;
  const promise = new Promise<void>((resolve) => { releaseFn = resolve; });
  signingLocks.set(index, { resolve: releaseFn });

  return () => {
    signingLocks.delete(index);
    releaseFn();
  };
}
```

On process crash, the in-memory lock is implicitly released. The SQLite `used_signing_addresses` INSERT is the durable commit — if it didn't happen before the crash, the address is still fresh on restart.

### 5.7 Quantum-Blind Check with Signing Mutex

The quantum-blind check is inserted into the `POST /api/internal/wallet/transaction` handler **after** the gate check and **before** keypair decryption.

**File to modify**: `packages/vps/src/services/auth/sovereign-shield/src/routes/workflow.routes.ts` (line ~3660)

```typescript
// ── QUANTUM-BLIND CHECK ──

// 1. Read current derivation index
const currentIndex = getCurrentReceiveIndex();
const currentAddress = getCurrentReceiveAddress();

// 2. Acquire signing mutex (prevents TOCTOU race)
const releaseLock = tryAcquireSigningLock(currentIndex);
if (!releaseLock) {
  return c.json({
    error: "ADDRESS_LOCKED_FOR_SWEEP",
    message: "Another transaction is being signed from this address. Retry after sweep completes.",
    retryAfterMs: 2000,
    currentAddress,
  }, 409);
}

try {
  // 3. Check if address has prior outbound transactions
  if (isAddressUsed(currentAddress)) {
    return c.json({
      error: "QUANTUM_BLIND_REJECT",
      message: "Signing address has prior outbound transactions. " +
               "Public key is exposed on the Solana ledger. " +
               "Call POST /api/internal/wallet/rotate to advance to a fresh address.",
      address: currentAddress,
      quantumBlindCheck: "FAILED",
    }, 403);
  }

  // 4. Proceed with keypair load, transaction construction, signing...
  // ... (existing code, modified for atomic sweep per Section 5.8)

  // 5. AFTER signing: mark address used and advance index (UNDER LOCK)
  markAddressUsed(currentAddress, currentIndex, txId, changeAddress);
  advanceToNextAddress(nextIndex, nextAddress);

} finally {
  // 6. Release lock (always, even on error)
  releaseLock();
}
```

**New endpoint**: `POST /api/internal/wallet/rotate`
- Forces advancement to next derivation index without a transaction.
- Use case: address was leaked via a failed broadcast attempt, or operator wants to preemptively rotate.

**New endpoint**: `GET /api/internal/wallet/status`
```json
{
  "currentAddress": "7xKXt...3mPq",
  "derivationIndex": 42,
  "quantumBlindCheck": "PASSED",
  "addressUsedCount": 41,
  "hdWalletVersion": 2,
  "nextDerivationIndex": 43
}
```

### 5.8 Atomic Sweep with Account Closure

**The Solana Rent-Exemption Trap**: Every Solana account requires a minimum rent-exemption balance (~2,039,280 lamports / ~0.002 SOL) to persist on the ledger. A naive `balance - fee` sweep leaves this rent reserve in the account — a mathematically guaranteed, quantum-vulnerable bounty on a public address with an exposed Ed25519 key.

At fleet scale (1,000 agents × 10 transactions/day × 0.002 SOL dust per address), this accumulates to **~20 SOL/day** in quantum-vulnerable dust across the fleet. Over the 3-year CRQC timeline, this totals **~21,900 SOL** (~$4.4M at $200/SOL) in trivially harvestable funds.

**Zero-Lamport Invariant**: Every outbound transaction MUST leave the origin account at exactly **0 lamports**. The proxy enforces this by construction.

**Transaction construction** (multi-instruction Solana transaction):

```typescript
const SOLANA_RENT_EXEMPT_MINIMUM = 890_880; // Minimum for system account (0 data bytes)
// Note: token accounts require 2,039,280. System accounts need less.

const transaction = new Transaction();
transaction.recentBlockhash = recentBlockhash;
transaction.feePayer = currentKeypair.publicKey;

// Fee estimate: 5,000 lamports per signature (Solana base fee)
// + 200 lamports per instruction (compute budget)
const instructionCount = sweepNeeded ? 2 : 1;
const estimatedFee = 5_000 + (instructionCount * 200);

// Instruction 1: Transfer requested amount to recipient
transaction.add(
  SystemProgram.transfer({
    fromPubkey: currentKeypair.publicKey,
    toPubkey: new PublicKey(recipient),
    lamports: amountLamports,
  }),
);

// Calculate sweep amount
const sweepAmount = balanceLamports - amountLamports - estimatedFee;

if (sweepAmount < 0) {
  // Insufficient balance (including fees) — reject
  return c.json({
    error: "INSUFFICIENT_BALANCE",
    balanceLamports,
    requested: amountLamports,
    estimatedFee,
  }, 400);
}

if (sweepAmount > 0 && sweepAmount < SOLANA_RENT_EXEMPT_MINIMUM) {
  // Dust trap: change address would be created below rent-exemption
  // Solana runtime would reject this anyway, but we catch it early
  // with an actionable error message.
  return c.json({
    error: "QUANTUM_DUST_TRAP",
    message: "Sweep amount is below Solana rent-exemption minimum. " +
             "Adjust amountLamports to leave either 0 or >= " +
             SOLANA_RENT_EXEMPT_MINIMUM + " lamports for the change address.",
    sweepAmount,
    rentExemptMinimum: SOLANA_RENT_EXEMPT_MINIMUM,
    suggestion: {
      maxSendWithoutSweep: balanceLamports - estimatedFee,
      maxSendWithSweep: balanceLamports - estimatedFee - SOLANA_RENT_EXEMPT_MINIMUM,
    },
  }, 400);
}

if (sweepAmount >= SOLANA_RENT_EXEMPT_MINIMUM) {
  // Instruction 2: Sweep remaining balance to fresh change address
  const changeKeypair = deriveKeypairAtIndex(seed, nextDerivationIndex);
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: currentKeypair.publicKey,
      toPubkey: changeKeypair.publicKey,
      lamports: sweepAmount,
    }),
  );
  changeKeypair.secretKey.fill(0); // Zero change key (only pubkey needed)
}

// Verify zero-drain invariant
const totalOut = amountLamports + sweepAmount + estimatedFee;
if (totalOut !== balanceLamports) {
  // This should be unreachable given the arithmetic above,
  // but defense-in-depth against integer bugs.
  throw new Error(
    `ZERO_DRAIN_VIOLATION: ${totalOut} !== ${balanceLamports}`
  );
}

transaction.sign(currentKeypair);
```

**Agent-provided `balanceLamports`**: The agent must query Solana RPC for the current balance and pass it to the proxy. This is an untrusted input, but the design is **fail-safe**: if the agent provides an incorrect balance, the transaction will fail on-chain (insufficient funds or incorrect amount). The address is still conservatively marked as used by the proxy regardless of broadcast outcome.

**New request body field**:
```typescript
{
  // ... existing fields ...
  balanceLamports: number;  // REQUIRED for HD wallet (v2). Current on-chain balance.
}
```

### 5.9 Operator UX: Gate Metadata Enrichment

When an agent requests a `wallet_spend` gate, the SSE event to the operator's browser extension is enriched with quantum-blind context:

**File to modify**: `packages/vps/src/services/auth/sovereign-shield/src/routes/gate-api.routes.ts`

**Enriched SSE payload** (added to `gate_request` event for `wallet_spend` gates):

```typescript
{
  // ... existing fields (requestId, gate, reason, project) ...
  walletContext: {
    currentAddress: "7xKXt...3mPq",
    derivationIndex: 42,
    quantumBlindCheck: "PASSED",  // or "FAILED"
    addressUsedCount: 41,
    hdWalletActive: true,
    changeAddress: "9pRbN...7kWz",  // Pre-computed next address
  }
}
```

**Operator display** (in browser extension / REPL):

```
┌─────────────────────────────────────────────────┐
│ Gate Request: wallet_spend                       │
│ Reason: "Transfer 2 SOL to merchant"             │
│ Project: sbx-a1b2c3d                             │
│                                                   │
│ ✓ Quantum-Blind Check: PASSED                    │
│   Signing Address: 7xKXt...3mPq (#42)           │
│   Status: FRESH (never used for outbound)         │
│   Change Address: 9pRbN...7kWz (#43)             │
│                                                   │
│ Transfer: 2.0 SOL → Gx4Rm...8nQp                │
│ Sweep:    3.495 SOL → 9pRbN...7kWz (change)     │
│ Fee:      ~0.005 SOL (estimated)                 │
│                                                   │
│ Guarantee: Origin public key is unexposed.       │
│                                                   │
│ [Approve (5 min)]  [Approve (session)]  [Deny]  │
└─────────────────────────────────────────────────┘
```

If the quantum-blind check **fails**:

```
│ ✗ Quantum-Blind Check: FAILED                    │
│   Signing Address: 7xKXt...3mPq (#42)           │
│   Status: EXPOSED (outbound tx on 2026-03-15)    │
│   WARNING: This address's Ed25519 public key is  │
│   on the Solana ledger. Signing is BLOCKED.      │
│   Agent must call /wallet/rotate first.          │
```

### 5.10 Migration: Single Keypair → HD Wallet

Existing VPS instances with the legacy single-keypair model (`wallet-keypair.json` v1) must migrate to HD wallets without losing access to funds.

**Migration trigger**: Shield startup detects `wallet-keypair.json` exists but `wallet-seed.json` does not.

**Migration flow**:

1. **Generate HD wallet**: Create BIP-39 mnemonic, derive 64-byte seed, encrypt to `wallet-seed.json` using current `node.key` envelope format (v1 RSA or v2 hybrid, depending on PQC migration state).

2. **Initialize HD state**: Derive address at index 0 = new receive address. Write `wallet-hd-state.json` with `nextDerivationIndex: 1, currentReceiveIndex: 0`.

3. **Mark legacy address as used**: Insert the legacy keypair address into `used_signing_addresses` with `derivation_index: -1` (sentinel for non-HD), `drain_verified: 0` (funds may still be present). This ensures the proxy will never sign from the legacy address again.

4. **Operator notification**: Push SSE event `wallet_hd_migration` with:
   - The BIP-39 mnemonic (one-time backup — operator must record this)
   - The legacy address (funds must be transferred)
   - The new receive address (index 0)
   - Instructions to transfer funds from legacy → index 0

5. **Legacy keypair preserved**: `wallet-keypair.json` is NOT deleted. It remains for:
   - Any in-flight signed transactions referencing the old address
   - Read-only balance checks
   - Emergency recovery if HD wallet is corrupted

6. **Platform sync**: Next heartbeat reports updated wallet state to platform DB (version 2, new receive address, HD fingerprint).

**File to modify**: `packages/vps/src/services/auth/sovereign-shield/src/services/wallet-keypair.service.ts` — `initWalletIfEnabled()` gains HD migration logic.

### 5.11 Files Requiring Modification

| File | Change | Priority |
|------|--------|----------|
| `packages/vps/.../services/wallet-keypair.service.ts` | HD seed generation, derivation, version dispatch, migration | P0 |
| `packages/vps/.../services/wallet-ledger.service.ts` | `used_signing_addresses` table, signing mutex, `isAddressUsed()` | P0 |
| `packages/vps/.../routes/workflow.routes.ts` | Quantum-blind check, atomic sweep, `/rotate`, `/status` endpoints | P0 |
| `packages/vps/.../routes/gate-api.routes.ts` | SSE enrichment with quantum-blind metadata | P1 |
| `packages/vps/.../config.ts` | HD wallet constants (paths, BIP-44 prefix, rent-exempt minimum) | P0 |
| `packages/db/src/schema.ts` | `walletVersion`, `derivationIndex`, `hdWalletFingerprint` on `serverWallets`; new columns on `walletTransactions` | P1 |

**New NPM dependencies**:

| Package | Purpose | Side |
|---------|---------|------|
| `ed25519-hd-key` | SLIP-10 HD derivation for Ed25519 (Solana BIP-44) | VPS (Shield) |
| `bip39` | BIP-39 mnemonic generation (used once at seed creation) | VPS (Shield) |

### 5.12 Threat Model Update

| Threat | Pre-QBTE Status | Post-QBTE Status |
|--------|-----------------|------------------|
| CRQC derives wallet private key from exposed Ed25519 pubkey | **VULNERABLE** (address reused indefinitely) | **MITIGATED** (single-use addresses, zero-lamport drain) |
| Partial spend leaves funds in exposed address | **VULNERABLE** (no sweep logic) | **MITIGATED** (atomic sweep + account closure) |
| Rent-exempt dust accumulation across fleet | **VULNERABLE** (~$4.4M exposure over 3 years) | **MITIGATED** (proxy rejects non-draining transactions) |
| Concurrent signing race condition (TOCTOU) | **VULNERABLE** (no locking) | **MITIGATED** (in-memory signing mutex, 409 on contention) |
| Non-hardened derivation leaks parent keys | N/A (no HD wallet) | **PREVENTED** (all-hardened path enforcement with runtime assertion) |
| Agent self-approves wallet drain | Not vulnerable (operator signature required) | Not vulnerable (unchanged — SLH-DSA per Section 4) |
| Deposit to previously-used address | **Accepted risk** | **Accepted risk** (platform updates deposit address; funds at old address require manual recovery) |

---

## 6. Fat Key Reality Check: Architectural Adjustments

### 6.1 Size Comparison Table

| Field | Current Size | PQC Size | Growth Factor |
|-------|-------------|----------|---------------|
| `servers.publicKey` (node.pub) | ~1,700 chars (RSA-4096 PEM) | ~2,180 chars (hybrid JSON) | 1.3x |
| `server_commands.payload` (E2EE envelope) | ~800 chars | ~2,300 chars | 2.9x |
| `servers.migrationSigningPublicKey` | ~120 chars (Ed25519 PEM) | ~2,700 chars (hybrid JSON) | 22x |
| Migration manifest `signature` field | 88 chars (64 B Ed25519) | ~4,500 chars (dual sig) | 51x |
| Operator signature (gate response body) | 88 chars (64 B ECDSA) | ~10,476 chars (7,856 B SLH-DSA) | 119x |
| `serverSecrets.encryptedKey` (per secret) | ~684 chars (RSA-OAEP) | ~2,136 chars (hybrid KEM) | 3.1x |
| HD wallet seed file (`wallet-seed.json`) | N/A (single keypair) | ~2,200 chars (hybrid KEM envelope for 64-byte seed) | New |

### 6.2 Database Schema Changes

**No column type changes required.** All affected columns are PostgreSQL `text` type (unbounded). The `json` columns (`server_commands.payload`) are also unbounded. PostgreSQL `text` and `json` can hold up to 1 GB per value.

**However**, the following index and query optimizations are needed:

```sql
-- Migration: 0042_pqc_schema_adjustments.sql

-- 1. Add version tracking to servers table for key format dispatch
ALTER TABLE servers ADD COLUMN IF NOT EXISTS public_key_version integer DEFAULT 1;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS migration_signing_key_version integer DEFAULT 1;

-- 2. No TOAST threshold changes needed — PostgreSQL automatically TOASTs
--    text values >2KB. The PQC key sizes (2-5 KB) will naturally TOAST,
--    which is correct behavior (keys are read infrequently, inline storage
--    would bloat the heap page).

-- 3. Add partial index for PQC-upgraded servers (speeds up migration tracking)
CREATE INDEX IF NOT EXISTS idx_servers_pqc_upgraded
  ON servers (id) WHERE public_key_version = 2;
```

### 6.3 API Transit Limits

**Current body limit**: 1 MB (`MAX_BODY_SIZE = 1024 * 1024` in `middleware.ts`).

**PQC impact analysis**:
- Largest single PQC payload: Gate response with SLH-DSA signature = ~11 KB. Well within 1 MB.
- Bulk secrets endpoint (batch encrypt): 50 secrets × 2.3 KB envelope = ~115 KB. Well within 1 MB.
- Block migration manifest with 1000 chunks + dual signatures: ~80 KB. Well within 1 MB.

**No body limit change required.** The 1 MB limit has ~10x headroom over the largest PQC payload.

### 6.4 Heartbeat Payload Size

The enforcer heartbeat sends the public key on registration. Current RSA-4096 PEM is ~1,700 chars. The hybrid JSON is ~2,180 chars.

**No change required.** The heartbeat payload is well within the 1 MB body limit and typical HTTP client buffers.

### 6.5 Bash Command-Line Argument Limits

**Critical issue**: The current `decrypt.sh` passes the base64 envelope as command-line arguments:

```bash
DECRYPTED=$(/usr/local/bin/ellul-decrypt "$ENC_KEY" "$ENC_IV" "$ENC_DATA")
```

The ML-KEM ciphertext is ~2,092 base64 chars. Linux `ARG_MAX` is typically 2 MB (`getconf ARG_MAX` → 2097152). This is NOT a problem for individual arguments.

**However**, the current heartbeat.sh extracts envelope fields with `jq` and passes them as separate CLI args. The PQC envelope should be passed as a single JSON blob via stdin instead:

```bash
# BEFORE (current — CLI args):
ENC_KEY=$(echo "$CMD_PAYLOAD" | jq -r '.encryptedKey')
DECRYPTED=$(/usr/local/bin/ellul-decrypt "$ENC_KEY" "$ENC_IV" "$ENC_DATA")

# AFTER (PQC — stdin pipe):
echo "$CMD_PAYLOAD" | /usr/local/bin/ellul-decrypt --key /etc/ellul/node.key --stdin
```

This also eliminates the security concern of sensitive ciphertext appearing in `/proc/*/cmdline`.

### 6.6 Node.js Memory Buffers

**ML-KEM-1024 decapsulation key**: 3,168 bytes in memory. The current RSA-4096 private key PEM is ~3,200 bytes. **No change** — same memory footprint.

**`@noble/post-quantum` memory usage**:
- ML-KEM-1024 encapsulate: ~50 KB peak (matrix operations)
- ML-KEM-1024 decapsulate: ~50 KB peak
- ML-DSA-65 sign: ~100 KB peak (NTT operations)
- ML-DSA-65 verify: ~80 KB peak
- SLH-DSA-SHA2-128s sign: ~200 KB peak (Merkle tree construction)
- SLH-DSA-SHA2-128s verify: ~50 KB peak

All well within Node.js heap limits (default 1.7 GB). No `--max-old-space-size` adjustment needed.

### 6.7 Browser Bundle Size Impact

| Package | Gzipped Size | Purpose |
|---------|-------------|---------|
| `@noble/post-quantum` (ML-KEM + ML-DSA + SLH-DSA) | ~80 KB | Console encryption, extension signing |
| `@noble/curves` (X25519) | ~25 KB | Already in bundle for Ed25519 |

**Total bundle increase**: ~80 KB gzipped. The admin console is not a public-facing app (authenticated users only), so this is acceptable.

### 6.8 WebSocket Frame Limits (Agent Bridge)

The agent-bridge WebSocket channel does NOT carry E2EE envelopes (it uses STS tokens + HMAC for auth). No changes needed.

### 6.9 Secrets Table (Per-Secret Encryption)

Each secret in `serverSecrets` has an `encryptedKey` column. Currently this holds ~684 chars (RSA-OAEP). With hybrid KEM, we store the full envelope per secret:

```json
{
  "version": 2,
  "x25519_eph_pub": "base64(32 B)",
  "mlkem_ct": "base64(1568 B)",
  "iv": "base64(12 B)",
  "encryptedData": "base64(ciphertext + tag)"
}
```

The `encryptedKey` column is repurposed to hold this JSON. Column type is already `text`. A server with 100 secrets would store ~230 KB of encrypted key material (vs ~68 KB currently). PostgreSQL handles this without issue.

**Schema migration**: No column type change. Add a `version` check in the decryption path.

---

## 7. Migration Strategy

### 7.1 Design Principles

1. **No split-brain**: At no point should the API encrypt with PQC for a VPS that only understands RSA, or vice versa.
2. **TOFU-safe**: Existing TOFU registrations (Ed25519 migration keys) must be honored. PQC key rotation must go through the same CAS (compare-and-set) mechanism.
3. **Atomic key rotation**: A VPS transitions from v1 to v2 as a single operation — never in a state where some components use v1 and others use v2.
4. **Backward-compatible window**: Both v1 and v2 envelopes/signatures are accepted during the migration window. The window closes via a server-side flag.

### 7.2 Migration Phases

```
Phase 0: Preparation (no VPS changes)
  ├── Ship @noble/post-quantum to API + console + extension
  ├── Ship ellul-keygen and ellul-decrypt binaries to VPS image
  ├── Deploy API with dual-version encryption/verification support
  └── Duration: 1 deploy cycle

Phase 1: New Servers Get PQC (green-field)
  ├── crypto-keys.sh generates hybrid keypairs on new servers
  ├── API detects version: 2 in publicKey, uses hybrid encryption
  ├── Existing servers continue with RSA (version: 1 or no version)
  └── Duration: Immediate after Phase 0

Phase 2: Fleet Rotation (brown-field)
  ├── Triggered per-server via "rotate-to-pqc" command type
  ├── VPS generates new hybrid keypair, reports new public key
  ├── API atomically swaps publicKey + publicKeyVersion
  ├── Old RSA key archived to /etc/ellul/node.key.v1.bak (vault)
  └── Duration: Weeks (rolling, rate-limited by fleet size)

Phase 3: Deprecation Window
  ├── API logs warnings for v1 key usage
  ├── Console shows "Quantum-Vulnerable" badge for v1 servers
  ├── No new v1 keys accepted (registration rejects RSA PEM)
  └── Duration: 90 days

Phase 4: Hard Cutover
  ├── API rejects v1 envelopes for encryption
  ├── v1 decryption still supported on VPS (for in-flight commands)
  ├── After 24h drain: v1 code paths removed
  └── Duration: 1 day
```

### 7.3 Phase 2 Detail: Per-Server Key Rotation

The rotation is orchestrated via the existing command channel. This creates a bootstrap problem: we need the command channel (currently RSA) to deliver the instruction to rotate to PQC. This is safe because:

1. The rotation command itself contains no long-lived secrets (it's just "generate new keypair and report it").
2. Even if an adversary records this RSA-encrypted command and later decrypts it, they learn nothing — the command payload is `{ "action": "rotate-to-pqc" }`.
3. The new PQC public key is sent back over HTTPS (TLS 1.3) which is separately quantum-vulnerable, but the key itself is not secret — it's a public key.

**Rotation command flow**:

```
API                                    VPS (Enforcer)
 │                                      │
 │──── E2EE(RSA, {action: "rotate"}) ──→│
 │                                      │ 1. Generate hybrid keypair
 │                                      │ 2. Write node.key.v2, node.pub.v2
 │                                      │ 3. Atomic rename:
 │                                      │    mv node.key node.key.v1.bak
 │                                      │    mv node.key.v2 node.key
 │                                      │    mv node.pub.v2 node.pub
 │                                      │ 4. Invalidate key cache (mtime change)
 │                                      │
 │←── heartbeat { publicKey: v2 JSON } ─│
 │                                      │
 │ 5. API verifies v2 format            │
 │ 6. CAS update:                       │
 │    SET publicKey = v2_json,           │
 │        publicKeyVersion = 2           │
 │    WHERE publicKey = v1_pem           │
 │ 7. All subsequent commands use hybrid │
```

**Failure recovery**: If the VPS generates a new key but the API never receives it (network failure, crash):
- The VPS continues to heartbeat with the new v2 public key.
- The API eventually processes the heartbeat and CAS-updates the key.
- In the interim, any commands encrypted with the old v1 key will fail to decrypt on the VPS.
- The command will timeout (10-minute TTL), and the API will retry.
- On the next heartbeat, the API picks up the new key and re-encrypts.

**No split-brain**: The CAS update ensures the API's stored key always matches what the VPS can decrypt. If CAS fails (concurrent update), the heartbeat retries on the next cycle (30s).

### 7.3.1 Phase 2.5: HD Wallet Rollout

Triggered per-server alongside the PQC key rotation (Phase 2). When the `rotate-to-pqc` command completes, if the wallet feature is enabled, Shield automatically:

1. Detects single-keypair `wallet-keypair.json` (v1) without `wallet-seed.json`.
2. Executes the HD wallet migration from Section 5.10.
3. Re-encrypts the seed file using the newly-rotated hybrid `node.key` (v2).
4. Reports updated wallet state (version 2, HD fingerprint, new receive address) in the next heartbeat.

**New servers** (provisioned after Phase 1) generate HD wallets by default if the wallet feature is enabled. No single-keypair path exists for v2 servers.

**Existing servers without wallet feature**: No action needed. HD wallet provisioning occurs on first `wallet` feature enable, using whatever `node.key` format is current at that time.

### 7.4 Migration Signing Key Rotation

Migration signing keys have stricter immutability requirements (the DB CAS prevents overwrite for anti-forgery). Rotation requires a new mechanism:

```sql
-- Allow version upgrade (not arbitrary overwrite)
UPDATE servers
SET migration_signing_public_key = $new_v2_json,
    migration_signing_key_version = 2
WHERE id = $server_id
  AND migration_signing_key_version = 1
  AND migration_signing_public_key = $old_v1_pem;
```

This is a one-way upgrade: v1→v2 only, requires the old key to match (prevents race conditions), and the version column prevents downgrade.

**Trigger**: The VPS generates the new hybrid signing keypair during the next block migration preparation (lazy rotation). If no migration occurs, the key remains Ed25519 — this is acceptable because the migration signing key is only used during migrations, and we can force-rotate via a command if needed.

### 7.5 Operator Key Migration (Gate Tokens)

Operator keys are ephemeral (session-scoped, generated on each login). No fleet rotation needed. The migration path is:

1. Ship SLH-DSA support to browser extension / REPL daemon.
2. On next login, the extension generates an SLH-DSA keypair instead of ECDSA P-256.
3. The public key is bound to the session via the existing nonce exchange.
4. Sovereign Shield detects SLH-DSA by signature length (7,856 bytes) during verification.
5. During the migration window, both ECDSA (64-byte sig) and SLH-DSA (7,856-byte sig) are accepted.
6. After the window closes, only SLH-DSA is accepted.

**No server-side rotation required.** Operator keys rotate naturally on every login.

### 7.6 Volume Vault Compatibility

The vault system preserves `/etc/ellul/` across hibernate/wake cycles via bind mounts. Key format changes are transparent to the vault because:

1. The vault preserves files by path, not by content format.
2. `node.key` at path `/etc/ellul/node.key` is preserved regardless of whether it contains RSA PEM or hybrid JSON.
3. The `version` field in the JSON enables the decryption path to dispatch correctly after wake.

**Wake guard update**: The existing wake guard in `boot-config.ts` checks `if (fs.existsSync('/etc/ellul/node.key'))`. This remains correct — the guard skips generation if any key exists, regardless of format.

### 7.7 Rollback Plan

If ML-KEM or ML-DSA are found to have critical vulnerabilities post-deployment:

1. **KEM hybrid construction provides immediate classical fallback.** The X25519 component of the KEM remains intact. Migration signatures are ML-DSA-65 only (no classical component), but SLH-DSA (hash-based) is available as a non-lattice alternative.
2. **API can force-downgrade** by sending a `rotate-to-classical` command that regenerates RSA-4096 / Ed25519 keys.
3. **Version dispatch code remains in place** permanently (it costs nothing and provides crypto-agility).
4. **SLH-DSA has no lattice dependency** — it cannot be broken by a lattice algorithm breakthrough. It would only fall if SHA-256 preimage resistance breaks, which would also break TLS, Bitcoin, and the rest of the internet.

---

## 8. Cryptographic Inventory Crosswalk

### 8.1 Files Requiring Modification

| File | Change | Priority |
|------|--------|----------|
| `apps/api/src/security/crypto/vps-encrypt.ts` | Add `encryptForVpsHybrid()`, version dispatch | P0 |
| `apps/api/src/engines/shared/provisioning.ts` | Version-aware encryption dispatch in `enqueueAndWait()` | P0 |
| `apps/api/src/provisioning/shell/packages/crypto-keys.sh` | Hybrid keygen, binary install | P0 |
| `packages/vps/src/shell/security/decrypt.sh` | Replace with `ellul-decrypt` binary call | P0 |
| `packages/vps/src/services/auth/sovereign-shield/src/services/secrets.service.ts` | Add `decryptHybridEnvelope()`, version dispatch | P0 |
| `apps/console/src/lib/crypto.ts` | Add `encryptSecretPQC()` with `@noble/post-quantum` | P0 |
| `packages/vps/src/services/daemons/enforcer/lib/heartbeat.sh` | Stdin-based decryption, version-aware key reporting | P0 |
| `apps/api/src/services/migration-manifest.ts` | Dual-signature verification, version dispatch | P1 |
| `packages/vps/src/services/daemons/enforcer/lib/block-migrate.sh` | Hybrid signing, `ellul-sign` binary | P1 |
| `packages/vps/src/services/auth/sovereign-shield/src/routes/gate-api.routes.ts` | SLH-DSA operator sig verification + intent sig enforcement + quantum-blind SSE metadata | P0 |
| `packages/vps/src/services/auth/sovereign-shield/src/auth/pop.ts` | `verifyPopHmac()`, HMAC SW JS, ML-KEM client JS, version dispatch | P0 |
| `packages/vps/src/services/auth/sovereign-shield/src/routes/session.routes.ts` | `/bind/init`, `/bind/complete`, `/_auth/intent/nonce`, `pqc-mlkem.js` serving | P0 |
| `packages/vps/src/services/auth/sovereign-shield/src/database.ts` | `pop_hmac_key`, `pop_version`, `pop_prf_bound`, `intent_public_key` columns | P0 |
| `packages/auth-proxy/src/pop-signer.ts` | ML-KEM handshake, HMAC signing, intent keypair generation | P0 |
| `packages/vps/src/services/auth/sovereign-shield/bundle.ts` | esbuild entry for `pqc-mlkem.js` browser bundle | P1 |
| `packages/vps/src/services/auth/sovereign-shield/src/services/wallet-keypair.service.ts` | HD seed generation, SLIP-10 derivation, version dispatch, migration | P0 |
| `packages/vps/src/services/auth/sovereign-shield/src/services/wallet-ledger.service.ts` | `used_signing_addresses` table, signing mutex, `isAddressUsed()` | P0 |
| `packages/vps/src/services/auth/sovereign-shield/src/routes/workflow.routes.ts` | Quantum-blind check, atomic sweep with account closure, `/rotate`, `/status` | P0 |
| `packages/vps/src/services/auth/sovereign-shield/src/config.ts` | HD wallet constants (BIP-44 prefix, rent-exempt minimum, seed paths) | P0 |
| `packages/vps/src/services/auth/sovereign-shield/src/auth/pop.ts` | No change (PoP stays ECDSA) | — |
| `packages/db/src/schema.ts` | Add version columns | P0 |
| `apps/api/src/routes/servers/commands.routes.ts` | No change (payload is opaque JSON) | — |
| `apps/api/src/security/middleware/middleware.ts` | No change (1 MB limit sufficient) | — |

### 8.2 New Binaries Required

| Binary | Language | Purpose | Install Path | Size |
|--------|----------|---------|-------------|------|
| `ellul-crypto` | Rust | All PQC operations: keygen (kem/sign), decrypt, sign, verify | `/usr/local/bin/ellul-crypto` | ~3 MB |

> **Implementation note**: The original spec described four separate binaries. The implementation consolidates them into a single binary with subcommands (`keygen kem`, `keygen sign`, `decrypt`, `sign`, `verify`), which simplifies provisioning and reduces binary management overhead.

All binaries: statically linked (musl), `mlock` key material, `zeroize` on drop, dual-arch (`x86_64` + `aarch64`).

**Alternative**: Consolidate into a single `ellul-crypto` binary with subcommands (`keygen`, `decrypt`, `sign`, `verify`). Reduces Packer image size and update surface.

### 8.3 New NPM Dependencies

| Package | Version | Usage | Side |
|---------|---------|-------|------|
| `@noble/post-quantum` | `>=0.2.0` | ML-KEM-1024, ML-DSA-65, SLH-DSA-SHA2-128s | API, Console, VPS (Shield), Extension |
| `@noble/curves` | `>=1.4.0` | X25519 (already depends on for Ed25519) | API, Console, VPS |
| `ed25519-hd-key` | `>=1.3.0` | SLIP-10 HD derivation for Ed25519 (Solana BIP-44) | VPS (Shield) |
| `bip39` | `>=3.1.0` | BIP-39 mnemonic generation (used once at seed creation) | VPS (Shield) |

`@noble/post-quantum` is authored by Paul Miller (same as `@noble/curves`), is pure JS (no native addons), and has been audited by Trail of Bits. It implements FIPS 203/204/205 final specifications.

### 8.4 Rust Crate Dependencies (for binaries)

| Crate | Purpose |
|-------|---------|
| `pqcrypto-mlkem` | ML-KEM-1024 (wraps reference C implementation) |
| `pqcrypto-dilithium` | ML-DSA-65 |
| `pqcrypto-sphincsplus` | SLH-DSA-SHA2-128s |
| `x25519-dalek` | X25519 ECDH |
| `ed25519-dalek` | Ed25519 signatures |
| `aes-gcm` | AES-256-GCM |
| `hkdf` + `sha2` | HKDF-SHA256 |
| `zeroize` | Secure memory wiping |
| `memsec` | `mlock` support |

### 8.5 Test Vectors

Cross-implementation consistency tests MUST pass before deployment:

1. **KEM round-trip**: API (Node.js `@noble`) encrypts → VPS (Rust `pqcrypto-mlkem`) decrypts → plaintext matches.
2. **Signature cross-verify**: VPS (Rust) signs → API (Node.js `@noble`) verifies → passes.
3. **Browser cross-verify**: Console (JS `@noble`) encrypts → VPS (Rust) decrypts → plaintext matches.
4. **Legacy interop**: v1 RSA envelopes still decrypt on VPS during migration window.
5. **NIST KAT vectors**: All implementations pass NIST Known Answer Tests for FIPS 203/204/205.
6. **Quantum-blind round-trip**: Derive keypair at index N, sign transaction, verify `used_signing_addresses` contains address, verify `isAddressUsed()` returns true, verify next derivation advances to N+1.
7. **Atomic sweep verification**: Construct 2-instruction transaction, verify `amountLamports + sweepAmount + fee == balanceLamports` (zero-drain invariant).
8. **Signing mutex contention**: Two concurrent requests to same derivation index — first succeeds, second gets 409 `ADDRESS_LOCKED_FOR_SWEEP`.
9. **Rent-exempt dust guard**: Attempt sweep with `sweepAmount < 890,880` lamports — verify 400 `QUANTUM_DUST_TRAP` rejection.
10. **Hardened derivation enforcement**: Attempt `deriveKeypairAtIndex` with non-hardened path component — verify runtime assertion throws.
11. **ML-KEM PoP handshake round-trip**: Browser encapsulates, server decapsulates — `K_pop` matches on both sides, `bind_proof` validates.
12. **HMAC-SHA256 request signing**: Server verifies `X-PoP-MAC` correctly with `timingSafeEqual`.
13. **Intent signature enforcement**: Gate action without `X-Intent-Signature` → 403. HMAC-only to intent-required endpoint → 403 (downgrade protection).
14. **Intent signature verification**: ML-DSA-44 and SLH-DSA-SHA2-128s signatures validate against stored public key.
15. **Layer separation**: Standard GET request passes with only HMAC (no intent sig required).
16. **Intent nonce challenge-scoping**: Nonce issued for `wallet_spend` action rejected when used for `deploy` action.
17. **Intent timestamp enforcement**: Signature >30s old → rejected. Timestamp >5s in future → rejected.

### 8.6 Threat Model Update

| Threat | Pre-PQC Status | Post-PQC Status |
|--------|---------------|-----------------|
| SNDL on command channel | **VULNERABLE** (RSA-4096) | **MITIGATED** (X25519+ML-KEM-1024 hybrid) |
| SNDL on migration manifests | Low risk (signatures, not encryption) | **MITIGATED** (ML-DSA-65 PQ-only signatures) |
| CRQC forges gate approvals | **VULNERABLE** (ECDSA P-256) | **MITIGATED** (SLH-DSA-SHA2-128s, hash-only) |
| CRQC forges PoP (session integrity) | **VULNERABLE** (ECDSA P-256) | **MITIGATED** (symmetric HMAC via ML-KEM-1024 — Section 4.3) |
| CRQC forges user intent signatures | N/A (new layer) | **MITIGATED** (ML-DSA-44 / SLH-DSA-SHA2-128s — Section 4.4) |
| CRQC spoofs FIDO2 assertion | **VULNERABLE** (ECDSA in authenticator) | Reduced exposure via HKDF combiner with PRF when available (defense-in-depth — Section 4.3.7) |
| CRQC breaks HMAC-SHA256 tokens | Not vulnerable (Grover → 128-bit) | Not vulnerable |
| CRQC breaks AES-256-GCM at rest | Not vulnerable (Grover → 128-bit) | Not vulnerable |
| Lattice algorithm breakthrough | N/A | **MITIGATED** (hybrid retains classical component; SLH-DSA is hash-only) |
| CRQC derives wallet key from exposed Ed25519 pubkey | **VULNERABLE** (single address reused) | **MITIGATED** (single-use addresses, zero-lamport drain — Section 5) |
| Rent-exempt dust accumulation across fleet | **VULNERABLE** (~$4.4M over 3 years) | **MITIGATED** (atomic sweep + account closure — Section 5.8) |
| Concurrent signing TOCTOU race condition | **VULNERABLE** (no locking) | **MITIGATED** (in-memory signing mutex — Section 5.7) |

---

## Appendix A: Envelope Version Dispatch Pseudocode

```
function dispatch(payload):
  if payload._platformEncrypted:
    return decryptPlatformAES(payload)    // Bootstrap, symmetric

  if payload._pqc == 2:
    return decryptHybridKEM(payload)      // Post-quantum hybrid

  if payload._e2ee && !payload._pqc:
    if MIGRATION_WINDOW_OPEN:
      return decryptLegacyRSA(payload)    // RSA-4096 (deprecated)
    else:
      REJECT("v1 envelopes no longer accepted")

  REJECT("unknown envelope format")
```

## Appendix B: Timeline

| Week | Milestone |
|------|-----------|
| W1 | Rust binaries compiled + NIST KAT tests passing |
| W2 | `@noble/post-quantum` integrated into API + console + extension. ML-KEM PoP handshake + HMAC signing + intent signature framework deployed. |
| W3 | Phase 0 deploy: dual-version support live, no VPS changes |
| W4 | Phase 1: new servers provisioned with hybrid keys |
| W5-W8 | Phase 2: rolling fleet rotation (batches of 50 servers/day) + Phase 2.5: HD wallet migration for wallet-enabled servers |
| W9-W12 | Phase 2 complete, Phase 3 deprecation warnings active |
| W13-W20 | 90-day deprecation window |
| W21 | Phase 4: hard cutover, v1 rejection enforced |

## Appendix C: Compliance Mapping

| Requirement | FIPS Standard | Our Implementation | Status |
|-------------|--------------|-------------------|--------|
| Key Encapsulation | FIPS 203 (ML-KEM) | ML-KEM-1024 (hybrid with X25519) | Planned |
| Digital Signatures (high-throughput) | FIPS 204 (ML-DSA) | ML-DSA-65 (PQ-only, greenfield) | Implemented |
| Digital Signatures (hash-based) | FIPS 205 (SLH-DSA) | SLH-DSA-SHA2-128s | Planned |
| Symmetric Encryption | FIPS 197 (AES) | AES-256-GCM | In place |
| Key Derivation | SP 800-56C (HKDF) | HKDF-SHA256 | In place |
| Random Number Generation | SP 800-90A | Node.js `crypto.randomBytes` (OpenSSL CSPRNG) | In place |
