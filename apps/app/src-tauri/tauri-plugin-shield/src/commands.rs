use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{command, State};

use crate::error::Error;
use crate::http::{extract_session_cookie, ShieldHttpClient};
use crate::operator::{self, OperatorState};
use crate::pop;
use crate::session::SessionState;

fn sandbox_slug(project: &str) -> &str {
    project.split('/').next().unwrap_or(project)
}

// ── Response types (mirror bridge-contracts.ts) ──

#[derive(Serialize)]
pub struct CheckSessionResponse {
    #[serde(rename = "hasSession")]
    pub has_session: bool,
}

#[derive(Serialize)]
pub struct SignedWsUrl {
    pub url: String,
}

#[derive(Serialize)]
pub struct ShieldFetchResponse {
    pub status: u16,
    pub body: serde_json::Value,
}

// ── Native WebAuthn ceremony (called from JS) ──

#[command(rename_all = "camelCase")]
pub async fn shield_native_credential_create(
    options_json: String,
) -> Result<serde_json::Value, Error> {
    eprintln!("[shield] native_credential_create: parsing options...");
    let options: serde_json::Value = serde_json::from_str(&options_json)
        .map_err(|e| Error::HttpError(format!("bad options JSON: {e}")))?;

    let challenge_b64 = options["challenge"]
        .as_str()
        .ok_or_else(|| Error::HttpError("No challenge in options".into()))?;
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(challenge_b64)
        .map_err(|e| Error::HttpError(format!("bad challenge: {e}")))?;
    let rp_id = options["rp"]["id"].as_str().unwrap_or("ellul.ai");
    let rp_name = options["rp"]["name"].as_str().unwrap_or("ellul");
    let user = &options["user"];
    let user_id_b64 = user["id"]
        .as_str()
        .ok_or_else(|| Error::HttpError("No user.id".into()))?;
    let user_id = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(user_id_b64)
        .map_err(|e| Error::HttpError(format!("bad user.id: {e}")))?;
    let user_name = user["name"].as_str().unwrap_or("");
    let user_display = user["displayName"].as_str().unwrap_or(user_name);
    let uv = options.get("authenticatorSelection")
        .and_then(|v| v.get("userVerification"))
        .and_then(|v| v.as_str());

    eprintln!("[shield] native_credential_create: calling ASAuthorizationController rp_id={rp_id} user={user_name}");
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
    {
        crate::passkey::register(
            &challenge, rp_id, rp_name, &user_id, user_name, user_display,
            None, uv,
        )
        .await
        .map_err(|e| { eprintln!("[shield] native_credential_create FAILED: {e}"); Error::HttpError(e) })
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
    Err(Error::HttpError("Native passkey not available on this platform".into()))
}

#[command(rename_all = "camelCase")]
pub async fn shield_native_credential_get(
    challenge_b64: String,
    rp_id: String,
    allow_credentials_json: Option<String>,
    user_verification: Option<String>,
) -> Result<serde_json::Value, Error> {
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
    {
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&challenge_b64)
            .map_err(|e| Error::HttpError(format!("bad challenge: {e}")))?;
        crate::passkey::authenticate_with_options(
            &challenge,
            &rp_id,
            allow_credentials_json.as_deref(),
            user_verification.as_deref(),
        )
        .await
        .map_err(Error::HttpError)
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
    Err(Error::HttpError("Native passkey not available on this platform".into()))
}

#[command(rename_all = "camelCase")]
pub async fn shield_native_credential_get_prf(
    challenge_b64: String,
    rp_id: String,
    allow_credentials_json: Option<String>,
    user_verification: Option<String>,
    prf_salt_b64: String,
) -> Result<serde_json::Value, Error> {
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
    {
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&challenge_b64)
            .map_err(|e| Error::HttpError(format!("bad challenge: {e}")))?;
        let prf_salt = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&prf_salt_b64)
            .map_err(|e| Error::HttpError(format!("bad prf_salt: {e}")))?;
        crate::passkey::authenticate_with_prf(
            &challenge,
            &rp_id,
            allow_credentials_json.as_deref(),
            user_verification.as_deref(),
            &prf_salt,
        )
        .await
        .map_err(Error::HttpError)
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
    Err(Error::HttpError("Native PRF passkey not available on this platform".into()))
}

// ── Safari auth sheet (opens ASWebAuthenticationSession) ──

#[command(rename_all = "camelCase")]
pub async fn shield_open_auth_sheet(
    url: String,
    callback_scheme: Option<String>,
) -> Result<serde_json::Value, Error> {
    let scheme = callback_scheme.as_deref().unwrap_or("ellul-auth");
    eprintln!("[shield] open_auth_sheet url={url} scheme={scheme}");
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let callback_url = crate::passkey::web_auth_session(&url, scheme)
            .await
            .map_err(Error::HttpError)?;
        eprintln!("[shield] open_auth_sheet completed callback={callback_url}");
        Ok(serde_json::json!({ "callbackUrl": callback_url }))
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    Err(Error::HttpError("Auth sheet not available on this platform".into()))
}

