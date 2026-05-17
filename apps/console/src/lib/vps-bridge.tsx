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
import type {
  BridgeMessageType,
  BridgeResponse,
} from "@ellul.ai/vps/auth/bridge-contracts";

const SHARED_RP_ID = process.env.NEXT_PUBLIC_WEBAUTHN_RP_ID!;

// A handle to a specific iframe instance. `generation` increments on each
// iframe mount; pending requests bound to a stale generation are rejected on
// detach instead of racing a fresh bridge or hanging forever.
export interface BridgeHandle {
  readonly contentWindow: Window;
  readonly hostname: string;
  readonly generation: number;
}

interface VpsBridgeState {
  ready: boolean;
  error: string | null;
  needsVpsAuth: boolean;
  sessionExpired: boolean;
  send: {
    <K extends BridgeMessageType>(type: K, data?: Record<string, unknown>): Promise<BridgeResponse<K>>;
    <T = unknown>(type: string, data?: Record<string, unknown>): Promise<T>;
  };
  // Resolves only when the bridge is fully usable (ready + iframe attached).
  // The returned handle pins the contentWindow at the time of acquisition so
  // callers don't have to re-check refs before sending.
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
}

// Top-level dispatch: each branch is a sibling component with its own hook
// graph. Rules of Hooks holds because no hook is called conditionally inside
// a single component body.
export function VpsBridgeProvider(props: VpsBridgeProviderProps) {
  if (MOCK_MODE) return <MockVpsBridgeProvider>{props.children}</MockVpsBridgeProvider>;
  // Tauri always uses native bridge — WebView WebAuthn (navigator.credentials.get)
  // fails in WKWebView without code-signed Associated Domains. The Rust plugin
  // uses ASAuthorizationController directly for passkey ceremonies.
  if (isTauriApp()) return <TauriVpsBridgeProvider hostname={props.hostname}>{props.children}</TauriVpsBridgeProvider>;
  return <RealVpsBridgeProvider hostname={props.hostname}>{props.children}</RealVpsBridgeProvider>;
}

function MockVpsBridgeProvider({ children }: { children: ReactNode }) {
  const send = useCallback(async <T = unknown,>(type: string): Promise<T> => {
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
    const response = mockVpsBridgeResponses[type];
    if (response !== undefined) return response as T;
    console.warn(`[mock-mode] Unmatched bridge call: ${type}`);
    return {} as T;
  }, []);

  const handle: BridgeHandle = {
    contentWindow: typeof window !== "undefined" ? window : ({} as Window),
    hostname: "mock",
    generation: 0,
  };

  const value: VpsBridgeState = {
    ready: true,
    error: null,
    needsVpsAuth: false,
    sessionExpired: false,
    send,
    waitForReady: async () => handle,
    reauthenticate: async () => {},
    signalAuthNeeded: () => {},
    reload: () => {},
    authenticateNative: async () => {},
    registerNative: async () => ({}),
  };

  return (
    <VpsBridgeContext.Provider value={value}>
      {children}
    </VpsBridgeContext.Provider>
  );
}

// ── Tauri native bridge: replaces iframe + SW with Rust plugin ──

const TAURI_COMMAND_MAP: Record<string, string> = {
  check_session: "shield_check_session",
  session_keepalive: "shield_session_keepalive",
  get_code_session: "shield_get_code_session",
  get_code_token: "shield_get_code_token",
  get_agent_token: "shield_get_agent_token",
  get_terminal_token: "shield_get_terminal_token",
  get_preview_token: "shield_get_preview_token",
  get_exchange_code: "shield_get_exchange_code",
  permission_list_pending: "shield_permission_list_pending",
  permission_get: "shield_permission_get",
  permission_history: "shield_permission_history",
  permission_mark_seen: "shield_permission_mark_seen",
  gate_list_active: "shield_gate_list_active",
  gate_request: "shield_gate_request",
  gate_respond: "shield_gate_respond",
  gate_revoke: "shield_gate_revoke",
  gate_set_permission: "shield_gate_set_permission",
  context_mode_get: "shield_context_mode_get",
  context_mode_set: "shield_context_mode_set",
  tool_permission_set: "shield_tool_permission_set",
  tool_permission_reset: "shield_tool_permission_reset",
  gate_operator_status: "shield_operator_status",
  gate_bind_nonce: "shield_operator_bind",
  gate_bind_operator: "shield_operator_bind",
  intent_nonce: "shield_intent_nonce",
};

async function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (window as any).__TAURI_INTERNALS__.invoke(`plugin:shield|${cmd}`, args) as Promise<T>;
}

