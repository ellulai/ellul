// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { AppsListProvider } from "@/contexts/AppsListContext";
import { CodeTokenProvider } from "@/contexts/CodeTokenContext";
import { PermissionInboxProvider } from "@/contexts/PermissionInboxContext";
import { OperatorKeyProvider } from "@/contexts/OperatorKeyContext";

import { VpsBridgeProvider, useVpsBridge } from "@/lib/vps-bridge";
import { VpsCapabilitiesProvider } from "@/providers/VpsCapabilitiesProvider";
import { RealtimeProvider } from "@/providers/realtime-provider";
import { getCodeApiUrl, isLocalServer, resolveServerDomain } from "@/lib/domains";
import { isTauriApp } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DashboardContext,
  type DashboardContextValue,
  type ServerStatus,
  type ServerSummary,
} from "@/contexts/DashboardContext";
import type { Session } from "@/lib/auth-client";
import type { useServerMutations } from "./useServerMutations";

interface DashboardProvidersProps {
  children: React.ReactNode;
  effectiveServerStatus: ServerStatus;
  effectiveIsStatusLoading: boolean;
  session: Session | null;
  allServers: Array<ServerSummary>;
  activeServerId: string | null;
  updateActiveServer: (id: string | null) => void;
  mutations: ReturnType<typeof useServerMutations>;
}

function TauriReauthWall({ hostname, children }: { hostname: string; children: React.ReactNode }) {
  const { needsVpsAuth, authenticateNative } = useVpsBridge();
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  if (!isTauriApp() || !needsVpsAuth) return <>{children}</>;

  const handlePasskeyLogin = async () => {
    setIsAuthenticating(true);
    setAuthError(null);
    try {
      await authenticateNative();
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsAuthenticating(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center max-w-sm p-8">
        <div className="w-16 h-16 rounded-2xl bg-sodium/10 border border-sodium/20 flex items-center justify-center mx-auto mb-6">
          <svg className="h-8 w-8 text-sodium" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-cream mb-2">Session expired</h2>
        <p className="text-sm text-cream/60 mb-8">
          Re-authenticate with your passkey to continue using {hostname}.
        </p>
        <Button
          onClick={handlePasskeyLogin}
          disabled={isAuthenticating}
          className="w-full bg-sodium hover:bg-sodium/90 text-ink font-medium"
          size="lg"
        >
          {isAuthenticating ? "Authenticating..." : "Login with Passkey"}
        </Button>
        {authError && (
          <p className="mt-4 text-xs text-red-400">{authError}</p>
        )}
      </div>
    </div>
  );
}

// Wraps the active-server view with all provider layers:
export function DashboardProviders({
  children,
  effectiveServerStatus,
  effectiveIsStatusLoading,
  session,
  allServers,
  activeServerId,
  updateActiveServer,
  mutations,
}: DashboardProvidersProps) {
  const server = effectiveServerStatus.server!;
  const isLocal = isLocalServer(server);
  const serverDomain = resolveServerDomain(server);

  const dashboardContext: DashboardContextValue = {
    serverStatus: effectiveServerStatus,
    isStatusLoading: effectiveIsStatusLoading,
    session,
    allServers,
    activeServerId,
    updateActiveServer,
    onDeleteServer: mutations.handleDeleteServer,
    isDeleting: mutations.deleteServerMutation.isPending,
    onRebuildServer: mutations.handleRebuildServer,
    isRebuilding: mutations.rebuildServerMutation.isPending,
    onRollbackServer: effectiveServerStatus.snapshot?.available
      ? mutations.handleRollbackServer
      : undefined,
    isRollingBack: mutations.rollbackServerMutation.isPending,
    snapshotExpiresAt: effectiveServerStatus.snapshot?.expiresAt,
    // Agent manifest self-update. The "Update Now" button is surfaced
    agentUpdate: effectiveServerStatus.agentUpdate ?? null,
    onUpdateServer:
      effectiveServerStatus.agentUpdate?.pendingUpdateVersion != null
        ? mutations.handleUpdateServer
        : undefined,
    isUpdating: mutations.updateServerMutation.isPending,
    onSetAgentUpdateMode: mutations.handleSetAgentUpdateMode,
    isSettingAgentUpdateMode: mutations.setAgentUpdateModeMutation.isPending,
    onChangeTier: mutations.handleChangeTier,
    isChangingTier: mutations.changeTierMutation.isPending,
    changeTierError: mutations.changeTierMutation.error,
    changeTierData: mutations.changeTierMutation.data ?? null,
    resetChangeTier: () => mutations.changeTierMutation.reset(),
    onCancelDowngrade: mutations.handleCancelDowngrade,
    isCancellingDowngrade: mutations.cancelDowngradeMutation.isPending,
    onUpgrade: () =>
      mutations.checkoutMutation.mutate({
        product: "cloud_platform",
        plan: "pro",
      }),
  };

  return (
    <DashboardContext.Provider value={dashboardContext}>
      <VpsBridgeProvider hostname={serverDomain} securityTier={server.securityTier}>
        <TauriReauthWall hostname={serverDomain}>
          <CodeTokenProvider
            securityTier={server.securityTier}
            codeApiUrl={getCodeApiUrl(serverDomain)}
            serverId={server.id}
            srvUrl={`https://${serverDomain}`}
          >
            <VpsCapabilitiesProvider hostname={serverDomain} serverStatus={effectiveServerStatus.state}>
              <RealtimeProvider
                serverDomain={serverDomain}
                securityTier={server.securityTier}
                enabled={true}
              >
                <AppsListProvider
                  serverDomain={serverDomain}
                  securityTier={server.securityTier}
                  serverStatus={effectiveServerStatus.state}
                >
                  <OperatorKeyProvider serverDomain={serverDomain} securityTier={server.securityTier}>
                    <PermissionInboxProvider serverDomain={serverDomain}>
                      {children}
                    </PermissionInboxProvider>
                  </OperatorKeyProvider>
                </AppsListProvider>
              </RealtimeProvider>
            </VpsCapabilitiesProvider>
          </CodeTokenProvider>
        </TauriReauthWall>
      </VpsBridgeProvider>
    </DashboardContext.Provider>
  );
}
