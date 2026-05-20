use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL}, Engine as _};
use fips204::traits::{SerDes as SerDes204, Signer as Signer204};
use fips205::traits::{SerDes as SerDes205, Signer as Signer205};
use rand::RngCore;
use sha2::{Sha256, Digest};
use tokio::sync::RwLock;
use zeroize::Zeroize;

use crate::error::Error;
use crate::http::ShieldHttpClient;
use crate::session::SessionState;
use crate::storage;

const BUNDLE_VERSION: u8 = 1;

pub struct OperatorKeys {
    pub server_domain: String,
    pub operator_sk: Vec<u8>,
    pub operator_pk_b64: String,
    pub intent_mldsa44_sk: Vec<u8>,
    pub intent_mldsa44_pk_b64: String,
    pub intent_slhdsa128s_sk: Vec<u8>,
    pub intent_slhdsa128s_pk_b64: String,
}

impl Drop for OperatorKeys {
    fn drop(&mut self) {
        self.operator_sk.zeroize();
        self.intent_mldsa44_sk.zeroize();
        self.intent_slhdsa128s_sk.zeroize();
    }
}

#[derive(Default)]
pub struct OperatorState(pub RwLock<Option<OperatorKeys>>);

impl OperatorState {
    pub async fn clear(&self) {
        let mut guard = self.0.write().await;
        *guard = None;
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct OperatorSignature {
    pub signature: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct IntentSignature {
    #[serde(rename = "intentSignature")]
    pub intent_signature: String,
    #[serde(rename = "intentNonce")]
    pub intent_nonce: String,
    #[serde(rename = "intentType")]
    pub intent_type: String,
}

fn get_required_signature_type(action: &str) -> Option<&'static str> {
    match action {
        "wallet_spend" | "deploy" | "db_migrate" => Some("slhdsa128s"),
        "db_write" | "git_push_external" | "exec" => Some("mldsa44"),
        _ => None,
    }
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
const OPERATOR_PRF_SALT_LABEL: &[u8] = b"ellul-operator-key-v1";

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
async fn derive_prf_kek() -> Result<[u8; 32], Error> {
    let salt = Sha256::digest(OPERATOR_PRF_SALT_LABEL);
    let mut challenge = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut challenge);

    let result = crate::passkey::authenticate_with_prf(
        &challenge,
        "ellul.ai",
        None,
        Some("required"),
        &salt,
    )
    .await
    .map_err(|e| Error::Other(format!("PRF derivation failed: {e}")))?;

    let prf_first_b64 = result["prfFirst"]
        .as_str()
        .ok_or_else(|| Error::Other("PRF result missing prfFirst".into()))?;
    let prf_bytes = B64URL
        .decode(prf_first_b64)
        .map_err(|e| Error::Other(format!("decode PRF output: {e}")))?;
    if prf_bytes.len() != 32 {
        return Err(Error::Other(format!(
            "unexpected PRF key length: {}",
            prf_bytes.len()
        )));
    }
    let mut kek = [0u8; 32];
    kek.copy_from_slice(&prf_bytes);
    Ok(kek)
}

#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
async fn derive_prf_kek() -> Result<[u8; 32], Error> {
    Err(Error::Other("PRF-based operator key not available on this platform".into()))
}

fn pubkeys_key(server_domain: &str) -> String {
    format!("pubkeys:{server_domain}")
}

fn save_pubkeys(server_domain: &str, op: &str, ml: &str, slh: &str) {
    let json = serde_json::json!({ "op": op, "ml": ml, "slh": slh });
    let _ = storage::store(pubkeys_key(server_domain).as_str(), json.to_string().as_bytes());
}

fn load_pubkeys(server_domain: &str) -> (String, String, String) {
    if let Ok(Some(bytes)) = storage::load(&pubkeys_key(server_domain)) {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            return (
                v["op"].as_str().unwrap_or("").to_string(),
                v["ml"].as_str().unwrap_or("").to_string(),
                v["slh"].as_str().unwrap_or("").to_string(),
            );
        }
    }
    (String::new(), String::new(), String::new())
}

pub fn load_or_bind<'a>(
    operator_state: &'a OperatorState,
    session_state: &'a SessionState,
    http: &'a ShieldHttpClient,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), Error>> + Send + 'a>> {
    Box::pin(async move {
    {
        let guard = operator_state.0.read().await;
        if guard.is_some() {
            return Ok(());
        }
    }

    let server_domain = session_state
        .server_domain()
        .await
        .ok_or(Error::NoSession)?;

    let _ = storage::remove(&storage::kek_key(&server_domain));

    // Fast path: local bundle exists → derive PRF KEK → unwrap → no HTTP needed
    if let Some(wrapped) = storage::load(&storage::bundle_key(&server_domain))? {
        let mut kek = derive_prf_kek().await?;
        match unwrap_bundle(&wrapped, &kek) {
            Ok(bundle) => {
                kek.zeroize();
                let (op_pk, ml_pk, slh_pk) = load_pubkeys(&server_domain);
                let mut guard = operator_state.0.write().await;
                *guard = Some(OperatorKeys {
                    server_domain,
                    operator_sk: bundle.operator,
                    operator_pk_b64: op_pk,
                    intent_mldsa44_sk: bundle.intent_mldsa44,
                    intent_mldsa44_pk_b64: ml_pk,
                    intent_slhdsa128s_sk: bundle.intent_slhdsa128s,
                    intent_slhdsa128s_pk_b64: slh_pk,
                });
                return Ok(());
            }
            Err(_) => {
                kek.zeroize();
                let _ = storage::remove(&storage::bundle_key(&server_domain));
            }
        }
    }

    // Slow path: no local bundle or unwrap failed — check server
    let status = http.get(session_state, "/_auth/gates/operator-status").await?;
    let _bound = status["bound"].as_bool().unwrap_or(false);

    let nonce_resp = http.get(session_state, "/_auth/gates/bind-nonce").await?;
    if nonce_resp["alreadyBound"].as_bool().unwrap_or(false) {
        return load_or_bind(operator_state, session_state, http).await;
    }
    let bind_nonce = nonce_resp["nonce"]
        .as_str()
        .ok_or_else(|| Error::OperatorBindFailed("no bind nonce available".into()))?
        .to_string();

    let (operator_pk, operator_sk) = fips205::slh_dsa_sha2_128s::try_keygen()
        .map_err(|_| Error::SigningFailed("SLH-DSA-SHA2-128s keygen failed".into()))?;
    let (mldsa44_pk, mldsa44_sk) = fips204::ml_dsa_44::try_keygen()
        .map_err(|_| Error::SigningFailed("ML-DSA-44 keygen failed".into()))?;
    let (slhdsa_intent_pk, slhdsa_intent_sk) = fips205::slh_dsa_sha2_128s::try_keygen()
        .map_err(|_| Error::SigningFailed("SLH-DSA-SHA2-128s intent keygen failed".into()))?;

    let operator_pk_b64 = B64.encode(operator_pk.into_bytes());
    let intent_mldsa44_pk_b64 = B64.encode(mldsa44_pk.into_bytes());
    let intent_slhdsa128s_pk_b64 = B64.encode(slhdsa_intent_pk.into_bytes());

    let operator_sk_bytes = operator_sk.into_bytes().to_vec();
    let mldsa44_sk_bytes = mldsa44_sk.into_bytes().to_vec();
    let slhdsa_intent_sk_bytes = slhdsa_intent_sk.into_bytes().to_vec();

    let mut kek = derive_prf_kek().await?;

    let bundle = SecretBundle {
        operator: operator_sk_bytes.clone(),
        intent_mldsa44: mldsa44_sk_bytes.clone(),
        intent_slhdsa128s: slhdsa_intent_sk_bytes.clone(),
    };
    let wrapped = wrap_bundle(&bundle, &kek)?;

    let bind_body = serde_json::json!({
        "operatorPublicKey": operator_pk_b64,
        "operatorBindNonce": bind_nonce,
        "intentMldsa44PublicKey": intent_mldsa44_pk_b64,
        "intentSlhdsa128sPublicKey": intent_slhdsa128s_pk_b64,
    });

    match http.post(session_state, "/_auth/gates/bind-operator", &bind_body).await {
        Ok(_) => {}
        Err(Error::HttpError(msg))
            if msg.contains("nonce")
                || msg.contains("already consumed")
                || msg.contains("already bound") =>
        {
            kek.zeroize();
            return Err(Error::BindNonceConsumed);
        }
        Err(e) => {
            kek.zeroize();
            return Err(e);
        }
    }

    storage::store(&storage::bundle_key(&server_domain), &wrapped)?;
    save_pubkeys(&server_domain, &operator_pk_b64, &intent_mldsa44_pk_b64, &intent_slhdsa128s_pk_b64);
    kek.zeroize();

    let mut guard = operator_state.0.write().await;
    *guard = Some(OperatorKeys {
        server_domain,
        operator_sk: operator_sk_bytes,
        operator_pk_b64,
        intent_mldsa44_sk: mldsa44_sk_bytes,
        intent_mldsa44_pk_b64,
        intent_slhdsa128s_sk: slhdsa_intent_sk_bytes,
        intent_slhdsa128s_pk_b64,
    });

    Ok(())
    }) // close Box::pin
}

pub fn sign_operator(keys: &OperatorKeys, payload: &[u8]) -> Result<OperatorSignature, Error> {
    let timestamp = now_millis().to_string();
    let sep = format!("|{timestamp}");
    let mut message = Vec::with_capacity(payload.len() + sep.len());
    message.extend_from_slice(payload);
    message.extend_from_slice(sep.as_bytes());

    let sk_arr: [u8; 64] = keys.operator_sk.as_slice().try_into()
        .map_err(|_| Error::SigningFailed(format!(
            "SLH-DSA sk wrong size: {}", keys.operator_sk.len()
        )))?;
    let sk = fips205::slh_dsa_sha2_128s::PrivateKey::try_from_bytes(&sk_arr)
        .map_err(|_| Error::SigningFailed("invalid SLH-DSA secret key".into()))?;
    let sig = sk.try_sign(&message, &[], false)
        .map_err(|_| Error::SigningFailed("SLH-DSA signing failed".into()))?;

    Ok(OperatorSignature {
        signature: B64.encode(sig),
        timestamp,
    })
}

pub async fn sign_intent(
    keys: &OperatorKeys,
    session_state: &SessionState,
    http: &ShieldHttpClient,
    action: &str,
    resource: Option<&str>,
) -> Result<IntentSignature, Error> {
    let required = get_required_signature_type(action)
        .ok_or_else(|| Error::SigningFailed(format!("action '{action}' not classified")))?;

    // Fetch intent nonce
    let resource_str = resource.unwrap_or("");
    let mut path = format!("/_auth/intent/nonce?action={action}");
    if !resource_str.is_empty() {
        path.push_str(&format!("&resource={resource_str}"));
    }
    let nonce_resp = http.get(session_state, &path).await?;
    let nonce = nonce_resp["nonce"]
        .as_str()
        .ok_or_else(|| Error::SigningFailed("no intent nonce returned".into()))?
        .to_string();

    let payload = format!("intent|{action}|{resource_str}|{nonce}");
    let payload_bytes = payload.as_bytes();

    let sig_b64 = match required {
        "slhdsa128s" => {
            let sk_arr: [u8; 64] = keys.intent_slhdsa128s_sk.as_slice().try_into()
                .map_err(|_| Error::SigningFailed(format!(
                    "SLH-DSA intent sk wrong size: {}", keys.intent_slhdsa128s_sk.len()
                )))?;
            let sk = fips205::slh_dsa_sha2_128s::PrivateKey::try_from_bytes(&sk_arr)
                .map_err(|_| Error::SigningFailed("invalid SLH-DSA intent key".into()))?;
            let sig = sk.try_sign(payload_bytes, &[], false)
                .map_err(|_| Error::SigningFailed("SLH-DSA intent signing failed".into()))?;
            B64.encode(sig)
        }
        "mldsa44" => {
            let sk_arr: [u8; 2560] = keys
                .intent_mldsa44_sk
                .as_slice()
                .try_into()
                .map_err(|_| {
                    Error::SigningFailed(format!(
                        "ML-DSA-44 sk wrong size: {}",
                        keys.intent_mldsa44_sk.len()
                    ))
                })?;
            let sk = fips204::ml_dsa_44::PrivateKey::try_from_bytes(sk_arr)
                .map_err(|_| Error::SigningFailed("invalid ML-DSA-44 secret key".into()))?;
            let sig = sk
                .try_sign(payload_bytes, &[])
                .map_err(|_| Error::SigningFailed("ML-DSA-44 signing failed".into()))?;
            B64.encode(sig)
        }
        _ => return Err(Error::SigningFailed(format!("unknown type: {required}"))),
    };

    Ok(IntentSignature {
        intent_signature: sig_b64,
        intent_nonce: nonce,
        intent_type: required.to_string(),
    })
}

pub fn clear_keys(server_domain: &str) -> Result<(), Error> {
    let _ = storage::remove(&pubkeys_key(server_domain));
    storage::clear_all(server_domain)
}

// ── Bundle encode/decode (matches operator-key.ts format) ──

struct SecretBundle {
    operator: Vec<u8>,
    intent_mldsa44: Vec<u8>,
    intent_slhdsa128s: Vec<u8>,
}

fn encode_bundle(bundle: &SecretBundle) -> Vec<u8> {
    let mut out = Vec::new();
    out.push(BUNDLE_VERSION);
    for secret in [&bundle.operator, &bundle.intent_mldsa44, &bundle.intent_slhdsa128s] {
        let len = (secret.len() as u32).to_be_bytes();
        out.extend_from_slice(&len);
        out.extend_from_slice(secret);
    }
    out
}

fn decode_bundle(bytes: &[u8]) -> Result<SecretBundle, Error> {
    if bytes.is_empty() || bytes[0] != BUNDLE_VERSION {
        return Err(Error::InvalidBundle(format!(
            "version mismatch: expected {BUNDLE_VERSION}, got {}",
            bytes.first().map_or("none".to_string(), |b| b.to_string())
        )));
    }
    let mut off = 1usize;
    let read_one = |data: &[u8], offset: &mut usize| -> Result<Vec<u8>, Error> {
        if *offset + 4 > data.len() {
            return Err(Error::InvalidBundle("truncated (len header)".into()));
        }
        let len = u32::from_be_bytes(
            data[*offset..*offset + 4]
                .try_into()
                .map_err(|_| Error::InvalidBundle("len parse".into()))?,
        ) as usize;
        *offset += 4;
        if *offset + len > data.len() {
            return Err(Error::InvalidBundle("truncated (body)".into()));
        }
        let slice = data[*offset..*offset + len].to_vec();
        *offset += len;
        Ok(slice)
    };

    let operator = read_one(bytes, &mut off)?;
    let intent_mldsa44 = read_one(bytes, &mut off)?;
    let intent_slhdsa128s = read_one(bytes, &mut off)?;

    if off != bytes.len() {
        return Err(Error::InvalidBundle("trailing bytes".into()));
    }

    Ok(SecretBundle {
        operator,
        intent_mldsa44,
        intent_slhdsa128s,
    })
}

fn wrap_bundle(bundle: &SecretBundle, kek: &[u8; 32]) -> Result<Vec<u8>, Error> {
    let mut plaintext = encode_bundle(bundle);
    let cipher = Aes256Gcm::new_from_slice(kek)
        .map_err(|_| Error::Other("AES-GCM key init failed".into()))?;

    let mut iv = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut iv);
    let nonce = Nonce::from_slice(&iv);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|_| Error::Other("AES-GCM encryption failed".into()))?;

    plaintext.zeroize();

    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn unwrap_bundle(blob: &[u8], kek: &[u8; 32]) -> Result<SecretBundle, Error> {
    if blob.len() < 13 {
        return Err(Error::InvalidBundle("blob too short".into()));
    }
    let iv = &blob[..12];
    let ciphertext = &blob[12..];

    let cipher = Aes256Gcm::new_from_slice(kek)
        .map_err(|_| Error::Other("AES-GCM key init failed".into()))?;
    let nonce = Nonce::from_slice(iv);

    let mut plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| Error::DecryptionFailed)?;

    let result = decode_bundle(&plaintext);
    plaintext.zeroize();
    result
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
    fn bundle_round_trip() {
        let bundle = SecretBundle {
            operator: vec![1u8; 64],
            intent_mldsa44: vec![2u8; 2560],
            intent_slhdsa128s: vec![3u8; 64],
        };
        let encoded = encode_bundle(&bundle);
        let decoded = decode_bundle(&encoded).unwrap();

        assert_eq!(decoded.operator, bundle.operator);
        assert_eq!(decoded.intent_mldsa44, bundle.intent_mldsa44);
        assert_eq!(decoded.intent_slhdsa128s, bundle.intent_slhdsa128s);
    }

    #[test]
    fn bundle_wrap_unwrap_round_trip() {
        let bundle = SecretBundle {
            operator: vec![0xAA; 64],
            intent_mldsa44: vec![0xBB; 2560],
            intent_slhdsa128s: vec![0xCC; 64],
        };
        let mut kek = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut kek);

        let wrapped = wrap_bundle(&bundle, &kek).unwrap();
        let unwrapped = unwrap_bundle(&wrapped, &kek).unwrap();

        assert_eq!(unwrapped.operator, bundle.operator);
        assert_eq!(unwrapped.intent_mldsa44, bundle.intent_mldsa44);
        assert_eq!(unwrapped.intent_slhdsa128s, bundle.intent_slhdsa128s);
    }

    #[test]
    fn bundle_wrong_kek_fails() {
        let bundle = SecretBundle {
            operator: vec![0xDD; 64],
            intent_mldsa44: vec![0xEE; 2560],
            intent_slhdsa128s: vec![0xFF; 64],
        };
        let mut kek = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut kek);
        let wrapped = wrap_bundle(&bundle, &kek).unwrap();

        let wrong_kek = [0x11u8; 32];
        assert!(unwrap_bundle(&wrapped, &wrong_kek).is_err());
    }

    #[test]
    fn intent_signature_type_classification() {
        assert_eq!(get_required_signature_type("deploy"), Some("slhdsa128s"));
        assert_eq!(get_required_signature_type("db_migrate"), Some("slhdsa128s"));
        assert_eq!(get_required_signature_type("wallet_spend"), Some("slhdsa128s"));
        assert_eq!(get_required_signature_type("db_write"), Some("mldsa44"));
        assert_eq!(get_required_signature_type("git_push_external"), Some("mldsa44"));
        assert_eq!(get_required_signature_type("exec"), Some("mldsa44"));
        assert_eq!(get_required_signature_type("logs"), None);
        assert_eq!(get_required_signature_type("env"), None);
    }

    #[test]
    fn prf_salt_derivation_is_deterministic() {
        let salt1 = Sha256::digest(OPERATOR_PRF_SALT_LABEL);
        let salt2 = Sha256::digest(OPERATOR_PRF_SALT_LABEL);
        assert_eq!(salt1.as_slice(), salt2.as_slice());
        assert_eq!(salt1.len(), 32);
    }

    #[test]
    fn prf_salt_matches_web_sha256_of_label() {
        let salt = Sha256::digest(b"ellul-operator-key-v1");
        assert_eq!(salt.len(), 32);
        assert_ne!(salt.as_slice(), &[0u8; 32]);
        assert_eq!(OPERATOR_PRF_SALT_LABEL, b"ellul-operator-key-v1");
    }

    #[test]
    fn legacy_random_kek_cannot_unwrap_prf_wrapped_bundle() {
        let bundle = SecretBundle {
            operator: vec![0xAA; 64],
            intent_mldsa44: vec![0xBB; 2560],
            intent_slhdsa128s: vec![0xCC; 64],
        };
        let mut prf_kek = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut prf_kek);
        let wrapped = wrap_bundle(&bundle, &prf_kek).unwrap();

        let mut legacy_kek = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut legacy_kek);
        assert!(unwrap_bundle(&wrapped, &legacy_kek).is_err(),
            "legacy random KEK must not decrypt PRF-wrapped bundle");
    }

    #[test]
    fn no_legacy_kek_stored_after_bind() {
        let kek_key = storage::kek_key("test.example.com");
        assert_eq!(kek_key, "kek:test.example.com");
        let bundle_key = storage::bundle_key("test.example.com");
        assert_eq!(bundle_key, "bundle:test.example.com");
    }

    #[test]
    fn full_keygen_wrap_sign_round_trip() {
        let (op_pk, op_sk) = fips205::slh_dsa_sha2_128s::try_keygen().unwrap();
        let (ml_pk, ml_sk) = fips204::ml_dsa_44::try_keygen().unwrap();
        let (si_pk, si_sk) = fips205::slh_dsa_sha2_128s::try_keygen().unwrap();

        let op_sk_bytes = op_sk.into_bytes().to_vec();
        let ml_sk_bytes = ml_sk.into_bytes().to_vec();
        let si_sk_bytes = si_sk.into_bytes().to_vec();

        let bundle = SecretBundle {
            operator: op_sk_bytes.clone(),
            intent_mldsa44: ml_sk_bytes.clone(),
            intent_slhdsa128s: si_sk_bytes.clone(),
        };

        let mut kek = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut kek);
        let wrapped = wrap_bundle(&bundle, &kek).unwrap();
        let unwrapped = unwrap_bundle(&wrapped, &kek).unwrap();

        assert_eq!(unwrapped.operator, op_sk_bytes);
        assert_eq!(unwrapped.intent_mldsa44, ml_sk_bytes);
        assert_eq!(unwrapped.intent_slhdsa128s, si_sk_bytes);

        let keys = OperatorKeys {
            server_domain: "test.example.com".into(),
            operator_sk: unwrapped.operator,
            operator_pk_b64: B64.encode(op_pk.into_bytes()),
            intent_mldsa44_sk: unwrapped.intent_mldsa44,
            intent_mldsa44_pk_b64: B64.encode(ml_pk.into_bytes()),
            intent_slhdsa128s_sk: unwrapped.intent_slhdsa128s,
            intent_slhdsa128s_pk_b64: B64.encode(si_pk.into_bytes()),
        };
        let sig = sign_operator(&keys, b"test payload").unwrap();
        assert!(!sig.signature.is_empty());
        assert!(!sig.timestamp.is_empty());
    }

    #[test]
    fn wrap_produces_unique_ciphertext_per_call() {
        let bundle = SecretBundle {
            operator: vec![1u8; 64],
            intent_mldsa44: vec![2u8; 2560],
            intent_slhdsa128s: vec![3u8; 64],
        };
        let kek = [0x42u8; 32];
        let w1 = wrap_bundle(&bundle, &kek).unwrap();
        let w2 = wrap_bundle(&bundle, &kek).unwrap();
        assert_ne!(w1, w2, "random IV must produce different ciphertext");
        assert_eq!(
            unwrap_bundle(&w1, &kek).unwrap().operator,
            unwrap_bundle(&w2, &kek).unwrap().operator,
        );
    }

    #[test]
    fn tampered_ciphertext_rejected() {
        let bundle = SecretBundle {
            operator: vec![0xAA; 64],
            intent_mldsa44: vec![0xBB; 2560],
            intent_slhdsa128s: vec![0xCC; 64],
        };
        let kek = [0x55u8; 32];
        let mut wrapped = wrap_bundle(&bundle, &kek).unwrap();
        let mid = wrapped.len() / 2;
        wrapped[mid] ^= 0xFF;
        assert!(unwrap_bundle(&wrapped, &kek).is_err(),
            "tampered ciphertext must be rejected by AES-GCM");
    }

    #[test]
    fn truncated_blob_rejected() {
        assert!(unwrap_bundle(&[0u8; 12], &[0u8; 32]).is_err());
        assert!(unwrap_bundle(&[], &[0u8; 32]).is_err());
    }
}
