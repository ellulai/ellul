// SPDX-License-Identifier: MIT
"use client";

import {
  LogOut,
  CreditCard,
  CheckCircle,
  XCircle,
  Clock,
  RefreshCw,
} from "lucide-react";
import { useTranslations, useLocale } from "next-intl";
import { EllulLogo } from "@ellul.ai/ui/ellul-logo";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { SessionExtendModal } from "@/components/dashboard/SessionExtendModal";
import { MOCK_MODE } from "@/lib/mock-data";
import type { ServerStatus, ServerSummary } from "@/contexts/DashboardContext";
import type { SessionInfo } from "@/hooks/useBrowserHeartbeat";
import type { Session } from "@/lib/auth-client";
import type { useServerMutations } from "./useServerMutations";
import { DashboardProviders } from "./DashboardProviders";
import { ResizeOverlay, VpsAuthDialog } from "./ActiveServerDialogs";
import { ServerCreation } from "./ServerCreation";
import { ProvisioningOverlay, UpgradingOverlay, WakingOverlay, HibernatingOverlay } from "./TransitionOverlays";
import { ErrorOverlay, AwaitingUnlockOverlay, PendingDeletionOverlay, FrozenOverlay } from "./StatusOverlays";

// ─── Types ────────────────────────────────────────────────────────

export interface DashboardShellProps {
  children: React.ReactNode;
  session: Session | null;
  serverStatus: ServerStatus | undefined;
  effectiveServerStatus: ServerStatus | undefined;
  effectiveIsStatusLoading: boolean;
  isStatusLoading: boolean;
  statusError: Error | null;
  allServers: Array<ServerSummary>;
  activeServerId: string | null;
  updateActiveServer: (id: string | null) => void;
  selectedTier: string;
  setSelectedTier: (tier: string) => void;
  mutations: ReturnType<typeof useServerMutations>;
  authReady: boolean;
  resizeElapsed: number;
  wakeElapsed: number;
  setAutoWakeTriggered: (v: boolean) => void;
  setWakeStartedAt: (v: number) => void;
  setWakeElapsed: (v: number) => void;
  unlockError: string | null;
  setUnlockError: (v: string | null) => void;
  isUnlocking: boolean;
  getPrfKey: () => Promise<string>;
  prfKeyRef: React.MutableRefObject<string | null>;
  unlockVolume: (params: { serverId: string; prfKey: string }) => Promise<unknown>;
  checkoutMessage: { type: "success" | "cancelled"; message: string } | null;
  setCheckoutMessage: (v: { type: "success" | "cancelled"; message: string } | null) => void;
  tierChangeError: string | null;
  setTierChangeError: (v: string | null) => void;
  awaitingPaymentConfirmation: boolean;
  setAutoProvisionTriggered: (v: boolean) => void;
  sessionInfo: SessionInfo | null;
  refreshHeartbeat: () => void;
  onRetryStatus: () => void;
}

// ─── Active Server View ──────────────────────────────────────────

