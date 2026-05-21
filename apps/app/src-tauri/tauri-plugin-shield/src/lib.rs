use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod error;
mod http;
mod operator;
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "windows"))]
mod passkey;
pub mod pop;
pub mod session;
pub mod storage;
pub mod webview_cookie;

pub use error::Error;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("shield")
        .invoke_handler(tauri::generate_handler![
            commands::shield_check_session,
            commands::shield_set_session,
            commands::shield_clear_session,
            commands::shield_login_options,
            commands::shield_login_verify,
            commands::shield_native_credential_create,
            commands::shield_native_credential_get,
            commands::shield_native_credential_get_prf,
            commands::shield_open_auth_sheet,
            commands::shield_passkey_login,
            commands::shield_passkey_register,
            commands::shield_web_auth_login,
            commands::shield_web_auth_register,
            commands::shield_register_options,
            commands::shield_register_verify,
            commands::shield_get_tier,
            commands::shield_token_login,
            commands::shield_session_info,
            commands::shield_logout,
            commands::shield_session_keepalive,
            commands::shield_get_code_session,
            commands::shield_get_code_token,
            commands::shield_get_agent_token,
            commands::shield_get_terminal_token,
            commands::shield_get_preview_token,
            commands::shield_get_exchange_code,
            commands::shield_permission_list_pending,
            commands::shield_permission_get,
            commands::shield_permission_history,
            commands::shield_permission_mark_seen,
            commands::shield_gate_list_active,
            commands::shield_gate_request,
            commands::shield_gate_respond,
            commands::shield_gate_revoke,
            commands::shield_gate_set_permission,
            commands::shield_context_mode_get,
            commands::shield_context_mode_set,
            commands::shield_tool_permission_set,
            commands::shield_tool_permission_reset,
            commands::shield_operator_status,
            commands::shield_operator_bind,
            commands::shield_operator_sign,
            commands::shield_operator_sign_intent,
            commands::shield_operator_clear,
            commands::shield_intent_nonce,
            commands::shield_create_signed_ws_url,
            commands::shield_fetch,
            commands::shield_byos_token,
            commands::shield_js_log,
            commands::shield_open_url,
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api
                    .register_android_plugin("ai.ellul.plugins.shield", "ShieldPlugin")?;
                storage::init_android(handle);

                let app_handle = app.clone();
                webview_cookie::set_android_eval(Box::new(move |js: &str| {
                    if let Some(win) = app_handle.get_webview_window("main") {
                        let _ = win.eval(js);
                    }
                }));
            }

            #[cfg(not(target_os = "android"))]
            let _ = api;

            app.manage(session::SessionState::default());
            app.manage(operator::OperatorState::default());
            app.manage(http::ShieldHttpClient::new());
            Ok(())
        })
        .build()
}
