// SPDX-License-Identifier: MIT
"use client";

import { createContext, useEffect, useState } from "react";
import { useVpsCapabilities, type VpsCapabilities } from "@/hooks/useVpsCapabilities";
import { hasTauriInvoke, localFetch } from "@/lib/local-fetch";
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
    let cancelled = false;
    if (hasTauriInvoke()) {
      localFetch("GET", "/_auth/capabilities")
        .then((r) => { if (!cancelled && r.status === 200) try { setLocalCaps(JSON.parse(r.body)); } catch {} })
        .catch(() => {});
    } else {
      fetch("http://localhost/_auth/capabilities", { credentials: "include" })
        .then((r) => r.ok ? r.json() : null)
        .then((data) => { if (!cancelled && data) setLocalCaps(data); })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [isLocal, serverStatus]);

  return (
    <VpsCapabilitiesContext.Provider value={(isLocal ? localCaps : remoteCaps) ?? null}>
      {children}
    </VpsCapabilitiesContext.Provider>
  );
}
