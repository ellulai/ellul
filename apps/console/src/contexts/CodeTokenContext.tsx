// SPDX-License-Identifier: MIT
"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";
import { useVpsBridge } from "@/lib/vps-bridge";
import { MOCK_MODE } from "@/lib/mock-data";
import { API_URL } from "@/lib/api";
import { fetchWithRetry } from "@/lib/vps-api";

interface CodeTokenContextValue {
  token: string | null;
  loading: boolean;
  error: string | null;
  codeSessionId: string | null;
  sessionExpiresAt: number;
  refresh: () => Promise<string | null>;
  fetchWithCodeToken: (url: string, options?: RequestInit) => Promise<Response>;
  reauthenticate: () => Promise<void>;
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

const CodeTokenContext = createContext<CodeTokenContextValue | null>(null);

interface CodeTokenProviderProps {
  children: ReactNode;
  securityTier?: "standard" | "web_locked" | "private_locked";
  codeApiUrl?: string;
  serverId?: string;
  srvUrl?: string;
}

// Top-level dispatch: each branch owns its own hook graph. No early-return
// patterns inside a single component body — Rules of Hooks holds trivially.
export function CodeTokenProvider(props: CodeTokenProviderProps) {
  return MOCK_MODE
    ? <MockCodeTokenProvider>{props.children}</MockCodeTokenProvider>
    : <RealCodeTokenProvider {...props}>{props.children}</RealCodeTokenProvider>;
}

function MockCodeTokenProvider({ children }: { children: ReactNode }) {
  const fetchWithCodeToken = useCallback(
    (url: string, options?: RequestInit) =>
      fetch(url, { ...options, credentials: "include" }),
    [],
  );

  const value: CodeTokenContextValue = {
    token: null,
    loading: false,
    error: null,
    codeSessionId: null,
    sessionExpiresAt: 0,
    refresh: async () => null,
    fetchWithCodeToken,
    reauthenticate: async () => {},
  };

  return (
    <CodeTokenContext.Provider value={value}>
      {children}
    </CodeTokenContext.Provider>
  );
}

function RealCodeTokenProvider({
  children,
  securityTier = "standard",
  codeApiUrl,
  serverId,
  srvUrl,
}: CodeTokenProviderProps) {
  const t = useTranslations("console.contexts.codeToken");
  const { ready, send, waitForReady, needsVpsAuth, reauthenticate: vpsBridgeReauth } = useVpsBridge();
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCodeSessionId, setActiveCodeSessionId] = useState<string | null>(null);
  const [activeSessionExpiresAt, setActiveSessionExpiresAt] = useState<number>(0);

  const cookieEstablishedRef = useRef(false);
  const establishingRef = useRef<Promise<void> | null>(null);
  const sessionExpiresRef = useRef<number>(0);
  const lastEstablishTimeRef = useRef<number>(0);
  const ESTABLISH_COOLDOWN_MS = 30_000;
  const jwtRef = useRef<string | null>(null);

