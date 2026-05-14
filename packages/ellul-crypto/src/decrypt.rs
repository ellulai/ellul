// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

//! Hybrid X25519 + ML-KEM-1024 decapsulation + HKDF + AES-256-GCM decryption.
//!
//! v3 envelope flow:
//!   1. X25519 DH: static_sk * ephemeral_pk -> x25519_ss (32 bytes)
//!   2. ML-KEM-1024 decapsulate -> mlkem_ss (32 bytes)
//!   3. IKM = x25519_ss || mlkem_ss (64 bytes, raw)
//!   4. salt = SHA-256(x25519_eph_pub_raw || mlkem_ct_raw)
//!   5. HKDF-SHA256(salt, IKM, info="ellul-hybrid-kem-v1") -> 32-byte AES key
//!   6. AES-256-GCM decrypt
//!
//! v2 envelope flow (backward compat):
//!   1. ML-KEM-1024 decapsulate -> 32-byte shared secret
//!   2. Use shared secret directly as AES-256 key
//!   3. AES-256-GCM decrypt

use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use aes_gcm::aead::Aead;
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use hkdf::Hkdf;
use pqcrypto_mlkem::mlkem1024;
use pqcrypto_traits::kem::{Ciphertext as _, SecretKey as _, SharedSecret as _};
use serde::Deserialize;
use sha2::{Sha256, Digest};
use std::fs;
use std::io::{self, Read};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};
use zeroize::Zeroize;

/// HKDF info string — must match TypeScript and browser implementations exactly.
const HYBRID_KEM_HKDF_INFO: &[u8] = b"ellul-hybrid-kem-v1";

// ---------------------------------------------------------------------------
// Deserialization structs (v2 + v3 compatible)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct PrivateKeyFile {
    #[allow(dead_code)]
    version: u32,
    /// Present in v3 hybrid keys, absent in v2 ML-KEM-only keys.
    x25519_sk: Option<String>,
    mlkem_dk: String,
}

#[derive(Deserialize)]
struct EnvelopeFile {
    #[allow(dead_code)]
    _e2ee: Option<bool>,
    #[allow(dead_code)]
    _pqc: Option<u32>,
    /// Present in v3 hybrid envelopes, absent in v2 envelopes.
    x25519_eph_pub: Option<String>,
    mlkem_ct: String,
    iv: String,
    #[serde(rename = "encryptedData")]
    encrypted_data: String,
}

/// Decrypt a hybrid X25519+ML-KEM-1024 or ML-KEM-1024-only envelope.
///
/// Automatically detects v3 (hybrid) vs v2 (ML-KEM-only) based on
/// presence of `x25519_sk` in the private key and `x25519_eph_pub`
/// in the envelope.
pub fn decrypt_envelope(
    key_path: &str,
    from_stdin: bool,
    envelope_json: Option<&str>,
) -> Result<(), String> {
    // Read private key
    let mut key_data = fs::read_to_string(key_path)
        .map_err(|e| format!("Failed to read private key: {e}"))?;
    let private_key: PrivateKeyFile = serde_json::from_str(&key_data)
        .map_err(|e| format!("Failed to parse private key: {e}"))?;
    key_data.zeroize();

    // Read envelope
    let envelope_str = if from_stdin {
        let mut buf = String::new();
        io::stdin().read_to_string(&mut buf)
            .map_err(|e| format!("Failed to read stdin: {e}"))?;
        buf
    } else if let Some(json) = envelope_json {
        json.to_string()
    } else {
        return Err("Must provide --stdin or --envelope".to_string());
    };

    let envelope: EnvelopeFile = serde_json::from_str(&envelope_str)
        .map_err(|e| format!("Failed to parse envelope: {e}"))?;

    // Require v3 hybrid format — v2 ML-KEM-only is removed (greenfield, no v2 keys exist)
    let has_x25519_sk = private_key.x25519_sk.as_ref().map_or(false, |s| !s.is_empty());
    let has_x25519_eph = envelope.x25519_eph_pub.as_ref().map_or(false, |s| !s.is_empty());

    if has_x25519_sk && has_x25519_eph {
        decrypt_v3_hybrid(&private_key, &envelope)
    } else if !has_x25519_sk || !has_x25519_eph {
        Err(
            "v2 ML-KEM-only format is not supported — both x25519_sk (in key) and \
             x25519_eph_pub (in envelope) are required. Regenerate keys with: \
             ellul-crypto keygen kem"
                .to_string(),
        )
    } else {
        Err("Key/envelope version mismatch".to_string())
    }
}