// ── Session lifecycle ──

#[command]
pub async fn shield_check_session(
    session: State<'_, SessionState>,
) -> Result<CheckSessionResponse, Error> {
    Ok(CheckSessionResponse {
        has_session: session.has_session().await,
    })
}

#[command(rename_all = "camelCase")]
pub async fn shield_set_session(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    server_domain: String,
    session_cookie: String,
) -> Result<(), Error> {
    let cookie_header = format!("__Host-shield_session={session_cookie}");
    session.set(server_domain.clone(), cookie_header.clone()).await;

    // Perform ML-KEM bind immediately
    let result = pop::perform_mlkem_bind(
        http.raw(),
        &format!("https://{server_domain}"),
        &cookie_header,
    )
    .await?;
    session.set_k_pop(result.k_pop).await;

    crate::webview_cookie::inject_cookies_for_session(&cookie_header, &server_domain);
    let k_pop_b64 = base64::engine::general_purpose::STANDARD.encode(result.k_pop);
    crate::webview_cookie::inject_pop_to_webview(&k_pop_b64);

    Ok(())
}

#[command]
pub async fn shield_clear_session(
    session: State<'_, SessionState>,
    operator: State<'_, OperatorState>,
) -> Result<(), Error> {
    crate::webview_cookie::remove_pop_from_webview();
    if let Some(domain) = session.server_domain().await {
        operator::clear_keys(&domain)?;
    }
    operator.clear().await;
    session.clear().await;
    Ok(())
}

// ── Authentication (pre-session, unauthenticated) ──

#[command(rename_all = "camelCase")]
pub async fn shield_login_options(
    http: State<'_, ShieldHttpClient>,
    server_domain: String,
) -> Result<serde_json::Value, Error> {
    let base_url = format!("https://{server_domain}");
    let res = http
        .post_unauthed(&base_url, "/_auth/login/options", &serde_json::json!({}))
        .await?;
    let status = res.status();
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    if !status.is_success() {
        let err_msg = match body["error"].as_str() {
            Some(e) => e.to_string(),
            None => format!("HTTP {status}"),
        };
        return Err(Error::HttpError(err_msg));
    }
    Ok(body)
}

#[command(rename_all = "camelCase")]
pub async fn shield_login_verify(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    server_domain: String,
    assertion: serde_json::Value,
) -> Result<serde_json::Value, Error> {
    let base_url = format!("https://{server_domain}");
    let res = http
        .post_unauthed(
            &base_url,
            "/_auth/login/verify",
            &serde_json::json!({ "assertion": assertion }),
        )
        .await?;

    let status = res.status();
    let cookie = extract_session_cookie(&res);
    let body: serde_json::Value = res.json().await.unwrap_or_default();

    if !status.is_success() {
        let err_msg = match body["error"].as_str() {
            Some(e) => e.to_string(),
            None => format!("HTTP {status}"),
        };
        return Err(Error::HttpError(err_msg));
    }

    if let Some(cookie_header) = cookie {
        session
            .set(server_domain.clone(), cookie_header.clone())
            .await;
        let result = pop::perform_mlkem_bind(http.raw(), &base_url, &cookie_header).await?;
        session.set_k_pop(result.k_pop).await;
        let k_pop_b64 = base64::engine::general_purpose::STANDARD.encode(result.k_pop);
        crate::webview_cookie::inject_pop_to_webview(&k_pop_b64);
    }

    Ok(body)
}

static PASSKEY_LOGIN_ACTIVE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static PASSKEY_LOGIN_LAST_OK: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);
const PASSKEY_LOGIN_COOLDOWN_SECS: u64 = 60;

