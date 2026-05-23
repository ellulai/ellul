// SPDX-License-Identifier: MIT
"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/types";
import { MOCK_MODE, mockVpsBridgeResponses } from "@/lib/mock-data";
import { onSessionStatus } from "@/lib/session-events";
import { isTauriApp } from "@/lib/utils";
import { isLocalDomain } from "@/lib/domains";
import type { LocalFetchResult } from "@/lib/local-fetch";
import { API_URL } from "@/lib/api";

function isAndroidTauriApp(): boolean {
  return isTauriApp() && /Android/i.test(navigator.userAgent);
}
import type {
  BridgeMessageType,
  BridgeResponse,
} from "@ellul.ai/vps/auth/bridge-contracts";

interface BridgeHandle {
  contentWindow: Window;
  hostname: string;
  generation: number;
}

interface VpsBridgeState {
  ready: boolean;
  error: string | null;
  needsVpsAuth: boolean;
  sessionExpired: boolean;
  send: <T = unknown>(type: string, data?: Record<string, unknown>) => Promise<T>;
  waitForReady: () => Promise<BridgeHandle>;
  reauthenticate: () => Promise<void>;
  signalAuthNeeded: () => void;
  reload: () => void;
  authenticateNative: () => Promise<void>;
  registerNative: (name: string) => Promise<unknown>;
}

const VpsBridgeContext = createContext<VpsBridgeState | null>(null);

interface VpsBridgeProviderProps {
  hostname: string;
  children: ReactNode;
  securityTier?: "standard" | "web_locked" | "private_locked";
  isLocal?: boolean;
}

export function VpsBridgeProvider(props: VpsBridgeProviderProps) {
  if (MOCK_MODE) return <MockVpsBridgeProvider>{props.children}</MockVpsBridgeProvider>;
  if (props.isLocal) return <LocalBridgeProvider>{props.children}</LocalBridgeProvider>;
  return <BridgeProvider hostname={props.hostname}>{props.children}</BridgeProvider>;
}

// ── Tauri IPC helper ──

async function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (window as any).__TAURI_INTERNALS__.invoke(`plugin:shield|${cmd}`, args) as Promise<T>;
}

function isByosLocalhost(hostname: string): boolean {
  return isTauriApp() && isLocalDomain(hostname);
}

// ── Tier-aware native auth (shared by all Tauri platforms) ──