function TauriVpsBridgeProvider({ hostname, children }: VpsBridgeProviderProps) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsVpsAuth, setNeedsVpsAuth] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Check session on mount
  useEffect(() => {
    tauriInvoke<{ hasSession: boolean }>("shield_check_session")
      .then((res) => {
        if (!res.hasSession) setNeedsVpsAuth(true);
        setReady(true);
      })
      .catch((e) => {
        setError(String(e));
        setNeedsVpsAuth(true);
        setReady(true);
      });
  }, [hostname]);

  // Session keepalive: refresh 5 min before expiry
  useEffect(() => {
    if (!ready || needsVpsAuth) return;
    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      tauriInvoke<{ active: boolean; expiresAt?: number }>("shield_session_info")
        .then((info) => {
          if (!info.active || !info.expiresAt) return;
          const msUntilExpiry = info.expiresAt * 1000 - Date.now();
          const refreshIn = Math.max(msUntilExpiry - 5 * 60 * 1000, 10_000);
          timer = setTimeout(() => {
            tauriInvoke<{ alive: boolean }>("shield_session_keepalive")
              .then((res) => {
                if (!res.alive) {
                  setNeedsVpsAuth(true);
                  setSessionExpired(true);
                } else {
                  schedule();
                }
              })
              .catch(() => {
                setNeedsVpsAuth(true);
                setSessionExpired(true);
              });
          }, refreshIn);
        })
        .catch(() => {});
    };

    schedule();
    return () => clearTimeout(timer);
  }, [ready, needsVpsAuth]);

  // Re-check session when app returns to foreground
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible" && ready && !needsVpsAuth) {
        tauriInvoke<{ hasSession: boolean }>("shield_check_session").then((res) => {
          if (!res.hasSession) {
            setNeedsVpsAuth(true);
            setSessionExpired(true);
          }
        });
      }
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, [ready, needsVpsAuth]);

  const send = useCallback(<T = unknown,>(type: string, data: Record<string, unknown> = {}): Promise<T> => {
    const cmd = TAURI_COMMAND_MAP[type];
    if (!cmd) return Promise.reject(new Error(`Unknown bridge message: ${type}`));
    return tauriInvoke<T>(cmd, data).catch((e) => {
      const msg = String(e);
      if (msg.includes("No active session") || msg.includes("NoSession")) {
        setNeedsVpsAuth(true);
      }
      throw e instanceof Error ? e : new Error(msg);
    });
  }, []);

  const dummyHandle: BridgeHandle = {
    contentWindow: typeof window !== "undefined" ? window : ({} as Window),
    hostname,
    generation: 0,
  };

  const waitForReady = useCallback((): Promise<BridgeHandle> => {
    if (ready && !error) return Promise.resolve(dummyHandle);
    if (error) return Promise.reject(new Error(error));
    return new Promise<BridgeHandle>((resolve, reject) => {
      const check = setInterval(() => {
        if (ready) { clearInterval(check); resolve(dummyHandle); }
        if (error) { clearInterval(check); reject(new Error(error)); }
      }, 50);
      setTimeout(() => { clearInterval(check); reject(new Error("Tauri bridge timeout")); }, 30_000);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, error, hostname]);

  const authenticateNative = useCallback(async (): Promise<void> => {
    // Full native passkey flow: options → ASAuthorizationController → verify → ML-KEM bind.
    // WebView WebAuthn (navigator.credentials.get) fails in WKWebView without
    // code-signed Associated Domains; the Rust command uses ASAuthorizationController directly.
    await tauriInvoke("shield_passkey_login", { serverDomain: hostname });
    setNeedsVpsAuth(false);
    setSessionExpired(false);
  }, [hostname]);

  const registerNative = useCallback(async (name: string): Promise<unknown> => {
    return tauriInvoke("shield_passkey_register", { serverDomain: hostname, name });
  }, [hostname]);

  const reauthenticate = useCallback(async (): Promise<void> => {
    await authenticateNative();
  }, [authenticateNative]);

  const signalAuthNeeded = useCallback(() => {
    setNeedsVpsAuth(true);
  }, []);

  const reload = useCallback(() => {
    setReady(false);
    setError(null);
    setNeedsVpsAuth(false);
    setSessionExpired(false);
    tauriInvoke("shield_clear_session")
      .catch(() => {})
      .finally(() => {
        tauriInvoke<{ hasSession: boolean }>("shield_check_session")
          .then((res) => {
            if (!res.hasSession) setNeedsVpsAuth(true);
            setReady(true);
          })
          .catch((e) => setError(String(e)));
      });
  }, []);

  return (
    <VpsBridgeContext.Provider
      value={{
        ready,
        error,
        needsVpsAuth,
        sessionExpired,
        send,
        waitForReady,
        reauthenticate,
        signalAuthNeeded,
        reload,
        authenticateNative,
        registerNative,
      }}
    >
      {children}
    </VpsBridgeContext.Provider>
  );
}

// ── Real iframe bridge (web) ──

function RealVpsBridgeProvider({ hostname, children }: VpsBridgeProviderProps) {
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
  useEffect(() => {
    needsAuthRef.current = needsVpsAuth || sessionExpired;
  }, [needsVpsAuth, sessionExpired]);

  useEffect(() => { errorRef.current = error; }, [error]);

  // Iframe lifecycle observed via ref callback — runs synchronously with the
  // actual DOM transition, so we never see a window that's about to detach.
  const setIframeNode = useCallback((node: HTMLIFrameElement | null) => {
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
  }, []);

  // Publish handle and drain ready-waiters once both signals hold at the
  // same instant. Without this conjunction the two have raced for years.
  useEffect(() => {
    if (!ready) return;
    const win = iframeRef.current?.contentWindow ?? null;
    if (!win) return;
    const handle: BridgeHandle = {
      contentWindow: win,
      hostname,
      generation: generationRef.current,
    };
    handleRef.current = handle;
    const waiters = readyCallbacks.current;
    readyCallbacks.current = [];
    for (const w of waiters) w.resolve(handle);
  }, [ready, hostname]);

  useEffect(() => {
    if (!error) return;
    const waiters = readyCallbacks.current;
    readyCallbacks.current = [];
    const err = new Error(error);
    for (const w of waiters) w.reject(err);
  }, [error]);

  const waitForReady = useCallback((): Promise<BridgeHandle> => {
    if (handleRef.current) return Promise.resolve(handleRef.current);
    if (errorRef.current) return Promise.reject(new Error(errorRef.current));
    return new Promise<BridgeHandle>((resolve, reject) => {
      readyCallbacks.current.push({ resolve, reject });
    });
  }, []);

  const send = useCallback(<T = unknown,>(type: string, data: Record<string, unknown> = {}): Promise<T> => {
    return (async () => {
      const handle = await waitForReady();
      return new Promise<T>((resolve, reject) => {
        const id = String(++requestId.current);
        pendingRequests.current.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          generation: handle.generation,
        });

        try {
          handle.contentWindow.postMessage(
            { type, requestId: id, ...data },
            `https://${handle.hostname}`,
          );
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
  }, [waitForReady]);

  const signalAuthNeeded = useCallback(() => {
    setNeedsVpsAuth(true);
  }, []);

  const reload = useCallback(() => {
    setReady(false);
    setError(null);
    setNeedsVpsAuth(false);
    setSessionExpired(false);
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
  }, []);

  const authenticateNative = useCallback(async (): Promise<void> => {
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
  }, [send]);

  const registerNative = useCallback(async (name: string): Promise<unknown> => {
    const { options } = await send<{ options: PublicKeyCredentialCreationOptionsJSON }>("get_registration_options", { name });
    const attestation = await startRegistration({ optionsJSON: options });
    const extResults = attestation.clientExtensionResults as Record<string, unknown> | undefined;
    const prfEnabled = (extResults?.prf as { enabled?: boolean } | undefined)?.enabled === true;
    return await send("verify_registration", { attestation, name, prfEnabled });
  }, [send]);

  const reauthenticate = useCallback(async (): Promise<void> => {
    await authenticateNative();
  }, [authenticateNative]);

  const triggerReauth = useCallback(() => {
    if (document.visibilityState === "visible") {
      setSessionExpired(false);
      (async () => {
        try {
          await authenticateNative();
          try {
            handleRef.current?.contentWindow.postMessage(
              { type: "auth_completed", success: true },
              `https://${hostname}`,
            );
          } catch {}
        } catch {
          setSessionExpired(true);
          setNeedsVpsAuth(true);
        }
      })();
    } else {
      setSessionExpired(true);
      setNeedsVpsAuth(true);
    }
  }, [authenticateNative, hostname]);

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

  // Auto-trigger passkey auth when bridge is ready but has no session
  const autoAuthAttempted = useRef(false);
  useEffect(() => {
    if (ready && needsVpsAuth && !autoAuthAttempted.current) {
      autoAuthAttempted.current = true;
      authenticateNative().catch(() => {
        setNeedsVpsAuth(true);
      });
    }
    if (!needsVpsAuth) {
      autoAuthAttempted.current = false;
    }
  }, [ready, needsVpsAuth, authenticateNative]);

  useEffect(() => {
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
                win.postMessage(
                  { type: "exchange_session", exchangeCode: sovereignCode },
                  `https://${hostname}`,
                );
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
          console.error('[VpsBridge] PoP initialization failed:', data.error);
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
      if (document.visibilityState !== "visible") return;
      if (!needsAuthRef.current) return;
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
  }, [hostname, queryClient, authenticateNative]);

  return (
    <VpsBridgeContext.Provider value={{ ready, error, needsVpsAuth, sessionExpired, send, waitForReady, reauthenticate, signalAuthNeeded, reload, authenticateNative, registerNative }}>
      <iframe
        key={bridgeKey}
        ref={setIframeNode}
        src={`https://${hostname}/_auth/bridge`}
        style={{ display: "none" }}
        title="VPS Auth Bridge"
        allow="publickey-credentials-create *; publickey-credentials-get *"
      />
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