#[command(rename_all = "camelCase")]
pub async fn shield_passkey_login(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    server_domain: String,
) -> Result<serde_json::Value, Error> {
    // If we recently logged in, validate with the server before deciding.
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let last_ok = PASSKEY_LOGIN_LAST_OK.load(std::sync::atomic::Ordering::SeqCst);
    if last_ok > 0 && now_secs.saturating_sub(last_ok) < PASSKEY_LOGIN_COOLDOWN_SECS {
        let has_local = session.0.read().await.is_some();
        if has_local {
            // Actually check with the server that our session is alive
            match http.get(&session, "/_auth/session/info").await {
                Ok(info) => {
                    let alive = info.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
                    if alive {
                        eprintln!(
                            "[shield] passkey_login SKIPPED — cooldown ({}s, server confirmed alive)",
                            now_secs.saturating_sub(last_ok)
                        );
                        return Ok(serde_json::json!({"skipped": true, "reason": "cooldown"}));
                    }
                    eprintln!("[shield] passkey_login cooldown — server says NOT alive, proceeding");
                }
                Err(e) => {
                    eprintln!("[shield] passkey_login cooldown — server check failed: {e}, proceeding");
                }
            }
        }
    }

    if PASSKEY_LOGIN_ACTIVE
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_err()
    {
        eprintln!("[shield] passkey_login SKIPPED — already in progress");
        return Err(Error::Other("Passkey login already in progress".into()));
    }
    struct ResetGuard;
    impl Drop for ResetGuard {
        fn drop(&mut self) {
            PASSKEY_LOGIN_ACTIVE.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _guard = ResetGuard;
    eprintln!("[shield] passkey_login START domain={server_domain}");
    let base_url = format!("https://{server_domain}");

    // 1. Get WebAuthn options from VPS
    let res = http
        .post_unauthed(&base_url, "/_auth/login/options", &serde_json::json!({}))
        .await?;
    let status = res.status();
    let options: serde_json::Value = res.json().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::HttpError(
            options["error"].as_str().unwrap_or("options failed").to_string(),
        ));
    }

    // 2. Extract challenge + RP ID
    let challenge_b64 = options["challenge"]
        .as_str()
        .ok_or_else(|| Error::HttpError("No challenge in options".into()))?;
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(challenge_b64)
        .map_err(|e| Error::HttpError(format!("bad challenge: {e}")))?;
    let rp_id = options["rpId"].as_str().unwrap_or("ellul.ai");

    // 3. Native passkey ceremony
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
    let assertion = {
        let allow_creds = options
            .get("allowCredentials")
            .and_then(|v| serde_json::to_string(v).ok());
        let uv = options
            .get("userVerification")
            .and_then(|v| v.as_str())
            .map(String::from);
        crate::passkey::authenticate_with_options(
            &challenge,
            rp_id,
            allow_creds.as_deref(),
            uv.as_deref(),
        )
        .await
        .map_err(Error::HttpError)?
    };

    #[cfg(target_os = "android")]
    let assertion: serde_json::Value = {
        let options_json = serde_json::to_string(&options)
            .map_err(|e| Error::HttpError(format!("serialize options: {e}")))?;
        let response_json = crate::storage::android_passkey_authenticate(&options_json)?;
        serde_json::from_str(&response_json)
            .map_err(|e| Error::HttpError(format!("parse assertion: {e}")))?
    };

    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows", target_os = "android")))]
    return Err(Error::HttpError(
        "Native passkey not available on this platform. Use browser sign-in instead.".into(),
    ));

    // 4. Verify assertion with VPS
    let res = http
        .post_unauthed(
            &base_url,
            "/_auth/login/verify",
            &serde_json::json!({ "assertion": assertion }),
        )
        .await?;
    let status = res.status();
    let cookie = extract_session_cookie(&res);
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::HttpError(
            body["error"].as_str().unwrap_or("verify failed").to_string(),
        ));
    }

    // 5. Establish session + ML-KEM bind
    if let Some(cookie_header) = cookie {
        session
            .set(server_domain.clone(), cookie_header.clone())
            .await;
        let result = pop::perform_mlkem_bind(http.raw(), &base_url, &cookie_header).await?;
        let final_cookie = if let Some(rotated) = result.rotated_cookie {
            session.update_cookie(rotated.clone()).await;
            rotated
        } else {
            cookie_header
        };
        session.set_k_pop(result.k_pop).await;

        crate::webview_cookie::inject_cookies_for_session(&final_cookie, &server_domain);
        let k_pop_b64 = base64::engine::general_purpose::STANDARD.encode(result.k_pop);
        crate::webview_cookie::inject_pop_to_webview(&k_pop_b64);
        #[cfg(target_os = "macos")]
        crate::webview_cookie::start_cookie_observer(&session);
    }

    let ok_ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    PASSKEY_LOGIN_LAST_OK.store(ok_ts, std::sync::atomic::Ordering::SeqCst);
    eprintln!("[shield] passkey_login OK — cooldown armed for {PASSKEY_LOGIN_COOLDOWN_SECS}s");
    Ok(body)
}

