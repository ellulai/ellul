use serde::{Deserialize, Serialize};
#[cfg(target_os = "android")]
use serde_json::json;
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
    pub phase: Option<String>,
    pub progress: Option<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TunnelStartResult {
    pub ok: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TunnelStatus {
    pub running: bool,
    pub connected: bool,
    pub subdomain: Option<String>,
    pub url: Option<String>,
    pub stats: Option<TunnelStatusStats>,
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatusStats {
    pub requests: u64,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub uptime: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub available: bool,
    pub version: Option<String>,
    pub sha256: Option<String>,
    pub url: Option<String>,
    pub size: Option<u64>,
    pub changelog: Option<String>,
    pub current_version: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettings {
    pub auto_update_services: bool,
    pub auto_update_runtime: bool,
    pub allow_metered_update: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationExportResult {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProotFetchResult {
    pub status: u16,
    pub body: String,
    pub content_type: String,
}

#[command]
pub async fn proot_fetch(
    method: String,
    path: String,
    body: Option<String>,
    port: Option<u16>,
) -> Result<ProotFetchResult, Error> {
    #[cfg(target_os = "android")]
    {
        let val = crate::bridge::call(
            "prootFetch",
            json!({
                "method": method,
                "path": path,
                "body": body,
                "port": port.unwrap_or(3005),
            }),
        )?;
        return serde_json::from_value(val).map_err(|e| Error::ProotFailed(e.to_string()));
    }
    #[cfg(not(target_os = "android"))]
    Err(Error::NotAvailable)
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
pub async fn proot_setup_reset() -> Result<(), Error> {
    #[cfg(target_os = "android")]
    {
        crate::bridge::call("resetSetup", serde_json::json!({}))?;
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
            if let Ok(current) = window.url() {
                if current.host_str() == Some("localhost") || current.host_str() == Some("127.0.0.1") {
                    return Ok(());
                }
            }
            let url: url::Url = "http://localhost:8443/dashboard"
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

#[command]
pub async fn proot_tunnel_start(subdomain: Option<String>) -> Result<TunnelStartResult, Error> {
    #[cfg(target_os = "android")]
    {
        let mut args = json!({});
        if let Some(sub) = subdomain {
            args["subdomain"] = json!(sub);
        }
        let val = crate::bridge::call("tunnelStart", args)?;
        return serde_json::from_value(val).map_err(|e| Error::ProotFailed(e.to_string()));
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = subdomain;
        Err(Error::NotAvailable)
    }
}

#[command]
pub async fn proot_tunnel_stop() -> Result<(), Error> {
    #[cfg(target_os = "android")]
    {
        crate::bridge::call("tunnelStop", json!({}))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    Err(Error::NotAvailable)
}

#[command]
pub async fn proot_tunnel_status() -> Result<TunnelStatus, Error> {
    #[cfg(target_os = "android")]
    {
        let val = crate::bridge::call("tunnelStatus", json!({}))?;
        return serde_json::from_value(val).map_err(|e| Error::ProotFailed(e.to_string()));
    }
    #[cfg(not(target_os = "android"))]
    Err(Error::NotAvailable)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConfig {
    pub has_token: bool,
    pub subdomain: Option<String>,
    pub auto_expose: bool,
}

#[command]
pub async fn proot_tunnel_set_auth(token: String) -> Result<(), Error> {
    #[cfg(target_os = "android")]
    {
        crate::bridge::call("tunnelSetAuth", json!({ "token": token }))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = token;
        Err(Error::NotAvailable)
    }
}

#[command]
pub async fn proot_tunnel_set_subdomain(subdomain: String) -> Result<(), Error> {
    #[cfg(target_os = "android")]
    {
        crate::bridge::call("tunnelSetSubdomain", json!({ "subdomain": subdomain }))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = subdomain;
        Err(Error::NotAvailable)
    }
}

#[command]
pub async fn proot_tunnel_get_config() -> Result<TunnelConfig, Error> {
    #[cfg(target_os = "android")]
    {
        let val = crate::bridge::call("tunnelGetConfig", json!({}))?;
        return serde_json::from_value(val).map_err(|e| Error::ProotFailed(e.to_string()));
    }
    #[cfg(not(target_os = "android"))]
    Err(Error::NotAvailable)
}

#[command]
pub async fn proot_tunnel_set_auto_expose(enabled: bool) -> Result<(), Error> {
    #[cfg(target_os = "android")]
    {
        crate::bridge::call("tunnelSetAutoExpose", json!({ "enabled": enabled }))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = enabled;
        Err(Error::NotAvailable)
    }
}

#[command]
pub async fn proot_update_check() -> Result<UpdateCheckResult, Error> {
    #[cfg(target_os = "android")]
    {
        let val = crate::bridge::call("updateCheck", json!({}))?;
        return serde_json::from_value(val).map_err(|e| Error::ProotFailed(e.to_string()));
    }
    #[cfg(not(target_os = "android"))]
    Err(Error::NotAvailable)
}

#[command]
pub async fn proot_update_apply(
    version: String,
    sha256: String,
    url: String,
    size: Option<u64>,
    changelog: Option<String>,
) -> Result<(), Error> {
    #[cfg(target_os = "android")]
    {
        let args = json!({
            "version": version,
            "sha256": sha256,
            "url": url,
            "size": size.unwrap_or(0),
            "changelog": changelog.unwrap_or_default(),
        });
        crate::bridge::call("updateApply", args)?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (version, sha256, url, size, changelog);
        Err(Error::NotAvailable)
    }
}

#[command]
pub async fn proot_update_get_settings() -> Result<UpdateSettings, Error> {
    #[cfg(target_os = "android")]
    {
        let val = crate::bridge::call("updateGetSettings", json!({}))?;
        return serde_json::from_value(val).map_err(|e| Error::ProotFailed(e.to_string()));
    }
    #[cfg(not(target_os = "android"))]
    Err(Error::NotAvailable)
}

#[command]
pub async fn proot_update_set_settings(
    auto_update_services: Option<bool>,
    auto_update_runtime: Option<bool>,
    allow_metered_update: Option<bool>,
) -> Result<(), Error> {
    #[cfg(target_os = "android")]
    {
        let mut args = json!({});
        if let Some(v) = auto_update_services {
            args["autoUpdateServices"] = json!(v);
        }
        if let Some(v) = auto_update_runtime {
            args["autoUpdateRuntime"] = json!(v);
        }
        if let Some(v) = allow_metered_update {
            args["allowMeteredUpdate"] = json!(v);
        }
        crate::bridge::call("updateSetSettings", args)?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (auto_update_services, auto_update_runtime, allow_metered_update);
        Err(Error::NotAvailable)
    }
}

#[command]
pub async fn proot_update_cancel() -> Result<(), Error> {
    #[cfg(target_os = "android")]
    {
        crate::bridge::call("updateCancel", json!({}))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    Err(Error::NotAvailable)
}

#[command]
pub async fn proot_migration_export_file() -> Result<MigrationExportResult, Error> {
    #[cfg(target_os = "android")]
    {
        let val = crate::bridge::call("migrationExportFile", json!({}))?;
        return serde_json::from_value(val).map_err(|e| Error::ProotFailed(e.to_string()));
    }
    #[cfg(not(target_os = "android"))]
    Err(Error::NotAvailable)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapAuthResult {
    pub session_id: String,
}

#[command]
pub async fn proot_bootstrap_auth() -> Result<BootstrapAuthResult, Error> {
    #[cfg(target_os = "android")]
    {
        let val = crate::bridge::call("bootstrapAuth", json!({}))?;
        return serde_json::from_value(val).map_err(|e| Error::ProotFailed(e.to_string()));
    }
    #[cfg(not(target_os = "android"))]
    Err(Error::NotAvailable)
}
