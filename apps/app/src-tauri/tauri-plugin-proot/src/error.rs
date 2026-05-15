use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("proot is not available on this platform")]
    NotAvailable,
    #[error("proot operation failed: {0}")]
    ProotFailed(String),
    #[error("Health check failed: {0}")]
    HealthCheckFailed(String),
    #[error("Setup failed: {0}")]
    SetupFailed(String),
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
