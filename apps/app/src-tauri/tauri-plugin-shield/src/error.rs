use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("No active session")]
    NoSession,
    #[error("PoP not bound — ML-KEM bind required")]
    PopNotBound,
    #[error("ML-KEM bind failed: {0}")]
    MlKemBindFailed(String),
    #[error("HTTP request failed: {0}")]
    HttpError(String),
    #[error("Operator keys not loaded")]
    OperatorNotLoaded,
    #[error("Operator bind failed: {0}")]
    OperatorBindFailed(String),
    #[error("Session already bound on another device; local key bundle missing")]
    OperatorBundleMissing,
    #[error("Bind nonce already consumed — another tab may have bound this session")]
    BindNonceConsumed,
    #[error("Keychain error: {0}")]
    KeychainError(String),
    #[error("AES-GCM decryption failed — key bundle may be corrupt")]
    DecryptionFailed,
    #[error("Invalid key bundle: {0}")]
    InvalidBundle(String),
    #[error("Signing failed: {0}")]
    SigningFailed(String),
    #[error("Unknown bridge message type: {0}")]
    UnknownMessageType(String),
    #[error("{0}")]
    Other(String),
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::HttpError(e.to_string())
    }
}
