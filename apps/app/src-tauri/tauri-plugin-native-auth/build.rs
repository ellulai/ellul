const COMMANDS: &[&str] = &[
    "sign_in_apple",
    "open_oauth_browser",
    "register_push",
    "haptic_feedback",
    "copy_to_clipboard",
    "share",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .build();
}
