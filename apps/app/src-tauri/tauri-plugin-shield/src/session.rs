use tokio::sync::RwLock;
use zeroize::Zeroize;

pub struct ShieldSession {
    pub server_domain: String,
    pub session_cookie: String,
    pub k_pop: [u8; 32],
    pub pop_bound: bool,
    pub created_at: u64,
    pub expires_at: u64,
    pub jwt: Option<String>,
}

impl Drop for ShieldSession {
    fn drop(&mut self) {
        self.k_pop.zeroize();
        self.session_cookie.zeroize();
        if let Some(ref mut j) = self.jwt {
            j.zeroize();
        }
    }
}

#[derive(Default)]
pub struct SessionState(pub RwLock<Option<ShieldSession>>);

impl SessionState {
    pub async fn set(&self, server_domain: String, session_cookie: String) {
        let now = now_secs();
        let mut guard = self.0.write().await;
        *guard = Some(ShieldSession {
            server_domain,
            session_cookie,
            k_pop: [0u8; 32],
            pop_bound: false,
            created_at: now,
            expires_at: now + 4 * 3600, // SESSION_TTL_MS = 4h
            jwt: None,
        });
    }

    pub async fn set_k_pop(&self, k_pop: [u8; 32]) {
        let mut guard = self.0.write().await;
        if let Some(session) = guard.as_mut() {
            session.k_pop = k_pop;
            session.pop_bound = true;
        }
    }

    pub async fn set_jwt(&self, jwt: String) {
        let mut guard = self.0.write().await;
        if let Some(session) = guard.as_mut() {
            session.jwt = Some(jwt);
        }
    }

    pub async fn jwt(&self) -> Option<String> {
        self.0.read().await.as_ref().and_then(|s| s.jwt.clone())
    }

    pub async fn update_cookie(&self, new_cookie: String) {
        let mut guard = self.0.write().await;
        if let Some(session) = guard.as_mut() {
            session.session_cookie = new_cookie;
            session.expires_at = now_secs() + 4 * 3600;
        }
    }

    pub async fn clear(&self) {
        let mut guard = self.0.write().await;
        *guard = None;
    }

    pub async fn has_session(&self) -> bool {
        let guard = self.0.read().await;
        guard.as_ref().map_or(false, |s| now_secs() < s.expires_at)
    }

    pub async fn is_expired(&self) -> bool {
        let guard = self.0.read().await;
        guard.as_ref().map_or(true, |s| now_secs() >= s.expires_at)
    }

    pub async fn server_domain(&self) -> Option<String> {
        self.0
            .read()
            .await
            .as_ref()
            .map(|s| s.server_domain.clone())
    }

    pub async fn cookie_header(&self) -> Option<String> {
        self.0
            .read()
            .await
            .as_ref()
            .map(|s| s.session_cookie.clone())
    }

    pub async fn k_pop(&self) -> Option<[u8; 32]> {
        self.0.read().await.as_ref().and_then(|s| {
            if s.pop_bound {
                Some(s.k_pop)
            } else {
                None
            }
        })
    }

    pub async fn session_info(&self) -> Option<SessionInfo> {
        self.0.read().await.as_ref().map(|s| SessionInfo {
            server_domain: s.server_domain.clone(),
            pop_bound: s.pop_bound,
            expires_at: s.expires_at,
        })
    }
}

#[derive(serde::Serialize)]
pub struct SessionInfo {
    #[serde(rename = "serverDomain")]
    pub server_domain: String,
    #[serde(rename = "popBound")]
    pub pop_bound: bool,
    #[serde(rename = "expiresAt")]
    pub expires_at: u64,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
