use std::ffi::{c_char, c_void, CString};
use tokio::sync::oneshot;

type PasskeyCallback =
    extern "C" fn(*mut c_void, *const u8, usize, *const c_char);

extern "C" {
    fn ellul_passkey_authenticate(
        challenge: *const u8,
        challenge_len: usize,
        rp_id: *const c_char,
        callback: PasskeyCallback,
        context: *mut c_void,
    );

    fn ellul_passkey_register(
        challenge: *const u8,
        challenge_len: usize,
        rp_id: *const c_char,
        user_id: *const u8,
        user_id_len: usize,
        user_name: *const c_char,
        user_display_name: *const c_char,
        callback: PasskeyCallback,
        context: *mut c_void,
    );
}

extern "C" fn on_result(
    ctx: *mut c_void,
    json: *const u8,
    len: usize,
    err: *const c_char,
) {
    let tx = unsafe {
        Box::from_raw(ctx as *mut oneshot::Sender<Result<Vec<u8>, String>>)
    };
    if !err.is_null() {
        let msg = unsafe { std::ffi::CStr::from_ptr(err) }
            .to_string_lossy()
            .to_string();
        let _ = tx.send(Err(msg));
    } else if !json.is_null() && len > 0 {
        let data = unsafe { std::slice::from_raw_parts(json, len) }.to_vec();
        let _ = tx.send(Ok(data));
    } else {
        let _ = tx.send(Err("No result".into()));
    }
}

pub async fn authenticate(
    challenge: &[u8],
    rp_id: &str,
) -> Result<serde_json::Value, String> {
    let (tx, rx) = oneshot::channel::<Result<Vec<u8>, String>>();
    let rp = CString::new(rp_id).map_err(|e| e.to_string())?;
    let ctx = Box::into_raw(Box::new(tx)) as *mut c_void;
    unsafe {
        ellul_passkey_authenticate(
            challenge.as_ptr(),
            challenge.len(),
            rp.as_ptr(),
            on_result,
            ctx,
        );
    }
    let bytes = match rx.await {
        Ok(Ok(b)) => b,
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("channel closed".into()),
    };
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

#[allow(dead_code)]
pub async fn register(
    challenge: &[u8],
    rp_id: &str,
    user_id: &[u8],
    user_name: &str,
    user_display_name: &str,
) -> Result<serde_json::Value, String> {
    let (tx, rx) = oneshot::channel::<Result<Vec<u8>, String>>();
    let rp = CString::new(rp_id).map_err(|e| e.to_string())?;
    let name = CString::new(user_name).map_err(|e| e.to_string())?;
    let display = CString::new(user_display_name).map_err(|e| e.to_string())?;
    let ctx = Box::into_raw(Box::new(tx)) as *mut c_void;
    unsafe {
        ellul_passkey_register(
            challenge.as_ptr(),
            challenge.len(),
            rp.as_ptr(),
            user_id.as_ptr(),
            user_id.len(),
            name.as_ptr(),
            display.as_ptr(),
            on_result,
            ctx,
        );
    }
    let bytes = match rx.await {
        Ok(Ok(b)) => b,
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("channel closed".into()),
    };
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
