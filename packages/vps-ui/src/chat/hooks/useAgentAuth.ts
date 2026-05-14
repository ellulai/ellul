// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { useCallback, useRef } from "react";

interface AuthResult {
  token: string;
}

interface AuthError {
  error: string;
  code: "auth_required" | "auth_failed" | "network_error";
}

// Same-origin agent auth hook.
export function useAgentAuth(t?: (key: string) => string) {
  const pendingRef = useRef<Promise<AuthResult | AuthError> | null>(null);

  const fetchToken = useCallback(async (): Promise<AuthResult | AuthError> => {
    // Deduplicate concurrent calls
    if (pendingRef.current) return pendingRef.current;

    pendingRef.current = (async () => {
      try {
        const res = await fetch("/_auth/agent/authorize", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        });

        const data = await res.json();

        if (!res.ok) {
          if (data.error === "No session" || data.reason?.includes("pop")) {
            return { error: t?.("agentAuth.authRequired") ?? "Authentication required", code: "auth_required" };
          }
          return { error: data.error ?? (t?.("agentAuth.authFailed") ?? "Authentication failed"), code: "auth_failed" };
        }

        return { token: data.token };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : (t?.("agentAuth.networkError") ?? "Network error"),
          code: "network_error",
        };
      } finally {
        pendingRef.current = null;
      }
    })();

    return pendingRef.current;
  }, [t]);

  return { fetchToken };
}