function ActiveServerView({
  children,
  effectiveServerStatus,
  effectiveIsStatusLoading,
  session,
  allServers,
  activeServerId,
  updateActiveServer,
  resizeElapsed,
  mutations,
  sessionInfo,
  refreshHeartbeat,
}: {
  children: React.ReactNode;
  effectiveServerStatus: ServerStatus;
  effectiveIsStatusLoading: boolean;
  session: Session | null;
  allServers: Array<ServerSummary>;
  activeServerId: string | null;
  updateActiveServer: (id: string | null) => void;
  resizeElapsed: number;
  mutations: ReturnType<typeof useServerMutations>;
  sessionInfo: SessionInfo | null;
  refreshHeartbeat: () => void;
}) {
  const t = useTranslations("console.dashboardShell");
  const locale = useLocale();
  return (
    <DashboardProviders
      effectiveServerStatus={effectiveServerStatus}
      effectiveIsStatusLoading={effectiveIsStatusLoading}
      session={session}
      allServers={allServers}
      activeServerId={activeServerId}
      updateActiveServer={updateActiveServer}
      mutations={mutations}
    >
      {/* Cancellation Pending Banner */}
      {effectiveServerStatus.server?.subscriptionEndsAt &&
        effectiveServerStatus.state === "running" && (
          <div className="mx-4 mb-4 rounded-lg border border-sodium/30 bg-sodium/5 p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Clock className="h-5 w-5 text-sodium shrink-0" />
                <div>
                  <p className="text-sm font-medium text-sodium">{t("subscriptionEnding")}</p>
                  <p className="text-xs text-cream/60">
                    {t("willBeDeletedOn", {
                      date: new Date(
                        effectiveServerStatus.server.subscriptionEndsAt
                      ).toLocaleDateString(locale, {
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                      }),
                    })}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                onClick={mutations.handleManageSubscription}
                disabled={mutations.portalMutation.isPending}
                className="bg-sodium hover:bg-sodium shrink-0"
              >
                {mutations.portalMutation.isPending ? <Spinner size="sm" className="mr-1" /> : null}
                {t("undoCancel")}
              </Button>
            </div>
          </div>
        )}

      {/* Shield Gateway "Still there?" modal */}
      {sessionInfo?.softCapHit && effectiveServerStatus.server?.id && (
        <SessionExtendModal
          serverId={effectiveServerStatus.server.id}
          sessionInfo={sessionInfo}
          onSessionRenewed={refreshHeartbeat}
          onUpgrade={() =>
            mutations.checkoutMutation.mutate({ product: "cloud_platform", plan: "pro" })
          }
        />
      )}

      {/* Upgrading / Downgrading Overlay (within active state) */}
      <ResizeOverlay effectiveServerStatus={effectiveServerStatus} resizeElapsed={resizeElapsed} />

      {children}

      {/* VPS Authorization Dialog */}
      <VpsAuthDialog
        vpsAuthDialog={mutations.vpsAuthDialog}
        setVpsAuthDialog={mutations.setVpsAuthDialog}
        handlePasskeyConfirmation={mutations.handlePasskeyConfirmation}
        deleteServerMutation={mutations.deleteServerMutation}
        rebuildServerMutation={mutations.rebuildServerMutation}
        updateServerMutation={mutations.updateServerMutation}
        rollbackServerMutation={mutations.rollbackServerMutation}
        changeTierMutation={mutations.changeTierMutation}
        cancelDowngradeMutation={mutations.cancelDowngradeMutation}
      />

    </DashboardProviders>
  );
}

// ─── Setup Page Shell (non-active server states) ─────────────────

