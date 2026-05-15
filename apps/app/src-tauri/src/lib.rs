use tauri::{Emitter, Listener, Manager, WindowEvent};

#[cfg(desktop)]
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

const CONSOLE_URL: &str = "https://console.ellul.ai/sign-up";
#[cfg(target_os = "android")]
const LOCAL_URL: &str = "https://localhost:8443";

fn is_internal_navigation(url: &url::Url) -> bool {
    let host = url.host_str().unwrap_or("");
    host.ends_with(".ellul.ai")
        || host == "ellul.ai"
        || host.ends_with(".ellul.app")
        || host == "ellul.app"
        || (cfg!(target_os = "android") && (host == "localhost" || host == "127.0.0.1"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_native_auth::init())
        .plugin(tauri_plugin_shield::init())
        .plugin(tauri_plugin_proot::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    builder
        .setup(|app| {
            #[cfg(target_os = "android")]
            let url = {
                let byos = app
                    .state::<tauri_plugin_proot::ProotState>()
                    .is_byos_ready();
                if byos {
                    tauri::WebviewUrl::External(LOCAL_URL.parse().unwrap())
                } else {
                    tauri::WebviewUrl::External(CONSOLE_URL.parse().unwrap())
                }
            };
            #[cfg(not(target_os = "android"))]
            let url = tauri::WebviewUrl::External(CONSOLE_URL.parse().unwrap());
            let mut builder =
                tauri::WebviewWindowBuilder::new(app, "main", url)
                    .title("ellul")
                    .inner_size(1280.0, 860.0)
                    .min_inner_size(375.0, 600.0);

            #[cfg(desktop)]
            {
                builder = builder.on_navigation(|url| {
                    if !is_internal_navigation(url) {
                        let _ = open::that(url.as_str());
                        return false;
                    }
                    true
                });
            }

            builder.build()?;

            #[cfg(desktop)]
            setup_desktop(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            #[cfg(not(desktop))]
            {
                let _ = (window, event);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building ellul.ai")
        .run(|app_handle, event| {
            #[cfg(desktop)]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
                if !has_visible_windows {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
            }
        });
}

#[cfg(desktop)]
fn setup_desktop(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let tray_icon_bytes = include_bytes!("../icons/32x32.png");
    let icon = Image::from_bytes(tray_icon_bytes).expect("failed to load tray icon");

    let status_item = MenuItemBuilder::with_id("status", "Server: Unknown")
        .enabled(false)
        .build(app)?;

    let show_item = MenuItemBuilder::with_id("show_dashboard", "Show Dashboard").build(app)?;

    let gates_item = MenuItemBuilder::with_id("pending_gates", "Pending Gates: 0")
        .enabled(false)
        .build(app)?;

    let quit_item = MenuItemBuilder::with_id("quit", "Quit ellul.ai").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&status_item)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&show_item)
        .item(&gates_item)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&quit_item)
        .build()?;

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("ellul.ai")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show_dashboard" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "pending_gates" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                let _ = app.emit("global-shortcut", "open_gates");
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { .. } = event {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    use tauri_plugin_global_shortcut::GlobalShortcutExt;

    if let Err(e) = app.global_shortcut().on_shortcut("CmdOrCtrl+Shift+Alt+G", {
        let app_handle = app.handle().clone();
        move |_app, _shortcut, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                let _ = app_handle.emit("global-shortcut", "open_gates");
            }
        }
    }) {
        eprintln!("[ellul.ai] Failed to register shortcut: {}", e);
    }

    if let Err(e) = app.global_shortcut().on_shortcut("CmdOrCtrl+Shift+Alt+D", {
        let app_handle = app.handle().clone();
        move |_app, _shortcut, event| {
            if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
                let _ = app_handle.emit("global-shortcut", "show_dashboard");
            }
        }
    }) {
        eprintln!("[ellul.ai] Failed to register shortcut: {}", e);
    }

    let status_item_clone = status_item.clone();
    let gates_item_clone = gates_item.clone();
    app.listen("tray-update-status", move |event| {
        let payload = event.payload();
        if let Ok(status) = serde_json::from_str::<String>(payload) {
            let label = format!("Server: {}", status);
            let _ = status_item_clone.set_text(&label);
        }
    });

    app.listen("tray-update-gates", move |event| {
        let payload = event.payload();
        if let Ok(count) = serde_json::from_str::<u32>(payload) {
            let label = format!("Pending Gates: {}", count);
            let _ = gates_item_clone.set_text(&label);
            let _ = gates_item_clone.set_enabled(count > 0);
        }
    });

    Ok(())
}
