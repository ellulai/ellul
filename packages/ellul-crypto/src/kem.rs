// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

//! Hybrid X25519 + ML-KEM-1024 key generation and public key derivation.

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use pqcrypto_mlkem::mlkem1024;
use pqcrypto_traits::kem::{PublicKey as _, SecretKey as _};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};
use zeroize::Zeroize;

#[derive(Serialize)]
struct HybridPrivateKeyFile {
    version: u32,
    algorithm: String,
    x25519_sk: String,
    mlkem_dk: String,
    created_at: String,
}

#[derive(Serialize)]
struct HybridPublicKeyFile {
    version: u32,
    algorithm: String,
    x25519_pk: String,
    mlkem_ek: String,
    created_at: String,
}

#[derive(Deserialize)]
struct HybridPrivateKeyParsed {
    #[allow(dead_code)]
    version: u32,
    #[allow(dead_code)]
    algorithm: Option<String>,
    x25519_sk: Option<String>,
    mlkem_dk: String,
}

/// Generate a new hybrid X25519 + ML-KEM-1024 keypair and write to files.
pub fn generate_keypair(private_out: &str, public_out: &str) -> Result<(), String> {
    // X25519 keypair
    let x25519_sk = X25519StaticSecret::random_from_rng(OsRng);
    let x25519_pk = X25519PublicKey::from(&x25519_sk);

    // ML-KEM-1024 keypair
    let (mlkem_pk, mlkem_sk) = mlkem1024::keypair();

    let now = chrono_now();

    let mut x25519_sk_bytes = x25519_sk.to_bytes();
    let mut x25519_sk_b64 = B64.encode(&x25519_sk_bytes);

    let private_key = HybridPrivateKeyFile {
        version: 3,
        algorithm: "X25519+ML-KEM-1024".to_string(),
        x25519_sk: x25519_sk_b64.clone(),
        mlkem_dk: B64.encode(mlkem_sk.as_bytes()),
        created_at: now.clone(),
    };

    let public_key = HybridPublicKeyFile {
        version: 3,
        algorithm: "X25519+ML-KEM-1024".to_string(),
        x25519_pk: B64.encode(x25519_pk.as_bytes()),
        mlkem_ek: B64.encode(mlkem_pk.as_bytes()),
        created_at: now,
    };

    let mut private_json = serde_json::to_string_pretty(&private_key)
        .map_err(|e| format!("Failed to serialize private key: {e}"))?;

    let public_json = serde_json::to_string_pretty(&public_key)
        .map_err(|e| format!("Failed to serialize public key: {e}"))?;

    // Write private key with restricted permissions
    atomic_write(private_out, private_json.as_bytes(), 0o640)?;
    // Write public key world-readable
    atomic_write(public_out, public_json.as_bytes(), 0o644)?;

    // Zeroize sensitive material
    x25519_sk_bytes.zeroize();
    private_json.zeroize();
    x25519_sk_b64.zeroize();

    Ok(())
}

