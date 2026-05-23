// SPDX-License-Identifier: MIT
"use client";

import { MobileDashboardLayout } from "@/components/dashboard/MobileDashboardLayout";
import { useDashboard } from "@/contexts/DashboardContext";

export default function DashboardOverviewPage() {
  const {
    serverStatus,
    onDeleteServer,
    isDeleting,
    onRebuildServer,
    isRebuilding,
    onRollbackServer,
    isRollingBack,
    snapshotExpiresAt,
    agentUpdate,
    onUpdateServer,
    isUpdating,
    onSetAgentUpdateMode,
    isSettingAgentUpdateMode,
    onUpgrade,
  } = useDashboard();

  // This component only renders when server is active (layout handles other states)
  if (!serverStatus?.server) {
    return null;
  }

  return (
    <MobileDashboardLayout
      server={{
        id: serverStatus.server.id,
        ipAddress: serverStatus.server.ipAddress!,
        domain: serverStatus.server.domain ?? undefined,
        state: serverStatus.state,
        performanceStatus: serverStatus.server.performanceStatus,
        size: serverStatus.server.size,
        createdAt: serverStatus.server.createdAt,
        terminalEnabled: serverStatus.server.terminalEnabled ?? true,
        sshEnabled: serverStatus.server.sshEnabled ?? false,
        preferredSession: serverStatus.server.preferredSession,
        preferredApp: serverStatus.server.preferredApp,
        securityTier: serverStatus.server.securityTier,
        product: serverStatus.server.product,
        serverPlan: serverStatus.server.serverPlan,
        volumeSecurityMode: serverStatus.server.volumeSecurityMode,
      }}
      plan={serverStatus.plan}
      deployments={serverStatus.deployments || []}
      aiQuota={serverStatus.aiQuota}
      onDeleteServer={onDeleteServer}
      isDeleting={isDeleting}
      onRebuildServer={onRebuildServer}
      isRebuilding={isRebuilding}
      onRollbackServer={onRollbackServer}
      isRollingBack={isRollingBack}
      snapshotExpiresAt={snapshotExpiresAt}
      agentUpdate={agentUpdate}
      adapterUpdates={serverStatus.adapterUpdates}
      onUpdateServer={onUpdateServer}
      isUpdating={isUpdating}
      onSetAgentUpdateMode={onSetAgentUpdateMode}
      isSettingAgentUpdateMode={isSettingAgentUpdateMode}
      onUpgrade={onUpgrade}
      view="overview"
    />
  );
}
