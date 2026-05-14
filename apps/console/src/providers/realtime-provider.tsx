// SPDX-License-Identifier: MIT
"use client";

import {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getCodeWsUrl } from "@/lib/domains";
import { useVpsBridge } from "@/lib/vps-bridge";
import { emitSessionStatus } from "@/lib/session-events";

export interface TreeData {
  project: string;
  tree: FileNode;
}

export interface FileNode {
  name: string;
  type: "file" | "dir";
  path: string;
  children?: FileNode[];
}

export interface StatusData {
  project: string;
  modified: Array<{ status: string; file: string }>;
}

export interface ServerStatusData {
  cpuUsage: number;
  ramUsage: number;
  activeSessions: string[];
  terminalEnabled: boolean;
  sshEnabled: boolean;
  lastSync: string;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export interface WatchdogHealthData {
  status?: string;
  zeroclaw?: {
    running?: boolean;
    status?: string;
    active_daemons?: number;
    daemons?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SessionStatusData {
  alive: boolean;
  reason?: string;
  tier?: string;
  effectiveExpiresAt?: number | null;
  sessionExpiresAt?: number | null;
  absoluteExpiry?: number | null;
  idleDeadline?: number | null;
}

export interface RealtimeMessage {
  type:
    | "connected"
    | "tree"
    | "status"
    | "apps_changed"
    | "server_status"
    | "preview_all_status"
    | "preview_install_status"
    | "whatsapp_qr"
    | "vault_index_changed"
    | "watchdog_health"
    | "session_status";
  data?:
    | TreeData
    | StatusData
    | ServerStatusData
    | WatchdogHealthData
    | SessionStatusData
    | { hint: string };
  timestamp: number;
}

interface RealtimeContextValue {
  status: ConnectionStatus;
  isConnected: boolean;
  tree: TreeData | null;
  gitStatus: StatusData | null;
  serverStatus: ServerStatusData | null;
  watchdogHealth: WatchdogHealthData | null;
  sessionStatus: SessionStatusData | null;
  reconnect: () => void;
  subscribe: (callback: (message: RealtimeMessage) => void) => () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

interface RealtimeProviderProps {
  serverDomain: string;
  securityTier?: string;
  enabled?: boolean;
  children: ReactNode;
}

const MAX_WS_ATTEMPTS = 20;
const BASE_WS_DELAY_MS = 1_000;
const MAX_WS_DELAY_MS = 15_000;
const QUICK_FAIL_THRESHOLD_MS = 2_000;
const MAX_QUICK_FAILS = 10;
const SESSION_REFRESH_BUFFER_MS = 2 * 60 * 1000;
const BRIDGE_BACKOFF_INITIAL_MS = 1_000;
const BRIDGE_BACKOFF_MAX_MS = 30_000;

export function RealtimeProvider({
  serverDomain,
  securityTier,
  enabled = true,
  children,
}: RealtimeProviderProps) {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [tree, setTree] = useState<TreeData | null>(null);
  const [gitStatus, setGitStatus] = useState<StatusData | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatusData | null>(null);
  const [watchdogHealth, setWatchdogHealth] = useState<WatchdogHealthData | null>(null);
  const [sessionStatus, setSessionStatus] = useState<SessionStatusData | null>(null);
  const [reconnectKick, setReconnectKick] = useState(0);

  const subscribersRef = useRef(new Set<(message: RealtimeMessage) => void>());
  const wsUrl = getCodeWsUrl(serverDomain);
  const needsAuth = securityTier !== "standard";

  const { send: bridgeSend, waitForReady: bridgeWaitForReady } = useVpsBridge();
  const bridgeSendRef = useRef(bridgeSend);
  const bridgeWaitForReadyRef = useRef(bridgeWaitForReady);
  bridgeSendRef.current = bridgeSend;
  bridgeWaitForReadyRef.current = bridgeWaitForReady;

  // Single lifecycle owner. Effect re-runs only when the *server identity*
  // changes (enabled / wsUrl / needsAuth). Bridge state flaps are absorbed
  // inside the loop via separate budgets — they never reset the WS budget.
  useEffect(() => {
    if (!enabled) {
      setStatus("disconnected");
      return;
    }

    const controller = new AbortController();
    const sessionCache: { id: string | null; expiresAt: number } = { id: null, expiresAt: 0 };

    const sleep = (ms: number): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        controller.signal.addEventListener(
          "abort",
          () => { clearTimeout(t); reject(new Error("aborted")); },
          { once: true },
        );
      });

    const acquireSession = async (): Promise<string | null> => {
      if (!needsAuth) return null;
      const now = Date.now();
      if (sessionCache.id && now < sessionCache.expiresAt - SESSION_REFRESH_BUFFER_MS) {
        return sessionCache.id;
      }
      // BridgeError: thrown if bridge is in terminal error or unmounted.
      // Caller treats this as a transient bridge failure (separate budget).
      await bridgeWaitForReadyRef.current();
      if (controller.signal.aborted) throw new Error("aborted");
      try {
        const result = await bridgeSendRef.current<{ codeSessionId: string; expiresAt: number }>(
          "get_code_session",
        );
        sessionCache.id = result.codeSessionId;
        sessionCache.expiresAt = result.expiresAt;
        return result.codeSessionId;
      } catch (e) {
        // "Authentication required" means the user must reauth before we
        // can connect. Treat as a bridge-tier wait, not a WS failure.
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === "Authentication required") return null;
        throw e;
      }
    };

    const attachWsHandlers = (ws: WebSocket) => {
      ws.onmessage = (event) => {
        try {
          const message: RealtimeMessage = JSON.parse(event.data);
          switch (message.type) {
            case "tree":
              if (message.data && "tree" in message.data) {
                setTree(message.data as TreeData);
              }
              break;
            case "status":
              if (message.data && "modified" in message.data) {
                setGitStatus(message.data as StatusData);
              }
              break;
            case "server_status":
              if (message.data && "cpuUsage" in message.data) {
                setServerStatus(message.data as ServerStatusData);
              }
              break;
            case "watchdog_health":
              if (message.data) {
                setWatchdogHealth(message.data as WatchdogHealthData);
              }
              break;
            case "session_status":
              if (message.data && "alive" in message.data) {
                const s = message.data as SessionStatusData;
                setSessionStatus(s);
                emitSessionStatus(s);
              }
              break;
          }
          for (const subscriber of subscribersRef.current) subscriber(message);
        } catch (e) {
          console.error("[Realtime] Failed to parse message:", e);
        }
      };
    };

    type Outcome =
      | { kind: "open_then_close"; durationMs: number }
      | { kind: "ws_construct_failed" }
      | { kind: "bridge_failed" }
      | { kind: "needs_user_auth" }
      | { kind: "aborted" };

    const runOnce = async (): Promise<Outcome> => {
      setStatus("connecting");
      let codeSessionId: string | null;
      try {
        codeSessionId = await acquireSession();
      } catch (e) {
        if (controller.signal.aborted) return { kind: "aborted" };
        const msg = e instanceof Error ? e.message : String(e);
        // Anything that came from the bridge layer (including "Bridge not
        // ready", "Bridge unmounted", "Bridge reloading", "Request timeout")
        // is a transient bridge failure. Don't burn the WS budget.
        console.warn("[Realtime] bridge failure during session acquire:", msg);
        return { kind: "bridge_failed" };
      }

      if (controller.signal.aborted) return { kind: "aborted" };

      if (needsAuth && codeSessionId === null) {
        // User needs to reauth via passkey. Wait for the bridge to flip
        // back to authenticated and have someone bump reconnectKick.
        return { kind: "needs_user_auth" };
      }

      const url = codeSessionId ? `${wsUrl}?_code_session=${codeSessionId}` : wsUrl;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        console.error("[Realtime] Failed to create WebSocket:", e);
        return { kind: "ws_construct_failed" };
      }

      attachWsHandlers(ws);

      const connectionStart = Date.now();
      let opened = false;

      const closePromise = new Promise<void>((resolve) => {
        ws.onopen = () => {
          opened = true;
          setStatus("connected");
        };
        ws.onerror = () => {
          // Browsers fire close right after error; let close drive teardown.
        };
        ws.onclose = () => resolve();
        controller.signal.addEventListener(
          "abort",
          () => { try { ws.close(); } catch { /* ignore */ } resolve(); },
          { once: true },
        );
      });

      await closePromise;
      ws.onmessage = ws.onopen = ws.onerror = ws.onclose = null;

      if (controller.signal.aborted) return { kind: "aborted" };
      setStatus("disconnected");

      if (!opened) {
        // Never reached open — server rejected handshake or network down.
        // Common causes: stale code session (rotated), origin block, TLS.
        // Invalidate cached session so next round re-mints.
        sessionCache.id = null;
        sessionCache.expiresAt = 0;
        return { kind: "open_then_close", durationMs: 0 };
      }

      return { kind: "open_then_close", durationMs: Date.now() - connectionStart };
    };

    const loop = async () => {
      let wsAttempts = 0;
      let quickFails = 0;
      let bridgeBackoff = BRIDGE_BACKOFF_INITIAL_MS;

      while (!controller.signal.aborted) {
        const outcome = await runOnce();
        if (outcome.kind === "aborted") return;

        if (outcome.kind === "bridge_failed") {
          try { await sleep(bridgeBackoff + Math.random() * 500); } catch { return; }
          bridgeBackoff = Math.min(bridgeBackoff * 2, BRIDGE_BACKOFF_MAX_MS);
          continue;
        }

        // Any progress to/past WS layer resets bridge backoff.
        bridgeBackoff = BRIDGE_BACKOFF_INITIAL_MS;

        if (outcome.kind === "needs_user_auth") {
          // Wait passively. The auth-needed UI is shown elsewhere; when the
          // user authenticates, the bridge reload triggers a re-render that
          // bumps reconnectKick, which restarts this effect from scratch.
          setStatus("disconnected");
          try { await sleep(BRIDGE_BACKOFF_MAX_MS); } catch { return; }
          continue;
        }

        if (outcome.kind === "open_then_close") {
          if (outcome.durationMs > 0) {
            // Connection opened. Reset the WS budget on a successful open;
            // close was server-side or network — count as one normal failure.
            wsAttempts = 1;
            quickFails = 0;
            if (outcome.durationMs < QUICK_FAIL_THRESHOLD_MS) {
              quickFails += 1;
            }
          } else {
            wsAttempts += 1;
            quickFails += 1;
          }

          if (quickFails >= MAX_QUICK_FAILS) {
            console.warn("[Realtime] Connection unavailable, stopped retrying");
            setStatus("error");
            return;
          }

          if (wsAttempts >= MAX_WS_ATTEMPTS) {
            console.warn("[Realtime] Max reconnect attempts reached");
            setStatus("error");
            return;
          }
        } else if (outcome.kind === "ws_construct_failed") {
          wsAttempts += 1;
          if (wsAttempts >= MAX_WS_ATTEMPTS) {
            setStatus("error");
            return;
          }
        }

        const delay = Math.min(
          BASE_WS_DELAY_MS * 2 ** Math.min(wsAttempts - 1, 5),
          MAX_WS_DELAY_MS,
        ) + Math.random() * 1_000;
        try { await sleep(delay); } catch { return; }
      }
    };

    void loop();

    return () => {
      controller.abort();
    };
  }, [enabled, wsUrl, needsAuth, reconnectKick]);

