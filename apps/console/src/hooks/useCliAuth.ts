// SPDX-License-Identifier: MIT
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { API_URL } from "@/lib/api";

// ─── Types ──────────────────────────────────────────────

export interface AuthToolStatus {
  configured: boolean;
  path: string;
}

export interface AuthStatus {
  claude: AuthToolStatus;
  gh: AuthToolStatus;
  npm: AuthToolStatus;
}

// ─── API Helpers ────────────────────────────────────────

async function fetchAuthStatus(serverId: string): Promise<AuthStatus> {
  const res = await fetch(`${API_URL}/api/servers/${serverId}/agents/auth-status`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch auth status: ${res.status}`);
  }
  return res.json();
}

async function triggerInteractiveSetup(
  serverId: string,
  tool: string,
): Promise<{ success: boolean; output: string; exitCode: number }> {
  const res = await fetch(
    `${API_URL}/api/servers/${serverId}/agents/interactive-setup`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool }),
    },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Setup failed: ${res.status}`);
  }
  return res.json();
}

// ─── Hooks ──────────────────────────────────────────────

// Hook for fetching CLI auth status (shared across all agents on a server).
export function useAuthStatus(serverId: string) {
  return useQuery({
    queryKey: ["auth-status", serverId],
    queryFn: () => fetchAuthStatus(serverId),
    enabled: !!serverId,
    staleTime: 60_000,
  });
}

// Hook for triggering interactive CLI setup (e.g. `claude login`, `gh auth login`).
export function useInteractiveSetup(serverId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tool: string) =>
      triggerInteractiveSetup(serverId, tool),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["auth-status", serverId] }),
  });
}
