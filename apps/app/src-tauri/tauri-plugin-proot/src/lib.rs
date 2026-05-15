use std::path::PathBuf;

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
pub mod error;
pub mod health;

pub use error::Error;

#[cfg(target_os = "android")]
pub(crate) mod bridge {
    use std::sync::OnceLock;

    use crate::error::Error;

    trait MobileBridge: Send + Sync {
        fn call(&self, method: &str, args: serde_json::Value) -> Result<serde_json::Value, Error>;
    }

    struct PluginBridge<R: tauri::Runtime> {
        handle: tauri::plugin::PluginHandle<R>,
    }

    impl<R: tauri::Runtime> MobileBridge for PluginBridge<R> {
        fn call(&self, method: &str, args: serde_json::Value) -> Result<serde_json::Value, Error> {
            self.handle
                .run_mobile_plugin(method, args)
                .map_err(|e| Error::ProotFailed(e.to_string()))
        }
    }

    static BRIDGE: OnceLock<Box<dyn MobileBridge>> = OnceLock::new();

    pub fn init<R: tauri::Runtime + 'static>(handle: tauri::plugin::PluginHandle<R>) {
        let _ = BRIDGE.set(Box::new(PluginBridge { handle }));
    }

    pub fn call(method: &str, args: serde_json::Value) -> Result<serde_json::Value, Error> {
        BRIDGE
            .get()
            .ok_or(Error::NotAvailable)?
            .call(method, args)
    }
}

pub struct ProotState {
    rootfs_path: Option<PathBuf>,
}

impl ProotState {
    pub fn is_byos_ready(&self) -> bool {
        self.rootfs_path
            .as_ref()
            .map(|p| p.exists())
            .unwrap_or(false)
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("proot")
        .invoke_handler(tauri::generate_handler![
            commands::proot_start,
            commands::proot_stop,
            commands::proot_status,
            commands::proot_health,
            commands::proot_setup_status,
            commands::proot_setup_start,
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("ai.ellul.plugins.proot", "ProotPlugin")?;
                bridge::init(handle);

                let rootfs_path = app
                    .path()
                    .app_data_dir()
                    .map(|d| d.join("rootfs"))
                    .ok();

                app.manage(ProotState { rootfs_path });
            }

            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(ProotState {
                    rootfs_path: None,
                });
            }

            Ok(())
        })
        .build()
}
