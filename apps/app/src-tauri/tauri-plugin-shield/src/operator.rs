use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use fips204::traits::{SerDes as SerDes204, Signer as Signer204};
use fips205::traits::{SerDes as SerDes205, Signer as Signer205};
use rand::RngCore;
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

    let status = http.get(session_state, "/_auth/gates/operator-status").await?;
    let bound = status["bound"].as_bool().unwrap_or(false);

    if bound {
        let bundle_data = storage::load(&storage::bundle_key(&server_domain))?;
        let kek_data = storage::load(&storage::kek_key(&server_domain))?;

        match (bundle_data, kek_data) {
            (Some(wrapped), Some(kek_bytes)) => {
                let mut kek = [0u8; 32];
                if kek_bytes.len() != 32 {
                    return Err(Error::InvalidBundle("KEK wrong length".into()));
                }
                kek.copy_from_slice(&kek_bytes);
                let bundle = unwrap_bundle(&wrapped, &kek)?;
                kek.zeroize();

                let mut guard = operator_state.0.write().await;
                *guard = Some(OperatorKeys {
                    server_domain,
                    operator_sk: bundle.operator,
                    operator_pk_b64: status["publicKey"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                    intent_mldsa44_sk: bundle.intent_mldsa44,
                    intent_mldsa44_pk_b64: status["intentMldsa44PublicKey"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                    intent_slhdsa128s_sk: bundle.intent_slhdsa128s,
                    intent_slhdsa128s_pk_b64: status["intentSlhdsa128sPublicKey"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                });
                return Ok(());
            }
            _ => return Err(Error::OperatorBundleMissing),
        }
    }

    // Not bound — generate keys and bind
    let nonce_resp = http.get(session_state, "/_auth/gates/bind-nonce").await?;
    if nonce_resp["alreadyBound"].as_bool().unwrap_or(false) {
        // Retry — another request just bound
        return load_or_bind(operator_state, session_state, http).await;
    }
    let bind_nonce = nonce_resp["nonce"]
        .as_str()
        .ok_or_else(|| Error::OperatorBindFailed("no bind nonce available".into()))?
        .to_string();

    // Generate three keypairs
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

    // Wrap bundle with AES-GCM and store in keychain
    let mut kek = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut kek);

    let bundle = SecretBundle {
        operator: operator_sk_bytes.clone(),
        intent_mldsa44: mldsa44_sk_bytes.clone(),
        intent_slhdsa128s: slhdsa_intent_sk_bytes.clone(),
    };
    let wrapped = wrap_bundle(&bundle, &kek)?;

    // Bind with server
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

    // Persist to keychain
    storage::store(&storage::kek_key(&server_domain), &kek)?;
    storage::store(&storage::bundle_key(&server_domain), &wrapped)?;
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

    eprintln!("[shield-sign] payload_utf8={:?} timestamp={timestamp}", String::from_utf8_lossy(payload));
    eprintln!("[shield-sign] full_message={:?}", String::from_utf8_lossy(&message));
    eprintln!("[shield-sign] sk_len={} pk_b64_len={}", keys.operator_sk.len(), keys.operator_pk_b64.len());

    let sk_arr: [u8; 64] = keys.operator_sk.as_slice().try_into()
        .map_err(|_| Error::SigningFailed(format!(
            "SLH-DSA sk wrong size: {}", keys.operator_sk.len()
        )))?;
    let sk = fips205::slh_dsa_sha2_128s::PrivateKey::try_from_bytes(&sk_arr)
        .map_err(|_| Error::SigningFailed("invalid SLH-DSA secret key".into()))?;
    let sig = sk.try_sign(&message, &[], false)
        .map_err(|_| Error::SigningFailed("SLH-DSA signing failed".into()))?;

    eprintln!("[shield-sign] sig_len={}", sig.len());

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
}