async fn shield_passkey_register_impl(
    session: &SessionState,
    http: &ShieldHttpClient,
    server_domain: String,
    name: String,
) -> Result<serde_json::Value, Error> {
    eprintln!("[shield] passkey_register_impl START domain={server_domain} name={name}");

    eprintln!("[shield] passkey_register_impl: fetching register options (authenticated)...");
    let resp = http
        .post(session, "/_auth/register/options", &serde_json::json!({ "name": name }))
        .await?;
    eprintln!("[shield] passkey_register_impl: options OK");

    let options = resp.get("options").unwrap_or(&resp);
    let challenge_b64 = options["challenge"]
        .as_str()
        .ok_or_else(|| Error::HttpError("No challenge in register options".into()))?;
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(challenge_b64)
        .map_err(|e| Error::HttpError(format!("bad challenge: {e}")))?;
    let rp_id = options["rp"]["id"].as_str().unwrap_or("ellul.ai");
    let rp_name = options["rp"]["name"].as_str().unwrap_or("ellul");
    let user = &options["user"];
    let user_id_b64 = user["id"]
        .as_str()
        .ok_or_else(|| Error::HttpError("No user.id in register options".into()))?;
    let user_id = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(user_id_b64)
        .map_err(|e| Error::HttpError(format!("bad user.id: {e}")))?;
    let user_name = user["name"].as_str().unwrap_or("");
    let user_display = user["displayName"].as_str().unwrap_or(user_name);
    let attestation = options.get("attestation").and_then(|v| v.as_str());
    let uv = options.get("authenticatorSelection")
        .and_then(|v| v.get("userVerification"))
        .and_then(|v| v.as_str());

    eprintln!("[shield] passkey_register_impl: calling native ASAuthorizationController rp_id={rp_id} user={user_name}");
    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
    let attestation_result = {
        match crate::passkey::register(
            &challenge, rp_id, rp_name, &user_id, user_name, user_display,
            attestation, uv,
        )
        .await
        {
            Ok(v) => { eprintln!("[shield] passkey_register_impl: native register OK"); v }
            Err(e) => { eprintln!("[shield] passkey_register_impl: native register FAILED: {e}"); return Err(Error::HttpError(e)); }
        }
    };

    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "windows")))]
    return Err(Error::HttpError(
        "Native passkey registration not available on this platform.".into(),
    ));

    eprintln!("[shield] passkey_register_impl: verifying attestation with VPS...");
    let base_url = format!("https://{server_domain}");
    let verify_body = serde_json::json!({ "attestation": attestation_result, "name": name, "prfEnabled": false });

    // Verify needs auth (current session) but we also need the raw response for Set-Cookie
    let session_cookie = session.cookie_header().await;
    let mut builder = http.raw()
        .post(format!("{base_url}/_auth/register/verify"))
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .json(&verify_body);
    if let Some(ref cookie) = session_cookie {
        builder = builder.header("Cookie", cookie);
    }
    let res = builder.send().await?;

    let status = res.status();
    let cookie = extract_session_cookie(&res);
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    eprintln!("[shield] passkey_register_impl: verify status={status}");
    if !status.is_success() {
        let e = body["error"].as_str().unwrap_or("verify failed").to_string();
        eprintln!("[shield] passkey_register_impl: verify FAILED: {e}");
        return Err(Error::HttpError(e));
    }

    if let Some(cookie_header) = cookie {
        session.set(server_domain.clone(), cookie_header.clone()).await;
        let result = pop::perform_mlkem_bind(http.raw(), &base_url, &cookie_header).await?;
        session.set_k_pop(result.k_pop).await;
        eprintln!("[shield] passkey_register_impl: session + PoP bind OK");
    }

    Ok(body)
}

#[command(rename_all = "camelCase")]
pub async fn shield_passkey_register(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    server_domain: String,
    name: String,
) -> Result<serde_json::Value, Error> {
    shield_passkey_register_impl(&session, &http, server_domain, name).await
}

