import { API_URL } from "./api";

const PENDING_KEY = "_pendingOAuthConnect";

export function isLocalhost(): boolean {
  return typeof window !== "undefined" && window.location.hostname === "localhost";
}

export function hasPendingConnect(): { url: string } | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_KEY);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function hasCloudSession(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/auth/get-session`, {
      credentials: "include",
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function cloudAuthThenRedirect(connectUrl: string): Promise<boolean> {
  const POLL_MS = 3_000;
  const TIMEOUT_MS = 300_000;

  const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
  if (!invoke) return false;

  const flowId = crypto.randomUUID();
  const oauthUrl = `${API_URL}/api/auth/native/start?provider=google&flow_id=${flowId}`;

  try {
    await invoke("plugin:native-auth|open_oauth_browser", { url: oauthUrl });
  } catch {
    return false;
  }

  const start = Date.now();
  let exchangeCode: string | null = null;

  while (Date.now() - start < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      const res = await fetch(`${API_URL}/api/auth/native/poll?flow_id=${flowId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === "complete" && data.code) {
          exchangeCode = data.code;
          break;
        }
      }
    } catch {}
  }

  if (!exchangeCode) return false;

  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ url: connectUrl }));

  const returnUrl = `${window.location.origin}${window.location.pathname}${window.location.search}`;
  window.location.href = `${API_URL}/api/auth/native/session/establish?code=${encodeURIComponent(exchangeCode)}&redirect=${encodeURIComponent(returnUrl)}`;
  return true;
}
