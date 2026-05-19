use std::sync::OnceLock;

static WK_PTR: OnceLock<usize> = OnceLock::new();

pub fn set_webview_ptr(ptr: *mut std::ffi::c_void) {
    WK_PTR.set(ptr as usize).ok();
}

pub(crate) fn get_webview_ptr() -> Option<*mut std::ffi::c_void> {
    WK_PTR.get().map(|&p| p as *mut std::ffi::c_void)
}

#[cfg(target_os = "macos")]
type CookieChangeCallback = unsafe extern "C" fn(
    domain: *const std::os::raw::c_char,
    new_value: *const std::os::raw::c_char,
    ctx: *mut std::ffi::c_void,
);

#[cfg(target_os = "macos")]
extern "C" {
    fn ellul_inject_session_cookie(
        wk_webview_ptr: *mut std::ffi::c_void,
        cookie_value: *const std::os::raw::c_char,
        domain: *const std::os::raw::c_char,
    );
    fn ellul_observe_cookie_changes(
        wk_webview_ptr: *mut std::ffi::c_void,
        callback: CookieChangeCallback,
        ctx: *mut std::ffi::c_void,
    );
    fn ellul_dump_cookies(wk_webview_ptr: *mut std::ffi::c_void);
    fn ellul_disable_itp(wk_webview_ptr: *mut std::ffi::c_void);
    fn ellul_inject_pop_user_script(
        wk_webview_ptr: *mut std::ffi::c_void,
        js_source: *const std::os::raw::c_char,
    );
    fn ellul_remove_pop_user_scripts(wk_webview_ptr: *mut std::ffi::c_void);
}

#[cfg(target_os = "macos")]
static SESSION_STATE_PTR: OnceLock<usize> = OnceLock::new();

#[cfg(target_os = "macos")]
unsafe extern "C" fn on_cookie_change(
    domain: *const std::os::raw::c_char,
    new_value: *const std::os::raw::c_char,
    _ctx: *mut std::ffi::c_void,
) {
    use std::ffi::CStr;
    let domain = CStr::from_ptr(domain).to_str().unwrap_or("");
    let value = CStr::from_ptr(new_value).to_str().unwrap_or("");
    let new_cookie = format!("__Host-shield_session={value}");
    eprintln!(
        "[ellul-cookie] sync: cookie changed for {} → updating Rust session",
        domain
    );
    if let Some(&ptr) = SESSION_STATE_PTR.get() {
        let session = &*(ptr as *const crate::session::SessionState);
        let cookie = new_cookie.clone();
        tokio::task::spawn(async move {
            session.update_cookie(cookie).await;
        });
    }
}

#[cfg(target_os = "macos")]
pub fn start_cookie_observer(session: &crate::session::SessionState) {
    let ptr = match get_webview_ptr() {
        Some(p) => p,
        None => return,
    };
    SESSION_STATE_PTR
        .set(session as *const crate::session::SessionState as usize)
        .ok();
    unsafe {
        ellul_observe_cookie_changes(ptr, on_cookie_change, std::ptr::null_mut());
    }
}

pub fn disable_itp() {
    #[cfg(target_os = "macos")]
    {
        if let Some(ptr) = get_webview_ptr() {
            unsafe {
                ellul_disable_itp(ptr);
            }
        }
    }
}

pub fn inject_cookies_for_session(cookie_header: &str, server_domain: &str) {
    #[cfg(target_os = "macos")]
    {
        let ptr = match get_webview_ptr() {
            Some(p) => p,
            None => {
                eprintln!("[ellul-cookie] no webview pointer stored");
                return;
            }
        };
        let cookie_val = cookie_header
            .strip_prefix("__Host-shield_session=")
            .unwrap_or(cookie_header);
        let code_domain = code_domain_from_server(server_domain);

        eprintln!(
            "[ellul-cookie] injecting for srv={} code={}",
            server_domain, code_domain
        );

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

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (cookie_header, server_domain);
    }
}

pub fn inject_pop_to_webview(k_pop_b64: &str) {
    #[cfg(target_os = "macos")]
    {
        let ptr = match get_webview_ptr() {
            Some(p) => p,
            None => {
                eprintln!("[ellul-pop] no webview pointer stored");
                return;
            }
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

    #[cfg(not(target_os = "macos"))]
    {
        let _ = k_pop_b64;
    }
}

pub fn remove_pop_from_webview() {
    #[cfg(target_os = "macos")]
    {
        if let Some(ptr) = get_webview_ptr() {
            unsafe {
                ellul_remove_pop_user_scripts(ptr);
            }
        }
    }
}

pub fn code_domain_from_server(server_domain: &str) -> String {
    server_domain
        .replace("-srv.", "-code.")
        .replace("-dc.", "-dcode.")
}
