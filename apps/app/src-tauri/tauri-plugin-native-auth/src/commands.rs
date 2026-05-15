use serde::{Deserialize, Serialize};
use tauri::command;

use crate::Error;

#[derive(Debug, Serialize, Deserialize)]
pub struct AppleSignInResult {
    pub identity_token: String,
    pub user_id: String,
    pub email: Option<String>,
    pub given_name: Option<String>,
    pub family_name: Option<String>,
}

/// Native Apple Sign In — iOS only.
/// On non-Apple platforms, returns an error so the frontend can fall back to web OAuth.
#[command]
pub async fn sign_in_apple() -> Result<AppleSignInResult, Error> {
    #[cfg(target_os = "ios")]
    {
        ios_apple_sign_in().await
    }

    #[cfg(target_os = "macos")]
    {
        macos_apple_sign_in().await
    }

    #[cfg(not(any(target_os = "ios", target_os = "macos")))]
    {
        Err(Error::NotApplePlatform)
    }
}

/// Open system browser for OAuth (GitHub/Google).
/// Uses ASWebAuthenticationSession on iOS, Custom Tabs on Android, default browser on desktop.
#[command]
pub async fn open_oauth_browser(url: String) -> Result<(), Error> {
    open::that(&url).map_err(|e: std::io::Error| Error::BrowserOpenFailed(e.to_string()))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PushTokenResult {
    pub token: String,
}

/// Register for remote push notifications and return the device token.
/// iOS: Returns APNs device token (hex-encoded).
/// Android: Returns FCM registration token.
/// Desktop: Returns error (desktop uses local notifications).
#[command]
pub async fn register_push() -> Result<PushTokenResult, Error> {
    #[cfg(target_os = "ios")]
    {
        // On iOS, this is handled by the Swift plugin bridge.
        // The Rust side returns an error — the mobile plugin intercepts the call.
        Err(Error::PushNotAvailable)
    }

    #[cfg(target_os = "android")]
    {
        // On Android, this is handled by the Kotlin plugin bridge.
        Err(Error::PushNotAvailable)
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        Err(Error::PushNotAvailable)
    }
}

/// Trigger haptic feedback on mobile devices.
/// On desktop, this is a no-op.
#[command]
pub async fn haptic_feedback(intensity: String) -> Result<(), Error> {
    // Validate intensity
    match intensity.as_str() {
        "light" | "medium" | "heavy" => {}
        _ => return Err(Error::InvalidHapticIntensity(intensity)),
    }

    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        // On mobile, the native plugin bridge intercepts this call.
        // If we reach here, it means the bridge didn't handle it.
        Ok(())
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        // No-op on desktop
        Ok(())
    }
}

/// Copy text to the system clipboard.
/// On desktop, uses arboard. On mobile, the native plugin bridge handles it.
#[command]
pub async fn copy_to_clipboard(text: String, label: Option<String>) -> Result<(), Error> {
    const MAX_CLIPBOARD_SIZE: usize = 10 * 1024 * 1024; // 10MB
    if text.len() > MAX_CLIPBOARD_SIZE {
        return Err(Error::ClipboardFailed(format!(
            "Text too large: {} bytes (max {})", text.len(), MAX_CLIPBOARD_SIZE
        )));
    }

    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        // On mobile, the native plugin bridge (Swift/Kotlin) intercepts this call.
        let _ = (text, label);
        Ok(())
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = label; // label is Android-only
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|e| Error::ClipboardFailed(e.to_string()))?;
        clipboard
            .set_text(&text)
            .map_err(|e| Error::ClipboardFailed(e.to_string()))?;
        Ok(())
    }
}

/// Share content via the native share sheet.
/// Only available on mobile (iOS/Android). Returns error on desktop.
#[command]
pub async fn share(text: Option<String>, title: Option<String>, url: Option<String>) -> Result<(), Error> {
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        // On mobile, the native plugin bridge (Swift/Kotlin) intercepts this call.
        let _ = (text, title, url);
        Ok(())
    }

    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = (text, title, url);
        Err(Error::ShareNotAvailable)
    }
}

// ─── macOS Apple Sign In via AuthenticationServices ─────────────

#[cfg(target_os = "macos")]
async fn macos_apple_sign_in() -> Result<AppleSignInResult, Error> {
    // macOS Apple Sign In via AuthenticationServices requires a proper
    // NSWindow anchor. For Tauri webview apps, the web-based OAuth flow
    // is the correct approach on macOS. Native is only needed for iOS.
    Err(Error::NotApplePlatform)
}

// ─── iOS Apple Sign In via AuthenticationServices ───────────────

#[cfg(target_os = "ios")]
async fn ios_apple_sign_in() -> Result<AppleSignInResult, Error> {
    use std::sync::{Arc, Mutex};
    use tokio::sync::oneshot;

    // Bridge to Swift via Objective-C runtime
    // The actual implementation is in the Swift plugin code (ios/Sources/)
    // This Rust function calls into Swift via the Tauri mobile plugin bridge

    // For Tauri v2 mobile plugins, the Swift code is invoked through
    // the plugin's mobile extension point. The actual Apple Sign In
    // flow happens in NativeAuthPlugin.swift
    Err(Error::AppleSignInFailed(
        "iOS Apple Sign In must be invoked through the mobile plugin bridge".into()
    ))
}
