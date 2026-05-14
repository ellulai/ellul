// SPDX-License-Identifier: MIT
"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useCodeToken } from "@/contexts/CodeTokenContext";
import { getCodeApiUrl } from "@/lib/domains";
import { MOCK_MODE, mockSandboxes, mockPreview } from "@/lib/mock-data";
import { useRealtimeSubscribe } from "@/providers/realtime-provider";
import {
  resolveSelection,
  type ApiApp,
  type ApiSandbox,
  type ApiPackage,
} from "@/contexts/AppsListContext";

// Preview status from the backend.
import type { PreviewHealthResult, OrphanReason, PreviewPhase } from "@ellul.ai/types";

export interface PreviewStatus extends Omit<PreviewHealthResult, 'error' | 'logTail'> {
  activated: boolean;
  error?: string | null;
  logTail?: string | null;
}

// Re-export the shared enums for consumers that want to narrow by phase.
export type { OrphanReason, PreviewPhase };

// Companion preview status (secondary process alongside primary).
export interface CompanionPreviewStatus extends PreviewStatus {
  pathPrefix: string;
}

export interface ContextInfo {
  hasProjectContext: boolean;
  hasGlobalContext: boolean;
}

// Response from GET /api/app/:directory — matches `ApiAppResponse`.
interface AppResponse {
  sandbox: ApiSandbox;
  app: ApiApp | null;
  selectedPackage: ApiPackage | null;
  redirectTo?: string;
  preview: PreviewStatus;
  context: ContextInfo;
}

// provisioning — request in flight, never had data
// The workspace never renders code/preview panels when state is anything
export type WorkspaceState =
  | "idle"
  | "provisioning"
  | "empty"
  | "installing"
  | "ready"
  | "error";

export interface UseCurrentAppResult {
  state: WorkspaceState;
  sandbox: ApiSandbox | null;
  app: ApiApp | null;
  selectedPackage: ApiPackage | null;
  preview: PreviewStatus | null;
  companions: CompanionPreviewStatus[];
  context: ContextInfo | null;
  redirectTo: string | null;
  isLoading: boolean;
  isActivating: boolean;
  error: string | null;
  refetch: () => void;
}

