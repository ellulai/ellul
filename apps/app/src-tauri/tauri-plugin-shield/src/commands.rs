use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{command, State};

use crate::error::Error;
use crate::http::{extract_session_cookie, ShieldHttpClient};
use crate::operator::{self, OperatorState};
use crate::pop;
use crate::session::SessionState;

// ── Response types (mirror bridge-contracts.ts) ──

#[derive(Serialize)]
pub struct CheckSessionResponse {
    #[serde(rename = "hasSession")]
    pub has_session: bool,
}

#[derive(Serialize)]
pub struct SignedWsParams {
    #[serde(rename = "popTimestamp")]
    pub pop_timestamp: String,
    #[serde(rename = "popNonce")]
    pub pop_nonce: String,
    #[serde(rename = "popSignature")]
    pub pop_signature: String,
    #[serde(rename = "sessionToken")]
    pub session_token: String,
}

#[derive(Serialize)]
pub struct ShieldFetchResponse {
    pub status: u16,
    pub body: serde_json::Value,
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

    Ok(())
}

#[command]
pub async fn shield_clear_session(
    session: State<'_, SessionState>,
    operator: State<'_, OperatorState>,
) -> Result<(), Error> {
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
    }

    Ok(body)
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
    http.post(&session, "/_auth/preview/token", &serde_json::json!({}))
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
    http.get(&session, &format!("/_auth/gates/active?project={project}"))
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
    http.post(
        &session,
        "/_auth/gates/request",
        &serde_json::json!({
            "project": project,
            "gate": gate,
            "reason": reason.unwrap_or_default(),
        }),
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
) -> Result<serde_json::Value, Error> {
    http.get(&session, "/_auth/context-mode").await
}

#[command(rename_all = "camelCase")]
pub async fn shield_context_mode_set(
    session: State<'_, SessionState>,
    http: State<'_, ShieldHttpClient>,
    mode: String,
    operator_signature: Option<String>,
    operator_timestamp: Option<String>,
) -> Result<serde_json::Value, Error> {
    let mut body = serde_json::json!({ "mode": mode });
    if let Some(sig) = &operator_signature {
        body["operatorSignature"] = serde_json::Value::String(sig.clone());
    }
    if let Some(ts) = &operator_timestamp {
        body["operatorTimestamp"] = serde_json::Value::String(ts.clone());
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
) -> Result<SignedWsParams, Error> {
    let k_pop = session.k_pop().await.ok_or(Error::PopNotBound)?;
    let cookie = session.cookie_header().await.ok_or(Error::NoSession)?;
    let headers = pop::sign_request(&k_pop, "GET", &path, None);
    Ok(SignedWsParams {
        pop_timestamp: headers.timestamp,
        pop_nonce: headers.nonce,
        pop_signature: headers.signature,
        session_token: cookie,
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
    match method.to_uppercase().as_str() {
        "GET" => http.get(&session, &path).await,
        "POST" => {
            http.post(&session, &path, &body.unwrap_or(serde_json::json!({})))
                .await
        }
        _ => Err(Error::Other(format!("unsupported method: {method}"))),
    }
}
