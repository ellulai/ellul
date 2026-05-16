use tauri::{Emitter, Listener, Manager, WindowEvent};

#[cfg(desktop)]
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

mod config;

const LOCAL_URL: &str = "https://localhost:8443";

fn is_internal_navigation(url: &url::Url) -> bool {
    if url.scheme() == "tauri" {
        return true;
    }
    let host = url.host_str().unwrap_or("");
    for suffix in config::allowed_domain_suffixes() {
        if host == *suffix || host.ends_with(&format!(".{}", suffix)) {
            return true;
        }
    }
    if (host == "localhost" || host == "127.0.0.1") && url.port() == Some(8443) {
        return true;
    }
    false
}


fn resolve_start_url(cfg: &config::AppConfig) -> tauri::WebviewUrl {
    match cfg.mode {
        config::AppMode::Cloud => {
            let dashboard = format!("{}/dashboard", config::console_url());
            tauri::WebviewUrl::External(dashboard.parse().unwrap())
        }
        _ => tauri::WebviewUrl::App("index.html".into()),
    }
}

#[tauri::command]
fn __dbg(msg: String) {
    eprintln!("[ellul-webview] {}", msg);
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    eprintln!("[ellul] open_external: {}", url);
    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_app_mode(state: tauri::State<'_, config::ConfigState>) -> config::AppConfig {
    state.get()
}

#[tauri::command]
fn set_app_mode(
    mode: config::AppMode,
    cloud_domain: Option<String>,
    state: tauri::State<'_, config::ConfigState>,
) -> Result<config::AppConfig, String> {
    state.set_mode(mode, cloud_domain)?;
    Ok(state.get())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformInfo {
    os: &'static str,
    can_run_local: bool,
    local_engine: &'static str,
}

#[tauri::command]
fn get_console_url() -> &'static str {
    config::console_url()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectPollResult {
    status: String,
    code: Option<String>,
    has_server: Option<bool>,
    server_domain: Option<String>,
}

#[tauri::command]
async fn poll_connect(connect_id: String) -> Result<ConnectPollResult, String> {
    let api_url = config::console_url().replace("console.", "api.");
    let url = format!(
        "{}/api/auth/native/connect-poll?connect_id={}",
        api_url, connect_id
    );
    eprintln!("[ellul] poll_connect: {}", url);

    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Ok(ConnectPollResult {
            status: "pending".into(),
            code: None,
            has_server: None,
            server_domain: None,
        });
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(ConnectPollResult {
        status: body["status"].as_str().unwrap_or("pending").into(),
        code: body["code"].as_str().map(String::from),
        has_server: body["hasServer"].as_bool(),
        server_domain: body["serverDomain"].as_str().map(String::from),
    })
}

#[tauri::command]
fn get_platform_info() -> PlatformInfo {
    if cfg!(target_os = "android") {
        PlatformInfo {
            os: "android",
            can_run_local: true,
            local_engine: "proot",
        }
    } else if cfg!(target_os = "ios") {
        PlatformInfo {
            os: "ios",
            can_run_local: false,
            local_engine: "none",
        }
    } else if cfg!(target_os = "macos") {
        PlatformInfo {
            os: "macos",
            can_run_local: true,
            local_engine: "lima",
        }
    } else if cfg!(target_os = "windows") {
        PlatformInfo {
            os: "windows",
            can_run_local: true,
            local_engine: "wsl2",
        }
    } else {
        PlatformInfo {
            os: "linux",
            can_run_local: true,
            local_engine: "native",
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_native_auth::init())
        .plugin(tauri_plugin_shield::init())
        .plugin(tauri_plugin_proot::init())
        .invoke_handler(tauri::generate_handler![
            __dbg,
            open_external,
            get_app_mode,
            set_app_mode,
            get_platform_info,
            get_console_url,
            poll_connect,
        ]);

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    builder
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("no app data dir");
            eprintln!("[ellul] data_dir: {:?}", data_dir);
            let cfg_state = config::ConfigState::load(data_dir);
            let cfg = cfg_state.get();
            eprintln!("[ellul] config: {:?}", cfg);

            let url = resolve_start_url(&cfg);
            eprintln!("[ellul] start_url: {:?}", url);

            app.manage(cfg_state);

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

            let win = builder.build()?;

            let win_clone = win.clone();
            eprintln!("[ellul] starting diagnostic injection thread");
            std::thread::spawn(move || {
                for delay in [3, 6, 10, 15, 20, 30] {
                    std::thread::sleep(std::time::Duration::from_secs(delay));
                    // Use window.name as persistent signal (not overwritten by React)
                    let probe = format!(r#"
                        window.name = 'PROBE|t={}|tauri=' + (typeof window.__TAURI_INTERNALS__ !== 'undefined') + '|url=' + window.location.pathname;
                    "#, delay);
                    let _ = win_clone.eval(&probe);
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    // Read window.name back via JS eval that assigns to title briefly
                    let readback = r#"document.title = window.name || 'NO_PROBE';"#;
                    let _ = win_clone.eval(readback);
                    std::thread::sleep(std::time::Duration::from_millis(100));

                    if let Ok(url) = win_clone.url() {
                        eprintln!("[ellul] url t+{}s: {}", delay, url);
                    }
                    let js = format!(r#"
                        (function() {{
                            var hasTauri = typeof window.__TAURI_INTERNALS__ !== 'undefined';
                            var dbg = hasTauri
                                ? function(msg) {{ window.__TAURI_INTERNALS__.invoke('__dbg', {{ msg: '[t+{d}s] ' + msg }}); }}
                                : function(msg) {{ console.log('[ellul-diag][t+{d}s] ' + msg); }};
                            try {{
                                dbg('url=' + window.location.href);
                                dbg('hasTauri=' + hasTauri);
                                dbg('cookies=' + document.cookie.split(';').map(function(c) {{ return c.trim().split('=')[0]; }}).filter(Boolean).join(','));
                                var bodyText = (document.body && document.body.innerText) || '';
                                dbg('body_len=' + bodyText.length);
                                dbg('body_preview=' + bodyText.substring(0, 400).replace(/\n/g, ' | '));

                                if (hasTauri) {{
                                    // Monkey-patch WebSocket once
                                    if (!window.__WS_PATCHED__) {{
                                        window.__WS_PATCHED__ = true;
                                        window.__WS_LOG__ = [];
                                        var OrigWS = window.WebSocket;
                                        window.WebSocket = function(url, protocols) {{
                                            window.__WS_LOG__.push({{ url: url, t: Date.now(), s: 'new' }});
                                            window.__TAURI_INTERNALS__.invoke('__dbg', {{ msg: 'WS_NEW: ' + url }});
                                            var ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
                                            ws.addEventListener('open', function() {{
                                                window.__TAURI_INTERNALS__.invoke('__dbg', {{ msg: 'WS_OPEN: ' + url }});
                                            }});
                                            ws.addEventListener('error', function() {{
                                                window.__TAURI_INTERNALS__.invoke('__dbg', {{ msg: 'WS_ERROR: ' + url }});
                                            }});
                                            ws.addEventListener('close', function(e) {{
                                                window.__TAURI_INTERNALS__.invoke('__dbg', {{ msg: 'WS_CLOSE: ' + url + ' code=' + e.code + ' reason=' + e.reason }});
                                            }});
                                            return ws;
                                        }};
                                        window.WebSocket.CONNECTING = OrigWS.CONNECTING;
                                        window.WebSocket.OPEN = OrigWS.OPEN;
                                        window.WebSocket.CLOSING = OrigWS.CLOSING;
                                        window.WebSocket.CLOSED = OrigWS.CLOSED;
                                    }}

                                    if (window.__WS_LOG__ && window.__WS_LOG__.length > 0) {{
                                        dbg('WS_LOG=' + JSON.stringify(window.__WS_LOG__));
                                    }}

                                    window.__TAURI_INTERNALS__.invoke('plugin:shield|shield_check_session')
                                        .then(function(r) {{ dbg('shield_check=' + JSON.stringify(r)); }})
                                        .catch(function(e) {{ dbg('shield_check_ERR=' + String(e)); }});
                                }}
                            }} catch(e) {{
                                if (hasTauri) {{
                                    window.__TAURI_INTERNALS__.invoke('__dbg', {{ msg: '[t+{d}s] ERR: ' + e.message }});
                                }}
                            }}
                        }})();
                    "#, d=delay);
                    let _ = win_clone.eval(&js);
                }
            });


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