async function performTauriAuth(hostname: string): Promise<void> {
  const tierBody = await tauriInvoke<{ tier?: string }>("shield_get_tier", { serverDomain: hostname });
  const tier = tierBody.tier;

  if (tier !== "standard") {
    await tauriInvoke("shield_passkey_login", { serverDomain: hostname });
    return;
  }

  // Try API-issued JWT (cloud or managed BYOS)
  const serverId = localStorage.getItem("ellul-active-server");
  if (serverId) {
    try {
      const tokenRes = await fetch(`${API_URL}/api/servers/${serverId}/terminal/token`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (tokenRes.ok) {
        const tokenData = await tokenRes.json() as { terminal?: { token?: string } };
        const jwt = tokenData.terminal?.token;
        if (jwt) {
          await tauriInvoke("shield_token_login", { serverDomain: hostname, jwt });
          return;
        }
      }
    } catch { /* fall through to BYOS bootstrap */ }
  }

  // BYOS localhost: bootstrap JWT from local engine
  const bootstrap = await tauriInvoke<{ jwt: string }>("shield_byos_token", { serverDomain: hostname });
  await tauriInvoke("shield_token_login", { serverDomain: hostname, jwt: bootstrap.jwt });
}

// ── Mock bridge ──

function MockVpsBridgeProvider({ children }: { children: ReactNode }) {
  const send = useCallback(async <T = unknown,>(type: string, data: Record<string, unknown> = {}): Promise<T> => {
    const handler = mockVpsBridgeResponses[type as BridgeMessageType];
    if (!handler) throw new Error(`Unknown bridge message type: ${type}`);
    return (handler as (data: Record<string, unknown>) => unknown)(data) as T;
  }, []);

  const handle: BridgeHandle = {
    contentWindow: typeof window !== "undefined" ? window : ({} as Window),
    hostname: "mock",
    generation: 0,
  };

  const value: VpsBridgeState = {
    ready: true, error: null, needsVpsAuth: false, sessionExpired: false,
    send,
    waitForReady: async () => handle,
    reauthenticate: async () => {},
    signalAuthNeeded: () => {},
    reload: () => {},
    authenticateNative: async () => {},
    registerNative: async () => ({}),
  };

  return <VpsBridgeContext.Provider value={value}>{children}</VpsBridgeContext.Provider>;
}

// ── Local bridge provider ──
// BYOS / local mode: VPS requests go through Tauri IPC or direct HTTP to localhost.

function LocalBridgeProvider({ children }: { children: ReactNode }) {
  const hasTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__?.invoke;
  const [ready, setReady] = useState(hasTauri);
  const [error, setError] = useState<string | null>(null);
  const jwtRef = useRef<string | null>(null);

  useEffect(() => {
    if (hasTauri) return;
    (async () => {
      try {
        const r = await fetch("http://localhost/_auth/byos/token", { method: "POST" });
        if (!r.ok) throw new Error(`BYOS token: ${r.status}`);
        const { token } = await r.json() as { token: string };
        jwtRef.current = token;
        setReady(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to get BYOS token");
      }
    })();
  }, [hasTauri]);

  const authHeaders = useCallback((extra?: HeadersInit): Record<string, string> => {
    const h: Record<string, string> = {};
    if (extra) {
      if (extra instanceof Headers) extra.forEach((v, k) => { h[k] = v; });
      else if (Array.isArray(extra)) extra.forEach(([k, v]) => { h[k] = v; });
      else Object.assign(h, extra);
    }
    if (jwtRef.current) h["Authorization"] = `Bearer ${jwtRef.current}`;
    return h;
  }, []);

  const send = useCallback(async <T = unknown,>(type: string, data: Record<string, unknown> = {}): Promise<T> => {
    if (hasTauri) {
      const invoke = (window as any).__TAURI_INTERNALS__.invoke;
      if (type === "code_api_proxy") {
        const { method = "GET", path, body } = data as { method?: string; path?: string; body?: unknown };
        const result = await invoke("plugin:proot|proot_fetch", {
          method: String(method).toUpperCase(),
          path: path || "/",
          body: body ? JSON.stringify(body) : null,
          port: 3002,
        }) as LocalFetchResult;
        if (result.status >= 400) throw new Error(result.body || `HTTP ${result.status}`);
        try { return JSON.parse(result.body) as T; } catch { return result.body as unknown as T; }
      }
      const result = await invoke("plugin:proot|proot_fetch", {
        method: "POST",
        path: "/_auth/bridge/dispatch",
        body: JSON.stringify({ type, ...data }),
        port: 3005,
      }) as LocalFetchResult;
      let parsed: any;
      try { parsed = JSON.parse(result.body); } catch { parsed = { error: result.body }; }
      if (result.status >= 400) throw new Error(parsed.error || `Dispatch failed: HTTP ${result.status}`);
      return parsed as T;
    }

    if (type === "get_exchange_code") {
      const r = await fetch("http://localhost/_auth/bridge/exchange-code", {
        method: "POST",
        headers: authHeaders(),
        credentials: "include",
      });
      const text = await r.text();
      if (r.status >= 400) throw new Error(text || `HTTP ${r.status}`);
      try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
    }

    if (type === "code_api_proxy") {
      const { method = "GET", path, body } = data as { method?: string; path?: string; body?: unknown };
      const r = await fetch(`http://localhost/api${path || "/"}`, {
        method: String(method).toUpperCase(),
        headers: authHeaders(body ? { "Content-Type": "application/json" } : undefined),
        body: body ? JSON.stringify(body) : undefined,
        credentials: "include",
      });
      const text = await r.text();
      if (r.status >= 400) throw new Error(text || `HTTP ${r.status}`);
      try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
    }

    const r = await fetch("http://localhost/_auth/bridge/dispatch", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ type, ...data }),
      credentials: "include",
    });
    const text = await r.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
    if (r.status >= 400) throw new Error(parsed.error || `Dispatch failed: HTTP ${r.status}`);
    return parsed as T;
  }, [hasTauri, authHeaders]);

  const dummyHandle: BridgeHandle = {
    contentWindow: typeof window !== "undefined" ? window : ({} as Window),
    hostname: "localhost",
    generation: 0,
  };

  const value: VpsBridgeState = {
    ready,
    error,
    needsVpsAuth: false,
    sessionExpired: false,
    send,
    waitForReady: async () => dummyHandle,
    reauthenticate: async () => {},
    signalAuthNeeded: () => {},
    reload: () => {},
    authenticateNative: async () => {},
    registerNative: async () => ({}),
  };

  return <VpsBridgeContext.Provider value={value}>{children}</VpsBridgeContext.Provider>;
}

