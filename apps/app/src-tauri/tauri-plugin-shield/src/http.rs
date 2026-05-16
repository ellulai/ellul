use crate::error::Error;
use crate::pop;
use crate::session::SessionState;

const SESSION_COOKIE_NAME: &str = "__Host-shield_session";

pub struct ShieldHttpClient {
    client: reqwest::Client,
}

impl ShieldHttpClient {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .use_rustls_tls()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build reqwest client");
        Self { client }
    }

    pub fn raw(&self) -> &reqwest::Client {
        &self.client
    }

    pub async fn get(
        &self,
        session: &SessionState,
        path: &str,
    ) -> Result<serde_json::Value, Error> {
        self.request(session, "GET", path, None).await
    }

    pub async fn post(
        &self,
        session: &SessionState,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, Error> {
        let body_bytes = serde_json::to_vec(body).map_err(|e| Error::Other(e.to_string()))?;
        self.request(session, "POST", path, Some(&body_bytes)).await
    }

    /// Send an unauthenticated request (no session cookie, no PoP).
    /// Used for login/register endpoints before a session exists.
    pub async fn post_unauthed(
        &self,
        base_url: &str,
        path: &str,
        body: &serde_json::Value,
    ) -> Result<reqwest::Response, Error> {
        let url = format!("{base_url}{path}");
        let res = self
            .client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json")
            .json(body)
            .send()
            .await?;
        Ok(res)
    }

    async fn request(
        &self,
        session: &SessionState,
        method: &str,
        path: &str,
        body: Option<&[u8]>,
    ) -> Result<serde_json::Value, Error> {
        let (url, cookie, k_pop, pop_bound) = {
            let guard = session.0.read().await;
            let sess = guard.as_ref().ok_or(Error::NoSession)?;
            (
                format!("https://{}{path}", sess.server_domain),
                sess.session_cookie.clone(),
                sess.k_pop,
                sess.pop_bound,
            )
        };

        let mut builder = match method {
            "GET" => self.client.get(&url),
            "POST" => self.client.post(&url),
            "PUT" => self.client.put(&url),
            "DELETE" => self.client.delete(&url),
            "PATCH" => self.client.patch(&url),
            _ => return Err(Error::Other(format!("unsupported method: {method}"))),
        };

        builder = builder
            .header("Cookie", &cookie)
            .header("Accept", "application/json");

        if pop_bound {
            let headers = pop::sign_request(&k_pop, method, path, body);
            builder = builder
                .header("X-PoP-Timestamp", &headers.timestamp)
                .header("X-PoP-Nonce", &headers.nonce)
                .header("X-PoP-Signature", &headers.signature);
            if let Some(hash) = &headers.body_hash {
                builder = builder.header("X-PoP-BodyHash", hash.as_str());
            }
        }

        if let Some(b) = body {
            builder = builder
                .header("Content-Type", "application/json")
                .body(b.to_vec());
        }

        let res = builder.send().await?;

        // Track session rotation: server may send a new session cookie on any
        // response (rotation interval is 15 min). Update our stored cookie so
        // subsequent requests use the rotated session ID.
        if let Some(new_cookie) = extract_session_cookie(&res) {
            session.update_cookie(new_cookie).await;
        }

        let status = res.status();

        if !status.is_success() {
            let body: serde_json::Value = res.json().await.unwrap_or_default();
            let err_msg = match body["error"].as_str() {
                Some(e) => e.to_string(),
                None => format!("HTTP {status}"),
            };
            return Err(Error::HttpError(err_msg));
        }

        res.json()
            .await
            .map_err(|e| Error::HttpError(format!("JSON parse: {e}")))
    }
}

impl Default for ShieldHttpClient {
    fn default() -> Self {
        Self::new()
    }
}

/// Extract `__Host-shield_session=<value>` from any Set-Cookie header in the
/// response. Returns the full `__Host-shield_session=<value>` cookie string
/// for direct use in the `Cookie:` header.
pub fn extract_session_cookie(res: &reqwest::Response) -> Option<String> {
    for value in res.headers().get_all(reqwest::header::SET_COOKIE) {
        if let Ok(s) = value.to_str() {
            if let Some(cookie_val) = parse_cookie_value(s, SESSION_COOKIE_NAME) {
                return Some(format!("{SESSION_COOKIE_NAME}={cookie_val}"));
            }
        }
    }
    None
}

fn parse_cookie_value<'a>(set_cookie: &'a str, name: &str) -> Option<&'a str> {
    let prefix = format!("{name}=");
    if !set_cookie.starts_with(&prefix) {
        return None;
    }
    let rest = &set_cookie[prefix.len()..];
    // Value ends at the first `;` (cookie attributes follow)
    let end = rest.find(';').unwrap_or(rest.len());
    Some(&rest[..end])
}