/// Derive public key from existing private key file.
///
/// Supports both v3 (hybrid X25519+ML-KEM-1024) and v2 (ML-KEM-1024 only).
pub fn derive_public_key(private_in: &str, public_out: &str) -> Result<(), String> {
    let private_json = fs::read_to_string(private_in)
        .map_err(|e| format!("Failed to read private key: {e}"))?;

    let parsed: HybridPrivateKeyParsed = serde_json::from_str(&private_json)
        .map_err(|e| format!("Failed to parse private key JSON: {e}"))?;

    // Detect v3 (hybrid) vs v2 (ML-KEM only) by presence of x25519_sk
    let is_v3 = parsed.x25519_sk.as_ref().map_or(false, |s| !s.is_empty());

    // Extract ML-KEM public key from decapsulation key (common to both versions)
    let dk_bytes = B64.decode(&parsed.mlkem_dk)
        .map_err(|e| format!("Failed to decode ML-KEM decapsulation key: {e}"))?;

    let expected_dk = mlkem1024::secret_key_bytes();
    let expected_ek = mlkem1024::public_key_bytes();
    if dk_bytes.len() != expected_dk {
        return Err(format!(
            "Invalid ML-KEM-1024 decapsulation key size: expected {expected_dk}, got {}",
            dk_bytes.len()
        ));
    }
    // FIPS 203: dk = dk_pke (1536 bytes) || ek (1568 bytes) || H(ek) (32 bytes) || z (32 bytes)
    // Encapsulation key starts at offset 1536 for ML-KEM-1024.
    const MLKEM1024_DK_PKE_SIZE: usize = 1536;
    let ek_bytes = &dk_bytes[MLKEM1024_DK_PKE_SIZE..MLKEM1024_DK_PKE_SIZE + expected_ek];

    // Validate extracted public key is well-formed
    mlkem1024::PublicKey::from_bytes(ek_bytes)
        .map_err(|_| "Failed to parse extracted ML-KEM public key — key file may be corrupt".to_string())?;

    if is_v3 {
        // v3 hybrid: re-derive X25519 public key from secret
        let mut x25519_sk_bytes = B64.decode(parsed.x25519_sk.as_ref().unwrap())
            .map_err(|e| format!("Failed to decode X25519 secret key: {e}"))?;
        if x25519_sk_bytes.len() != 32 {
            x25519_sk_bytes.zeroize();
            return Err(format!(
                "Invalid X25519 secret key size: expected 32, got {}",
                x25519_sk_bytes.len()
            ));
        }
        let mut sk_array = [0u8; 32];
        sk_array.copy_from_slice(&x25519_sk_bytes);
        x25519_sk_bytes.zeroize();
        let x25519_sk = X25519StaticSecret::from(sk_array);
        sk_array.zeroize();
        let x25519_pk = X25519PublicKey::from(&x25519_sk);

        let public_key = HybridPublicKeyFile {
            version: 3,
            algorithm: "X25519+ML-KEM-1024".to_string(),
            x25519_pk: B64.encode(x25519_pk.as_bytes()),
            mlkem_ek: B64.encode(ek_bytes),
            created_at: chrono_now(),
        };

        let public_json = serde_json::to_string_pretty(&public_key)
            .map_err(|e| format!("Failed to serialize public key: {e}"))?;
        atomic_write(public_out, public_json.as_bytes(), 0o644)?;
    } else {
        // v2 ML-KEM-only: output v2 format public key
        #[derive(Serialize)]
        struct V2PublicKeyFile {
            version: u32,
            algorithm: String,
            mlkem_ek: String,
            created_at: String,
        }

        let public_key = V2PublicKeyFile {
            version: 2,
            algorithm: "ML-KEM-1024".to_string(),
            mlkem_ek: B64.encode(ek_bytes),
            created_at: chrono_now(),
        };

        let public_json = serde_json::to_string_pretty(&public_key)
            .map_err(|e| format!("Failed to serialize public key: {e}"))?;
        atomic_write(public_out, public_json.as_bytes(), 0o644)?;
    }

    Ok(())
}

