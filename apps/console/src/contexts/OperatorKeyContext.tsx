// SPDX-License-Identifier: MIT
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  operatorKeyFor,
  OperatorKeyUnrecoverableError,
  type OperatorKeyApi,
} from "@/lib/operator-key";
import { makeGateClient, type GateClient } from "@/lib/gate-client";
import {
  makeContextModeClient,
  type ContextModeClient,
} from "@/lib/context-mode-client";
import {
  makeToolPermissionClient,
  type ToolPermissionClient,
} from "@/lib/tool-permission-client";
import { useVpsBridge } from "@/lib/vps-bridge";

export type OperatorKeyStatus = "idle" | "ready" | "error";

export interface OperatorKeyContextValue {
  sign: OperatorKeyApi["sign"];
  clear: OperatorKeyApi["clear"];
  status: OperatorKeyStatus;
  lastError: string | null;
  gateClient: GateClient;
  contextModeClient: ContextModeClient;
  toolPermissionClient: ToolPermissionClient;
}

const OperatorKeyContext = createContext<OperatorKeyContextValue | null>(null);

export function useOperatorKey(): OperatorKeyContextValue {
  const ctx = useContext(OperatorKeyContext);
  if (!ctx) {
    throw new Error("useOperatorKey must be used within OperatorKeyProvider");
  }
  return ctx;
}

export function useOperatorKeyOptional(): OperatorKeyContextValue | null {
  return useContext(OperatorKeyContext);
}

interface ProviderProps {
  serverDomain: string;
  securityTier?: "standard" | "web_locked" | "private_locked";
  children: ReactNode;
}

export function OperatorKeyProvider({ serverDomain, securityTier, children }: ProviderProps) {
  const [status, setStatus] = useState<OperatorKeyStatus>("idle");
  const [lastError, setLastError] = useState<string | null>(null);

  const isLockedTier = securityTier === "web_locked" || securityTier === "private_locked";

  // Routing through the iframe bridge is mandatory: the console origin has
  // no PoP Service Worker, so direct fetch against shield endpoints returns
  // 401 missing_pop_headers. The bridge SW at {srv}.ellul.ai signs every
  // request. OperatorKeyProvider is mounted INSIDE VpsBridgeProvider in
  // DashboardProviders, so this hook is safe.
  const { send: bridgeSend } = useVpsBridge();

  const api = useMemo(
    () => operatorKeyFor(serverDomain, bridgeSend),
    [serverDomain, bridgeSend],
  );
  const gateClient = useMemo(
    () => makeGateClient(serverDomain, api, bridgeSend, isLockedTier),
    [serverDomain, api, bridgeSend, isLockedTier],
  );
  const contextModeClient = useMemo(
    () => makeContextModeClient(serverDomain, api, bridgeSend, isLockedTier),
    [serverDomain, api, bridgeSend, isLockedTier],
  );
  const toolPermissionClient = useMemo(
    () => makeToolPermissionClient(serverDomain, api, bridgeSend, isLockedTier),
    [serverDomain, api, bridgeSend, isLockedTier],
  );

  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
    setStatus("idle");
    setLastError(null);
  }, [api]);

  const sign = useCallback<OperatorKeyApi["sign"]>(async (payload) => {
    try {
      const result = await apiRef.current.sign(payload);
      setStatus("ready");
      setLastError(null);
      return result;
    } catch (e) {
      const msg =
        e instanceof OperatorKeyUnrecoverableError
          ? e.message
          : e instanceof Error
          ? e.message
          : String(e);
      setStatus("error");
      setLastError(msg);
      throw e;
    }
  }, []);

  const clear = useCallback<OperatorKeyApi["clear"]>(async () => {
    try {
      await apiRef.current.clear();
      setStatus("idle");
      setLastError(null);
    } catch (e) {
      setStatus("error");
      setLastError(e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, []);

  const value = useMemo<OperatorKeyContextValue>(
    () => ({
      sign,
      clear,
      status,
      lastError,
      gateClient,
      contextModeClient,
      toolPermissionClient,
    }),
    [sign, clear, status, lastError, gateClient, contextModeClient, toolPermissionClient],
  );

  return (
    <OperatorKeyContext.Provider value={value}>
      {children}
    </OperatorKeyContext.Provider>
  );
}