/// v3 hybrid decrypt: X25519 DH + ML-KEM-1024 decapsulate -> HKDF -> AES-256-GCM.
///
/// HKDF raw-byte invariants:
///   ALL inputs are raw bytes, never base64 or hex strings.
///   IKM = raw x25519_ss || raw mlkem_ss (64 bytes)
///   Salt = SHA-256(raw x25519_eph_pub || raw mlkem_ct)
fn decrypt_v3_hybrid(
    private_key: &PrivateKeyFile,
    envelope: &EnvelopeFile,
) -> Result<(), String> {
    // Decode all components from base64 to raw bytes
    let mut x25519_sk_bytes = B64.decode(private_key.x25519_sk.as_ref().unwrap())
        .map_err(|e| format!("Failed to decode X25519 secret key: {e}"))?;
    let mut dk_bytes = B64.decode(&private_key.mlkem_dk)
        .map_err(|e| format!("Failed to decode ML-KEM decapsulation key: {e}"))?;
    let x25519_eph_pub_bytes = B64.decode(envelope.x25519_eph_pub.as_ref().unwrap())
        .map_err(|e| format!("Failed to decode X25519 ephemeral public key: {e}"))?;
    let ct_bytes = B64.decode(&envelope.mlkem_ct)
        .map_err(|e| format!("Failed to decode ML-KEM ciphertext: {e}"))?;
    let iv_bytes = B64.decode(&envelope.iv)
        .map_err(|e| format!("Failed to decode IV: {e}"))?;
    let encrypted_data = B64.decode(&envelope.encrypted_data)
        .map_err(|e| format!("Failed to decode encrypted data: {e}"))?;

    // mlock sensitive key material (best-effort — may fail on dev/macOS due to RLIMIT_MEMLOCK)
    mlock_warn(&x25519_sk_bytes);
    mlock_warn(&dk_bytes);

    // 1. X25519 Diffie-Hellman
    if x25519_sk_bytes.len() != 32 {
        let len = x25519_sk_bytes.len();
        munlock_zeroize(&mut x25519_sk_bytes);
        munlock_zeroize(&mut dk_bytes);
        return Err(format!("Invalid X25519 secret key size: expected 32, got {len}"));
    }
    if x25519_eph_pub_bytes.len() != 32 {
        let len = x25519_eph_pub_bytes.len();
        munlock_zeroize(&mut x25519_sk_bytes);
        munlock_zeroize(&mut dk_bytes);
        return Err(format!("Invalid X25519 ephemeral public key size: expected 32, got {len}"));
    }

    let mut sk_array = [0u8; 32];
    sk_array.copy_from_slice(&x25519_sk_bytes);
    munlock_zeroize(&mut x25519_sk_bytes);

    let x25519_sk = X25519StaticSecret::from(sk_array);
    sk_array.zeroize();

    let mut eph_pub_array = [0u8; 32];
    eph_pub_array.copy_from_slice(&x25519_eph_pub_bytes);
    let x25519_eph_pub = X25519PublicKey::from(eph_pub_array);
    let x25519_shared = x25519_sk.diffie_hellman(&x25519_eph_pub);

    // 2. ML-KEM-1024 decapsulate
    let mlkem_sk = mlkem1024::SecretKey::from_bytes(&dk_bytes)
        .map_err(|_| "Invalid ML-KEM-1024 decapsulation key".to_string())?;
    let mlkem_ct = mlkem1024::Ciphertext::from_bytes(&ct_bytes)
        .map_err(|_| "Invalid ML-KEM-1024 ciphertext".to_string())?;
    let mlkem_shared = mlkem1024::decapsulate(&mlkem_ct, &mlkem_sk);

    // Zeroize raw decapsulation key bytes
    munlock_zeroize(&mut dk_bytes);

    // 3. HKDF-SHA256 — ALL raw bytes, no encoded strings
    // IKM = x25519_ss || mlkem_ss (64 bytes)
    let mut ikm = Vec::with_capacity(64);
    ikm.extend_from_slice(x25519_shared.as_bytes());
    ikm.extend_from_slice(mlkem_shared.as_bytes());
    mlock_warn(&ikm);

    // Salt = SHA-256(raw x25519_eph_pub || raw mlkem_ct)
    let salt = {
        let mut hasher = Sha256::new();
        hasher.update(&x25519_eph_pub_bytes);
        hasher.update(&ct_bytes);
        hasher.finalize()
    };

    let hk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
    let mut aes_key = [0u8; 32];
    hk.expand(HYBRID_KEM_HKDF_INFO, &mut aes_key)
        .map_err(|e| {
            munlock_zeroize(&mut ikm);
            format!("HKDF expand failed: {e}")
        })?;
    mlock_warn(&aes_key);

    // Zeroize IKM
    munlock_zeroize(&mut ikm);

    // 4. AES-256-GCM decrypt
    if encrypted_data.len() < 16 {
        munlock_zeroize_arr(&mut aes_key);
        return Err("Encrypted data too short (missing auth tag)".to_string());
    }

    let cipher = Aes256Gcm::new_from_slice(&aes_key)
        .map_err(|e| format!("Failed to create AES cipher: {e}"))?;
    munlock_zeroize_arr(&mut aes_key);

    let nonce = Nonce::from_slice(&iv_bytes);
    let plaintext = cipher.decrypt(nonce, encrypted_data.as_ref())
        .map_err(|_| "AES-256-GCM decryption failed (authentication tag mismatch)".to_string())?;

    // Output plaintext to stdout
    io::Write::write_all(&mut io::stdout(), &plaintext)
        .map_err(|e| format!("Failed to write output: {e}"))?;

    Ok(())
}

