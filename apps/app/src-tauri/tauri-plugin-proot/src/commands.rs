use serde::{Deserialize, Serialize};
#[cfg(target_os = "android")]
use serde_json::json;
use tauri::command;

use crate::error::Error;
use crate::health;

fn mint_internal_jwt(jwt_secret: &str) -> String {
    use base64::Engine;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let header = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(r#"{"alg":"HS256","typ":"JWT"}"#);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let payload_json = format!(r#"{{"purpose":"internal","iat":{now},"exp":{}}}"#, now + 60);
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&payload_json);

    let sign_input = format!("{header}.{payload}");
    let mut mac =
        Hmac::<Sha256>::new_from_slice(jwt_secret.as_bytes()).expect("HMAC key");
    mac.update(sign_input.as_bytes());
    let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

    format!("{sign_input}.{sig}")
}

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
pub struct ProotFetchResponse {
    pub status: u16,
    pub body: String,
    pub content_type: String,
}

fn decode_chunked(raw: &str) -> String {
    let mut result = String::new();
    let mut remaining = raw;
    loop {
        let remaining_trimmed = remaining.trim_start_matches("\r\n");
        let (size_line, rest) = match remaining_trimmed.split_once("\r\n") {
            Some(pair) => pair,
            None => break,
        };
        let size = match usize::from_str_radix(size_line.trim(), 16) {
            Ok(s) => s,
            Err(_) => break,
        };
        if size == 0 {
            break;
        }
        if rest.len() >= size {
            result.push_str(&rest[..size]);
            remaining = &rest[size..];
        } else {
            result.push_str(rest);
            break;
        }
    }
    result
}

#[command]
pub async fn proot_fetch<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    method: String,
    path: String,
    body: Option<String>,
    port: Option<u16>,
) -> Result<ProotFetchResponse, Error> {
    use tauri::Manager;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::time::{timeout, Duration};

    let target_port = port.unwrap_or(3002);
    let addr = format!("127.0.0.1:{}", target_port);

    let mut stream = timeout(Duration::from_secs(10), TcpStream::connect(&addr))
        .await
        .map_err(|_| Error::ProotFailed("connection timeout".into()))?
        .map_err(|e| Error::ProotFailed(format!("connect failed: {e}")))?;

    let auth_header = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|d| {
            std::fs::read_to_string(d.join("vault/etc/ellul/jwt-secret"))
                .or_else(|_| std::fs::read_to_string(d.join("rootfs/etc/ellul/jwt-secret")))
                .ok()
        })
        .map(|secret| format!("Authorization: Bearer {}\r\n", mint_internal_jwt(secret.trim())));

    let body_bytes = body.as_deref().unwrap_or("");
    let mut req = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{target_port}\r\nConnection: close\r\n"
    );
    if let Some(ref auth) = auth_header {
        req.push_str(auth);
    }
    if !body_bytes.is_empty() {
        req.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body_bytes.len()
        ));
    }
    req.push_str("Accept: */*\r\n\r\n");
    if !body_bytes.is_empty() {
        req.push_str(body_bytes);
    }

    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| Error::ProotFailed(format!("write failed: {e}")))?;

    let mut buf = Vec::with_capacity(64 * 1024);
    timeout(Duration::from_secs(120), async {
        loop {
            let mut chunk = [0u8; 8192];
            match stream.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(e) => return Err(Error::ProotFailed(format!("read failed: {e}"))),
            }
        }
        Ok(())
    })
    .await
    .map_err(|_| Error::ProotFailed("read timeout".into()))??;

    let response_str = String::from_utf8_lossy(&buf);
    let (head, body_content) = response_str
        .split_once("\r\n\r\n")
        .unwrap_or((&response_str, ""));

    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(500);

    let content_type = head
        .lines()
        .find(|l| l.to_lowercase().starts_with("content-type:"))
        .map(|l| l.splitn(2, ':').nth(1).unwrap_or("").trim().to_string())
        .unwrap_or_default();

    let is_chunked = head
        .lines()
        .any(|l| l.to_lowercase().starts_with("transfer-encoding:") && l.to_lowercase().contains("chunked"));

    let decoded_body = if is_chunked {
        decode_chunked(body_content)
    } else {
        body_content.to_string()
    };

    Ok(ProotFetchResponse {
        status,
        body: decoded_body,
        content_type,
    })
}
