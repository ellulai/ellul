// SPDX-License-Identifier: MIT
"use client";

import { createContext, useEffect, useState } from "react";
import { useVpsCapabilities, type VpsCapabilities } from "@/hooks/useVpsCapabilities";
import { MOCK_MODE } from "@/lib/mock-data";

export const VpsCapabilitiesContext = createContext<VpsCapabilities | null>(null);

interface VpsCapabilitiesProviderProps {
  hostname: string | null;
  serverStatus?: string | null;
  isLocal?: boolean;
  children: React.ReactNode;
}

export function VpsCapabilitiesProvider({ hostname, serverStatus, isLocal, children }: VpsCapabilitiesProviderProps) {
  const { data: remoteCaps } = useVpsCapabilities(
    MOCK_MODE || isLocal ? null : hostname,
    serverStatus,
  );

  const [localCaps, setLocalCaps] = useState<VpsCapabilities | null>(null);

  useEffect(() => {
    if (!isLocal || serverStatus !== "running") return;
    const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
    if (!invoke) return;
    let cancelled = false;
    invoke("plugin:proot|proot_fetch", {
      method: "GET",
      path: "/_auth/capabilities",
      port: 3005,
    }).then((result: { status: number; body: string }) => {
      if (cancelled || result.status !== 200) return;
      try { setLocalCaps(JSON.parse(result.body)); } catch {}
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isLocal, serverStatus]);

  return (
    <VpsCapabilitiesContext.Provider value={(isLocal ? localCaps : remoteCaps) ?? null}>
      {children}
    </VpsCapabilitiesContext.Provider>
  );
}