// v2 ML-KEM-only decrypt path REMOVED — greenfield system, no v2 keys exist.
// Using raw shared secret as AES key (no HKDF) was cryptographically weaker.
// All production keys are v3 hybrid (X25519 + ML-KEM-1024 + HKDF).

// ---------------------------------------------------------------------------
// Memory locking helpers
// ---------------------------------------------------------------------------

/// Attempt to mlock a buffer to prevent paging to swap.
/// Logs a warning on failure (may fail on macOS/dev due to RLIMIT_MEMLOCK)
/// but never crashes — mlock is defense-in-depth, not a hard requirement.
fn mlock_warn(buf: &[u8]) {
    if buf.is_empty() {
        return;
    }
    unsafe {
        if !memsec::mlock(buf.as_ptr() as *mut u8, buf.len()) {
            eprintln!(
                "Warning: mlock failed for {} bytes (RLIMIT_MEMLOCK may be too low)",
                buf.len()
            );
        }
    }
}

/// Munlock and zeroize a Vec<u8>.
fn munlock_zeroize(buf: &mut Vec<u8>) {
    if !buf.is_empty() {
        unsafe {
            memsec::munlock(buf.as_ptr() as *mut u8, buf.len());
        }
    }
    buf.zeroize();
}

/// Munlock and zeroize a fixed 32-byte array.
fn munlock_zeroize_arr(buf: &mut [u8; 32]) {
    unsafe {
        memsec::munlock(buf.as_ptr() as *mut u8, buf.len());
    }
    buf.zeroize();
}