#[command(rename_all = "camelCase")]
pub async fn shield_register_options(
    http: State<'_, ShieldHttpClient>,
    server_domain: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, Error> {
    let base_url = format!("https://{server_domain}");
    let res = http
        .post_unauthed(&base_url, "/_auth/register/options", &body)
        .await?;
    let status = res.status();
    let resp: serde_json::Value = res.json().await.unwrap_or_default();
    if !status.is_success() {
        let err_msg = match resp["error"].as_str() {
            Some(e) => e.to_string(),
            None => format!("HTTP {status}"),
        };
        return Err(Error::HttpError(err_msg));
    }
    Ok(resp)
}

#[command(rename_all = "camelCase")]
pub async fn shield_register_verify(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    server_domain: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, Error> {
    let base_url = format!("https://{server_domain}");
    let res = http
        .post_unauthed(&base_url, "/_auth/register/verify", &body)
        .await?;

    let status = res.status();
    let cookie = extract_session_cookie(&res);
    let resp: serde_json::Value = res.json().await.unwrap_or_default();

    if !status.is_success() {
        let err_msg = match resp["error"].as_str() {
            Some(e) => e.to_string(),
            None => format!("HTTP {status}"),
        };
        return Err(Error::HttpError(err_msg));
    }

    if let Some(cookie_header) = cookie {
        session
            .set(server_domain.clone(), cookie_header.clone())
            .await;
        let result = pop::perform_mlkem_bind(http.raw(), &base_url, &cookie_header).await?;
        session.set_k_pop(result.k_pop).await;
    }

    Ok(resp)
}

#[command(rename_all = "camelCase")]
pub async fn shield_web_auth_login(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    server_domain: String,
    console_url: String,
) -> Result<serde_json::Value, Error> {
    let base_url = format!("https://{server_domain}");

    let res = http
        .post_unauthed(&base_url, "/_auth/login/options", &serde_json::json!({}))
        .await?;
    let status = res.status();
    let options: serde_json::Value = res.json().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::HttpError(
            options["error"].as_str().unwrap_or("options failed").to_string(),
        ));
    }

    let flow_id = uuid::Uuid::new_v4().to_string();
    let api_url = console_url.replace("console.", "api.");

    let relay_client = reqwest::Client::new();
    let relay_res = relay_client
        .post(format!("{api_url}/api/auth/native/vps-auth-data"))
        .json(&serde_json::json!({
            "flowId": flow_id,
            "type": "options",
            "data": options,
        }))
        .send()
        .await
        .map_err(|e| Error::HttpError(format!("relay store options: {e}")))?;

    if !relay_res.status().is_success() {
        return Err(Error::HttpError("Failed to store auth options at relay".into()));
    }

    let auth_url = format!(
        "{console_url}/en/vps-auth?flow_id={flow_id}&server={server_domain}"
    );

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        crate::passkey::web_auth_session(&auth_url, "ellul-auth")
            .await
            .map_err(Error::HttpError)?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    return Err(Error::HttpError(
        "Web auth session not available on this platform".into(),
    ));

    let mut assertion: Option<serde_json::Value> = None;
    for _ in 0..30 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let poll_res = relay_client
            .get(format!(
                "{api_url}/api/auth/native/vps-auth-data?flow_id={flow_id}&type=assertion"
            ))
            .send()
            .await
            .map_err(|e| Error::HttpError(format!("relay poll assertion: {e}")))?;
        let body: serde_json::Value = poll_res.json().await.unwrap_or_default();
        if body["status"].as_str() == Some("complete") {
            assertion = body.get("data").cloned();
            break;
        }
    }

    let assertion = assertion
        .ok_or_else(|| Error::HttpError("Timeout waiting for passkey assertion".into()))?;

    let res = http
        .post_unauthed(
            &base_url,
            "/_auth/login/verify",
            &serde_json::json!({ "assertion": assertion }),
        )
        .await?;
    let status = res.status();
    let cookie = extract_session_cookie(&res);
    let body: serde_json::Value = res.json().await.unwrap_or_default();
    if !status.is_success() {
        return Err(Error::HttpError(
            body["error"].as_str().unwrap_or("verify failed").to_string(),
        ));
    }

    if let Some(cookie_header) = cookie {
        session
            .set(server_domain.clone(), cookie_header.clone())
            .await;
        let result = pop::perform_mlkem_bind(http.raw(), &base_url, &cookie_header).await?;
        session.set_k_pop(result.k_pop).await;
    }

    Ok(body)
}

#[command(rename_all = "camelCase")]
pub async fn shield_web_auth_register(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    server_domain: String,
    name: String,
    console_url: String,
) -> Result<serde_json::Value, Error> {
    // Delegate directly to native ASAuthorizationController passkey + PoP
    eprintln!("[shield] web_auth_register → delegating to native passkey_register domain={server_domain}");
    let _ = console_url; // not needed for native path
    shield_passkey_register_impl(&session, &http, server_domain, name).await
}

#[command]
pub async fn shield_session_info(
    session: State<'_, SessionState>,
) -> Result<serde_json::Value, Error> {
    match session.session_info().await {
        Some(info) => {
            let mut obj =
                serde_json::to_value(info).map_err(|e| Error::Other(e.to_string()))?;
            obj["active"] = serde_json::Value::Bool(true);
            Ok(obj)
        }
        None => Ok(serde_json::json!({ "active": false })),
    }
}

#[command]
pub async fn shield_logout(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    operator: State<'_, OperatorState>,
) -> Result<(), Error> {
    let _ = http
        .post(&session, "/_auth/logout", &serde_json::json!({}))
        .await;
    if let Some(domain) = session.server_domain().await {
        let _ = operator::clear_keys(&domain);
    }
    operator.clear().await;
    session.clear().await;
    Ok(())
}

// ── Session keepalive ──

#[command]
pub async fn shield_session_keepalive(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
) -> Result<serde_json::Value, Error> {
    http.post(&session, "/_auth/session/keepalive", &serde_json::json!({}))
        .await
}

// ── Token issuance ──

#[command]
pub async fn shield_get_code_session(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
) -> Result<serde_json::Value, Error> {
    http.post(&session, "/_auth/code/session", &serde_json::json!({}))
        .await
}

#[command]
pub async fn shield_get_code_token(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
) -> Result<serde_json::Value, Error> {
    http.post(&session, "/_auth/code/token", &serde_json::json!({}))
        .await
}

#[command]
pub async fn shield_get_agent_token(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
) -> Result<serde_json::Value, Error> {
    http.post(&session, "/_auth/agent/token", &serde_json::json!({}))
        .await
}

#[command]
pub async fn shield_get_terminal_token(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
) -> Result<serde_json::Value, Error> {
    http.post(&session, "/_auth/terminal/token", &serde_json::json!({}))
        .await
}

#[command]
pub async fn shield_get_preview_token(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
) -> Result<serde_json::Value, Error> {
    http.post(&session, "/_auth/preview/authorize", &serde_json::json!({}))
        .await
}

