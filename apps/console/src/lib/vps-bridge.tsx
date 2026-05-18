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

// ── Debug overlay (persists across navigations via sessionStorage) ──
const _DBG_KEY = "__vps_bridge_dbg__";
function _loadLines(): string[] {
  try { return JSON.parse(sessionStorage.getItem(_DBG_KEY) || "[]"); } catch { return []; }
}
const _debugLines: string[] = typeof window !== "undefined" ? _loadLines() : [];
let _debugListeners: Array<() => void> = [];
function dbg(tag: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `${ts} [${tag}] ${msg}`;
  _debugLines.push(line);
  if (_debugLines.length > 300) _debugLines.splice(0, _debugLines.length - 300);
  try { sessionStorage.setItem(_DBG_KEY, JSON.stringify(_debugLines)); } catch {}
  for (const fn of _debugListeners) fn();
}
if (typeof window !== "undefined") dbg("init", `page=${location.pathname} ua=${navigator.userAgent.slice(0, 80)}`);
function useDebugLog() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    _debugListeners.push(fn);
    return () => { _debugListeners = _debugListeners.filter((f) => f !== fn); };
  }, []);
  return _debugLines;
}
function DebugOverlay() {
  const lines = useDebugLog();
  const ref = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [lines.length]);
  if (lines.length === 0) return null;
  return (
    <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 99999 }}>
      <div style={{ display: "flex", justifyContent: "space-between", background: "rgba(0,0,0,0.95)", borderTop: "1px solid rgba(255,255,255,0.15)", padding: "2px 10px", fontSize: "10px", color: "rgba(255,255,255,0.6)" }}>
        <span>VPS Bridge Debug ({lines.length} lines)</span>
        <span style={{ display: "flex", gap: "8px" }}>
          <button onClick={() => { _debugLines.length = 0; try { sessionStorage.removeItem(_DBG_KEY); } catch {} }} style={{ color: "#f88", background: "none", border: "none", cursor: "pointer", fontSize: "10px" }}>clear</button>
          <button onClick={() => setCollapsed(!collapsed)} style={{ color: "#8ff", background: "none", border: "none", cursor: "pointer", fontSize: "10px" }}>{collapsed ? "expand" : "collapse"}</button>
        </span>
      </div>
      {!collapsed && (
        <div
          ref={ref}
          style={{
            maxHeight: "35vh", overflowY: "auto",
            background: "rgba(0,0,0,0.92)",
            padding: "4px 10px", fontFamily: "monospace", fontSize: "10px",
            lineHeight: "1.5", color: "rgba(255,255,255,0.8)", whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  );
}

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
  const tauri = isTauriApp();
  const hasTauriInternals = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  dbg("dispatch", `isTauriApp=${tauri} __TAURI_INTERNALS__=${hasTauriInternals} securityTier=${props.securityTier ?? "undefined"} hostname=${props.hostname} MOCK_MODE=${MOCK_MODE}`);
  if (MOCK_MODE) { dbg("dispatch", "→ MockVpsBridgeProvider"); return <MockVpsBridgeProvider>{props.children}</MockVpsBridgeProvider>; }
  // Tauri native bridge for non-standard tiers (passkey + PoP in Rust).
  // Standard tier uses the iframe bridge — session managed via cookies.
  if (tauri && props.securityTier !== "standard") {
    dbg("dispatch", `→ TauriVpsBridgeProvider (tier=${props.securityTier})`);
    return <><TauriVpsBridgeProvider hostname={props.hostname} securityTier={props.securityTier}>{props.children}</TauriVpsBridgeProvider><DebugOverlay /></>;
  }
  dbg("dispatch", `→ RealVpsBridgeProvider (tauri=${tauri}, tier=${props.securityTier})`);
  return <><RealVpsBridgeProvider hostname={props.hostname}>{props.children}</RealVpsBridgeProvider><DebugOverlay /></>;
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
  const mountIdRef = useRef(Math.random().toString(36).slice(2, 8));

  console.error("[tauri-bridge] render: needsVpsAuth=%s ready=%s mountId=%s", needsVpsAuth, ready, mountIdRef.current);
  dbg("tauri", `mount hostname=${hostname}`);

  // Check session on mount
  useEffect(() => {
    dbg("tauri", "shield_check_session → calling...");
    tauriInvoke<{ hasSession: boolean }>("shield_check_session")
      .then((res) => {
        dbg("tauri", `shield_check_session → hasSession=${res.hasSession}`);
        if (!res.hasSession) setNeedsVpsAuth(true);
        setReady(true);
      })
      .catch((e) => {
        dbg("tauri", `shield_check_session ERROR: ${String(e)}`);
        setError(String(e));
        setNeedsVpsAuth(true);
        setReady(true);
      });
  }, [hostname]);

  // Session keepalive: refresh 5 min before expiry
  useEffect(() => {
    if (!ready || needsVpsAuth) return;
    dbg("tauri", "keepalive: scheduling...");
    let timer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      tauriInvoke<{ active: boolean; expiresAt?: number }>("shield_session_info")
        .then((info) => {
          dbg("tauri", `session_info → active=${info.active}, expiresAt=${info.expiresAt}`);
          if (!info.active || !info.expiresAt) return;
          const msUntilExpiry = info.expiresAt * 1000 - Date.now();
          const refreshIn = Math.max(msUntilExpiry - 5 * 60 * 1000, 10_000);
          dbg("tauri", `keepalive: refreshIn=${Math.round(refreshIn / 1000)}s`);
          timer = setTimeout(() => {
            dbg("tauri", "shield_session_keepalive → calling...");
            tauriInvoke<{ alive: boolean }>("shield_session_keepalive")
              .then((res) => {
                dbg("tauri", `shield_session_keepalive → alive=${res.alive}`);
                if (!res.alive) {
                  setNeedsVpsAuth(true);
                  setSessionExpired(true);
                } else {
                  schedule();
                }
              })
              .catch((e) => {
                dbg("tauri", `shield_session_keepalive ERROR: ${e}`);
                setNeedsVpsAuth(true);
                setSessionExpired(true);
              });
          }, refreshIn);
        })
        .catch((e) => { dbg("tauri", `session_info ERROR: ${e}`); });
    };

    schedule();
    return () => clearTimeout(timer);
  }, [ready, needsVpsAuth]);

  // Re-check session when app returns to foreground
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible" && ready && !needsVpsAuth) {
        dbg("tauri", "visibility → visible, re-checking session...");
        tauriInvoke<{ hasSession: boolean }>("shield_check_session").then((res) => {
          dbg("tauri", `visibility re-check → hasSession=${res.hasSession}`);
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
    if (!cmd) {
      dbg("tauri", `send(${type}) → UNKNOWN, no mapping`);
      return Promise.reject(new Error(`Unknown bridge message: ${type}`));
    }
    dbg("tauri", `send(${type}) → ${cmd}`);
    return tauriInvoke<T>(cmd, data).then((res) => {
      dbg("tauri", `send(${type}) → OK`);
      console.error("[tauri] send(%s) → OK", type);
      return res;
    }).catch((e) => {
      const msg = String(e);
      dbg("tauri", `send(${type}) ERROR: ${msg}`);
      console.error("[tauri] send(%s) ERROR: %s", type, msg);
      if (msg.includes("No active session") || msg.includes("NoSession") ||
          msg.includes("Authentication required") || msg.includes("401") ||
          msg.includes("Unauthorized")) {
        dbg("tauri", `send(${type}) → auth failure detected, setting needsVpsAuth=true`);
        console.error("[tauri] send(%s) → auth failure detected, setting needsVpsAuth=true", type);
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
    dbg("tauri", `authenticateNative called — native passkey on ${hostname}`);
    try {
      const result = await tauriInvoke<Record<string, unknown>>("shield_passkey_login", {
        serverDomain: hostname,
      });
      dbg("tauri", `authenticateNative OK: ${JSON.stringify(result).slice(0, 200)}`);
      setNeedsVpsAuth(false);
      setSessionExpired(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      dbg("tauri", `authenticateNative FAILED: ${msg}`);
      throw e;
    }
  }, [hostname]);

  const registerNative = useCallback(async (name: string): Promise<unknown> => {
    dbg("tauri", `registerNative called name=${name}`);
    return tauriInvoke("shield_passkey_register", { serverDomain: hostname, name });
  }, [hostname]);

  const reauthenticate = useCallback(async (): Promise<void> => {
    dbg("tauri", "reauthenticate called → delegating to authenticateNative");
    await authenticateNative();
  }, [authenticateNative]);

  const signalAuthNeeded = useCallback(() => {
    dbg("tauri", "signalAuthNeeded called");
    setNeedsVpsAuth(true);
  }, []);

  const reload = useCallback(() => {
    dbg("tauri", "reload called → clearing session");
    setReady(false);
    setError(null);
    setNeedsVpsAuth(false);
    setSessionExpired(false);
    tauriInvoke("shield_clear_session")
      .catch(() => {})
      .finally(() => {
        tauriInvoke<{ hasSession: boolean }>("shield_check_session")
          .then((res) => {
            dbg("tauri", `reload check_session → hasSession=${res.hasSession}`);
            if (!res.hasSession) setNeedsVpsAuth(true);
            setReady(true);
          })
          .catch((e) => { dbg("tauri", `reload check_session ERROR: ${e}`); setError(String(e)); });
      });
  }, []);

  // No auto-trigger for Tauri — WebAuthn requires user gesture (click).
  // The AuthWall button calls reauthenticate → authenticateNative on click.
  useEffect(() => {
    if (ready && needsVpsAuth) {
      dbg("tauri", "state: ready=true needsVpsAuth=true — waiting for user to click Login with Passkey");
    }
  }, [ready, needsVpsAuth]);

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

  dbg("real", `mount hostname=${hostname}, isTauri=${isTauriApp()}, bridgeKey=${bridgeKey}`);

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
    dbg("real", `authenticateNative called, isTauri=${isTauriApp()}`);
    if (isTauriApp()) {
      dbg("real", "authenticateNative → redirecting to /sign-in (Tauri WKWebView)");
      window.location.replace("/sign-in");
      return new Promise(() => {});
    }
    dbg("real", "authenticateNative → WebAuthn flow: get_auth_options...");
    const options = await send<PublicKeyCredentialRequestOptionsJSON>("get_auth_options");
    dbg("real", "authenticateNative → startAuthentication...");
    const assertion = await startAuthentication({ optionsJSON: options });
    dbg("real", "authenticateNative → verify_auth...");
    await send("verify_auth", { assertion });
    dbg("real", "authenticateNative → waiting for bridge ready...");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { dbg("real", "authenticateNative → TIMEOUT"); reject(new Error("Auth timeout")); }, 30_000);
      const check = setInterval(() => {
        if (handleRef.current) {
          clearInterval(check);
          clearTimeout(timeout);
          dbg("real", "authenticateNative → bridge ready, done");
          resolve();
        }
      }, 100);
    });
  }, [send]);

  const registerNative = useCallback(async (name: string): Promise<unknown> => {
    dbg("real", `registerNative name=${name}`);
    const { options } = await send<{ options: PublicKeyCredentialCreationOptionsJSON }>("get_registration_options", { name });
    const attestation = await startRegistration({ optionsJSON: options });
    const extResults = attestation.clientExtensionResults as Record<string, unknown> | undefined;
    const prfEnabled = (extResults?.prf as { enabled?: boolean } | undefined)?.enabled === true;
    return await send("verify_registration", { attestation, name, prfEnabled });
  }, [send]);

  const reauthenticate = useCallback(async (): Promise<void> => {
    dbg("real", "reauthenticate → delegating to authenticateNative");
    await authenticateNative();
  }, [authenticateNative]);

  const triggerReauth = useCallback(() => {
    dbg("real", `triggerReauth visible=${document.visibilityState}`);
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
        } catch (e) {
          dbg("real", `triggerReauth FAILED: ${e}`);
          setSessionExpired(true);
          setNeedsVpsAuth(true);
        }
      })();
    } else {
      dbg("real", "triggerReauth → not visible, setting expired");
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

  // Auto-trigger passkey auth when bridge is ready but has no session.
  // Skip in Tauri — WKWebView can't do WebAuthn; user clicks the button
  // which redirects to /sign-in instead.
  const autoAuthAttempted = useRef(false);
  useEffect(() => {
    if (isTauriApp()) { dbg("real", "auto-auth: skipped (Tauri)"); return; }
    if (ready && needsVpsAuth && !autoAuthAttempted.current) {
      dbg("real", "auto-auth: triggering (ready + needsVpsAuth)");
      autoAuthAttempted.current = true;
      authenticateNative().catch((e) => {
        dbg("real", `auto-auth FAILED: ${e}`);
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
      dbg("real", `msg: type=${type} reqId=${reqId ?? "-"} keys=${Object.keys(data).join(",")}`);

      if (type === "bridge_ready") {
        dbg("real", `bridge_ready: pop=${data.pop} error=${data.error ?? "none"}`);
        if (data.pop === false) {
          if (data.error === "No session" || data.error === "Invalid session" || data.error === "Authentication required") {
            const sovereignCode = sessionStorage.getItem("sovereign-exchange-code");
            dbg("real", `bridge_ready: no session, sovereignCode=${sovereignCode ? "present" : "absent"}`);
            const win = iframeRef.current?.contentWindow;
            if (sovereignCode && win) {
              dbg("real", "bridge_ready: exchanging sovereign code");
              sessionStorage.removeItem("sovereign-exchange-code");
              try {
                win.postMessage(
                  { type: "exchange_session", exchangeCode: sovereignCode },
                  `https://${hostname}`,
                );
              } catch {}
              return;
            }
            dbg("real", "bridge_ready: → needsVpsAuth=true (no session)");
            setNeedsVpsAuth(true);
            setReady(true);
            return;
          }
          if (data.error?.includes('Device key missing') || data.error?.includes('re-authentication required')) {
            dbg("real", `bridge_ready: → needsVpsAuth=true (${data.error})`);
            setNeedsVpsAuth(true);
            setReady(true);
            return;
          }
          dbg("real", `bridge_ready: PoP init FAILED: ${data.error}`);
          console.error('[VpsBridge] PoP initialization failed:', data.error);
          setError('Security initialization failed. Please refresh the page.');
          return;
        }
        dbg("real", "bridge_ready: PoP OK → ready");
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

      if (type === "passkey_required") { dbg("real", "passkey_required received"); return; }

      if (type === "session_expired" || type === "session_revoked" || type === "auth_required") {
        dbg("real", `${type} received → triggerReauth`);
        triggerReauthRef.current();
        return;
      }

      if (reqId && pendingRequests.current.has(reqId)) {
        const { resolve, reject } = pendingRequests.current.get(reqId)!;
        pendingRequests.current.delete(reqId);

        if (data.success === false) {
          const errMsg = typeof data.error === 'string' ? data.error
            : data.error ? JSON.stringify(data.error) : "Request failed";
          dbg("real", `response reqId=${reqId} FAILED: ${errMsg}`);
          if (errMsg === "Authentication required") setNeedsVpsAuth(true);
          reject(new Error(errMsg));
        } else {
          dbg("real", `response reqId=${reqId} OK`);
          resolve(data);
        }
      }
    };

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (!needsAuthRef.current) return;
      dbg("real", "visibility → visible + needsAuth → retrying auth");
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
