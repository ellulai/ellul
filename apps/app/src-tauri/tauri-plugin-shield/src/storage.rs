use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

use crate::error::Error;

const SERVICE: &str = "ai.ellul.shield";

// ── Desktop + iOS: keyring (Apple Keychain / Windows Credential Manager / Secret Service) ──

#[cfg(not(target_os = "android"))]
fn entry(key: &str) -> Result<keyring::Entry, Error> {
    keyring::Entry::new(SERVICE, key).map_err(|e| Error::KeychainError(e.to_string()))
}

// ── Android: EncryptedSharedPreferences via Kotlin plugin bridge ──

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use std::sync::OnceLock;

    pub(super) trait Backend: Send + Sync {
        fn put(&self, key: &str, data_b64: &str) -> Result<(), Error>;
        fn get(&self, key: &str) -> Result<Option<String>, Error>;
        fn del(&self, key: &str) -> Result<(), Error>;
    }

    struct Bridge<R: tauri::Runtime> {
        handle: tauri::plugin::PluginHandle<R>,
    }

    impl<R: tauri::Runtime> Backend for Bridge<R> {
        fn put(&self, key: &str, data_b64: &str) -> Result<(), Error> {
            self.handle
                .run_mobile_plugin::<serde_json::Value>(
                    "secureStore",
                    serde_json::json!({ "key": key, "data": data_b64 }),
                )
                .map_err(|e| Error::KeychainError(format!("Android Keystore store: {e}")))?;
            Ok(())
        }

        fn get(&self, key: &str) -> Result<Option<String>, Error> {
            #[derive(serde::Deserialize)]
            struct Resp {
                data: Option<String>,
            }
            let resp: Resp = self
                .handle
                .run_mobile_plugin(
                    "secureLoad",
                    serde_json::json!({ "key": key }),
                )
                .map_err(|e| Error::KeychainError(format!("Android Keystore load: {e}")))?;
            Ok(resp.data)
        }

        fn del(&self, key: &str) -> Result<(), Error> {
            self.handle
                .run_mobile_plugin::<serde_json::Value>(
                    "secureRemove",
                    serde_json::json!({ "key": key }),
                )
                .map_err(|e| Error::KeychainError(format!("Android Keystore remove: {e}")))?;
            Ok(())
        }
    }

    static BACKEND: OnceLock<Box<dyn Backend>> = OnceLock::new();

    pub fn init<R: tauri::Runtime + 'static>(handle: tauri::plugin::PluginHandle<R>) {
        let _ = BACKEND.set(Box::new(Bridge { handle }));
    }

    pub(super) fn backend() -> Result<&'static dyn Backend, Error> {
        BACKEND
            .get()
            .map(|b| b.as_ref())
            .ok_or_else(|| Error::KeychainError("Android storage not initialized".into()))
    }
}

#[cfg(target_os = "android")]
pub use android::init as init_android;

// ── Public API ──

pub fn store(key: &str, data: &[u8]) -> Result<(), Error> {
    let encoded = B64.encode(data);

    #[cfg(not(target_os = "android"))]
    {
        entry(key)?
            .set_password(&encoded)
            .map_err(|e| Error::KeychainError(e.to_string()))
    }

    #[cfg(target_os = "android")]
    {
        android::backend()?.put(key, &encoded)
    }
}

pub fn load(key: &str) -> Result<Option<Vec<u8>>, Error> {
    #[cfg(not(target_os = "android"))]
    {
        match entry(key)?.get_password() {
            Ok(encoded) => {
                let bytes = B64
                    .decode(&encoded)
                    .map_err(|e| Error::KeychainError(format!("base64 decode: {e}")))?;
                Ok(Some(bytes))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::KeychainError(e.to_string())),
        }
    }

    #[cfg(target_os = "android")]
    {
        match android::backend()?.get(key)? {
            Some(encoded) => {
                let bytes = B64
                    .decode(&encoded)
                    .map_err(|e| Error::KeychainError(format!("base64 decode: {e}")))?;
                Ok(Some(bytes))
            }
            None => Ok(None),
        }
    }
}

pub fn remove(key: &str) -> Result<(), Error> {
    #[cfg(not(target_os = "android"))]
    {
        match entry(key)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::KeychainError(e.to_string())),
        }
    }

    #[cfg(target_os = "android")]
    {
        android::backend()?.del(key)
    }
}

pub fn kek_key(server_domain: &str) -> String {
    format!("kek:{server_domain}")
}

pub fn bundle_key(server_domain: &str) -> String {
    format!("bundle:{server_domain}")
}

pub fn clear_all(server_domain: &str) -> Result<(), Error> {
    remove(&kek_key(server_domain))?;
    remove(&bundle_key(server_domain))?;
    Ok(())
}
