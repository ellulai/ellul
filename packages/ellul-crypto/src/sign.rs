// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

//! ML-DSA-44, ML-DSA-65, and SLH-DSA-SHA2-128s signing and verification.
//!
//! ML-DSA uses the `fips204` crate (FIPS 204 final standard).
//! SLH-DSA uses `pqcrypto-sphincsplus` (FIPS 205).
//! Both are cross-implementation compatible with @noble/post-quantum (TypeScript).

use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use fips204::traits::{SerDes, Signer, Verifier};
use pqcrypto_sphincsplus::sphincssha2128ssimple as slhdsa128s;
use pqcrypto_traits::sign::{
    DetachedSignature, PublicKey as _, SecretKey as _,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use zeroize::Zeroize;

#[derive(Serialize)]
struct MlDsaPrivateKeyFile {
    version: u32,
    algorithm: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    mldsa_sk: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mldsa44_sk: Option<String>,
    created_at: String,
}

#[derive(Serialize)]
struct MlDsaPublicKeyFile {
    version: u32,
    algorithm: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    mldsa_pk: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mldsa44_pk: Option<String>,
    created_at: String,
}

#[derive(Deserialize)]
struct SigningKeyParsed {
    #[allow(dead_code)]
    version: u32,
    #[allow(dead_code)]
    algorithm: String,
    #[serde(default)]
    mldsa_sk: Option<String>,
    #[serde(default)]
    mldsa44_sk: Option<String>,
    #[serde(default)]
    slhdsa_sk: Option<String>,
}

#[derive(Deserialize)]
struct VerifyKeyParsed {
    #[allow(dead_code)]
    version: u32,
    #[allow(dead_code)]
    algorithm: String,
    #[serde(default)]
    mldsa_pk: Option<String>,
    #[serde(default)]
    mldsa44_pk: Option<String>,
    #[serde(default)]
    slhdsa_pk: Option<String>,
}

/// Generate a new ML-DSA signing keypair (ML-DSA-65 default, ML-DSA-44 for heartbeat).
pub fn generate_keypair(private_out: &str, public_out: &str, algorithm: Option<&str>) -> Result<(), String> {
    let now = timestamp_now();
    let algo = algorithm.unwrap_or("mldsa65");

    let (private_key, public_key) = match algo {
        "mldsa44" => {
            let (pk, sk) = fips204::ml_dsa_44::try_keygen()
                .map_err(|_| "ML-DSA-44 keygen failed")?;
            (
                MlDsaPrivateKeyFile {
                    version: 2,
                    algorithm: "ML-DSA-44".to_string(),
                    mldsa_sk: None,
                    mldsa44_sk: Some(B64.encode(sk.into_bytes())),
                    created_at: now.clone(),
                },
                MlDsaPublicKeyFile {
                    version: 2,
                    algorithm: "ML-DSA-44".to_string(),
                    mldsa_pk: None,
                    mldsa44_pk: Some(B64.encode(pk.into_bytes())),
                    created_at: now,
                },
            )
        }
        "mldsa65" => {
            let (pk, sk) = fips204::ml_dsa_65::try_keygen()
                .map_err(|_| "ML-DSA-65 keygen failed")?;
            (
                MlDsaPrivateKeyFile {
                    version: 2,
                    algorithm: "ML-DSA-65".to_string(),
                    mldsa_sk: Some(B64.encode(sk.into_bytes())),
                    mldsa44_sk: None,
                    created_at: now.clone(),
                },
                MlDsaPublicKeyFile {
                    version: 2,
                    algorithm: "ML-DSA-65".to_string(),
                    mldsa_pk: Some(B64.encode(pk.into_bytes())),
                    mldsa44_pk: None,
                    created_at: now,
                },
            )
        }
        _ => return Err(format!("Unknown keygen algorithm: {algo}. Use 'mldsa44' or 'mldsa65'")),
    };

    let mut private_json = serde_json::to_string_pretty(&private_key)
        .map_err(|e| format!("Failed to serialize private key: {e}"))?;
    let public_json = serde_json::to_string_pretty(&public_key)
        .map_err(|e| format!("Failed to serialize public key: {e}"))?;

    atomic_write(private_out, private_json.as_bytes(), 0o600)?;
    atomic_write(public_out, public_json.as_bytes(), 0o644)?;

    private_json.zeroize();
    Ok(())
}

/// Sign data from a file using ML-DSA-44, ML-DSA-65, or SLH-DSA-SHA2-128s.
/// Outputs base64-encoded detached signature to stdout.
pub fn sign_data(key_path: &str, input_path: &str, algorithm: &str) -> Result<(), String> {
    let mut key_json = fs::read_to_string(key_path)
        .map_err(|e| format!("Failed to read signing key: {e}"))?;
    let data = fs::read(input_path)
        .map_err(|e| format!("Failed to read input file: {e}"))?;

    let signature_b64 = match algorithm {
        "mldsa44" => {
            let parsed: SigningKeyParsed = serde_json::from_str(&key_json)
                .map_err(|e| format!("Failed to parse signing key: {e}"))?;
            let sk_b64 = parsed.mldsa44_sk
                .ok_or("Missing mldsa44_sk in key file")?;
            let mut sk_bytes = B64.decode(&sk_b64)
                .map_err(|e| format!("Failed to decode signing key: {e}"))?;

            let sk_arr: [u8; 2560] = sk_bytes.as_slice().try_into()
                .map_err(|_| format!("Invalid ML-DSA-44 secret key size: expected 2560, got {}", sk_bytes.len()))?;
            let sk = fips204::ml_dsa_44::PrivateKey::try_from_bytes(sk_arr)
                .map_err(|_| "Invalid ML-DSA-44 secret key")?;
            sk_bytes.zeroize();

            let sig = sk.try_sign(&data, &[])
                .map_err(|_| "ML-DSA-44 signing failed")?;
            B64.encode(sig)
        }
        "mldsa65" => {
            let parsed: SigningKeyParsed = serde_json::from_str(&key_json)
                .map_err(|e| format!("Failed to parse signing key: {e}"))?;
            let sk_b64 = parsed.mldsa_sk
                .ok_or("Missing mldsa_sk in key file")?;
            let mut sk_bytes = B64.decode(&sk_b64)
                .map_err(|e| format!("Failed to decode signing key: {e}"))?;

            let sk_arr: [u8; 4032] = sk_bytes.as_slice().try_into()
                .map_err(|_| format!("Invalid ML-DSA-65 secret key size: expected 4032, got {}", sk_bytes.len()))?;
            let sk = fips204::ml_dsa_65::PrivateKey::try_from_bytes(sk_arr)
                .map_err(|_| "Invalid ML-DSA-65 secret key")?;
            sk_bytes.zeroize();

            let sig = sk.try_sign(&data, &[])
                .map_err(|_| "ML-DSA-65 signing failed")?;
            B64.encode(sig)
        }
        "slhdsa128s" => {
            let parsed: SigningKeyParsed = serde_json::from_str(&key_json)
                .map_err(|e| format!("Failed to parse signing key: {e}"))?;
            let sk_b64 = parsed.slhdsa_sk
                .ok_or("Missing slhdsa_sk in key file")?;
            let mut sk_bytes = B64.decode(&sk_b64)
                .map_err(|e| format!("Failed to decode signing key: {e}"))?;
            let sk = slhdsa128s::SecretKey::from_bytes(&sk_bytes)
                .map_err(|_| "Invalid SLH-DSA-SHA2-128s secret key")?;
            sk_bytes.zeroize();

            let sig = slhdsa128s::detached_sign(&data, &sk);
            B64.encode(sig.as_bytes())
        }
        _ => return Err(format!("Unknown algorithm: {algorithm}. Use 'mldsa44', 'mldsa65', or 'slhdsa128s'")),
    };

    key_json.zeroize();

    // Output signature to stdout
    print!("{signature_b64}");
    Ok(())
}

/// Verify a detached signature using ML-DSA-44, ML-DSA-65, or SLH-DSA-SHA2-128s.
pub fn verify_data(
    key_path: &str,
    input_path: Option<&str>,
    manifest_path: Option<&str>,
    algorithm: &str,
) -> Result<(), String> {
    let key_json = fs::read_to_string(key_path)
        .map_err(|e| format!("Failed to read verification key: {e}"))?;

    // Get data and signature to verify
    let (data, sig_b64) = if let Some(manifest) = manifest_path {
        // Extract from manifest JSON: signature field + unsigned payload
        let manifest_str = fs::read_to_string(manifest)
            .map_err(|e| format!("Failed to read manifest: {e}"))?;
        let mut manifest_val: serde_json::Value = serde_json::from_str(&manifest_str)
            .map_err(|e| format!("Failed to parse manifest: {e}"))?;

        let sig = manifest_val.get("signature_mldsa65")
            .or_else(|| manifest_val.get("signature"))
            .and_then(|v| v.as_str())
            .ok_or("Missing signature field in manifest")?
            .to_string();

        // Remove signature fields for canonical unsigned payload
        if let Some(obj) = manifest_val.as_object_mut() {
            obj.remove("signature");
            obj.remove("signature_mldsa65");
            obj.remove("signature_slhdsa128s");
        }

        // Canonical JSON: explicitly sorted keys, no whitespace.
        // Uses our defensive canonical serializer (not serde_json::to_string)
        // to guarantee key ordering matches TypeScript canonicalJson().
        let canonical = crate::canonical::canonical_json(&manifest_val);

        (canonical.into_bytes(), sig)
    } else if let Some(input) = input_path {
        let data = fs::read(input)
            .map_err(|e| format!("Failed to read input: {e}"))?;
        // Read signature from stdin
        let mut sig = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut sig)
            .map_err(|e| format!("Failed to read signature from stdin: {e}"))?;
        (data, sig.trim().to_string())
    } else {
        return Err("Must provide --input or --manifest".to_string());
    };

    let sig_bytes = B64.decode(&sig_b64)
        .map_err(|e| format!("Failed to decode signature: {e}"))?;

    let valid = match algorithm {
        "mldsa44" => {
            let parsed: VerifyKeyParsed = serde_json::from_str(&key_json)
                .map_err(|e| format!("Failed to parse key: {e}"))?;
            let pk_b64 = parsed.mldsa44_pk
                .ok_or("Missing mldsa44_pk in key file")?;
            let pk_bytes = B64.decode(&pk_b64)
                .map_err(|e| format!("Failed to decode public key: {e}"))?;
            let pk_arr: [u8; 1312] = pk_bytes.as_slice().try_into()
                .map_err(|_| format!("Invalid ML-DSA-44 public key size: expected 1312, got {}", pk_bytes.len()))?;
            let pk = fips204::ml_dsa_44::PublicKey::try_from_bytes(pk_arr)
                .map_err(|_| "Invalid ML-DSA-44 public key")?;

            let sig_arr: [u8; 2420] = sig_bytes.as_slice().try_into()
                .map_err(|_| format!("Invalid ML-DSA-44 signature size: expected 2420, got {}", sig_bytes.len()))?;

            pk.verify(&data, &sig_arr, &[])
        }
        "mldsa65" => {
            let parsed: VerifyKeyParsed = serde_json::from_str(&key_json)
                .map_err(|e| format!("Failed to parse key: {e}"))?;
            let pk_b64 = parsed.mldsa_pk
                .ok_or("Missing mldsa_pk in key file")?;
            let pk_bytes = B64.decode(&pk_b64)
                .map_err(|e| format!("Failed to decode public key: {e}"))?;
            let pk_arr: [u8; 1952] = pk_bytes.as_slice().try_into()
                .map_err(|_| format!("Invalid ML-DSA-65 public key size: expected 1952, got {}", pk_bytes.len()))?;
            let pk = fips204::ml_dsa_65::PublicKey::try_from_bytes(pk_arr)
                .map_err(|_| "Invalid ML-DSA-65 public key")?;

            let sig_arr: [u8; 3309] = sig_bytes.as_slice().try_into()
                .map_err(|_| format!("Invalid ML-DSA-65 signature size: expected 3309, got {}", sig_bytes.len()))?;

            pk.verify(&data, &sig_arr, &[])
        }
        "slhdsa128s" => {
            let parsed: VerifyKeyParsed = serde_json::from_str(&key_json)
                .map_err(|e| format!("Failed to parse key: {e}"))?;
            let pk_b64 = parsed.slhdsa_pk
                .ok_or("Missing slhdsa_pk in key file")?;
            let pk_bytes = B64.decode(&pk_b64)
                .map_err(|e| format!("Failed to decode public key: {e}"))?;
            let pk = slhdsa128s::PublicKey::from_bytes(&pk_bytes)
                .map_err(|_| "Invalid SLH-DSA-SHA2-128s public key")?;
            let sig = slhdsa128s::DetachedSignature::from_bytes(&sig_bytes)
                .map_err(|_| "Invalid SLH-DSA-SHA2-128s signature")?;

            slhdsa128s::verify_detached_signature(&sig, &data, &pk).is_ok()
        }
        _ => return Err(format!("Unknown algorithm: {algorithm}")),
    };

    if valid {
        eprintln!("Signature verified successfully");
        Ok(())
    } else {
        Err("Signature verification FAILED".to_string())
    }
}