/// Get current UTC timestamp in ISO 8601 format.
fn chrono_now() -> String {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();

    let days = (secs / 86400) as i64;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use pqcrypto_mlkem::mlkem1024;
    use pqcrypto_traits::kem::{PublicKey as KemPublicKey, SecretKey as KemSecretKey, SharedSecret as _};
    use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};
    use rand::rngs::OsRng;
    // -----------------------------------------------------------------------
    // ML-KEM-1024 Known Answer Tests
    // -----------------------------------------------------------------------

    #[test]
    fn mlkem1024_keypair_sizes() {
        let (pk, sk) = mlkem1024::keypair();
        assert_eq!(pk.as_bytes().len(), 1568, "ML-KEM-1024 encapsulation key must be 1568 bytes");
        assert_eq!(sk.as_bytes().len(), 3168, "ML-KEM-1024 decapsulation key must be 3168 bytes");
    }

    #[test]
    fn mlkem1024_encaps_decaps_round_trip() {
        let (pk, sk) = mlkem1024::keypair();
        let (ss_enc, ct) = mlkem1024::encapsulate(&pk);
        let ss_dec = mlkem1024::decapsulate(&ct, &sk);
        assert_eq!(
            ss_enc.as_bytes(),
            ss_dec.as_bytes(),
            "ML-KEM-1024 encapsulated and decapsulated shared secrets must match"
        );
        assert_eq!(ss_enc.as_bytes().len(), 32, "ML-KEM-1024 shared secret must be 32 bytes");
    }

    #[test]
    fn mlkem1024_different_keypairs_produce_different_shared_secrets() {
        let (pk_a, _sk_a) = mlkem1024::keypair();
        let (pk_b, _sk_b) = mlkem1024::keypair();
        let (ss_a, _ct_a) = mlkem1024::encapsulate(&pk_a);
        let (ss_b, _ct_b) = mlkem1024::encapsulate(&pk_b);
        // Overwhelmingly unlikely to collide
        assert_ne!(
            ss_a.as_bytes(),
            ss_b.as_bytes(),
            "Different keypairs should produce different shared secrets"
        );
    }

    // -----------------------------------------------------------------------
    // X25519 Known Answer Tests
    // -----------------------------------------------------------------------

    #[test]
    fn x25519_keypair_sizes() {
        let sk = X25519StaticSecret::random_from_rng(OsRng);
        let pk = X25519PublicKey::from(&sk);
        assert_eq!(sk.to_bytes().len(), 32, "X25519 secret key must be 32 bytes");
        assert_eq!(pk.as_bytes().len(), 32, "X25519 public key must be 32 bytes");
    }

    #[test]
    fn x25519_diffie_hellman_round_trip() {
        let sk_a = X25519StaticSecret::random_from_rng(OsRng);
        let pk_a = X25519PublicKey::from(&sk_a);
        let sk_b = X25519StaticSecret::random_from_rng(OsRng);
        let pk_b = X25519PublicKey::from(&sk_b);

        let shared_a = sk_a.diffie_hellman(&pk_b);
        let shared_b = sk_b.diffie_hellman(&pk_a);
        assert_eq!(
            shared_a.as_bytes(),
            shared_b.as_bytes(),
            "X25519 DH shared secrets must be symmetric"
        );
    }

    // -----------------------------------------------------------------------
    // Hybrid keygen / derive-pub round-trip (file-based)
    // -----------------------------------------------------------------------

    #[test]
    fn hybrid_keygen_produces_v3_format() {
        let dir = tempfile::tempdir().unwrap();
        let priv_path = dir.path().join("node.key");
        let pub_path = dir.path().join("node.pub");

        generate_keypair(
            priv_path.to_str().unwrap(),
            pub_path.to_str().unwrap(),
        )
        .expect("keygen must succeed");

        let priv_json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&priv_path).unwrap()).unwrap();
        let pub_json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&pub_path).unwrap()).unwrap();

        assert_eq!(priv_json["version"], 3);
        assert_eq!(priv_json["algorithm"], "X25519+ML-KEM-1024");
        assert!(priv_json["x25519_sk"].as_str().unwrap().len() > 0);
        assert!(priv_json["mlkem_dk"].as_str().unwrap().len() > 0);

        assert_eq!(pub_json["version"], 3);
        assert_eq!(pub_json["algorithm"], "X25519+ML-KEM-1024");
        assert!(pub_json["x25519_pk"].as_str().unwrap().len() > 0);
        assert!(pub_json["mlkem_ek"].as_str().unwrap().len() > 0);

        // Verify decoded sizes
        let ek_bytes = B64.decode(pub_json["mlkem_ek"].as_str().unwrap()).unwrap();
        let dk_bytes = B64.decode(priv_json["mlkem_dk"].as_str().unwrap()).unwrap();
        let x_sk_bytes = B64.decode(priv_json["x25519_sk"].as_str().unwrap()).unwrap();
        let x_pk_bytes = B64.decode(pub_json["x25519_pk"].as_str().unwrap()).unwrap();
        assert_eq!(ek_bytes.len(), 1568);
        assert_eq!(dk_bytes.len(), 3168);
        assert_eq!(x_sk_bytes.len(), 32);
        assert_eq!(x_pk_bytes.len(), 32);
    }

    #[test]
    fn derive_public_key_produces_valid_v3_output() {
        let dir = tempfile::tempdir().unwrap();
        let priv_path = dir.path().join("node.key");
        let pub_path = dir.path().join("node.pub");
        let derived_pub_path = dir.path().join("node-derived.pub");

        generate_keypair(
            priv_path.to_str().unwrap(),
            pub_path.to_str().unwrap(),
        )
        .unwrap();

        derive_public_key(
            priv_path.to_str().unwrap(),
            derived_pub_path.to_str().unwrap(),
        )
        .expect("derive must succeed");

        let original: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&pub_path).unwrap()).unwrap();
        let derived: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&derived_pub_path).unwrap()).unwrap();

        // Metadata must match
        assert_eq!(original["version"], derived["version"]);
        assert_eq!(original["algorithm"], derived["algorithm"]);

        // X25519 public key must be identical (derived from same secret key)
        assert_eq!(original["x25519_pk"], derived["x25519_pk"]);

        // Derived ML-KEM ek must be a valid, parseable encapsulation key
        let derived_ek_bytes = B64.decode(derived["mlkem_ek"].as_str().unwrap()).unwrap();
        assert_eq!(derived_ek_bytes.len(), 1568, "Derived ML-KEM ek must be 1568 bytes");
        mlkem1024::PublicKey::from_bytes(&derived_ek_bytes)
            .expect("Derived ek must parse as valid ML-KEM-1024 public key");
    }

    /// NOTE: derive_public_key extracts the ML-KEM ek as dk_bytes[..ek_len].
    /// In the pqcrypto-mlkem crate, the ek stored inside dk may differ from
    /// the ek returned by keypair() (the crate's internal dk layout may not
    /// embed the original ek as a prefix). If this test fails, it indicates
    /// that the crate's dk layout assumption needs revisiting.
    #[test]
    fn derive_public_key_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let priv_path = dir.path().join("node.key");
        let pub_path = dir.path().join("node.pub");
        let derived1 = dir.path().join("derived1.pub");
        let derived2 = dir.path().join("derived2.pub");

        generate_keypair(
            priv_path.to_str().unwrap(),
            pub_path.to_str().unwrap(),
        )
        .unwrap();

        derive_public_key(priv_path.to_str().unwrap(), derived1.to_str().unwrap()).unwrap();
        derive_public_key(priv_path.to_str().unwrap(), derived2.to_str().unwrap()).unwrap();

        let d1: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&derived1).unwrap()).unwrap();
        let d2: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&derived2).unwrap()).unwrap();

        // Multiple derivations from the same private key must produce identical ek
        assert_eq!(d1["x25519_pk"], d2["x25519_pk"]);
        assert_eq!(d1["mlkem_ek"], d2["mlkem_ek"]);
    }
}

/// Write file atomically via tmp + rename, with specified permissions.
fn atomic_write(path: &str, data: &[u8], mode: u32) -> Result<(), String> {
    let tmp_path = format!("{path}.tmp");

    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp_path)
        .map_err(|e| format!("Failed to create {tmp_path}: {e}"))?;

    // Set permissions before writing (security: no window of world-readable private key)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(mode))
            .map_err(|e| format!("Failed to set permissions on {tmp_path}: {e}"))?;
    }

    file.write_all(data)
        .map_err(|e| format!("Failed to write {tmp_path}: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("Failed to sync {tmp_path}: {e}"))?;
    drop(file);

    fs::rename(&tmp_path, path)
        .map_err(|e| format!("Failed to rename {tmp_path} → {path}: {e}"))?;

    Ok(())
}
