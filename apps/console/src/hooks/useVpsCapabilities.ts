// SPDX-License-Identifier: MIT
"use client";

// (10s → 20s → 30s) until the VPS responds. Caps at 30s to avoid hammering.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

export interface VpsCapabilities {
  version: string;
  endpoints: Record<string, number>;
  features: string[];
}

// Jitter prevents thundering herd when multiple tabs reconnect simultaneously
function jitter(baseMs: number): number {
  return baseMs + Math.random() * Math.min(baseMs * 0.3, 3000);
}

async function fetchCapabilities(hostname: string): Promise<VpsCapabilities | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(`https://${hostname}/_auth/capabilities`, {
      signal: controller.signal,
      // Avoids CORS preflight which can fail during VPS boot.
      cache: "no-store",
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();

    // Empty capabilities response ({}) — treat as null so consumers
    if (!data?.version) return null;

    return data as VpsCapabilities;
  } finally {
    clearTimeout(timeout);
  }
}

// Discover VPS capabilities with resilient retry and adaptive polling.
export function useVpsCapabilities(
  hostname: string | null,
  serverStatus?: string | null,
) {
  const queryClient = useQueryClient();
  const consecutiveFailures = useRef(0);
  const lastSuccessAt = useRef<number>(0);
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Brief cooldown after status transitions to "running" from a non-running state.
  const [stabilizing, setStabilizing] = useState(false);

  // Invalidate capabilities when server transitions to running after a
  const prevStatus = useRef(serverStatus);
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = serverStatus;

    // Transitioned to running from a non-running state — wait for VPS to stabilize
    if (
      serverStatus === "running" &&
      prev &&
      prev !== "running" &&
      hostname
    ) {
      setStabilizing(true);
      if (transitionTimer.current) clearTimeout(transitionTimer.current);
      transitionTimer.current = setTimeout(() => {
        setStabilizing(false);
        queryClient.invalidateQueries({ queryKey: ["vps-capabilities", hostname] });
      }, 5000);
    }

    return () => {
      if (transitionTimer.current) clearTimeout(transitionTimer.current);
    };
  }, [serverStatus, hostname, queryClient]);

  return useQuery<VpsCapabilities | null>({
    queryKey: ["vps-capabilities", hostname],
    queryFn: async () => {
      if (!hostname) return null;

      try {
        const result = await fetchCapabilities(hostname);
        // Reset failure tracking on success
        consecutiveFailures.current = 0;
        lastSuccessAt.current = Date.now();
        return result;
      } catch (err) {
        consecutiveFailures.current++;
        throw err;
      }
    },

    // Disable fetching when VPS is in a transitional state or stabilizing after one.
    enabled: !!hostname && !stabilizing &&
      serverStatus !== "upgrading" && serverStatus !== "downgrading",

    // Once capabilities are loaded, they're stable (only change on VPS rebuild).
    staleTime: 5 * 60 * 1000,

    // Initial retry: 4 attempts with exponential backoff + jitter.
    retry: 4,
    retryDelay: (attempt) => jitter(Math.min(2000 * Math.pow(2, attempt), 15000)),

    // - Never loaded: poll at decaying interval (10s → 20s → 30s → 60s circuit breaker)
    refetchInterval: (query) => {
      // Successfully loaded — no polling needed
      if (query.state.data) return false;

      // Server is in a known transitional state — poll aggressively
      if (serverStatus === "creating" || serverStatus === "provisioning" ||
          serverStatus === "upgrading" || serverStatus === "downgrading") {
        return jitter(10_000);
      }

      // Circuit breaker: after many failures, back off to 60s
      if (consecutiveFailures.current > 6) {
        return jitter(60_000);
      }

      // Decaying poll: 10s → 15s → 20s → 30s
      const base = Math.min(10_000 + consecutiveFailures.current * 5_000, 30_000);
      return jitter(base);
    },

    // Refetch when tab becomes visible (user may have left during a resize)
    refetchOnWindowFocus: (query) => !query.state.data,

    // Don't refetch on mount if we already have data
    refetchOnMount: (query) => (query.state.data ? false : "always"),
  });
}
