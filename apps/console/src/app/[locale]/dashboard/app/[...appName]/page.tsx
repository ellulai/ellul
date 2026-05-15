// SPDX-License-Identifier: MIT
"use client";

import { use, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { MobileDashboardLayout } from "@/components/dashboard/MobileDashboardLayout";
import { AuthWall } from "@/components/dashboard/AuthWall";
import { LoadingScreen } from "@/components/ui/spinner";
import { useDashboard } from "@/contexts/DashboardContext";
import { WorkbenchProvider, useWorkbench } from "@/contexts/WorkbenchContext";
import { useCurrentApp } from "@/hooks/useCurrentApp";
import { useEnsurePreviewActive } from "@/hooks/useEnsurePreviewActive";
import { useOfflineCache } from "@/hooks/useOfflineCache";
import { OnboardingFlow } from "@/components/dashboard/OnboardingFlow";

// Transparent wrapper that auto-caches WorkbenchContext messages to localStorage.
function OfflineCacheBridge({ children }: { children: ReactNode }) {
  const { activeThreadId, messages } = useWorkbench();
  const { getCachedMessages, removeCachedThread } = useOfflineCache({ activeThreadId, messages });
  void getCachedMessages;
  void removeCachedThread;
  return <>{children}</>;
}

// Catch-all app route.
interface AppPageProps {
  params: Promise<{ appName: string[] }>;
}

export default function DashboardAppPage({ params }: AppPageProps) {
  const { appName } = use(params);
  const directory = Array.isArray(appName) ? appName.join("/") : (appName as unknown as string);
  const router = useRouter();
  const t = useTranslations("console.app");

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

  const serverDomain = serverStatus?.server?.domain ??
    (serverStatus?.server?.ipAddress
      ? `${serverStatus.server.ipAddress.replace(/\./g, "-")}.sslip.io`
      : "");

  const {
    state,
    sandbox,
    app,
    selectedPackage,
    preview,
    companions,
    redirectTo,
    isLoading: isAppLoading,
    error: appError,
    refetch: retryApp,
  } = useCurrentApp(directory, serverDomain);

  // Activation lives client-side: see useEnsurePreviewActive for why the
  useEnsurePreviewActive(app, selectedPackage, serverDomain);

  if (!serverStatus?.server) {
    return null;
  }

  if (isAppLoading) {
    return <LoadingScreen message={`Loading ${directory}...`} />;
  }

  const isAuthError = appError && (
    appError.includes("Authentication") ||
    appError.includes("authenticate") ||
    appError.includes("401") ||
    appError.includes("Session") ||
    appError.includes("session")
  );

  if (isAuthError) {
    return (
      <div className="relative h-screen bg-card">
        <AuthWall
          show={true}
          message="Your session has expired. Please authenticate to continue."
          onReauthenticated={() => retryApp()}
        />
      </div>
    );
  }

  // Sandbox not found — the URL is stale (server rebuilt, sandbox deleted,
  if (appError || !sandbox) {
    router.replace("/dashboard");
    return <LoadingScreen message={t("redirecting")} />;
  }

  // Backend auto-resolved a sandbox URL to its single nested app. Sync the
  if (redirectTo && redirectTo !== directory) {
    router.replace(`/dashboard/app/${redirectTo.split("/").map(encodeURIComponent).join("/")}`);
    return <LoadingScreen message={t("switchingApps")} />;
  }

  // are never surfaced through the code view.
  if (state === "empty") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-card">
        <div className="w-full max-w-lg">
          <OnboardingFlow
            serverId={serverStatus.server.id}
            serverDomain={serverDomain}
            securityTier={serverStatus.server.securityTier}
            product={serverStatus.server.product}
            onComplete={(targetDirectory) => {
              router.replace(
                `/dashboard/app/${targetDirectory.split("/").map(encodeURIComponent).join("/")}`,
              );
            }}
          />
        </div>
      </div>
    );
  }

  // IMPORTANT: key by the **sandbox slug**, not the full directory. When the
  const sandboxKey = sandbox.id;

  return (
    <WorkbenchProvider key={sandboxKey}>
      <OfflineCacheBridge>
      <MobileDashboardLayout
        key={sandboxKey}
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
        onUpdateServer={onUpdateServer}
        isUpdating={isUpdating}
        onSetAgentUpdateMode={onSetAgentUpdateMode}
        isSettingAgentUpdateMode={isSettingAgentUpdateMode}
        onUpgrade={onUpgrade}
        view="app"
        appDirectory={directory}
        app={app}
        preview={preview}
        companions={companions}
        onRetryApp={retryApp}
      />
      </OfflineCacheBridge>
    </WorkbenchProvider>
  );
}