// Hook for fetching current sandbox + app data.
export function useCurrentApp(
  directory: string | null,
  serverDomain: string,
): UseCurrentAppResult {
  const { fetchWithCodeToken } = useCodeToken();
  const queryClient = useQueryClient();
  const codeApiUrl = getCodeApiUrl(serverDomain);

  const {
    data,
    isLoading,
    error,
    refetch,
  } = useQuery<AppResponse>({
    queryKey: ["current-app", directory, codeApiUrl],
    queryFn: async () => {
      if (!directory) {
        throw new Error("No app directory provided");
      }

      const res = await fetchWithCodeToken(
        `${codeApiUrl}/api/app/${encodeURIComponent(directory)}`,
        { credentials: "include" },
      );

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to load app: ${res.status}`);
      }

      return res.json();
    },
    enabled: !MOCK_MODE && !!directory && !!codeApiUrl,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    retry: (failureCount, err) => {
      if (err instanceof Error && err.message.includes("404")) return false;
      return failureCount < 2;
    },
  });

  // Guard: only return data that matches the requested directory. Accept a
  const dataMatchesRequest = (() => {
    if (!data || !directory) return false;
    if (data.sandbox.id === directory) return true;
    if (data.app?.directory === directory) return true;
    if (data.selectedPackage?.directory === directory) return true;
    // Sandbox requested, auto-resolved to an app
    if (data.sandbox.id.startsWith(directory + "/") || directory.startsWith(data.sandbox.id)) return true;
    return false;
  })();
  const validData = dataMatchesRequest ? data : null;

  const [companions, setCompanions] = useState<CompanionPreviewStatus[]>([]);

  useRealtimeSubscribe(useCallback((message) => {
    if (!directory || !codeApiUrl) return;

    // Preview lifecycle invalidation is handled centrally by
    if (message.type === "preview_all_status") {
      const allHealth = message.data as unknown as {
        primary: { app: string | null; phase: string; active: boolean; port: number; error?: string | null; logTail?: string | null; healAttempts?: number; healStatus?: string | null };
        companions: Array<{ app: string | null; phase: string; active: boolean; port: number; pathPrefix: string; error?: string | null; logTail?: string | null; healAttempts?: number; healStatus?: string | null }>;
      };
      if (!allHealth) return;

      const primary = allHealth.primary;
      if (
        primary.app === null ||
        primary.app === directory ||
        (primary.app && primary.app.startsWith(directory + '/'))
      ) {
        // by a structural-equality shortcut. Belt-and-braces: the cache
        queryClient.setQueryData<AppResponse>(
          ["current-app", directory, codeApiUrl],
          (prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              preview: {
                ...prev.preview,
                active: primary.active,
                app: primary.app,
                port: primary.port,
                phase: primary.phase as PreviewStatus["phase"],
                error: primary.error ?? prev.preview.error,
                logTail: primary.logTail ?? prev.preview.logTail,
                healAttempts: primary.healAttempts ?? prev.preview.healAttempts,
                healStatus: (primary.healStatus as PreviewStatus["healStatus"]) ?? prev.preview.healStatus,
                httpStatus: (primary as { httpStatus?: number }).httpStatus,
                orphanReason: (primary as { orphanReason?: PreviewStatus["orphanReason"] }).orphanReason,
                recoveryHint: (primary as { recoveryHint?: string }).recoveryHint,
                failReason: (primary as { failReason?: PreviewStatus["failReason"] }).failReason ?? prev.preview.failReason,
              },
            };
          },
        );
      }

      setCompanions(allHealth.companions.map(c => ({
        active: c.active,
        app: c.app,
        activated: c.active,
        port: c.port,
        phase: c.phase as PreviewStatus["phase"],
        error: c.error ?? null,
        logTail: c.logTail ?? null,
        healAttempts: c.healAttempts,
        healStatus: (c.healStatus as CompanionPreviewStatus["healStatus"]) ?? null,
        pathPrefix: c.pathPrefix,
      })));
    }
  }, [directory, codeApiUrl, queryClient]));

  if (MOCK_MODE) {
    const resolved = directory ? resolveSelection(mockSandboxes, directory) : { sandbox: null, app: null, pkg: null };

    // Mirror the real API's auto-resolve: if the user requested a bare sandbox
    let mockRedirectTo: string | null = null;
    if (directory && resolved.sandbox && !resolved.app) {
      const target = resolved.sandbox.activeApp ?? resolved.sandbox.apps[0]?.name;
      if (target) mockRedirectTo = `${resolved.sandbox.id}/${target}`;
    }

    const mockState: WorkspaceState = !directory
      ? "idle"
      : !resolved.sandbox
        ? "error"
        : resolved.app
          ? "ready"
          : mockRedirectTo
            ? "ready"
            : "empty";
    return {
      state: mockState,
      sandbox: resolved.sandbox,
      app: resolved.app,
      selectedPackage: resolved.pkg,
      preview: resolved.app ? mockPreview : null,
      companions: [],
      context: { hasProjectContext: false, hasGlobalContext: false },
      redirectTo: mockRedirectTo,
      isLoading: false,
      isActivating: false,
      error: resolved.sandbox ? null : `Sandbox for "${directory}" not found`,
      refetch: () => {},
    };
  }

  const effectivelyLoading = isLoading || (!!data && !dataMatchesRequest);
  const errorMessage = error instanceof Error ? error.message : null;

  // getPreviewHealth returns it whenever package.json exists but node_modules
  const state: WorkspaceState = !directory
    ? "idle"
    : errorMessage
      ? "error"
      : !validData
        ? "provisioning"
        : !validData.app
          ? "empty"
          : validData.preview?.phase === "installing"
            ? "installing"
            : "ready";

  return {
    state,
    sandbox: validData?.sandbox ?? null,
    app: validData?.app ?? null,
    selectedPackage: validData?.selectedPackage ?? null,
    preview: validData?.preview ?? null,
    companions,
    context: validData?.context ?? null,
    redirectTo: validData?.redirectTo ?? null,
    isLoading: effectivelyLoading,
    isActivating: isLoading && !validData,
    error: errorMessage,
    refetch,
  };
}
