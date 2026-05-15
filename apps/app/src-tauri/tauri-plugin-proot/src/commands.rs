use serde::{Deserialize, Serialize};
use tauri::command;

use crate::error::Error;
use crate::health;

#[derive(Debug, Serialize, Deserialize)]
pub struct ProotStatus {
    pub running: bool,
    pub services: Vec<ServiceStatus>,
    pub uptime_secs: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ServiceStatus {
    pub name: String,
    pub healthy: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SetupStatus {
    pub complete: bool,
    pub version: Option<String>,
}

#[command]
pub async fn proot_start() -> Result<(), Error> {
    #[cfg(target_os = "android")]
    {
        crate::bridge::call("startWorkspace", serde_json::json!({}))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    Err(Error::NotAvailable)
}

#[command]
pub async fn proot_stop() -> Result<(), Error> {
    #[cfg(target_os = "android")]
    {
        crate::bridge::call("stopWorkspace", serde_json::json!({}))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    Err(Error::NotAvailable)
}

#[command]
pub async fn proot_status() -> Result<ProotStatus, Error> {
    #[cfg(target_os = "android")]
    {
        let val = crate::bridge::call("getStatus", serde_json::json!({}))?;
        return serde_json::from_value(val).map_err(|e| Error::ProotFailed(e.to_string()));
    }
    #[cfg(not(target_os = "android"))]
    Err(Error::NotAvailable)
}

#[command]
pub async fn proot_health() -> Result<Vec<health::ServiceHealth>, Error> {
    Ok(health::check_all().await)
}

#[command]
pub async fn proot_setup_status() -> Result<SetupStatus, Error> {
    #[cfg(target_os = "android")]
    {
        let val = crate::bridge::call("isSetupComplete", serde_json::json!({}))?;
        return serde_json::from_value(val).map_err(|e| Error::SetupFailed(e.to_string()));
    }
    #[cfg(not(target_os = "android"))]
    Err(Error::NotAvailable)
}

#[command]
pub async fn proot_setup_start() -> Result<(), Error> {
    #[cfg(target_os = "android")]
    {
        crate::bridge::call("setupRootfs", serde_json::json!({}))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    Err(Error::NotAvailable)
}

#[command]
pub async fn proot_switch_to_local<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), Error> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let url: url::Url = "https://localhost:8443"
                .parse()
                .expect("valid localhost url");
            window
                .navigate(url)
                .map_err(|e| Error::ProotFailed(e.to_string()))?;
        }
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(Error::NotAvailable)
    }
}