  const reconnect = useCallback(() => {
    setReconnectKick((k) => k + 1);
  }, []);

  const subscribe = useCallback(
    (callback: (message: RealtimeMessage) => void) => {
      subscribersRef.current.add(callback);
      return () => {
        subscribersRef.current.delete(callback);
      };
    },
    [],
  );

  // Tab-visibility nudge: only kick if the loop is currently in a backoff or
  // error state. We never tear down a healthy connection just because the
  // user came back to the tab.
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState !== "visible") return;
      if (statusRef.current === "connected" || statusRef.current === "connecting") return;
      setReconnectKick((k) => k + 1);
    };
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  const value: RealtimeContextValue = {
    status,
    isConnected: status === "connected",
    tree,
    gitStatus,
    serverStatus,
    watchdogHealth,
    sessionStatus,
    reconnect,
    subscribe,
  };

  return (
    <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
  );
}

export function useRealtime(): RealtimeContextValue {
  const ctx = useContext(RealtimeContext);
  if (!ctx) {
    throw new Error("useRealtime must be used within a RealtimeProvider");
  }
  return ctx;
}

export function useRealtimeSubscribe(
  callback: (message: RealtimeMessage) => void,
) {
  const ctx = useContext(RealtimeContext);

  useEffect(() => {
    if (!ctx) return;
    return ctx.subscribe(callback);
  }, [ctx, callback]);

  return {
    isConnected: ctx?.isConnected ?? false,
    status: ctx?.status ?? ("disconnected" as ConnectionStatus),
  };
}