#[command]
pub async fn shield_get_exchange_code(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
) -> Result<serde_json::Value, Error> {
    http.post(
        &session,
        "/_auth/bridge/exchange-code",
        &serde_json::json!({}),
    )
    .await
}

// ── Permission inbox ──

#[command]
pub async fn shield_permission_list_pending(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
) -> Result<serde_json::Value, Error> {
    http.get(&session, "/_auth/permissions/pending").await
}

#[command]
pub async fn shield_permission_get(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    id: String,
) -> Result<serde_json::Value, Error> {
    http.get(&session, &format!("/_auth/permissions/{id}")).await
}

#[command]
pub async fn shield_permission_history(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
) -> Result<serde_json::Value, Error> {
    http.get(&session, "/_auth/permissions/history").await
}

#[command]
pub async fn shield_permission_mark_seen(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    id: String,
) -> Result<serde_json::Value, Error> {
    http.post(
        &session,
        &format!("/_auth/permissions/{id}/seen"),
        &serde_json::json!({}),
    )
    .await
}

// ── Gate operations ──

#[command]
pub async fn shield_gate_list_active(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    project: String,
) -> Result<serde_json::Value, Error> {
    let sts = http.acquire_sts_token(&session, &project).await?;
    http.get_with_headers(&session, "/_auth/gates/active", &[("X-STS-Token", &sts)])
        .await
}

#[command]
pub async fn shield_gate_request(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    project: String,
    gate: String,
    reason: Option<String>,
) -> Result<serde_json::Value, Error> {
    let sts = http.acquire_sts_token(&session, &project).await?;
    http.post_with_headers(
        &session,
        "/_auth/gates/request",
        &serde_json::json!({
            "gate": gate,
            "reason": reason.unwrap_or_default(),
        }),
        &[("X-STS-Token", &sts)],
    )
    .await
}

#[derive(Deserialize)]
pub struct GateRespondArgs {
    #[serde(rename = "gateRequestId")]
    pub gate_request_id: String,
    pub action: String,
    pub metadata: Option<serde_json::Value>,
    #[serde(rename = "operatorSignature")]
    pub operator_signature: Option<String>,
    #[serde(rename = "operatorTimestamp")]
    pub operator_timestamp: Option<String>,
    #[serde(rename = "intentSignature")]
    pub intent_signature: Option<String>,
    #[serde(rename = "intentNonce")]
    pub intent_nonce: Option<String>,
    #[serde(rename = "intentType")]
    pub intent_type: Option<String>,
}

#[command]
pub async fn shield_gate_respond(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    args: GateRespondArgs,
) -> Result<serde_json::Value, Error> {
    let mut body = serde_json::json!({
        "gateRequestId": args.gate_request_id,
        "action": args.action,
    });

    if let Some(meta) = &args.metadata {
        body["metadata"] = meta.clone();
    }
    if let Some(sig) = &args.operator_signature {
        body["operatorSignature"] = serde_json::Value::String(sig.clone());
    }
    if let Some(ts) = &args.operator_timestamp {
        body["operatorTimestamp"] = serde_json::Value::String(ts.clone());
    }
    if let Some(sig) = &args.intent_signature {
        body["intentSignature"] = serde_json::Value::String(sig.clone());
    }
    if let Some(n) = &args.intent_nonce {
        body["intentNonce"] = serde_json::Value::String(n.clone());
    }
    if let Some(t) = &args.intent_type {
        body["intentType"] = serde_json::Value::String(t.clone());
    }

    http.post(&session, "/_auth/gates/respond", &body).await
}

#[command(rename_all = "camelCase")]
pub async fn shield_gate_revoke(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    gate: String,
    project: String,
    operator_signature: Option<String>,
    operator_timestamp: Option<String>,
) -> Result<serde_json::Value, Error> {
    let mut body = serde_json::json!({
        "gate": gate,
        "project": project,
    });
    if let Some(sig) = &operator_signature {
        body["operatorSignature"] = serde_json::Value::String(sig.clone());
    }
    if let Some(ts) = &operator_timestamp {
        body["operatorTimestamp"] = serde_json::Value::String(ts.clone());
    }
    http.post(&session, "/_auth/gates/revoke", &body).await
}

#[command(rename_all = "camelCase")]
pub async fn shield_gate_set_permission(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    gate: String,
    project: String,
    policy: String,
    operator_signature: Option<String>,
    operator_timestamp: Option<String>,
) -> Result<serde_json::Value, Error> {
    let mut body = serde_json::json!({
        "gate": gate,
        "project": project,
        "policy": policy,
    });
    if let Some(sig) = &operator_signature {
        body["operatorSignature"] = serde_json::Value::String(sig.clone());
    }
    if let Some(ts) = &operator_timestamp {
        body["operatorTimestamp"] = serde_json::Value::String(ts.clone());
    }
    http.post(&session, "/_auth/gates/permissions", &body).await
}

// ── Context mode ──

