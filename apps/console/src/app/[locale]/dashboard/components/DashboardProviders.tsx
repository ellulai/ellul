// SPDX-License-Identifier: MIT
"use client";

import { AppsListProvider } from "@/contexts/AppsListContext";
import { CodeTokenProvider } from "@/contexts/CodeTokenContext";
import { PermissionInboxProvider } from "@/contexts/PermissionInboxContext";
import { OperatorKeyProvider } from "@/contexts/OperatorKeyContext";

import { VpsBridgeProvider } from "@/lib/vps-bridge";
import { VpsCapabilitiesProvider } from "@/providers/VpsCapabilitiesProvider";
import { RealtimeProvider } from "@/providers/realtime-provider";
import { getCodeApiUrl } from "@/lib/domains";
import {
  DashboardContext,
  type DashboardContextValue,
  type ServerStatus,
  type ServerSummary,
} from "@/contexts/DashboardContext";
import type { Session } from "@/lib/auth-client";
import type { useServerMutations } from "./useServerMutations";
import { DebugOverlay } from "./DebugOverlay";

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
  const serverDomain = server.domain ?? `${server.ipAddress}.nip.io`;

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
      <VpsBridgeProvider hostname={serverDomain}>
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
                    <DebugOverlay />
                  </PermissionInboxProvider>
                </OperatorKeyProvider>
              </AppsListProvider>
            </RealtimeProvider>
          </VpsCapabilitiesProvider>
        </CodeTokenProvider>
      </VpsBridgeProvider>
    </DashboardContext.Provider>
  );
}
