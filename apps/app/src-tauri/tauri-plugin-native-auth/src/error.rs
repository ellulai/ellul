use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Apple Sign In is only available on Apple platforms")]
    NotApplePlatform,
    #[error("Apple Sign In was cancelled")]
    Cancelled,
    #[error("Apple Sign In failed: {0}")]
    AppleSignInFailed(String),
    #[error("Failed to open browser: {0}")]
    BrowserOpenFailed(String),
    #[error("Push notifications not available on this platform")]
    PushNotAvailable,
    #[error("Invalid haptic intensity: {0}. Must be light, medium, or heavy")]
    InvalidHapticIntensity(String),
    #[error("Clipboard operation failed: {0}")]
    ClipboardFailed(String),
    #[error("Share not available on desktop")]
    ShareNotAvailable,
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