#[command]
pub async fn shield_context_mode_get(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    project: Option<String>,
) -> Result<serde_json::Value, Error> {
    let proj = project.unwrap_or_default();
    let slug = sandbox_slug(&proj);
    http.get(&session, &format!("/_auth/context-mode?project={}", urlencoding::encode(slug)))
        .await
}

#[command(rename_all = "camelCase")]
pub async fn shield_context_mode_set(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    operator: State<'_, OperatorState>,
    project: String,
    mode: String,
    operator_signature: Option<String>,
    operator_timestamp: Option<String>,
) -> Result<serde_json::Value, Error> {
    let slug = sandbox_slug(&project);
    let mut body = serde_json::json!({ "project": slug, "mode": mode });
    if operator_signature.is_some() {
        let guard = operator.0.read().await;
        if let Some(keys) = guard.as_ref() {
            let payload = format!("context-mode|{slug}|{mode}");
            let sig = operator::sign_operator(keys, payload.as_bytes())?;
            body["operatorSignature"] = serde_json::Value::String(sig.signature);
            body["operatorTimestamp"] = serde_json::Value::String(sig.timestamp);
        }
    }
    http.post(&session, "/_auth/context-mode", &body).await
}

// ── Tool permissions ──

#[command(rename_all = "camelCase")]
pub async fn shield_tool_permission_set(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    permissions: serde_json::Value,
    operator_signature: Option<String>,
    operator_timestamp: Option<String>,
) -> Result<serde_json::Value, Error> {
    let mut body = serde_json::json!({ "permissions": permissions });
    if let Some(sig) = &operator_signature {
        body["operatorSignature"] = serde_json::Value::String(sig.clone());
    }
    if let Some(ts) = &operator_timestamp {
        body["operatorTimestamp"] = serde_json::Value::String(ts.clone());
    }
    http.post(&session, "/_auth/tool-permissions", &body).await
}

#[command(rename_all = "camelCase")]
pub async fn shield_tool_permission_reset(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    operator_signature: Option<String>,
    operator_timestamp: Option<String>,
) -> Result<serde_json::Value, Error> {
    let mut body = serde_json::json!({});
    if let Some(sig) = &operator_signature {
        body["operatorSignature"] = serde_json::Value::String(sig.clone());
    }
    if let Some(ts) = &operator_timestamp {
        body["operatorTimestamp"] = serde_json::Value::String(ts.clone());
    }
    http.post(&session, "/_auth/tool-permissions/reset", &body)
        .await
}

// ── Operator key lifecycle ──

#[command]
pub async fn shield_operator_status(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
) -> Result<serde_json::Value, Error> {
    http.get(&session, "/_auth/gates/operator-status").await
}

#[command]
pub async fn shield_operator_bind(
    session: State<'_, SessionState>,
    operator: State<'_, OperatorState>,
    http: State<'_, ShieldHttpClient>,
) -> Result<serde_json::Value, Error> {
    operator::load_or_bind(&operator, &session, &http).await?;
    Ok(serde_json::json!({ "status": "bound" }))
}

#[command(rename_all = "camelCase")]
pub async fn shield_operator_sign(
    session: State<'_, SessionState>,
    operator: State<'_, OperatorState>,
    http: State<'_, ShieldHttpClient>,
    payload_b64: String,
) -> Result<operator::OperatorSignature, Error> {
    operator::load_or_bind(&operator, &session, &http).await?;
    let guard = operator.0.read().await;
    let keys = guard.as_ref().ok_or(Error::OperatorNotLoaded)?;
    let payload = base64::engine::general_purpose::STANDARD
        .decode(&payload_b64)
        .map_err(|e| Error::Other(format!("decode payload: {e}")))?;
    operator::sign_operator(keys, &payload)
}

#[command]
pub async fn shield_operator_sign_intent(
    session: State<'_, SessionState>,
    operator: State<'_, OperatorState>,
    http: State<'_, ShieldHttpClient>,
    action: String,
    resource: Option<String>,
) -> Result<operator::IntentSignature, Error> {
    operator::load_or_bind(&operator, &session, &http).await?;
    let guard = operator.0.read().await;
    let keys = guard.as_ref().ok_or(Error::OperatorNotLoaded)?;
    operator::sign_intent(keys, &session, &http, &action, resource.as_deref()).await
}

#[command]
pub async fn shield_operator_clear(
    session: State<'_, SessionState>,
    operator: State<'_, OperatorState>,
) -> Result<(), Error> {
    if let Some(domain) = session.server_domain().await {
        operator::clear_keys(&domain)?;
    }
    operator.clear().await;
    Ok(())
}

// ── Intent nonces ──

#[command]
pub async fn shield_intent_nonce(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    action: String,
    resource: Option<String>,
) -> Result<serde_json::Value, Error> {
    let mut path = format!("/_auth/intent/nonce?action={action}");
    if let Some(r) = &resource {
        if !r.is_empty() {
            path.push_str(&format!("&resource={r}"));
        }
    }
    http.get(&session, &path).await
}

