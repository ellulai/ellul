use tauri::{Emitter, Listener, Manager, WindowEvent};

#[cfg(desktop)]
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

mod config;

const LOCAL_URL: &str = "https://localhost:8443";

fn is_marketing_site(url: &url::Url) -> bool {
    let host = url.host_str().unwrap_or("");
    (host == "ellul.ai" || host == "www.ellul.ai") && !host.contains("console.")
}

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
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let dashboard = format!("{}/dashboard?_cb={}", config::console_url(), ts);
            tauri::WebviewUrl::External(dashboard.parse().unwrap())
        }
        _ => tauri::WebviewUrl::App("index.html".into()),
    }
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

            let config_json = serde_json::to_string(&cfg).unwrap_or_default();
            let init_script = format!(
                r#"window.__ELLUL_APP_CONFIG__ = {cfg};
// Nuke service workers + force one reload to bypass cached JS
(function() {{
  if (!navigator.serviceWorker) return;
  navigator.serviceWorker.getRegistrations().then(function(regs) {{
    if (regs.length === 0) return;
    for (var i = 0; i < regs.length; i++) regs[i].unregister();
    if ('caches' in window) caches.keys().then(function(ks) {{ for (var i=0;i<ks.length;i++) caches.delete(ks[i]); }});
    if (!sessionStorage.getItem('_sw_cleared')) {{
      sessionStorage.setItem('_sw_cleared', '1');
      location.reload();
    }}
  }});
}})();
// If session-expired flag is set, hide cloudDomain so dashboard shows connect screen
if (sessionStorage.getItem('ellul_needs_reconnect')) {{
  delete window.__ELLUL_APP_CONFIG__.cloudDomain;
  sessionStorage.removeItem('ellul_needs_reconnect');
}}
// Forward JS console to Rust stderr via Tauri IPC
(function() {{
  var _log = console.log, _err = console.error, _warn = console.warn;
  function fwd(level, args) {{
    try {{
      var msg = '[' + level + '] ' + Array.prototype.slice.call(args).map(function(a) {{
        return typeof a === 'object' ? JSON.stringify(a) : String(a);
      }}).join(' ');
      if (window.__TAURI_INTERNALS__) {{
        window.__TAURI_INTERNALS__.invoke('plugin:shield|shield_js_log', {{ message: msg }});
      }}
    }} catch(e) {{}}
  }}
  console.log = function() {{ fwd('log', arguments); _log.apply(console, arguments); }};
  console.error = function() {{ fwd('err', arguments); _err.apply(console, arguments); }};
  console.warn = function() {{ fwd('warn', arguments); _warn.apply(console, arguments); }};
}})();
// Trace passkey_login invocations to find re-auth triggers
(function() {{
  var ti = window.__TAURI_INTERNALS__;
  if (!ti || !ti.invoke) return;
  var _inv = ti.invoke.bind(ti);
  ti.invoke = function(cmd, args) {{
    if (cmd && cmd.indexOf('passkey_login') !== -1) {{
      console.warn('[ellul-diag] passkey_login invoked — stack:', new Error().stack);
    }}
    return _inv(cmd, args);
  }};
}})();
// Polyfill PublicKeyCredential so browserSupportsWebAuthn() passes in WKWebView
if (!window.PublicKeyCredential) {{
  window.PublicKeyCredential = function() {{}};
  window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = function() {{ return Promise.resolve(true); }};
  window.PublicKeyCredential.isConditionalMediationAvailable = function() {{ return Promise.resolve(false); }};
}}
(function() {{
  var _fetch = window.fetch;
  window.fetch = function(url, opts) {{
    var urlStr = (typeof url === 'string') ? url : (url && url.url ? url.url : String(url));
    if (urlStr.indexOf('/_auth/bridge/upgrade-to-web-locked') !== -1) {{
      urlStr = urlStr.replace('/_auth/bridge/upgrade-to-web-locked', '/_auth/upgrade-to-web-locked');
      url = urlStr;
    }}
    var creds = (opts && opts.credentials) || 'same-origin';
    var isAuth = urlStr.indexOf('/_auth/') !== -1 || urlStr.indexOf('.ellul.ai') !== -1;
    if (isAuth) {{
      console.log('[ellul-fetch] → ' + urlStr.substring(0, 160) + ' creds=' + creds);
    }}
    return _fetch.call(this, url, opts).then(function(resp) {{
      if (isAuth) {{
        var tag = resp.ok ? 'OK' : 'FAIL';
        console.log('[ellul-fetch] ← ' + resp.status + ' ' + tag + ' ' + urlStr.substring(0, 120));
        if (!resp.ok) {{
          resp.clone().text().then(function(body) {{
            console.error('[ellul-fetch] body=' + body.substring(0, 300));
          }});
        }}
      }}
      return resp;
    }}, function(err) {{
      if (isAuth) {{
        console.error('[ellul-fetch] NETWORK/CORS err=' + String(err) + ' url=' + urlStr.substring(0, 120));
      }}
      throw err;
    }});
  }};
  setTimeout(function() {{
    console.log('[ellul-cookie-js] document.cookie=' + document.cookie.substring(0, 200));
    console.log('[ellul-cookie-js] location=' + window.location.href);
  }}, 2000);
}})();
// Strip _shield_code from iframe src — Tauri injects session cookie directly,
// so the exchange code creates a duplicate session that evicts the reqwest one.
(function() {{
  var desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
  if (!desc || !desc.set) return;
  var origSet = desc.set;
  var origGet = desc.get;
  function stripCode(v) {{
    if (typeof v !== 'string' || v.indexOf('_shield_code=') === -1) return v;
    var u;
    try {{ u = new URL(v); }} catch(e) {{ return v; }}
    u.searchParams.delete('_shield_code');
    var clean = u.toString();
    console.log('[ellul-iframe] stripped _shield_code → ' + clean.substring(0, 120));
    return clean;
  }}
  Object.defineProperty(HTMLIFrameElement.prototype, 'src', {{
    set: function(v) {{ return origSet.call(this, stripCode(v)); }},
    get: function() {{ return origGet.call(this); }},
    enumerable: desc.enumerable,
    configurable: true
  }});
  var origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, val) {{
    if (this instanceof HTMLIFrameElement && name === 'src') {{
      val = stripCode(val);
    }}
    return origSetAttr.call(this, name, val);
  }};
}})();
"#,
                cfg = config_json,
            );

            let mut builder =
                tauri::WebviewWindowBuilder::new(app, "main", url)
                    .title("ellul")
                    .inner_size(1280.0, 860.0)
                    .min_inner_size(375.0, 600.0)
                    .initialization_script(&init_script);

            #[cfg(desktop)]
            {
                let nav_handle = app.handle().clone();
                builder = builder.on_navigation(move |url| {
                    eprintln!("[ellul-nav] {}", url.as_str());
                    if url.path() == "/sign-in" && url.host_str().map_or(false, |h| h.contains("console.")) {
                        eprintln!("[ellul-nav] BLOCKED /sign-in redirect — VPS session needs passkey re-auth, not platform sign-in");
                        return false;
                    }
                    if is_marketing_site(url) {
                        eprintln!("[ellul-nav] BLOCKED marketing site — triggering reconnect");
                        if let Some(win) = nav_handle.get_webview_window("main") {
                            let _ = win.eval(
                                "sessionStorage.setItem('ellul_needs_reconnect','1'); window.location.reload();"
                            );
                        }
                        return false;
                    }
                    if !is_internal_navigation(url) {
                        eprintln!("[ellul-nav] BLOCKED external — opening in browser");
                        let _ = open::that(url.as_str());
                        return false;
                    }
                    true
                });
            }

            let win = builder.build()?;

            #[cfg(target_os = "macos")]
            {
                let _ = win.with_webview(|wv| {
                    let ptr = wv.inner() as *mut std::ffi::c_void;
                    tauri_plugin_shield::webview_cookie::set_webview_ptr(ptr);
                    tauri_plugin_shield::webview_cookie::disable_itp();
                    tauri_plugin_shield::webview_cookie::clear_http_cache_and_reload();
                    eprintln!("[ellul] WKWebView pointer stored, ITP disabled, cache clear+reload queued");
                });
            }
            #[cfg(not(target_os = "macos"))]
            let _ = &win;

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