// ---------------------------------------------------------------------------
// Tests — HKDF combiner cross-platform vectors
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce as AesNonce};
    use aes_gcm::aead::Aead;
    use pqcrypto_traits::kem::SecretKey as KemSecretKey;
    use rand::rngs::OsRng;
    use rand::RngCore;

    /// Decode a hex string to a Vec<u8>.
    fn hex_decode(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// Shared JSON fixture structure.
    #[derive(Deserialize)]
    struct FixtureFile {
        vectors: Vec<TestVector>,
    }

    #[derive(Deserialize)]
    struct TestVector {
        label: String,
        x25519_ss: String,
        mlkem_ss: String,
        x25519_eph_pub: String,
        mlkem_ct: String,
        expected_salt: String,
        expected_derived_key: String,
    }

    /// Load the shared test fixture from packages/ellul-crypto/test-fixtures/.
    fn load_vectors() -> Vec<TestVector> {
        let fixture_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/test-fixtures/hkdf-combiner-vectors.json"
        );
        let data = fs::read_to_string(fixture_path)
            .expect("Failed to read hkdf-combiner-vectors.json — run generate-hkdf-vectors.mjs first");
        let fixture: FixtureFile =
            serde_json::from_str(&data).expect("Failed to parse fixture JSON");
        fixture.vectors
    }

    #[test]
    fn hkdf_combiner_salt_matches_vectors() {
        for v in load_vectors() {
            let eph_pub = hex_decode(&v.x25519_eph_pub);
            let ct = hex_decode(&v.mlkem_ct);

            let mut hasher = Sha256::new();
            hasher.update(&eph_pub);
            hasher.update(&ct);
            let salt = hasher.finalize();

            let expected_salt = hex_decode(&v.expected_salt);
            assert_eq!(
                salt.as_slice(),
                expected_salt.as_slice(),
                "Salt mismatch for vector '{}'",
                v.label
            );
        }
    }

    #[test]
    fn hkdf_combiner_derived_key_matches_vectors() {
        for v in load_vectors() {
            let x25519_ss = hex_decode(&v.x25519_ss);
            let mlkem_ss = hex_decode(&v.mlkem_ss);
            let eph_pub = hex_decode(&v.x25519_eph_pub);
            let ct = hex_decode(&v.mlkem_ct);

            // IKM = x25519_ss || mlkem_ss
            let mut ikm = Vec::with_capacity(64);
            ikm.extend_from_slice(&x25519_ss);
            ikm.extend_from_slice(&mlkem_ss);

            // Salt = SHA-256(eph_pub || ct)
            let salt = {
                let mut hasher = Sha256::new();
                hasher.update(&eph_pub);
                hasher.update(&ct);
                hasher.finalize()
            };

            // HKDF-SHA256 expand
            let hk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
            let mut derived = [0u8; 32];
            hk.expand(HYBRID_KEM_HKDF_INFO, &mut derived)
                .expect("HKDF expand failed");

            let expected = hex_decode(&v.expected_derived_key);
            assert_eq!(
                derived.as_slice(),
                expected.as_slice(),
                "Derived key mismatch for vector '{}'",
                v.label
            );
        }
    }

    // -----------------------------------------------------------------------
    // Helper: construct a v3 hybrid envelope (encrypt side)
    // -----------------------------------------------------------------------

    /// Encrypt `plaintext` under a fresh hybrid keypair. Returns (envelope_json, private_key_json).
    fn make_v3_envelope(plaintext: &[u8]) -> (String, String) {
        // Recipient keypair
        let x25519_sk = X25519StaticSecret::random_from_rng(OsRng);
        let x25519_pk = X25519PublicKey::from(&x25519_sk);
        let (mlkem_pk, mlkem_sk) = mlkem1024::keypair();

        // Ephemeral sender X25519
        let eph_sk = X25519StaticSecret::random_from_rng(OsRng);
        let eph_pk = X25519PublicKey::from(&eph_sk);

        // X25519 DH
        let x25519_ss = eph_sk.diffie_hellman(&x25519_pk);

        // ML-KEM-1024 encapsulate
        let (mlkem_ss, mlkem_ct) = mlkem1024::encapsulate(&mlkem_pk);

        // HKDF
        let mut ikm = Vec::with_capacity(64);
        ikm.extend_from_slice(x25519_ss.as_bytes());
        ikm.extend_from_slice(mlkem_ss.as_bytes());

        let salt = {
            let mut hasher = Sha256::new();
            hasher.update(eph_pk.as_bytes());
            hasher.update(mlkem_ct.as_bytes());
            hasher.finalize()
        };

        let hk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
        let mut aes_key = [0u8; 32];
        hk.expand(HYBRID_KEM_HKDF_INFO, &mut aes_key).unwrap();

        // AES-256-GCM encrypt
        let mut iv = [0u8; 12];
        OsRng.fill_bytes(&mut iv);
        let cipher = Aes256Gcm::new_from_slice(&aes_key).unwrap();
        let nonce = AesNonce::from_slice(&iv);
        let ciphertext = cipher.encrypt(nonce, plaintext).unwrap();

        let envelope = serde_json::json!({
            "_e2ee": true,
            "_pqc": 3,
            "x25519_eph_pub": B64.encode(eph_pk.as_bytes()),
            "mlkem_ct": B64.encode(mlkem_ct.as_bytes()),
            "iv": B64.encode(&iv),
            "encryptedData": B64.encode(&ciphertext),
        });

        let private_key = serde_json::json!({
            "version": 3,
            "algorithm": "X25519+ML-KEM-1024",
            "x25519_sk": B64.encode(x25519_sk.to_bytes()),
            "mlkem_dk": B64.encode(mlkem_sk.as_bytes()),
        });

        (envelope.to_string(), private_key.to_string())
    }

    /// Replicate the v3 decrypt path, returning plaintext bytes instead of
    /// writing to stdout (avoids capturing stdout in tests).
    fn decrypt_v3_to_bytes(
        private_key: &PrivateKeyFile,
        envelope: &EnvelopeFile,
    ) -> Result<Vec<u8>, String> {
        let x25519_sk_bytes = B64.decode(private_key.x25519_sk.as_ref().unwrap())
            .map_err(|e| format!("Failed to decode X25519 secret key: {e}"))?;
        let dk_bytes = B64.decode(&private_key.mlkem_dk)
            .map_err(|e| format!("Failed to decode ML-KEM dk: {e}"))?;
        let x25519_eph_pub_bytes = B64.decode(envelope.x25519_eph_pub.as_ref().unwrap())
            .map_err(|e| format!("Failed to decode X25519 eph pub: {e}"))?;
        let ct_bytes = B64.decode(&envelope.mlkem_ct)
            .map_err(|e| format!("Failed to decode ML-KEM ct: {e}"))?;
        let iv_bytes = B64.decode(&envelope.iv)
            .map_err(|e| format!("Failed to decode IV: {e}"))?;
        let encrypted_data = B64.decode(&envelope.encrypted_data)
            .map_err(|e| format!("Failed to decode encrypted data: {e}"))?;

        if x25519_sk_bytes.len() != 32 || x25519_eph_pub_bytes.len() != 32 {
            return Err("Invalid key sizes".to_string());
        }

        let mut sk_arr = [0u8; 32];
        sk_arr.copy_from_slice(&x25519_sk_bytes);
        let x25519_sk = X25519StaticSecret::from(sk_arr);

        let mut eph_arr = [0u8; 32];
        eph_arr.copy_from_slice(&x25519_eph_pub_bytes);
        let x25519_eph_pub = X25519PublicKey::from(eph_arr);
        let x25519_shared = x25519_sk.diffie_hellman(&x25519_eph_pub);

        let mlkem_sk = mlkem1024::SecretKey::from_bytes(&dk_bytes)
            .map_err(|_| "Invalid ML-KEM-1024 dk".to_string())?;
        let mlkem_ct = mlkem1024::Ciphertext::from_bytes(&ct_bytes)
            .map_err(|_| "Invalid ML-KEM-1024 ct".to_string())?;
        let mlkem_shared = mlkem1024::decapsulate(&mlkem_ct, &mlkem_sk);

        let mut ikm = Vec::with_capacity(64);
        ikm.extend_from_slice(x25519_shared.as_bytes());
        ikm.extend_from_slice(mlkem_shared.as_bytes());

        let salt = {
            let mut hasher = Sha256::new();
            hasher.update(&x25519_eph_pub_bytes);
            hasher.update(&ct_bytes);
            hasher.finalize()
        };

        let hk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
        let mut aes_key = [0u8; 32];
        hk.expand(HYBRID_KEM_HKDF_INFO, &mut aes_key)
            .map_err(|e| format!("HKDF expand failed: {e}"))?;

        if encrypted_data.len() < 16 {
            return Err("Encrypted data too short (missing auth tag)".to_string());
        }

        let cipher = Aes256Gcm::new_from_slice(&aes_key)
            .map_err(|e| format!("Failed to create AES cipher: {e}"))?;
        let nonce = AesNonce::from_slice(&iv_bytes);
        cipher.decrypt(nonce, encrypted_data.as_ref())
            .map_err(|_| "AES-256-GCM decryption failed (authentication tag mismatch)".to_string())
    }

    // -----------------------------------------------------------------------
    // v3 hybrid encrypt -> decrypt round-trip
    // -----------------------------------------------------------------------

    #[test]
    fn v3_hybrid_round_trip() {
        let plaintext = b"post-quantum E2EE round-trip test payload";
        let (envelope_json, key_json) = make_v3_envelope(plaintext);

        let private_key: PrivateKeyFile = serde_json::from_str(&key_json).unwrap();
        let envelope: EnvelopeFile = serde_json::from_str(&envelope_json).unwrap();

        let result = decrypt_v3_to_bytes(&private_key, &envelope);
        assert_eq!(result.unwrap(), plaintext, "Decrypted plaintext must match original");
    }

    #[test]
    fn v3_hybrid_round_trip_empty_payload() {
        let plaintext = b"";
        let (envelope_json, key_json) = make_v3_envelope(plaintext);
        let private_key: PrivateKeyFile = serde_json::from_str(&key_json).unwrap();
        let envelope: EnvelopeFile = serde_json::from_str(&envelope_json).unwrap();
        let result = decrypt_v3_to_bytes(&private_key, &envelope);
        assert_eq!(result.unwrap(), plaintext);
    }

    #[test]
    fn v3_hybrid_round_trip_large_payload() {
        let plaintext = vec![0x42u8; 64 * 1024]; // 64KB
        let (envelope_json, key_json) = make_v3_envelope(&plaintext);
        let private_key: PrivateKeyFile = serde_json::from_str(&key_json).unwrap();
        let envelope: EnvelopeFile = serde_json::from_str(&envelope_json).unwrap();
        let result = decrypt_v3_to_bytes(&private_key, &envelope);
        assert_eq!(result.unwrap(), plaintext);
    }

    // -----------------------------------------------------------------------
    // Wrong key must fail (auth tag mismatch)
    // -----------------------------------------------------------------------

    #[test]
    fn v3_wrong_key_fails_decryption() {
        let plaintext = b"this should not decrypt with wrong key";
        let (envelope_json, _correct_key) = make_v3_envelope(plaintext);

        // Different keypair entirely
        let wrong_x25519_sk = X25519StaticSecret::random_from_rng(OsRng);
        let (_wrong_mlkem_pk, wrong_mlkem_sk) = mlkem1024::keypair();
        let wrong_key_json = serde_json::json!({
            "version": 3,
            "algorithm": "X25519+ML-KEM-1024",
            "x25519_sk": B64.encode(wrong_x25519_sk.to_bytes()),
            "mlkem_dk": B64.encode(wrong_mlkem_sk.as_bytes()),
        })
        .to_string();

        let private_key: PrivateKeyFile = serde_json::from_str(&wrong_key_json).unwrap();
        let envelope: EnvelopeFile = serde_json::from_str(&envelope_json).unwrap();

        let result = decrypt_v3_to_bytes(&private_key, &envelope);
        assert!(result.is_err(), "Decryption with wrong key must fail");
        let err = result.unwrap_err();
        assert!(
            err.contains("authentication tag mismatch") || err.contains("decryption failed"),
            "Error must indicate auth failure, got: {err}"
        );
    }

    // -----------------------------------------------------------------------
    // Truncated ciphertext must fail
    // -----------------------------------------------------------------------

    #[test]
    fn v3_truncated_ciphertext_fails() {
        let plaintext = b"truncation test";
        let (envelope_json, key_json) = make_v3_envelope(plaintext);

        // Truncate the encrypted data to less than auth tag size
        let mut env_val: serde_json::Value = serde_json::from_str(&envelope_json).unwrap();
        let enc_b64 = env_val["encryptedData"].as_str().unwrap().to_string();
        let enc_bytes = B64.decode(&enc_b64).unwrap();
        let truncated = B64.encode(&enc_bytes[..8.min(enc_bytes.len())]);
        env_val["encryptedData"] = serde_json::Value::String(truncated);

        let private_key: PrivateKeyFile = serde_json::from_str(&key_json).unwrap();
        let envelope: EnvelopeFile = serde_json::from_str(&env_val.to_string()).unwrap();

        let result = decrypt_v3_to_bytes(&private_key, &envelope);
        assert!(result.is_err(), "Truncated ciphertext must fail decryption");
    }

    // -----------------------------------------------------------------------
    // Bit-flip in ciphertext must fail (integrity check)
    // -----------------------------------------------------------------------

    #[test]
    fn v3_bitflip_ciphertext_fails() {
        let plaintext = b"bit-flip integrity test";
        let (envelope_json, key_json) = make_v3_envelope(plaintext);

        let mut env_val: serde_json::Value = serde_json::from_str(&envelope_json).unwrap();
        let enc_b64 = env_val["encryptedData"].as_str().unwrap().to_string();
        let mut enc_bytes = B64.decode(&enc_b64).unwrap();
        // Flip one bit in the middle of the ciphertext
        if enc_bytes.len() > 4 {
            let mid = enc_bytes.len() / 2;
            enc_bytes[mid] ^= 0x01;
        }
        env_val["encryptedData"] = serde_json::Value::String(B64.encode(&enc_bytes));

        let private_key: PrivateKeyFile = serde_json::from_str(&key_json).unwrap();
        let envelope: EnvelopeFile = serde_json::from_str(&env_val.to_string()).unwrap();

        let result = decrypt_v3_to_bytes(&private_key, &envelope);
        assert!(result.is_err(), "Bit-flipped ciphertext must fail decryption");
    }
}