// ── WebSocket PoP signing ──

#[command]
pub async fn shield_create_signed_ws_url(
    session: State<'_, SessionState>,
    path: String,
) -> Result<SignedWsUrl, Error> {
    let k_pop = session.k_pop().await.ok_or(Error::PopNotBound)?;
    let cookie = session.cookie_header().await.ok_or(Error::NoSession)?;
    let domain = session.server_domain().await.ok_or(Error::NoSession)?;
    let headers = pop::sign_request(&k_pop, "GET", &path, None);
    let params = format!(
        "session={}&t={}&n={}&s={}",
        urlencoding::encode(&cookie),
        urlencoding::encode(&headers.timestamp),
        urlencoding::encode(&headers.nonce),
        urlencoding::encode(&headers.signature),
    );
    Ok(SignedWsUrl {
        url: format!("wss://{domain}{path}?{params}"),
    })
}

// ── Raw signed fetch ──

#[command]
pub async fn shield_fetch(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, Error> {
    eprintln!("[shield] shield_fetch called method={method} path={path}");
    let m = method.to_uppercase();
    match m.as_str() {
        "GET" => http.get(&session, &path).await,
        "POST" | "PUT" | "PATCH" => {
            let b = body.unwrap_or(serde_json::json!({}));
            let body_bytes = serde_json::to_vec(&b).map_err(|e| Error::Other(e.to_string()))?;
            let guard = session.0.read().await;
            let sess = guard.as_ref().ok_or(Error::NoSession)?;
            let url = format!("https://{}{path}", sess.server_domain);
            let cookie = sess.session_cookie.clone();
            let k_pop = sess.k_pop;
            let pop_bound = sess.pop_bound;
            drop(guard);

            let mut builder = match m.as_str() {
                "PUT" => http.raw().put(&url),
                "PATCH" => http.raw().patch(&url),
                _ => http.raw().post(&url),
            };
            builder = builder
                .header("Cookie", &cookie)
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .body(body_bytes.clone());
            if pop_bound {
                let headers = crate::pop::sign_request(&k_pop, &m, &path, Some(&body_bytes));
                builder = builder
                    .header("X-PoP-Timestamp", &headers.timestamp)
                    .header("X-PoP-Nonce", &headers.nonce)
                    .header("X-PoP-Signature", &headers.signature);
                if let Some(hash) = &headers.body_hash {
                    builder = builder.header("X-PoP-BodyHash", hash.as_str());
                }
            }
            let res = builder.send().await?;
            if let Some(new_cookie) = crate::http::extract_session_cookie(&res) {
                session.update_cookie(new_cookie).await;
            }
            let status = res.status();
            if !status.is_success() {
                let body: serde_json::Value = res.json().await.unwrap_or_default();
                let err = body["error"].as_str().unwrap_or("request failed");
                return Err(Error::HttpError(err.to_string()));
            }
            res.json().await.map_err(|e| Error::HttpError(format!("JSON parse: {e}")))
        }
        "DELETE" => {
            let guard = session.0.read().await;
            let sess = guard.as_ref().ok_or(Error::NoSession)?;
            let url = format!("https://{}{path}", sess.server_domain);
            let cookie = sess.session_cookie.clone();
            let k_pop = sess.k_pop;
            let pop_bound = sess.pop_bound;
            drop(guard);

            let body_bytes = body.as_ref().map(|b| serde_json::to_vec(b).unwrap_or_default());
            let mut builder = http.raw().delete(&url)
                .header("Cookie", &cookie)
                .header("Accept", "application/json");
            if let Some(ref b) = body_bytes {
                builder = builder
                    .header("Content-Type", "application/json")
                    .body(b.clone());
            }
            if pop_bound {
                let headers = crate::pop::sign_request(&k_pop, "DELETE", &path, body_bytes.as_deref());
                builder = builder
                    .header("X-PoP-Timestamp", &headers.timestamp)
                    .header("X-PoP-Nonce", &headers.nonce)
                    .header("X-PoP-Signature", &headers.signature);
                if let Some(hash) = &headers.body_hash {
                    builder = builder.header("X-PoP-BodyHash", hash.as_str());
                }
            }
            let res = builder.send().await?;
            if let Some(new_cookie) = crate::http::extract_session_cookie(&res) {
                session.update_cookie(new_cookie).await;
            }
            let status = res.status();
            if !status.is_success() {
                let body: serde_json::Value = res.json().await.unwrap_or_default();
                let err = body["error"].as_str().unwrap_or("request failed");
                return Err(Error::HttpError(err.to_string()));
            }
            res.json().await.map_err(|e| Error::HttpError(format!("JSON parse: {e}")))
        }
        _ => Err(Error::Other(format!("unsupported method: {method}"))),
    }
}

// ── JS console log forwarder ──

#[command]
pub async fn shield_js_log(message: String) -> Result<(), Error> {
    eprintln!("[js] {message}");
    Ok(())
}
