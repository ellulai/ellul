// SPDX-License-Identifier: MIT
"use client";

import { useQuery } from "@tanstack/react-query";
import { useCodeToken } from "@/contexts/CodeTokenContext";
import { getCodeApiUrl } from "@/lib/domains";
import { MOCK_MODE } from "@/lib/mock-data";

interface OpenApiSpecResponse {
  found: boolean;
  path?: string;
  spec?: Record<string, unknown>;
  reason?: string;
  healStatus?: "healing" | "exhausted" | null;
  healAttempts?: number;
  maxHealAttempts?: number;
}

export interface UseOpenApiSpecResult {
  spec: Record<string, unknown> | null;
  specPath: string | null;
  isLoading: boolean;
  // true during background refetch (data in cache but stale) — use for subtle loading indicators
  isFetching: boolean;
  error: string | null;
  healStatus: "healing" | "exhausted" | null;
  healAttempts: number;
  maxHealAttempts: number;
  refetch: () => void;
}

export function useOpenApiSpec(
  directory: string | null,
  serverDomain: string,
  options: { enabled?: boolean } = {}
): UseOpenApiSpecResult {
  const { fetchWithCodeToken } = useCodeToken();
  const codeApiUrl = getCodeApiUrl(serverDomain);

  const { data, isLoading, isFetching, error, refetch } = useQuery<OpenApiSpecResponse>({
    queryKey: ["openapi-spec", directory, codeApiUrl],
    queryFn: async () => {
      if (!directory) throw new Error("No app directory");

      const res = await fetchWithCodeToken(
        `${codeApiUrl}/api/openapi-spec?app=${encodeURIComponent(directory)}`,
        { credentials: "include" }
      );

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.reason || `Failed to fetch spec: ${res.status}`);
      }

      return res.json();
    },
    enabled: !MOCK_MODE && !!directory && !!codeApiUrl && (options.enabled !== false),
    staleTime: 5_000,   // 5s — spec changes frequently during dev; refetch promptly after invalidation
    gcTime: 10_000,     // 10s — discard stale cache quickly so fresh data is always shown
    retry: 3,           // Retry on failure — server may be restarting after code change
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000), // 1s, 2s, 4s backoff
    // Poll faster while AI agent is working on adding the spec
    refetchInterval: (query) => {
      const d = query.state.data;
      return d?.healStatus === "healing" ? 10_000 : false;
    },
  });

  if (MOCK_MODE) {
    return {
      spec: null,
      specPath: null,
      isLoading: false,
      isFetching: false,
      error: null,
      healStatus: null,
      healAttempts: 0,
      maxHealAttempts: 2,
      refetch: () => {},
    };
  }

  return {
    spec: data?.found ? (data.spec ?? null) : null,
    specPath: data?.found ? (data.path ?? null) : null,
    isLoading,
    isFetching,
    error: error instanceof Error ? error.message : null,
    healStatus: data?.healStatus ?? null,
    healAttempts: data?.healAttempts ?? 0,
    maxHealAttempts: data?.maxHealAttempts ?? 2,
    refetch,
  };
}