  const establishCookie = useCallback(async (): Promise<void> => {
    if (!codeApiUrl) return;

    if (establishingRef.current) {
      await establishingRef.current;
      return;
    }

    establishingRef.current = (async () => {
      try {
        let codeSessionId: string;
        let expiresAt: number;

        if (securityTier !== "standard") {
          await waitForReady();
          const result = await send("get_code_session");
          codeSessionId = result.codeSessionId;
          expiresAt = result.expiresAt;
        } else {
          if (!serverId || !srvUrl) return;

          const tokenRes = await fetch(`${API_URL}/api/servers/${serverId}/terminal/token`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
          });
          if (!tokenRes.ok) throw new Error(t("platformTokenFailed"));
          const tokenData = await tokenRes.json() as { terminal?: { token?: string } };
          const jwt = tokenData.terminal?.token;
          if (!jwt) throw new Error(t("noPlatformJwt"));

          // Inject JWT into the bridge iframe so it can authorize
          // standard-tier requests (native apps lack cross-origin cookies).
          jwtRef.current = jwt;
          send("inject_token", { jwt }).catch(() => {});

          const sessionRes = await fetchWithRetry(`${srvUrl}/_auth/code/session`, {
            method: "POST",
            credentials: "include",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${jwt}`,
            },
          });
          if (!sessionRes.ok) throw new Error(t("createSessionFailed"));
          const sessionData = await sessionRes.json() as { codeSessionId: string; expiresAt: number };
          codeSessionId = sessionData.codeSessionId;
          expiresAt = sessionData.expiresAt;
        }

        const res = await fetch(
          `${codeApiUrl}/_auth/code/establish?_code_session=${codeSessionId}`,
          { credentials: "include" },
        );
        if (!res.ok) throw new Error(t("establishCookieFailed"));

        const data = await res.json() as { established: boolean; expiresAt: number };
        if (data.established) {
          cookieEstablishedRef.current = true;
          lastEstablishTimeRef.current = Date.now();
          sessionExpiresRef.current = data.expiresAt || expiresAt;
          setActiveCodeSessionId(codeSessionId);
          setActiveSessionExpiresAt(data.expiresAt || expiresAt);
          setToken("cookie-session");
          setError(null);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : t("establishSessionFailed");
        if (msg.includes("pop_not_bound")) {
          await new Promise(r => setTimeout(r, 1000));
          establishingRef.current = null;
          return establishCookie();
        }
        setError(msg);
        throw err;
      } finally {
        establishingRef.current = null;
      }
    })();

    await establishingRef.current;
  }, [codeApiUrl, securityTier, serverId, srvUrl, waitForReady, send, t]);

  const refresh = useCallback(async (): Promise<string | null> => {
    cookieEstablishedRef.current = false;
    lastEstablishTimeRef.current = 0;
    await establishCookie();
    return cookieEstablishedRef.current ? "cookie-session" : null;
  }, [establishCookie]);

  useEffect(() => {
    if (securityTier !== "standard" && needsVpsAuth && error) {
      setError(null);
      cookieEstablishedRef.current = false;
      lastEstablishTimeRef.current = 0;
    }
  }, [securityTier, needsVpsAuth, error]);

  useEffect(() => {
    if (cookieEstablishedRef.current || loading || error) return;
    if (securityTier !== "standard" && (!ready || needsVpsAuth)) return;
    if (securityTier === "standard" && (!serverId || !srvUrl)) return;

    setLoading(true);
    establishCookie()
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [securityTier, ready, needsVpsAuth, loading, error, serverId, srvUrl, establishCookie]);

  useEffect(() => {
    if (!cookieEstablishedRef.current || sessionExpiresRef.current === 0) return;

    const refreshAt = sessionExpiresRef.current - 5 * 60 * 1000;
    const delay = refreshAt - Date.now();
    if (delay <= 0) return;

    const timer = setTimeout(async () => {
      if (securityTier !== "standard" && ready) {
        try {
          await send("session_keepalive");
        } catch {
          // Non-fatal: bridge may not be ready
        }
      }
      cookieEstablishedRef.current = false;
      establishCookie().catch(() => {});
    }, delay);

    return () => clearTimeout(timer);
  }, [token, establishCookie, securityTier, ready, send]);

  const fetchWithCodeToken = useCallback(
    async (url: string, options?: RequestInit): Promise<Response> => {
      if (!cookieEstablishedRef.current) {
        if (securityTier !== "standard") {
          try {
            await waitForReady();
          } catch (bridgeError) {
            throw new AuthenticationError(
              bridgeError instanceof Error ? bridgeError.message : t("securityInitFailed"),
            );
          }
        }
        await establishCookie();
      }

      const response = await fetch(url, {
        ...options,
        credentials: "include",
      });

      if (response.status === 401) {
        const timeSinceEstablish = Date.now() - lastEstablishTimeRef.current;
        if (timeSinceEstablish < ESTABLISH_COOLDOWN_MS) {
          throw new AuthenticationError(t("authFailed"));
        }

        cookieEstablishedRef.current = false;
        try {
          await establishCookie();
        } catch {
          throw new AuthenticationError(t("authRequired"));
        }

        if (cookieEstablishedRef.current) {
          const retryResponse = await fetch(url, {
            ...options,
            credentials: "include",
          });
          if (retryResponse.status === 401) {
            throw new AuthenticationError(t("authFailed"));
          }
          return retryResponse;
        }
        throw new AuthenticationError(t("authRequired"));
      }

      return response;
    },
    [securityTier, waitForReady, establishCookie, t],
  );

  const reauthenticate = useCallback(async (): Promise<void> => {
    setError(null);
    setToken(null);
    setActiveCodeSessionId(null);
    setActiveSessionExpiresAt(0);
    cookieEstablishedRef.current = false;
    lastEstablishTimeRef.current = 0;
    if (securityTier !== "standard") {
      await vpsBridgeReauth();
    }
    await establishCookie();
  }, [securityTier, vpsBridgeReauth, establishCookie]);

  return (
    <CodeTokenContext.Provider
      value={{
        token,
        loading,
        error,
        codeSessionId: activeCodeSessionId,
        sessionExpiresAt: activeSessionExpiresAt,
        refresh,
        fetchWithCodeToken,
        reauthenticate,
      }}
    >
      {children}
    </CodeTokenContext.Provider>
  );
}

export function useCodeToken() {
  const context = useContext(CodeTokenContext);
  if (!context) {
    throw new Error("useCodeToken must be used within CodeTokenProvider");
  }
  return context;
}
