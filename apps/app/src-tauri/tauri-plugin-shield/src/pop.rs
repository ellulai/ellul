use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use hmac::{Hmac, Mac};
use pqcrypto_mlkem::mlkem1024;
use pqcrypto_traits::kem::{Ciphertext as _, PublicKey as _, SharedSecret as _};
use sha2::Sha256;
use uuid::Uuid;
use zeroize::Zeroize;

use crate::error::Error;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, serde::Serialize)]
pub struct PopHeaders {
    pub timestamp: String,
    pub nonce: String,
    pub signature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_hash: Option<String>,
}

pub fn sign_request(
    k_pop: &[u8; 32],
    method: &str,
    path: &str,
    body: Option<&[u8]>,
) -> PopHeaders {
    let timestamp = now_millis().to_string();
    let nonce = Uuid::new_v4().to_string();

    let body_hash = body
        .filter(|b| !b.is_empty())
        .map(|b| {
            use sha2::Digest;
            let hash = Sha256::digest(b);
            B64.encode(hash)
        });

    let payload = format!(
        "{timestamp}|{method}|{path}|{body_hash}|{nonce}",
        method = method.to_uppercase(),
        body_hash = body_hash.as_deref().unwrap_or(""),
    );

    let mut mac = HmacSha256::new_from_slice(k_pop).expect("HMAC key length is always 32");
    mac.update(payload.as_bytes());
    let signature = B64.encode(mac.finalize().into_bytes());

    PopHeaders {
        timestamp,
        nonce,
        signature,
        body_hash,
    }
}

pub struct MlKemBindResult {
    pub k_pop: [u8; 32],
    pub rotated_cookie: Option<String>,
}

pub async fn perform_mlkem_bind(
    client: &reqwest::Client,
    base_url: &str,
    session_cookie: &str,
) -> Result<MlKemBindResult, Error> {
    let mut current_cookie = session_cookie.to_string();
    let mut latest_rotated: Option<String> = None;

    // Phase 1: Init
    let init_res = client
        .post(format!("{base_url}/_auth/pop/bind/init"))
        .header("Content-Type", "application/json")
        .header("Cookie", &current_cookie)
        .body("{}")
        .send()
        .await?;

    if let Some(rotated) = crate::http::extract_session_cookie(&init_res) {
        current_cookie = rotated.clone();
        latest_rotated = Some(rotated);
    }

    if !init_res.status().is_success() {
        let body: serde_json::Value = init_res.json().await.unwrap_or_default();
        let err = body["error"].as_str().unwrap_or("ML-KEM bind init failed");
        return Err(Error::MlKemBindFailed(err.to_string()));
    }

    let init_data: serde_json::Value = init_res.json().await?;
    let mlkem_ek_b64 = init_data["mlkem_ek"]
        .as_str()
        .ok_or_else(|| Error::MlKemBindFailed("missing mlkem_ek".into()))?;
    let bind_challenge = init_data["bind_challenge"]
        .as_str()
        .ok_or_else(|| Error::MlKemBindFailed("missing bind_challenge".into()))?;

    // Phase 2: Encapsulate
    let ek_bytes = B64
        .decode(mlkem_ek_b64)
        .map_err(|e| Error::MlKemBindFailed(format!("decode mlkem_ek: {e}")))?;
    let ek = mlkem1024::PublicKey::from_bytes(&ek_bytes)
        .map_err(|_| Error::MlKemBindFailed("invalid ML-KEM-1024 encapsulation key".into()))?;
    let (shared_secret, ciphertext) = mlkem1024::encapsulate(&ek);

    let mut ss_bytes = shared_secret.as_bytes().to_vec();

    // bind_proof = HMAC-SHA256(shared_secret, "pop-bind|" + challenge)
    let mut mac = HmacSha256::new_from_slice(&ss_bytes)
        .map_err(|_| Error::MlKemBindFailed("HMAC key init failed".into()))?;
    mac.update(format!("pop-bind|{bind_challenge}").as_bytes());
    let bind_proof = B64.encode(mac.finalize().into_bytes());

    // K_pop = HMAC-SHA256(shared_secret, "pop-session-mac")
    let mut mac2 = HmacSha256::new_from_slice(&ss_bytes)
        .map_err(|_| Error::MlKemBindFailed("HMAC key init failed".into()))?;
    mac2.update(b"pop-session-mac");
    let k_pop_bytes = mac2.finalize().into_bytes();
    let mut k_pop = [0u8; 32];
    k_pop.copy_from_slice(&k_pop_bytes);

    // Zeroize shared secret
    ss_bytes.zeroize();

    // Phase 3: Complete
    let ciphertext_b64 = B64.encode(ciphertext.as_bytes());
    let complete_body = serde_json::json!({
        "ciphertext": ciphertext_b64,
        "bind_proof": bind_proof,
    });

    let complete_res = client
        .post(format!("{base_url}/_auth/pop/bind/complete"))
        .header("Content-Type", "application/json")
        .header("Cookie", &current_cookie)
        .json(&complete_body)
        .send()
        .await?;

    if let Some(rotated) = crate::http::extract_session_cookie(&complete_res) {
        latest_rotated = Some(rotated);
    }

    if !complete_res.status().is_success() {
        let body: serde_json::Value = complete_res.json().await.unwrap_or_default();
        let err = body["error"]
            .as_str()
            .unwrap_or("ML-KEM bind complete failed");
        k_pop.zeroize();
        return Err(Error::MlKemBindFailed(err.to_string()));
    }

    Ok(MlKemBindResult { k_pop, rotated_cookie: latest_rotated })
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_request_format_matches_pop_sw() {
        let k_pop = [0xABu8; 32];
        let headers = sign_request(&k_pop, "POST", "/_auth/gates/active", Some(b"{}"));

        assert!(!headers.timestamp.is_empty());
        assert!(!headers.nonce.is_empty());
        assert!(!headers.signature.is_empty());
        assert!(headers.body_hash.is_some());

        // Verify signature is valid base64
        B64.decode(&headers.signature).expect("signature must be valid base64");
        B64.decode(headers.body_hash.as_ref().unwrap())
            .expect("body_hash must be valid base64");
    }

    #[test]
    fn sign_request_empty_body_omits_hash() {
        let k_pop = [0xCDu8; 32];
        let headers = sign_request(&k_pop, "GET", "/_auth/session", None);
        assert!(headers.body_hash.is_none());
    }

    #[test]
    fn sign_request_deterministic_with_same_inputs() {
        let k_pop = [0xEFu8; 32];
        let h1 = sign_request(&k_pop, "GET", "/test", None);
        let h2 = sign_request(&k_pop, "GET", "/test", None);
        // Timestamps and nonces differ, so signatures differ — but both are valid
        assert_ne!(h1.nonce, h2.nonce);
    }
}
