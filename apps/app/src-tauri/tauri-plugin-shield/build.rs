const COMMANDS: &[&str] = &[
    "shield_check_session",
    "shield_set_session",
    "shield_clear_session",
    "shield_login_options",
    "shield_login_verify",
    "shield_passkey_login",
    "shield_register_options",
    "shield_register_verify",
    "shield_session_info",
    "shield_logout",
    "shield_session_keepalive",
    "shield_get_code_session",
    "shield_get_code_token",
    "shield_get_agent_token",
    "shield_get_terminal_token",
    "shield_get_preview_token",
    "shield_get_exchange_code",
    "shield_permission_list_pending",
    "shield_permission_get",
    "shield_permission_history",
    "shield_permission_mark_seen",
    "shield_gate_list_active",
    "shield_gate_request",
    "shield_gate_respond",
    "shield_gate_revoke",
    "shield_gate_set_permission",
    "shield_context_mode_get",
    "shield_context_mode_set",
    "shield_tool_permission_set",
    "shield_tool_permission_reset",
    "shield_operator_status",
    "shield_operator_bind",
    "shield_operator_sign",
    "shield_operator_sign_intent",
    "shield_operator_clear",
    "shield_intent_nonce",
    "shield_create_signed_ws_url",
    "shield_fetch",
];

fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    match target_os.as_str() {
        "macos" | "ios" => {
            cc::Build::new()
                .file("objc/passkey.m")
                .include("objc")
                .flag("-fobjc-arc")
                .flag("-fmodules")
                .compile("ellul_passkey");

            println!("cargo:rustc-link-lib=framework=AuthenticationServices");
            if target_os == "macos" {
                println!("cargo:rustc-link-lib=framework=AppKit");
            } else {
                println!("cargo:rustc-link-lib=framework=UIKit");
            }
        }
        "windows" => {
            cc::Build::new()
                .file("win/passkey.c")
                .include("win")
                .compile("ellul_passkey");
        }
        _ => {}
    }

    tauri_plugin::Builder::new(COMMANDS).build();
}
