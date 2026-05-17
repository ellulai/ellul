use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use tokio::sync::oneshot;

type PasskeyCallback =
    unsafe extern "C" fn(json: *const c_char, error: *const c_char, cancelled: c_int, ctx: *mut c_void);

type WebAuthCallback =
    unsafe extern "C" fn(callback_url: *const c_char, error: *const c_char, cancelled: c_int, ctx: *mut c_void);

extern "C" {
    fn ellul_passkey_available() -> c_int;

    fn ellul_passkey_authenticate(
        challenge: *const u8,
        challenge_len: usize,
        rp_id: *const c_char,
        allow_creds_json: *const c_char,
        user_verification: *const c_char,
        callback: PasskeyCallback,
        ctx: *mut c_void,
    );

    fn ellul_passkey_register(
        challenge: *const u8,
        challenge_len: usize,
        rp_id: *const c_char,
        rp_name: *const c_char,
        user_id: *const u8,
        user_id_len: usize,
        user_name: *const c_char,
        user_display_name: *const c_char,
        attestation: *const c_char,
        user_verification: *const c_char,
        callback: PasskeyCallback,
        ctx: *mut c_void,
    );

    fn ellul_web_auth_session(
        url_str: *const c_char,
        callback_scheme: *const c_char,
        callback: WebAuthCallback,
        ctx: *mut c_void,
    );
}

struct CallbackResult {
    json: Option<String>,
    error: Option<String>,
    cancelled: bool,
}

struct SendPtr(*mut c_void);
unsafe impl Send for SendPtr {}

unsafe extern "C" fn on_complete(
    json: *const c_char,
    error: *const c_char,
    cancelled: c_int,
    ctx: *mut c_void,
) {
    let tx = Box::from_raw(ctx as *mut oneshot::Sender<CallbackResult>);
    let result = CallbackResult {
        json: if json.is_null() {
            None
        } else {
            Some(CStr::from_ptr(json).to_string_lossy().into_owned())
        },
        error: if error.is_null() {
            None
        } else {
            Some(CStr::from_ptr(error).to_string_lossy().into_owned())
        },
        cancelled: cancelled != 0,
    };
    let _ = tx.send(result);
}

fn parse_result(result: CallbackResult) -> Result<serde_json::Value, String> {
    if result.cancelled {
        return Err("User cancelled".into());
    }
    if let Some(err) = result.error {
        return Err(err);
    }
    let json_str = result.json.ok_or("No response from passkey ceremony")?;
    serde_json::from_str(&json_str).map_err(|e| format!("parse passkey response: {e}"))
}

fn to_cstring(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|e| format!("invalid string for FFI: {e}"))
}

pub fn is_available() -> bool {
    unsafe { ellul_passkey_available() != 0 }
}

fn not_available_msg() -> String {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    return "Native passkey not available (requires macOS 13+ / iOS 16+)".into();
    #[cfg(target_os = "windows")]
    return "Native passkey not available (requires Windows 10 1903+)".into();
}

pub async fn authenticate(challenge: &[u8], rp_id: &str) -> Result<serde_json::Value, String> {
    authenticate_with_options(challenge, rp_id, None, None).await
}

