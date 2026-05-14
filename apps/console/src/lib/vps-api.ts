// SPDX-License-Identifier: MIT

// - Never assume a field exists — old VPS may not have it
// - Return normalized types so callers don't need to handle shapes

export interface SessionInfo {
  valid: boolean;
  userId: string | null;
  name: string | null;
  // Callers MUST treat null as "deny" — never fall back to a lower tier.
  tier: "standard" | "web_locked" | "private_locked" | null;
  popBound: boolean;
}

export interface TerminalToken {
  token: string;
  expiresIn: number;
  sessionId: string | null;
}

export interface AgentToken {
  token: string;
  expiresIn: number;
}

export interface CodeToken {
  token: string;
  expiresIn: number;
}

// Retry a fetch on transient errors (502, 503, 504, network failures).
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3,
  baseDelayMs = 2000
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, init);

      // Retry on transient server errors (Caddy upstream not ready)
      if (attempt < maxRetries && (res.status === 502 || res.status === 503 || res.status === 504)) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // Retry on transient auth errors (session initializing, shield restarting).
      if (attempt < maxRetries && res.status === 401) {
        try {
          const body = await res.clone().json();
          if (body?.retry) {
            const delay = baseDelayMs * Math.pow(2, attempt);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
        } catch {}
      }

      return res;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Retry on network errors (connection refused, timeout, CORS during transition)
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }

  throw lastError ?? new Error("Request failed after retries");
}

// Get session info — handles v1 and future response shapes.
export async function getSessionInfo(vpsUrl: string): Promise<SessionInfo> {
  const res = await fetch(`${vpsUrl}/_auth/bridge/session`, { credentials: "include" });
  if (!res.ok) {
    // SECURITY: Do NOT default tier to "standard" on failure — that would downgrade
    return { valid: false, userId: null, name: null, tier: null, popBound: false };
  }
  const data = await res.json();
  // Validate tier is a known value — reject unknown values as null (fail-secure)
  const rawTier = data.tier;
  const tier: "standard" | "web_locked" | "private_locked" | null =
    rawTier === "standard" || rawTier === "web_locked" || rawTier === "private_locked" ? rawTier : null;
  return {
    valid: data.valid ?? false,
    userId: data.user?.id ?? data.userId ?? null,
    name: data.user?.name ?? data.name ?? null,
    tier,
    popBound: data.popBound ?? data.pop_bound ?? false,
  };
}

// Authorize terminal access — handles current and future shapes.
export async function authorizeTerminal(
  vpsUrl: string,
  options: { sessionId?: string } = {}
): Promise<TerminalToken> {
  const res = await fetchWithRetry(`${vpsUrl}/_auth/terminal/authorize`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    throw new Error(`Terminal authorization failed: ${res.status}`);
  }
  const data = await res.json();
  return {
    token: data.token,
    expiresIn: data.expiresIn ?? data.expires_in ?? 30,
    sessionId: data.sessionId ?? data.session_id ?? null,
  };
}

// Authorize agent access — handles current and future shapes.
export async function authorizeAgent(
  vpsUrl: string,
  options: { sessionId?: string } = {}
): Promise<AgentToken> {
  const res = await fetchWithRetry(`${vpsUrl}/_auth/agent/authorize`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    throw new Error(`Agent authorization failed: ${res.status}`);
  }
  const data = await res.json();
  return {
    token: data.token,
    expiresIn: data.expiresIn ?? data.expires_in ?? 30,
  };
}

// Authorize code browser access — handles current and future shapes.
export async function authorizeCode(
  vpsUrl: string,
  options: { sessionId?: string } = {}
): Promise<CodeToken> {
  const res = await fetchWithRetry(`${vpsUrl}/_auth/code/authorize`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    throw new Error(`Code authorization failed: ${res.status}`);
  }
  const data = await res.json();
  return {
    token: data.token,
    expiresIn: data.expiresIn ?? data.expires_in ?? 30,
  };
}
