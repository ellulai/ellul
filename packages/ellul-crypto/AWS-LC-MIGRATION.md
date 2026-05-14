# aws-lc-rs Migration Evaluation

## Current State

The `ellul-crypto` binary uses these crates for PQC:

| Crate | Algorithm | FIPS Status |
|-------|-----------|-------------|
| `pqcrypto-mlkem 0.1` | ML-KEM-1024 (FIPS 203) | Reference impl, NOT FIPS-validated |
| `pqcrypto-dilithium 0.5` | ML-DSA-65 (FIPS 204) | Reference impl, NOT FIPS-validated |
| `pqcrypto-sphincsplus 0.7` | SLH-DSA-SHA2-128s (FIPS 205) | Reference impl, NOT FIPS-validated |
| `aes-gcm 0.10` | AES-256-GCM | RustCrypto, NOT FIPS-validated |

## aws-lc-rs Coverage

`aws-lc-rs` (>= 1.12) provides FIPS 140-3 validated implementations of:

| Algorithm | aws-lc-rs support | API |
|-----------|-------------------|-----|
| ML-KEM-1024 | Yes (since 1.12) | `aws_lc_rs::kem::{ML_KEM_1024, DecapsulationKey, EncapsulationKey}` |
| ML-DSA-65 | Yes (since 1.12) | `aws_lc_rs::unstable::mldsa::{MLDSA65, MLDSASigningKey, MLDSAVerificationKey}` |
| SLH-DSA-SHA2-128s | **No** | Not supported as of aws-lc-rs 1.12 |
| AES-256-GCM | Yes | `aws_lc_rs::aead::{AES_256_GCM, LessSafeKey}` |
| X25519 | Yes | `aws_lc_rs::agreement::{X25519, agree_ephemeral}` |
| HKDF-SHA256 | Yes | `aws_lc_rs::hkdf::{Hkdf, HKDF_SHA256}` |

## Migration Assessment

### Blocker: SLH-DSA-SHA2-128s not in aws-lc-rs

SLH-DSA (SPHINCS+) is used for:
- Operator gate signatures (highest security — hash-based, zero lattice assumptions)
- Financial/irreversible intent signatures (wallet_spend, deploy, db_migrate)

aws-lc-rs does not implement SLH-DSA. This means we cannot fully migrate to aws-lc-rs today. Options:

1. **Hybrid approach**: Use aws-lc-rs for ML-KEM + ML-DSA + AES + X25519 + HKDF, keep `pqcrypto-sphincsplus` for SLH-DSA only.
2. **Wait**: AWS has SLH-DSA on their roadmap. When it ships, do a full migration.
3. **Drop SLH-DSA**: Unacceptable — it's the hedge against lattice breaks for financial operations.

**Recommendation: Option 1 (hybrid) when FIPS validation is required.**

### API Differences

The `pqcrypto-*` crates and `aws-lc-rs` have different APIs:

**ML-KEM-1024:**
```rust
// pqcrypto-mlkem (current)
let (pk, sk) = mlkem1024::keypair();
let (ss, ct) = mlkem1024::encapsulate(&pk);
let ss2 = mlkem1024::decapsulate(&ct, &sk);

// aws-lc-rs
let dk = DecapsulationKey::generate(&ML_KEM_1024)?;
let ek_bytes = dk.encapsulation_key()?.as_ref();
let (ct, ss) = EncapsulationKey::new(&ML_KEM_1024, ek_bytes)?.encapsulate()?;
let ss2 = dk.decapsulate(ct)?;
```

**ML-DSA-65:**
```rust
// pqcrypto-dilithium (current)
let (pk, sk) = mldsa65::keypair();
let sig = mldsa65::detached_sign(msg, &sk);
let valid = mldsa65::verify_detached_signature(&sig, msg, &pk).is_ok();

// aws-lc-rs (unstable API)
let sk = MLDSASigningKey::generate(&MLDSA65)?;
let pk = sk.verification_key();
let sig = sk.sign(msg)?;
let valid = pk.verify(msg, sig.as_ref()).is_ok();
```

The key format (raw bytes) is compatible — both use the same underlying NIST reference vectors. The wrapping API differs but the cryptographic output is interoperable.

### Build Considerations

- `aws-lc-rs` requires CMake and a C compiler for building AWS-LC (the C library underneath)
- Binary size increases (~2-3 MB for the static AWS-LC library)
- Cross-compilation (musl) is supported but requires `AWS_LC_SYS_CMAKE_BUILDER=1`
- FIPS mode requires `aws-lc-rs/fips` feature flag

### Migration Steps (when ready)

1. Add to Cargo.toml:
   ```toml
   aws-lc-rs = { version = "1.12", features = ["fips"] }
   ```
2. Replace ML-KEM calls in kem.rs and decrypt.rs
3. Replace ML-DSA calls in sign.rs
4. Replace AES-GCM calls in decrypt.rs
5. Replace X25519 calls in kem.rs and decrypt.rs (drop x25519-dalek)
6. Replace HKDF calls in decrypt.rs (drop hkdf + sha2 crates)
7. Keep `pqcrypto-sphincsplus` for SLH-DSA (no aws-lc-rs equivalent)
8. Run full KAT + cross-implementation test suite
9. Verify binary sizes haven't regressed unacceptably
10. Update build scripts for CMake requirement

### Timeline

- **Now**: Keep current crates. Correct implementations, not FIPS-validated.
- **When FIPS required**: Migrate ML-KEM + ML-DSA + AES + X25519 + HKDF to aws-lc-rs. Keep SLH-DSA on pqcrypto-sphincsplus.
- **When aws-lc-rs adds SLH-DSA**: Complete migration. Drop all pqcrypto-* crates.
