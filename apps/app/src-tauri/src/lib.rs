use tauri::{Emitter, Listener, Manager, WindowEvent};

#[cfg(desktop)]
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

mod config;

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
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    match cfg.mode {
        config::AppMode::Cloud => {
            let dashboard = format!("{}/dashboard?_cb={}", config::console_url(), ts);
            tauri::WebviewUrl::External(dashboard.parse().unwrap())
        }
        config::AppMode::Local if cfg!(target_os = "android") => {
            let dashboard = format!("{}/dashboard?_cb={}", config::console_url(), ts);
            tauri::WebviewUrl::External(dashboard.parse().unwrap())
        }
        _ => tauri::WebviewUrl::App("index.html".into()),
    }
}

#[tauri::command]
fn open_external(_app: tauri::AppHandle, url: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        tauri_plugin_shield::storage::android_open_url(&url).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        open::that(&url).map_err(|e| e.to_string())
    }
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
        .invoke_handler(tauri::generate_handler![
            open_external,
            get_app_mode,
            set_app_mode,
            get_platform_info,
            get_console_url,
            poll_connect,
        ]);

    let builder = builder.plugin(tauri_plugin_proot::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    builder
        .setup(|app| {
            let data_dir = app.path().app_data_dir().expect("no app data dir");
            tauri_plugin_shield::pop::init_persistence(&data_dir);
            let cfg_state = config::ConfigState::load(data_dir);

            let cfg = cfg_state.get();
            let url = resolve_start_url(&cfg);

            app.manage(cfg_state);

            let config_json = serde_json::to_string(&cfg).unwrap_or_default();
            let init_script = format!(
                r#"window.__ELLUL_APP_CONFIG__ = {cfg};
window.__IS_ELLUL_TAURI__ = true;
if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {{
  var __inv = window.__TAURI_INTERNALS__.invoke;
  __inv('get_app_mode').then(function(c) {{
    if (c) window.__ELLUL_APP_CONFIG__ = c;
  }}).catch(function() {{}});
  if (/Android/i.test(navigator.userAgent) && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {{
    (function __prootPoll(n) {{
      if (n > 60) return;
      __inv('plugin:proot|proot_health').then(function(h) {{
        var ok = h && h.length > 0 && h.every(function(s) {{ return s.healthy; }});
        if (ok) {{
          __inv('plugin:proot|proot_switch_to_local').catch(function() {{}});
        }} else {{
          setTimeout(function() {{ __prootPoll(n + 1); }}, 2000);
        }}
      }}).catch(function() {{
        setTimeout(function() {{ __prootPoll(n + 1); }}, 2000);
      }});
    }})(0);
  }}
}}
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
if (sessionStorage.getItem('ellul_needs_reconnect')) {{
  delete window.__ELLUL_APP_CONFIG__.cloudDomain;
  sessionStorage.removeItem('ellul_needs_reconnect');
}}
if (!window.PublicKeyCredential) {{
  window.PublicKeyCredential = function() {{}};
  window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = function() {{ return Promise.resolve(true); }};
  window.PublicKeyCredential.isConditionalMediationAvailable = function() {{ return Promise.resolve(false); }};
}}
(function() {{
  function b64url(buf) {{
    var b = '';
    var bytes = new Uint8Array(buf);
    for (var i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
    return btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }}
  function b64urlDecode(s) {{
    var b = s.replace(/-/g, '+').replace(/_/g, '/');
    b += '='.repeat((4 - b.length % 4) % 4);
    var raw = atob(b);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }}
  var origGet = navigator.credentials && navigator.credentials.get
    ? navigator.credentials.get.bind(navigator.credentials) : null;
  if (origGet) {{
    navigator.credentials.get = function(opts) {{
      var ti = window.__TAURI_INTERNALS__;
      var pk = opts && opts.publicKey;
      var hasPrf = pk && pk.extensions && pk.extensions.prf;
      if (!hasPrf || !ti || !ti.invoke) return origGet(opts);
      var saltBytes = pk.extensions.prf.eval && pk.extensions.prf.eval.first;
      if (!saltBytes) return origGet(opts);
      var challenge = new Uint8Array(32);
      crypto.getRandomValues(challenge);
      return ti.invoke('plugin:shield|shield_native_credential_get_prf', {{
        challengeB64: b64url(challenge),
        rpId: pk.rpId || 'ellul.ai',
        userVerification: pk.userVerification || 'required',
        prfSaltB64: b64url(saltBytes),
      }}).then(function(result) {{
        if (!result.prfFirst) throw new Error('PRF extension did not return a result. Requires macOS 15+ / iOS 18+.');
        var prfBytes = b64urlDecode(result.prfFirst);
        var credIdBytes = result.id ? b64urlDecode(result.id) : new Uint8Array(0);
        var mockResponse = Object.create(PublicKeyCredential.prototype);
        mockResponse.id = result.id || '';
        mockResponse.rawId = credIdBytes.buffer;
        mockResponse.type = 'public-key';
        mockResponse.response = {{ attestationObject: new ArrayBuffer(0), clientDataJSON: new ArrayBuffer(0) }};
        mockResponse.getClientExtensionResults = function() {{
          return {{ prf: {{ results: {{ first: prfBytes.buffer }} }} }};
        }};
        mockResponse.authenticatorAttachment = 'platform';
        return mockResponse;
      }});
    }};
  }}
}})();
(function() {{
  var _fetch = window.fetch;
  window.fetch = function(url, opts) {{
    var urlStr = (typeof url === 'string') ? url : (url && url.url ? url.url : String(url));
    if (urlStr.indexOf('/_auth/bridge/upgrade-to-web-locked') !== -1) {{
      urlStr = urlStr.replace('/_auth/bridge/upgrade-to-web-locked', '/_auth/upgrade-to-web-locked');
      url = urlStr;
    }}
    if ((window.__TAURI_INTERNALS__ || window.__IS_ELLUL_TAURI__) && urlStr.indexOf('/encryption/authenticate/options') !== -1) {{
      var ch = new Uint8Array(32); crypto.getRandomValues(ch);
      var b = ''; for (var j = 0; j < ch.length; j++) b += String.fromCharCode(ch[j]);
      var chB64 = btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      var body = JSON.stringify({{
        challenge: chB64,
        rpId: 'ellul.ai',
        allowCredentials: [],
        userVerification: 'required',
        timeout: 60000,
      }});
      return Promise.resolve(new Response(body, {{ status: 200, headers: {{ 'Content-Type': 'application/json' }} }}));
    }}
    return _fetch.call(this, url, opts);
  }};
}})();
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
    return u.toString();
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
                    if url.path() == "/sign-in" && url.host_str().map_or(false, |h| h.contains("console.")) {
                        return false;
                    }
                    if is_marketing_site(url) {
                        if let Some(win) = nav_handle.get_webview_window("main") {
                            let _ = win.eval(
                                "sessionStorage.setItem('ellul_needs_reconnect','1'); window.location.reload();"
                            );
                        }
                        return false;
                    }
                    if !is_internal_navigation(url) {
                        let _ = open::that(url.as_str());
                        return false;
                    }
                    true
                });
            }

            let win = builder.build()?;

            #[cfg(any(target_os = "macos", target_os = "ios"))]
            {
                use tauri::Manager;
                let session_state = app.state::<tauri_plugin_shield::session::SessionState>();
                let session_ref: &tauri_plugin_shield::session::SessionState = &session_state;
                let _ = win.with_webview(|wv| {
                    let ptr = wv.inner() as *mut std::ffi::c_void;
                    tauri_plugin_shield::webview_cookie::set_webview_ptr(ptr);
                    tauri_plugin_shield::webview_cookie::disable_itp();
                    tauri_plugin_shield::webview_cookie::inject_console_bridge();
                    tauri_plugin_shield::pop::restore_pop_seed_if_available();
                    tauri_plugin_shield::webview_cookie::clear_http_cache_and_reload();
                });
                tauri_plugin_shield::webview_cookie::start_cookie_observer(session_ref);
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
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
        let _ = e;
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
        let _ = e;
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