fn timestamp_now() -> String {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();

    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    let days = (secs / 86400) as i64;
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
    #[allow(unused_imports)]
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    use fips204::traits::{SerDes, Signer, Verifier};
    use pqcrypto_sphincsplus::sphincssha2128ssimple as slhdsa128s;
    use pqcrypto_traits::sign::{
        DetachedSignature, PublicKey as SignPublicKey, SecretKey as SignSecretKey,
    };

    /// Cross-implementation test: verify that Rust's serde_json canonical JSON
    /// (BTreeMap-sorted keys) produces byte-identical output to TypeScript's
    /// canonicalJson() function. Both use shared fixtures.
    #[test]
    fn canonical_json_matches_fixture() {
        let input = include_str!("../test-fixtures/canonical-manifest.json");
        let expected = include_str!("../test-fixtures/canonical-manifest-expected.json").trim();

        let mut val: serde_json::Value = serde_json::from_str(input).unwrap();
        if let Some(obj) = val.as_object_mut() {
            obj.remove("signature");
            obj.remove("signature_mldsa65");
            obj.remove("signature_slhdsa128s");
        }

        let canonical = crate::canonical::canonical_json(&val);
        assert_eq!(canonical, expected);
    }

    // -----------------------------------------------------------------------
    // ML-DSA-65 Known Answer Tests (fips204 crate — FIPS 204 final standard)
    // -----------------------------------------------------------------------

    #[test]
    fn mldsa65_keypair_sizes() {
        let (pk, sk) = fips204::ml_dsa_65::try_keygen().unwrap();
        assert_eq!(pk.into_bytes().len(), 1952, "ML-DSA-65 public key must be 1952 bytes");
        assert_eq!(sk.into_bytes().len(), 4032, "ML-DSA-65 secret key must be 4032 bytes");
    }

    #[test]
    fn mldsa65_sign_verify_round_trip() {
        let (pk, sk) = fips204::ml_dsa_65::try_keygen().unwrap();
        let message = b"ellul post-quantum KAT vector: ML-DSA-65";
        let sig = sk.try_sign(message, &[]).unwrap();
        assert!(
            pk.verify(message, &sig, &[]),
            "ML-DSA-65 signature must verify against signing key"
        );
    }

    #[test]
    fn mldsa65_detached_signature_size() {
        let (_pk, sk) = fips204::ml_dsa_65::try_keygen().unwrap();
        let sig = sk.try_sign(b"size check", &[]).unwrap();
        assert_eq!(sig.len(), 3309, "ML-DSA-65 detached signature must be 3309 bytes");
    }

    #[test]
    fn mldsa65_wrong_key_rejects() {
        let (_pk_a, sk_a) = fips204::ml_dsa_65::try_keygen().unwrap();
        let (pk_b, _sk_b) = fips204::ml_dsa_65::try_keygen().unwrap();
        let message = b"signed by key A";
        let sig = sk_a.try_sign(message, &[]).unwrap();
        // Verify with wrong key must fail
        assert!(
            !pk_b.verify(message, &sig, &[]),
            "ML-DSA-65 signature must NOT verify with a different public key"
        );
    }

    #[test]
    fn mldsa65_tampered_message_rejects() {
        let (pk, sk) = fips204::ml_dsa_65::try_keygen().unwrap();
        let sig = sk.try_sign(b"original message", &[]).unwrap();
        assert!(
            !pk.verify(b"tampered message", &sig, &[]),
            "ML-DSA-65 signature must NOT verify with tampered message"
        );
    }

    // -----------------------------------------------------------------------
    // SLH-DSA-SHA2-128s Known Answer Tests
    // -----------------------------------------------------------------------

    #[test]
    fn slhdsa128s_keypair_sizes() {
        let (pk, sk) = slhdsa128s::keypair();
        assert!(pk.as_bytes().len() > 0, "SLH-DSA public key must be non-empty");
        assert!(sk.as_bytes().len() > 0, "SLH-DSA secret key must be non-empty");
    }

    #[test]
    fn slhdsa128s_sign_verify_round_trip() {
        let (pk, sk) = slhdsa128s::keypair();
        let message = b"ellul post-quantum KAT vector: SLH-DSA-SHA2-128s";
        let sig = slhdsa128s::detached_sign(message, &sk);
        assert!(
            slhdsa128s::verify_detached_signature(&sig, message, &pk).is_ok(),
            "SLH-DSA-SHA2-128s signature must verify against signing key"
        );
    }

    #[test]
    fn slhdsa128s_detached_signature_size() {
        let (_pk, sk) = slhdsa128s::keypair();
        let sig = slhdsa128s::detached_sign(b"size check", &sk);
        assert_eq!(sig.as_bytes().len(), 7856, "SLH-DSA-SHA2-128s detached signature must be 7856 bytes");
    }

    #[test]
    fn slhdsa128s_wrong_key_rejects() {
        let (_pk_a, sk_a) = slhdsa128s::keypair();
        let (pk_b, _sk_b) = slhdsa128s::keypair();
        let message = b"signed by key A";
        let sig = slhdsa128s::detached_sign(message, &sk_a);
        assert!(
            slhdsa128s::verify_detached_signature(&sig, message, &pk_b).is_err(),
            "SLH-DSA signature must NOT verify with a different public key"
        );
    }

    // -----------------------------------------------------------------------
    // Cross-implementation: verify @noble/post-quantum (TS) signatures in Rust
    // -----------------------------------------------------------------------

    #[derive(serde::Deserialize)]
    struct CrossVectorFile {
        vectors: CrossVectors,
    }

    #[derive(serde::Deserialize)]
    struct CrossVectors {
        mldsa65: Vec<CrossVector>,
        mldsa44: Vec<CrossVector>,
    }

    #[derive(serde::Deserialize)]
    struct CrossVector {
        label: String,
        message: String,
        public_key_b64: String,
        signature_b64: String,
        public_key_size: usize,
        signature_size: usize,
    }

    fn load_cross_vectors() -> CrossVectorFile {
        let fixture_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/test-fixtures/mldsa-cross-vectors.json"
        );
        let data = std::fs::read_to_string(fixture_path)
            .expect("Failed to read mldsa-cross-vectors.json — run generate-mldsa-cross-vectors.mjs first");
        serde_json::from_str(&data).expect("Failed to parse cross-vector fixture")
    }

    #[test]
    fn cross_impl_mldsa65_noble_signs_rust_verifies() {
        let fixture = load_cross_vectors();
        for v in &fixture.vectors.mldsa65 {
            let pk_bytes = B64.decode(&v.public_key_b64).unwrap();
            let sig_bytes = B64.decode(&v.signature_b64).unwrap();
            let msg = v.message.as_bytes();

            assert_eq!(pk_bytes.len(), v.public_key_size, "PK size mismatch for {}", v.label);
            assert_eq!(sig_bytes.len(), v.signature_size, "Sig size mismatch for {}", v.label);

            let pk_arr: [u8; 1952] = pk_bytes.as_slice().try_into()
                .unwrap_or_else(|_| panic!("PK wrong length for {}", v.label));
            let pk = fips204::ml_dsa_65::PublicKey::try_from_bytes(pk_arr)
                .unwrap_or_else(|_| panic!("Invalid ML-DSA-65 public key in vector '{}'", v.label));
            let sig_arr: [u8; 3309] = sig_bytes.as_slice().try_into()
                .unwrap_or_else(|_| panic!("Sig wrong length for {}", v.label));

            assert!(
                pk.verify(msg, &sig_arr, &[]),
                "Cross-impl verification FAILED for '{}': @noble/post-quantum signature must verify in fips204",
                v.label
            );
        }
    }

    #[test]
    fn cross_impl_mldsa44_noble_signs_rust_verifies() {
        let fixture = load_cross_vectors();
        for v in &fixture.vectors.mldsa44 {
            let pk_bytes = B64.decode(&v.public_key_b64).unwrap();
            let sig_bytes = B64.decode(&v.signature_b64).unwrap();
            let msg = v.message.as_bytes();

            assert_eq!(pk_bytes.len(), v.public_key_size, "PK size mismatch for {}", v.label);
            assert_eq!(sig_bytes.len(), v.signature_size, "Sig size mismatch for {}", v.label);

            let pk_arr: [u8; 1312] = pk_bytes.as_slice().try_into()
                .unwrap_or_else(|_| panic!("PK wrong length for {}", v.label));
            let pk = fips204::ml_dsa_44::PublicKey::try_from_bytes(pk_arr)
                .unwrap_or_else(|_| panic!("Invalid ML-DSA-44 public key in vector '{}'", v.label));
            let sig_arr: [u8; 2420] = sig_bytes.as_slice().try_into()
                .unwrap_or_else(|_| panic!("Sig wrong length for {}", v.label));

            assert!(
                pk.verify(msg, &sig_arr, &[]),
                "Cross-impl verification FAILED for '{}': @noble/post-quantum signature must verify in fips204",
                v.label
            );
        }
    }

    // -----------------------------------------------------------------------
    // File-based keygen round-trip (ML-DSA-65)
    // -----------------------------------------------------------------------

    #[test]
    fn mldsa65_file_keygen_sizes() {
        let dir = tempfile::tempdir().unwrap();
        let priv_path = dir.path().join("sign.key");
        let pub_path = dir.path().join("sign.pub");

        generate_keypair(
            priv_path.to_str().unwrap(),
            pub_path.to_str().unwrap(),
            None,
        )
        .expect("ML-DSA-65 keygen must succeed");

        let priv_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&priv_path).unwrap()).unwrap();
        let pub_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&pub_path).unwrap()).unwrap();

        assert_eq!(priv_json["version"], 2);
        assert_eq!(priv_json["algorithm"], "ML-DSA-65");
        assert_eq!(pub_json["version"], 2);
        assert_eq!(pub_json["algorithm"], "ML-DSA-65");

        let sk_bytes = B64.decode(priv_json["mldsa_sk"].as_str().unwrap()).unwrap();
        let pk_bytes = B64.decode(pub_json["mldsa_pk"].as_str().unwrap()).unwrap();
        assert_eq!(sk_bytes.len(), 4032);
        assert_eq!(pk_bytes.len(), 1952);
    }
}

fn atomic_write(path: &str, data: &[u8], mode: u32) -> Result<(), String> {
    let tmp_path = format!("{path}.tmp");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp_path)
        .map_err(|e| format!("Failed to create {tmp_path}: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(mode))
            .map_err(|e| format!("Failed to set permissions: {e}"))?;
    }

    file.write_all(data)
        .map_err(|e| format!("Failed to write: {e}"))?;
    file.sync_all()
        .map_err(|e| format!("Failed to sync: {e}"))?;
    drop(file);

    fs::rename(&tmp_path, path)
        .map_err(|e| format!("Failed to rename: {e}"))?;
    Ok(())
}