// ── Unified bridge provider ──
// IPC (Android / BYOS localhost): shield_fetch dispatch. Web: iframe postMessage.

function BridgeProvider({ hostname, children }: { hostname: string; children: ReactNode }) {
  const useIPC = isAndroidTauriApp() || isByosLocalhost(hostname);
  const queryClient = useQueryClient();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsVpsAuth, setNeedsVpsAuth] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [bridgeKey, setBridgeKey] = useState(0);

  const generationRef = useRef(0);
  const handleRef = useRef<BridgeHandle | null>(null);
  const errorRef = useRef<string | null>(null);

  type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void; generation: number };
  const pendingRequests = useRef(new Map<string, Pending>());
  const requestId = useRef(0);

  type ReadyWaiter = { resolve: (h: BridgeHandle) => void; reject: (err: Error) => void };
  const readyCallbacks = useRef<ReadyWaiter[]>([]);

  const needsAuthRef = useRef(false);
  useEffect(() => { needsAuthRef.current = needsVpsAuth || sessionExpired; }, [needsVpsAuth, sessionExpired]);
  useEffect(() => { errorRef.current = error; }, [error]);

  // ── IPC: dummy handle (no iframe) ──

  const dummyHandle = useRef<BridgeHandle>({
    contentWindow: typeof window !== "undefined" ? window : ({} as Window),
    hostname,
    generation: 0,
  });

  // ── Iframe lifecycle (web + macOS only) ──

  const setIframeNode = useCallback((node: HTMLIFrameElement | null) => {
    if (useIPC) return;
    if (node === iframeRef.current) return;
    if (!node) {
      const stale = generationRef.current;
      handleRef.current = null;
      iframeRef.current = null;
      const err = new Error("Bridge unmounted");
      for (const [id, req] of pendingRequests.current) {
        if (req.generation === stale) {
          pendingRequests.current.delete(id);
          req.reject(err);
        }
      }
      setReady(false);
      return;
    }
    generationRef.current += 1;
    iframeRef.current = node;
  }, [useIPC]);

  // Publish handle once iframe signals ready (web/macOS)
  useEffect(() => {
    if (useIPC) return;
    if (!ready) return;
    const win = iframeRef.current?.contentWindow ?? null;
    if (!win) return;
    const handle: BridgeHandle = { contentWindow: win, hostname, generation: generationRef.current };
    handleRef.current = handle;
    const waiters = readyCallbacks.current;
    readyCallbacks.current = [];
    for (const w of waiters) w.resolve(handle);
  }, [useIPC, ready, hostname]);

  // Drain ready waiters on IPC path (no iframe)
  useEffect(() => {
    if (!useIPC) return;
    if (!ready || error) return;
    const waiters = readyCallbacks.current;
    readyCallbacks.current = [];
    for (const w of waiters) w.resolve(dummyHandle.current);
  }, [useIPC, ready, error]);

  useEffect(() => {
    if (!error) return;
    const waiters = readyCallbacks.current;
    readyCallbacks.current = [];
    const err = new Error(error);
    for (const w of waiters) w.reject(err);
  }, [error]);

  const waitForReady = useCallback((): Promise<BridgeHandle> => {
    if (useIPC) {
      if (ready && !errorRef.current) return Promise.resolve(dummyHandle.current);
    } else {
      if (handleRef.current) return Promise.resolve(handleRef.current);
    }
    if (errorRef.current) return Promise.reject(new Error(errorRef.current));
    return new Promise<BridgeHandle>((resolve, reject) => {
      readyCallbacks.current.push({ resolve, reject });
    });
  }, [useIPC, ready]);

  // ── send: single dispatch, transport varies ──

  const send = useCallback(<T = unknown,>(type: string, data: Record<string, unknown> = {}): Promise<T> => {
    return (async () => {
      if (useIPC) {
        await waitForReady();
        try {
          // Bypass dispatch for get_exchange_code: dispatchInternal on the
          // VPS doesn't forward Authorization to inner routes, so standard-
          // tier dispatch fails for endpoints that need JWT. Calling the
          // endpoint directly lets shield_fetch's JWT reach the tier-gate.
          if (type === "get_exchange_code") {
            return await tauriInvoke<T>("shield_fetch", {
              method: "POST",
              path: "/_auth/bridge/exchange-code",
            });
          }
          return await tauriInvoke<T>("shield_fetch", {
            method: "POST",
            path: "/_auth/bridge/dispatch",
            body: { type, ...data },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "Authentication required" || msg.includes("No session") || msg.includes("Invalid session")) {
            setNeedsVpsAuth(true);
          }
          throw err;
        }
      }

      const handle = await waitForReady();
      return new Promise<T>((resolve, reject) => {
        const id = String(++requestId.current);
        pendingRequests.current.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          generation: handle.generation,
        });
        try {
          handle.contentWindow.postMessage({ type, requestId: id, ...data }, `https://${handle.hostname}`);
        } catch (e) {
          pendingRequests.current.delete(id);
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        setTimeout(() => {
          if (pendingRequests.current.has(id)) {
            pendingRequests.current.delete(id);
            reject(new Error("Request timeout"));
          }
        }, 60_000);
      });
    })();
  }, [useIPC, waitForReady]);

  // ── Session bootstrap ──

  const checkSession = useCallback(async () => {
    if (useIPC) {
      try {
        const result = await tauriInvoke<{ valid?: boolean }>("shield_fetch", {
          method: "GET",
          path: "/_auth/bridge/session",
        });
        if (result.valid) {
          setNeedsVpsAuth(false);
          setSessionExpired(false);
          setReady(true);
        } else {
          setNeedsVpsAuth(true);
          setReady(true);
        }
      } catch {
        setNeedsVpsAuth(true);
        setReady(true);
      }
    }
    // Web/macOS: session checked by iframe bridge_ready message
  }, [useIPC]);

  useEffect(() => {
    if (!useIPC) return;
    (async () => {
      try {
        await performTauriAuth(hostname);
        setNeedsVpsAuth(false);
        setSessionExpired(false);
        setReady(true);
      } catch {
        checkSession();
      }
    })();
  }, [useIPC, hostname, checkSession]);

  const signalAuthNeeded = useCallback(() => { setNeedsVpsAuth(true); }, []);

  const reload = useCallback(() => {
    setReady(false);
    setError(null);
    setNeedsVpsAuth(false);
    setSessionExpired(false);
    if (useIPC) {
      const waiters = readyCallbacks.current;
      readyCallbacks.current = [];
      const err = new Error("Bridge reloading");
      for (const w of waiters) w.reject(err);
      checkSession();
    } else {
      handleRef.current = null;
      const err = new Error("Bridge reloading");
      for (const [id, req] of pendingRequests.current) {
        pendingRequests.current.delete(id);
        req.reject(err);
      }
      const waiters = readyCallbacks.current;
      readyCallbacks.current = [];
      for (const w of waiters) w.reject(err);
      setBridgeKey((k) => k + 1);
    }
  }, [useIPC, checkSession]);

  // ── Auth ceremonies (shared) ──

  const authenticateNative = useCallback(async (): Promise<void> => {
    if (isTauriApp()) {
      await performTauriAuth(hostname);

      if (!useIPC) {
        setNeedsVpsAuth(false);
        setSessionExpired(false);
        setReady(false);
        handleRef.current = null;
        setBridgeKey((k) => k + 1);
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Auth timeout")), 30_000);
          const check = setInterval(() => {
            if (handleRef.current) {
              clearInterval(check);
              clearTimeout(timeout);
              resolve();
            }
          }, 100);
        });
      }

      setNeedsVpsAuth(false);
      setSessionExpired(false);
      setReady(true);
      return;
    }

    // Web passkey flow
    const options = await send<PublicKeyCredentialRequestOptionsJSON>("get_auth_options");
    const assertion = await startAuthentication({ optionsJSON: options });
    await send("verify_auth", { assertion });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Auth timeout")), 30_000);
      const check = setInterval(() => {
        if (handleRef.current) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 100);
    });
  }, [useIPC, send, hostname]);

  const registerNative = useCallback(async (name: string): Promise<unknown> => {
    if (isTauriApp()) {
      return tauriInvoke("shield_passkey_register", { serverDomain: hostname, name });
    }
    const { options } = await send<{ options: PublicKeyCredentialCreationOptionsJSON }>("get_registration_options", { name });
    const attestation = await startRegistration({ optionsJSON: options });
    const extResults = attestation.clientExtensionResults as Record<string, unknown> | undefined;
    const prfEnabled = (extResults?.prf as { enabled?: boolean } | undefined)?.enabled === true;
    return await send("verify_registration", { attestation, name, prfEnabled });
  }, [send, hostname]);

  const reauthenticate = useCallback(async (): Promise<void> => {
    await authenticateNative();
  }, [authenticateNative]);

  // ── Auto-auth + visibility + session status (shared) ──

  const triggerReauth = useCallback(() => {
    if (document.visibilityState === "visible") {
      setSessionExpired(false);
      (async () => {
        try {
          await authenticateNative();
          if (!useIPC) {
            try {
              iframeRef.current?.contentWindow?.postMessage(
                { type: "auth_completed", success: true },
                `https://${hostname}`,
              );
            } catch {}
          }
        } catch {
          setSessionExpired(true);
          setNeedsVpsAuth(true);
        }
      })();
    } else {
      setSessionExpired(true);
      setNeedsVpsAuth(true);
    }
  }, [useIPC, authenticateNative, hostname]);

  const triggerReauthRef = useRef(triggerReauth);
  useEffect(() => { triggerReauthRef.current = triggerReauth; }, [triggerReauth]);

  useEffect(() => {
    let lastAlive: boolean | null = null;
    return onSessionStatus((signal) => {
      if (signal.alive) { lastAlive = true; return; }
      if (lastAlive !== true) return;
      lastAlive = false;
      triggerReauthRef.current();
    });
  }, []);

  const autoAuthAttempted = useRef(false);
  useEffect(() => {
    if (ready && needsVpsAuth && !autoAuthAttempted.current) {
      autoAuthAttempted.current = true;
      authenticateNative().catch(() => { setNeedsVpsAuth(true); });
    }
    if (!needsVpsAuth) autoAuthAttempted.current = false;
  }, [ready, needsVpsAuth, authenticateNative]);

  // ── Iframe message handler (web + macOS only) ──

  useEffect(() => {
    if (useIPC) {
      // IPC: visibility reauth only
      const onVisible = () => {
        if (document.visibilityState !== "visible" || !needsAuthRef.current) return;
        setNeedsVpsAuth(false);
        setSessionExpired(false);
        authenticateNative().catch(() => { setNeedsVpsAuth(true); });
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => document.removeEventListener("visibilitychange", onVisible);
    }

    const handler = (event: MessageEvent) => {
      if (event.origin !== `https://${hostname}`) return;
      const { type, requestId: reqId, ...data } = event.data;

      if (type === "bridge_ready") {
        if (data.pop === false) {
          if (data.error === "No session" || data.error === "Invalid session" || data.error === "Authentication required") {
            const sovereignCode = sessionStorage.getItem("sovereign-exchange-code");
            const win = iframeRef.current?.contentWindow;
            if (sovereignCode && win) {
              sessionStorage.removeItem("sovereign-exchange-code");
              try {
                win.postMessage({ type: "exchange_session", exchangeCode: sovereignCode }, `https://${hostname}`);
              } catch {}
              return;
            }
            setNeedsVpsAuth(true);
            setReady(true);
            return;
          }
          if (data.error?.includes('Device key missing') || data.error?.includes('re-authentication required')) {
            setNeedsVpsAuth(true);
            setReady(true);
            return;
          }
          if (isTauriApp()) {
            setNeedsVpsAuth(false);
            setSessionExpired(false);
            setReady(true);
            return;
          }
          setError('Security initialization failed. Please refresh the page.');
          return;
        }
        setNeedsVpsAuth(false);
        setSessionExpired(false);
        setReady(true);
        try {
          iframeRef.current?.contentWindow?.postMessage(
            { type: "auth_completed", success: true },
            `https://${hostname}`,
          );
        } catch {}
        return;
      }

      if (type === "passkey_required") return;

      if (type === "session_expired" || type === "session_revoked" || type === "auth_required") {
        triggerReauthRef.current();
        return;
      }

      if (reqId && pendingRequests.current.has(reqId)) {
        const { resolve, reject } = pendingRequests.current.get(reqId)!;
        pendingRequests.current.delete(reqId);
        if (data.success === false) {
          const errMsg = typeof data.error === 'string' ? data.error
            : data.error ? JSON.stringify(data.error) : "Request failed";
          if (errMsg === "Authentication required") setNeedsVpsAuth(true);
          reject(new Error(errMsg));
        } else {
          resolve(data);
        }
      }
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible" || !needsAuthRef.current) return;
      setNeedsVpsAuth(false);
      setSessionExpired(false);
      (async () => {
        try {
          await authenticateNative();
          try {
            iframeRef.current?.contentWindow?.postMessage(
              { type: "auth_completed", success: true },
              `https://${hostname}`,
            );
          } catch {}
        } catch {
          setNeedsVpsAuth(true);
        }
      })();
    };

    window.addEventListener("message", handler);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("message", handler);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [useIPC, hostname, queryClient, authenticateNative]);

  return (
    <VpsBridgeContext.Provider value={{ ready, error, needsVpsAuth, sessionExpired, send, waitForReady, reauthenticate, signalAuthNeeded, reload, authenticateNative, registerNative }}>
      {!useIPC && (
        <iframe
          key={bridgeKey}
          ref={setIframeNode}
          src={`https://${hostname}/_auth/bridge`}
          style={{ display: "none" }}
          title="VPS Auth Bridge"
          allow="publickey-credentials-create *; publickey-credentials-get *"
        />
      )}
      {children}
    </VpsBridgeContext.Provider>
  );
}

export function useVpsBridge() {
  const context = useContext(VpsBridgeContext);
  if (!context) {
    throw new Error("useVpsBridge must be used within VpsBridgeProvider");
  }
  return context;
}
