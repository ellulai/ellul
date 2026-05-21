// SPDX-License-Identifier: MIT
"use client";

import { createContext } from "react";
import { useVpsCapabilities, type VpsCapabilities } from "@/hooks/useVpsCapabilities";
import { MOCK_MODE } from "@/lib/mock-data";

export const VpsCapabilitiesContext = createContext<VpsCapabilities | null>(null);

interface VpsCapabilitiesProviderProps {
  hostname: string | null;
  serverStatus?: string | null;
  children: React.ReactNode;
}

export function VpsCapabilitiesProvider({ hostname, serverStatus, children }: VpsCapabilitiesProviderProps) {
  const { data: caps } = useVpsCapabilities(
    MOCK_MODE ? null : hostname,
    serverStatus,
  );

  return (
    <VpsCapabilitiesContext.Provider value={caps ?? null}>
      {children}
    </VpsCapabilitiesContext.Provider>
  );
}