function SetupShell({
  children,
  session,
  serverStatus,
  isStatusLoading,
  statusError,
  checkoutMessage,
  setCheckoutMessage,
  tierChangeError,
  setTierChangeError,
  awaitingPaymentConfirmation,
  mutations,
  onRetryStatus,
}: {
  children: React.ReactNode;
  session: Session | null;
  serverStatus: ServerStatus | undefined;
  isStatusLoading: boolean;
  statusError: Error | null;
  checkoutMessage: { type: "success" | "cancelled"; message: string } | null;
  setCheckoutMessage: (v: { type: "success" | "cancelled"; message: string } | null) => void;
  tierChangeError: string | null;
  setTierChangeError: (v: string | null) => void;
  awaitingPaymentConfirmation: boolean;
  mutations: ReturnType<typeof useServerMutations>;
  onRetryStatus: () => void;
}) {
  const t = useTranslations("console.dashboardShell");
  return (
    <div className="min-h-screen text-cream p-4 sm:p-5 relative">
      {/* Header */}
      <header className="panel-ascente mb-4 sm:mb-5 relative z-10">
        <div className="flex h-14 items-center justify-between px-4">
          <span className="flex items-center gap-2 font-semibold text-cream">
            <EllulLogo className="h-6 w-6" />
            ellul
          </span>
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-cream/60 sm:inline truncate max-w-[150px]">{session?.user?.email}</span>
            {serverStatus?.hasActiveSubscription && (
              <Button variant="outline" size="sm" onClick={mutations.handleManageSubscription} disabled={mutations.portalMutation.isPending}
                className="hidden sm:flex h-8 border-border bg-cream/5 hover:bg-cream/10 text-cream/75">
                <CreditCard className="h-3.5 w-3.5 mr-1.5" /> {t("billing")}
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={mutations.handleSignOut} className="h-8 w-8 text-cream/60 hover:text-cream hover:bg-cream/10">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto w-full space-y-4 sm:space-y-5 relative z-10">
        {checkoutMessage && (
          <div className="panel-ascente p-3 sm:p-4 flex items-start sm:items-center gap-2 sm:gap-3">
            {checkoutMessage.type === "success"
              ? <CheckCircle className="h-4 w-4 sm:h-5 sm:w-5 text-sodium shrink-0" />
              : <XCircle className="h-4 w-4 sm:h-5 sm:w-5 text-sodium shrink-0" />}
            <p className="text-xs sm:text-sm text-cream flex-1">{checkoutMessage.message}</p>
            <Button variant="ghost" size="sm" className="ml-auto text-cream/60 hover:text-cream" onClick={() => setCheckoutMessage(null)}>{t("dismiss")}</Button>
          </div>
        )}
        {tierChangeError && (
          <div className="panel-ascente border-terra/30 p-3 sm:p-4 flex items-start sm:items-center gap-2 sm:gap-3">
            <XCircle className="h-4 w-4 sm:h-5 sm:w-5 text-terra shrink-0" />
            <p className="text-xs sm:text-sm text-cream flex-1">{tierChangeError}</p>
            <Button variant="ghost" size="sm" className="ml-auto text-cream/60 hover:text-cream" onClick={() => setTierChangeError(null)}>{t("dismiss")}</Button>
          </div>
        )}
        {isStatusLoading && (
          <div className="flex items-center justify-center" style={{ minHeight: "calc(100vh - 12rem)" }}>
            <Spinner size="lg" delay={300} />
          </div>
        )}
        {statusError && (
          <div className="panel-ascente py-8 text-center">
            <p className="text-terra">{t("loadStatusFailed")}</p>
            <Button variant="outline" className="mt-4" onClick={onRetryStatus}><RefreshCw className="mr-2 h-4 w-4" /> {t("retry")}</Button>
          </div>
        )}
        {awaitingPaymentConfirmation && !serverStatus?.hasActiveSubscription && (
          <div className="max-w-md mx-auto w-full">
            <div className="panel-ascente p-8 text-center">
              <div className="w-16 h-16 rounded-2xl bg-sodium/10 border border-sodium/20 flex items-center justify-center mx-auto mb-6">
                <CheckCircle className="h-8 w-8 text-sodium" />
              </div>
              <h2 className="text-lg font-semibold text-cream mb-2">{t("paymentReceived")}</h2>
              <p className="text-sm text-cream/60 mb-6">{t("confirmingSubscription")}</p>
              <Spinner size="default" />
            </div>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

// ─── Mock mode indicator ─────────────────────────────────────────

function MockModeBanner() {
  const t = useTranslations("console.dashboardShell");
  if (!MOCK_MODE) return null;
  return (
    <div className="fixed top-0 inset-x-0 z-[9999] flex items-center justify-center gap-2 bg-sodium/90 text-ink text-xs font-medium py-1 px-3 backdrop-blur-sm">
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-cream/80 animate-pulse" />
      {t("demoMode")}
    </div>
  );
}

// ─── Main exported shell ─────────────────────────────────────────

export function DashboardShell(props: DashboardShellProps) {
  const {
    children, session, serverStatus, effectiveServerStatus,
    effectiveIsStatusLoading, isStatusLoading, statusError,
    allServers, activeServerId, updateActiveServer,
    selectedTier, setSelectedTier,
    mutations, authReady, resizeElapsed,
    wakeElapsed, setAutoWakeTriggered, setWakeStartedAt, setWakeElapsed,
    unlockError, setUnlockError, isUnlocking, getPrfKey, prfKeyRef, unlockVolume,
    checkoutMessage, setCheckoutMessage, tierChangeError, setTierChangeError,
    awaitingPaymentConfirmation, setAutoProvisionTriggered,
    sessionInfo, refreshHeartbeat, onRetryStatus,
  } = props;

  // ── Active server path ──

  const isAwaitingUnlock = effectiveServerStatus?.state === "awaiting_unlock";
  const operationStep = effectiveServerStatus?.operation?.step;
  const isRunningAndReady = effectiveServerStatus?.state === "running" && (operationStep == null || operationStep === "ready");
  const isActiveOrTransitioning =
    (isRunningAndReady ||
    effectiveServerStatus?.state === "upgrading" ||
    effectiveServerStatus?.state === "downgrading") &&
    !isAwaitingUnlock;

  if (
    isActiveOrTransitioning &&
    effectiveServerStatus?.server &&
    effectiveServerStatus.server.ipAddress &&
    authReady
  ) {
    return (
      <>
        <MockModeBanner />
        <ActiveServerView
          effectiveServerStatus={effectiveServerStatus}
          effectiveIsStatusLoading={effectiveIsStatusLoading}
          session={session}
          allServers={allServers}
          activeServerId={activeServerId}
          updateActiveServer={updateActiveServer}
          resizeElapsed={resizeElapsed}
          mutations={mutations}
          sessionInfo={sessionInfo}
          refreshHeartbeat={refreshHeartbeat}
        >
          {children}
        </ActiveServerView>
      </>
    );
  }

  // ── Non-active server states ──

  return (
    <>
    <MockModeBanner />
    <SetupShell
      session={session}
      serverStatus={serverStatus}
      isStatusLoading={isStatusLoading}
      statusError={statusError}
      checkoutMessage={checkoutMessage}
      setCheckoutMessage={setCheckoutMessage}
      tierChangeError={tierChangeError}
      setTierChangeError={setTierChangeError}
      awaitingPaymentConfirmation={awaitingPaymentConfirmation}
      mutations={mutations}
      onRetryStatus={onRetryStatus}
    >
      {serverStatus?.state === "none" && (
        <div className="panel-ascente p-5 sm:p-8">
          <ServerCreation
            serverStatus={serverStatus}
            selectedTier={selectedTier}
            setSelectedTier={setSelectedTier}
            createServerMutation={mutations.createServerMutation}
            checkoutMutation={mutations.checkoutMutation}
            handleCheckout={mutations.handleCheckout}
            setAutoProvisionTriggered={setAutoProvisionTriggered}
          />
        </div>
      )}
      {serverStatus && <ProvisioningOverlay serverStatus={serverStatus} />}
      {serverStatus && <UpgradingOverlay serverStatus={serverStatus} resizeElapsed={resizeElapsed} />}
      {serverStatus && <ErrorOverlay serverStatus={serverStatus} deleteServerMutation={mutations.deleteServerMutation} />}
      {serverStatus && (
        <WakingOverlay
          serverStatus={serverStatus} wakeElapsed={wakeElapsed}
          wakeServerMutation={mutations.wakeServerMutation}
          unlockError={unlockError} setAutoWakeTriggered={setAutoWakeTriggered}
          setWakeStartedAt={setWakeStartedAt} setWakeElapsed={setWakeElapsed}
          setUnlockError={setUnlockError} prfKeyRef={prfKeyRef}
        />
      )}
      {serverStatus && <HibernatingOverlay serverStatus={serverStatus} />}
      {serverStatus && (
        <AwaitingUnlockOverlay
          serverStatus={serverStatus} isUnlocking={isUnlocking}
          unlockError={unlockError} setUnlockError={setUnlockError}
          getPrfKey={getPrfKey} prfKeyRef={prfKeyRef}
          unlockVolume={unlockVolume}
        />
      )}
      {serverStatus && <PendingDeletionOverlay serverStatus={serverStatus} handleManageSubscription={mutations.handleManageSubscription} portalMutation={mutations.portalMutation} />}
      {serverStatus && <FrozenOverlay serverStatus={serverStatus} onRefresh={onRetryStatus} />}
    </SetupShell>
    </>
  );
}