pub async fn authenticate_with_options(
    challenge: &[u8],
    rp_id: &str,
    allow_credentials: Option<&str>,
    user_verification: Option<&str>,
) -> Result<serde_json::Value, String> {
    if !is_available() {
        return Err(not_available_msg());
    }

    let (tx, rx) = oneshot::channel::<CallbackResult>();
    let ctx = SendPtr(Box::into_raw(Box::new(tx)) as *mut c_void);

    let challenge = challenge.to_vec();
    let rp_id_c = to_cstring(rp_id)?;
    let allow_c = allow_credentials.map(to_cstring).transpose()?;
    let uv_c = user_verification.map(to_cstring).transpose()?;

    // Windows WebAuthN API blocks until user completes/cancels.
    // macOS/iOS dispatches to the main queue and returns immediately.
    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(move || {
            unsafe {
                ellul_passkey_authenticate(
                    challenge.as_ptr(),
                    challenge.len(),
                    rp_id_c.as_ptr(),
                    allow_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                    uv_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                    on_complete,
                    ctx.0,
                );
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    #[cfg(not(target_os = "windows"))]
    unsafe {
        ellul_passkey_authenticate(
            challenge.as_ptr(),
            challenge.len(),
            rp_id_c.as_ptr(),
            allow_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
            uv_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
            on_complete,
            ctx.0,
        );
    }

    let result = rx.await.map_err(|_| "Passkey callback channel dropped".to_string())?;
    parse_result(result)
}

pub async fn register(
    challenge: &[u8],
    rp_id: &str,
    rp_name: &str,
    user_id: &[u8],
    user_name: &str,
    user_display_name: &str,
    attestation: Option<&str>,
    user_verification: Option<&str>,
) -> Result<serde_json::Value, String> {
    if !is_available() {
        return Err(not_available_msg());
    }

    let (tx, rx) = oneshot::channel::<CallbackResult>();
    let ctx = SendPtr(Box::into_raw(Box::new(tx)) as *mut c_void);

    let challenge = challenge.to_vec();
    let rp_id_c = to_cstring(rp_id)?;
    let rp_name_c = to_cstring(rp_name)?;
    let user_id = user_id.to_vec();
    let user_name_c = to_cstring(user_name)?;
    let display_c = to_cstring(user_display_name)?;
    let att_c = attestation.map(to_cstring).transpose()?;
    let uv_c = user_verification.map(to_cstring).transpose()?;

    #[cfg(target_os = "windows")]
    {
        tokio::task::spawn_blocking(move || {
            unsafe {
                ellul_passkey_register(
                    challenge.as_ptr(),
                    challenge.len(),
                    rp_id_c.as_ptr(),
                    rp_name_c.as_ptr(),
                    user_id.as_ptr(),
                    user_id.len(),
                    user_name_c.as_ptr(),
                    display_c.as_ptr(),
                    att_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                    uv_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
                    on_complete,
                    ctx.0,
                );
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    #[cfg(not(target_os = "windows"))]
    unsafe {
        ellul_passkey_register(
            challenge.as_ptr(),
            challenge.len(),
            rp_id_c.as_ptr(),
            rp_name_c.as_ptr(),
            user_id.as_ptr(),
            user_id.len(),
            user_name_c.as_ptr(),
            display_c.as_ptr(),
            att_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
            uv_c.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
            on_complete,
            ctx.0,
        );
    }

    let result = rx.await.map_err(|_| "Passkey callback channel dropped".to_string())?;
    parse_result(result)
}

unsafe extern "C" fn on_web_auth_complete(
    callback_url: *const c_char,
    error: *const c_char,
    cancelled: c_int,
    ctx: *mut c_void,
) {
    let tx = Box::from_raw(ctx as *mut oneshot::Sender<CallbackResult>);
    let result = CallbackResult {
        json: if callback_url.is_null() {
            None
        } else {
            Some(CStr::from_ptr(callback_url).to_string_lossy().into_owned())
        },
        error: if error.is_null() {
            None
        } else {
            Some(CStr::from_ptr(error).to_string_lossy().into_owned())
        },
        cancelled: cancelled != 0,
    };
    let _ = tx.send(result);
}

pub async fn web_auth_session(url: &str, callback_scheme: &str) -> Result<String, String> {
    let (tx, rx) = oneshot::channel::<CallbackResult>();
    let ctx = SendPtr(Box::into_raw(Box::new(tx)) as *mut c_void);

    let url_c = to_cstring(url)?;
    let scheme_c = to_cstring(callback_scheme)?;

    unsafe {
        ellul_web_auth_session(url_c.as_ptr(), scheme_c.as_ptr(), on_web_auth_complete, ctx.0);
    }

    let result = rx.await.map_err(|_| "Web auth session channel dropped".to_string())?;
    if result.cancelled {
        return Err("User cancelled".into());
    }
    if let Some(err) = result.error {
        return Err(err);
    }
    result.json.ok_or_else(|| "No callback URL from web auth session".into())
}
