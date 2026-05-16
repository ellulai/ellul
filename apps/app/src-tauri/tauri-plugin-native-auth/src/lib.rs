use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

mod commands;
mod error;

pub use error::Error;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("native-auth")
        .invoke_handler(tauri::generate_handler![
            commands::sign_in_apple,
            commands::open_oauth_browser,
            commands::register_push,
            commands::haptic_feedback,
            commands::copy_to_clipboard,
            commands::share,
        ])
        .build()
}
