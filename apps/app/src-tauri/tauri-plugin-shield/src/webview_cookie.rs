use std::sync::OnceLock;

static WK_PTR: OnceLock<usize> = OnceLock::new();

pub fn set_webview_ptr(ptr: *mut std::ffi::c_void) {
    WK_PTR.set(ptr as usize).ok();
}

pub(crate) fn get_webview_ptr() -> Option<*mut std::ffi::c_void> {
    WK_PTR.get().map(|&p| p as *mut std::ffi::c_void)
}

#[cfg(target_os = "android")]
static ANDROID_EVAL: OnceLock<Box<dyn Fn(&str) + Send + Sync>> = OnceLock::new();

#[cfg(target_os = "android")]
pub fn set_android_eval(f: Box<dyn Fn(&str) + Send + Sync>) {
    ANDROID_EVAL.set(f).ok();
}

#[cfg(target_os = "android")]
fn eval_in_webview(js: &str) {
    if let Some(f) = ANDROID_EVAL.get() {
        f(js);
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
type CookieChangeCallback = unsafe extern "C" fn(
    domain: *const std::os::raw::c_char,
    new_value: *const std::os::raw::c_char,
    ctx: *mut std::ffi::c_void,
);

#[cfg(any(target_os = "macos", target_os = "ios"))]
extern "C" {
    fn ellul_inject_session_cookie(
        wk_webview_ptr: *mut std::ffi::c_void,
        cookie_value: *const std::os::raw::c_char,
        domain: *const std::os::raw::c_char,
    );
    fn ellul_inject_console_bridge(wk_webview_ptr: *mut std::ffi::c_void);
    fn ellul_observe_cookie_changes(
        wk_webview_ptr: *mut std::ffi::c_void,
        callback: CookieChangeCallback,
        ctx: *mut std::ffi::c_void,
    );
    fn ellul_scan_existing_session(
        wk_webview_ptr: *mut std::ffi::c_void,
        callback: CookieChangeCallback,
        ctx: *mut std::ffi::c_void,
    );
    fn ellul_dump_cookies(wk_webview_ptr: *mut std::ffi::c_void);
    fn ellul_clear_http_cache_and_reload(wk_webview_ptr: *mut std::ffi::c_void);
    fn ellul_disable_itp(wk_webview_ptr: *mut std::ffi::c_void);
    fn ellul_inject_pop_user_script(
        wk_webview_ptr: *mut std::ffi::c_void,
        js_source: *const std::os::raw::c_char,
    );
    fn ellul_remove_pop_user_scripts(wk_webview_ptr: *mut std::ffi::c_void);
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
static SESSION_STATE_PTR: OnceLock<usize> = OnceLock::new();
#[cfg(any(target_os = "macos", target_os = "ios"))]
static TOKIO_HANDLE: std::sync::Mutex<Option<tokio::runtime::Handle>> = std::sync::Mutex::new(None);

#[cfg(any(target_os = "macos", target_os = "ios"))]
unsafe extern "C" fn on_cookie_change(
    domain: *const std::os::raw::c_char,
    new_value: *const std::os::raw::c_char,
    _ctx: *mut std::ffi::c_void,
) {
    use std::ffi::CStr;
    let domain_str = CStr::from_ptr(domain).to_str().unwrap_or("").to_string();
    let value = CStr::from_ptr(new_value).to_str().unwrap_or("");
    let new_cookie = format!("__Host-shield_session={value}");
    if let Some(&ptr) = SESSION_STATE_PTR.get() {
        let session = &*(ptr as *const crate::session::SessionState);
        let cookie = new_cookie.clone();
        let domain_owned = domain_str.clone();

        let run_hydration = move |session: &crate::session::SessionState, cookie: String, domain: String| {
            let handle = TOKIO_HANDLE.lock().ok().and_then(|g| g.clone());
            if let Some(h) = handle {
                let session_ptr = session as *const crate::session::SessionState as usize;
                h.spawn(async move {
                    let session = &*(session_ptr as *const crate::session::SessionState);
                    hydrate_session(session, cookie, domain).await;
                });
            } else {
                let session_ptr = session as *const crate::session::SessionState as usize;
                std::thread::spawn(move || {
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .expect("mini-runtime");
                    rt.block_on(async {
                        let session = &*(session_ptr as *const crate::session::SessionState);
                        hydrate_session(session, cookie, domain).await;
                    });
                });
            }
        };

        run_hydration(session, cookie, domain_owned);
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn start_cookie_observer(session: &crate::session::SessionState) {
    let ptr = match get_webview_ptr() {
        Some(p) => p,
        None => return,
    };
    SESSION_STATE_PTR
        .set(session as *const crate::session::SessionState as usize)
        .ok();
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        if let Ok(mut guard) = TOKIO_HANDLE.lock() {
            *guard = Some(handle);
        }
    }
    unsafe {
        ellul_observe_cookie_changes(ptr, on_cookie_change, std::ptr::null_mut());
        ellul_scan_existing_session(ptr, on_cookie_change, std::ptr::null_mut());
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
async fn hydrate_session(session: &crate::session::SessionState, cookie: String, domain: String) {
    if session.has_session().await {
        session.update_cookie(cookie).await;
    } else {
        session.set(domain.clone(), cookie).await;
        if let Some(k_pop) = crate::pop::load_persisted_k_pop() {
            session.set_k_pop(k_pop).await;
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn ensure_tokio_handle() {
    if let Ok(guard) = TOKIO_HANDLE.lock() {
        if guard.is_some() { return; }
    }
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        if let Ok(mut guard) = TOKIO_HANDLE.lock() {
            *guard = Some(handle);
        }
    }
}

pub fn inject_console_bridge() {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        if let Some(ptr) = get_webview_ptr() {
            unsafe {
                ellul_inject_console_bridge(ptr);
            }
        }
    }
}

pub fn clear_http_cache_and_reload() {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        if let Some(ptr) = get_webview_ptr() {
            unsafe {
                ellul_clear_http_cache_and_reload(ptr);
            }
        }
    }
}

pub fn disable_itp() {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        if let Some(ptr) = get_webview_ptr() {
            unsafe {
                ellul_disable_itp(ptr);
            }
        }
    }
}

pub fn inject_cookies_for_session(cookie_header: &str, server_domain: &str) {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let ptr = match get_webview_ptr() {
            Some(p) => p,
            None => return,
        };
        let cookie_val = cookie_header
            .strip_prefix("__Host-shield_session=")
            .unwrap_or(cookie_header);
        let code_domain = code_domain_from_server(server_domain);

        if let Ok(c_val) = std::ffi::CString::new(cookie_val) {
            if let Ok(c_srv) = std::ffi::CString::new(server_domain) {
                unsafe {
                    ellul_inject_session_cookie(ptr, c_val.as_ptr(), c_srv.as_ptr());
                }
            }
            if let Ok(c_code) = std::ffi::CString::new(code_domain.as_str()) {
                unsafe {
                    ellul_inject_session_cookie(ptr, c_val.as_ptr(), c_code.as_ptr());
                }
            }
        }

        unsafe {
            ellul_dump_cookies(ptr);
        }
    }

    #[cfg(target_os = "android")]
    {
        let cookie_val = cookie_header
            .strip_prefix("__Host-shield_session=")
            .unwrap_or(cookie_header);
        let code_domain = code_domain_from_server(server_domain);
        let srv_url = format!("https://{server_domain}");
        let code_url = format!("https://{code_domain}");
        let cookie_str = format!("__Host-shield_session={cookie_val}; Path=/; Secure; HttpOnly; SameSite=None");

        let _ = crate::storage::android_cookie_set(&srv_url, &cookie_str);
        let _ = crate::storage::android_cookie_set(&code_url, &cookie_str);
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    {
        let _ = (cookie_header, server_domain);
    }
}

pub fn inject_pop_to_webview(k_pop_b64: &str) {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let ptr = match get_webview_ptr() {
            Some(p) => p,
            None => return,
        };
        let js = include_str!("pop_seed.js")
            .replace("__K_POP__", k_pop_b64)
            .replace("__DEVICE_ID__", crate::pop::TAURI_DEVICE_ID);
        if let Ok(c_js) = std::ffi::CString::new(js) {
            unsafe {
                ellul_inject_pop_user_script(ptr, c_js.as_ptr());
            }
        }
    }

    #[cfg(target_os = "android")]
    {
        let js = include_str!("pop_seed.js")
            .replace("__K_POP__", k_pop_b64)
            .replace("__DEVICE_ID__", crate::pop::TAURI_DEVICE_ID);
        eval_in_webview(&js);
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
    {
        let _ = k_pop_b64;
    }
}

pub fn remove_pop_from_webview() {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        if let Some(ptr) = get_webview_ptr() {
            unsafe {
                ellul_remove_pop_user_scripts(ptr);
            }
        }
    }

    #[cfg(target_os = "android")]
    {
        eval_in_webview(
            "try{var r=indexedDB.open('sovereign-shield',2);r.onsuccess=function(){var db=r.result;try{var tx=db.transaction('session-keys','readwrite');tx.objectStore('session-keys').clear();}catch(e){};};}catch(e){}"
        );
    }
}

#[cfg(target_os = "android")]
pub async fn android_scan_and_hydrate(session: &crate::session::SessionState, server_domain: &str) {
    let url = format!("https://{server_domain}");
    match crate::storage::android_cookie_scan(&url, "__Host-shield_session") {
        Ok(Some(value)) => {
            let cookie = format!("__Host-shield_session={value}");
            if session.has_session().await {
                session.update_cookie(cookie).await;
            } else {
                session.set(server_domain.to_string(), cookie).await;
                if let Some(k_pop) = crate::pop::load_persisted_k_pop() {
                    session.set_k_pop(k_pop).await;
                }
            }
        }
        Ok(None) => {}
        Err(_) => {}
    }
}

pub fn code_domain_from_server(server_domain: &str) -> String {
    server_domain
        .replace("-srv.", "-code.")
        .replace("-dc.", "-dcode.")
}
