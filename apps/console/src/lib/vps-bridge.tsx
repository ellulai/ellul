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

async function tauriInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (window as any).__TAURI_INTERNALS__.invoke(`plugin:shield|${cmd}`, args) as Promise<T>;
}

// ── Iframe bridge (web + Tauri) ──

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
    if (isTauriApp()) {
      await tauriInvoke("shield_passkey_login", { serverDomain: hostname });
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
  }, [send, hostname]);

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
          if (isTauriApp()) {
            // No SW in cross-origin iframe is expected — server accepts cookie-only auth
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
