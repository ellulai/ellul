// SPDX-License-Identifier: MIT
"use client";

import {
  RefreshCw,
  Rocket,
  Shield,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { EllulLogo } from "@ellul.ai/ui/ellul-logo";
import { ShieldSetupFlow } from "@/components/dashboard/ShieldSetupFlow";
import type { ServerStatus } from "@/contexts/DashboardContext";
import type { UseMutationResult } from "@tanstack/react-query";

// ── Provisioning / Shield CLI ────────────────────────────────────

interface ProvisioningOverlayProps {
  serverStatus: ServerStatus;
}

// SSE step ids that the API/enforcer emits. Translate via console.serverStatus.stepLabels.*
// We re-derive the displayed label from the step id rather than trusting
// serverStatus.operation.label, which on the initial /api/servers/status
// fetch comes back baked in English from the API server.
const STEP_LABEL_KEY: Record<string, "starting_dots" | "writing_files" | "packages_dots" | "nodejs_dots" | "devtools" | "opencode_dots" | "configuring_dots" | "services" | "ready" | "settingUp"> = {
  starting: "starting_dots",
  writing_files: "writing_files",
  packages: "packages_dots",
  nodejs: "nodejs_dots",
  devtools: "devtools",
  opencode: "opencode_dots",
  configuring: "configuring_dots",
  services: "services",
  ready: "ready",
};

function useLocalizedStepLabel(): (step: string | null | undefined) => string {
  const tStep = useTranslations("console.serverStatus.stepLabels");
  return (step) => {
    if (step) {
      const key = STEP_LABEL_KEY[step];
      if (key) return tStep(key);
      return tStep("settingUp");
    }
    return tStep("starting_dots");
  };
}

export function ProvisioningOverlay({ serverStatus }: ProvisioningOverlayProps) {
  const t = useTranslations("console.transitions.provisioning");
  const localizedStepLabel = useLocalizedStepLabel();
  const isProvisioningState = serverStatus.state === "provisioning" || serverStatus.state === "creating";
  const isRunningState = serverStatus.state === "running";
  const isShieldProduct = serverStatus.server?.product === "shield_proxy";
  const hasCliCallback = typeof window !== "undefined" && !!localStorage.getItem("ps_cli_callback_port");
  const isShieldCliFlow = isShieldProduct && hasCliCallback;

  // Keep overlay visible when state transitioned to "running" but post-claim
  // work hasn't finished — prevents the UI from rendering before the volume
  // is mounted and services are configured (pool-claimed servers).
  const operationNotReady = serverStatus.operation?.step != null && serverStatus.operation.step !== "ready";
  const isRunningButNotReady = isRunningState && (!serverStatus.server?.ipAddress || operationNotReady);

  const stepLabel = localizedStepLabel(serverStatus.operation?.step ?? null);

  if (isShieldCliFlow && (isProvisioningState || isRunningState)) {
    return (
      <ShieldSetupFlow
        operationLabel={stepLabel}
        isReady={isRunningState}
        serverDomain={serverStatus.server?.domain ?? null}
        setupToken={serverStatus.server?.setupToken ?? null}
      />
    );
  }

  if (isProvisioningState || isRunningButNotReady) {
    return (
      <div className="fixed inset-0 flex items-center justify-center z-10 bg-background/95 backdrop-blur-sm p-4">
        <div className="max-w-lg w-full">
          <div className="panel-ascente p-6 sm:p-10">
            <div className="flex items-center justify-center py-6">
              <div className="relative">
                <div className="w-20 h-20 rounded-full border-4 border-sodium/20" />
                <div className="absolute inset-0 w-20 h-20 rounded-full border-4 border-sodium border-t-transparent animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <EllulLogo className="h-7 w-7 text-sodium" />
                </div>
              </div>
            </div>
            <h2 className="mb-3 text-2xl font-semibold text-center text-cream">
              {t("title")}
            </h2>
            {stepLabel ? (
              <p className="text-center text-sodium text-sm font-medium mb-2">
                {stepLabel}
              </p>
            ) : null}
            <p className="text-center text-cream/60 text-sm">
              {t("wait")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

// ── Upgrading (free -> paid) ─────────────────────────────────────

interface UpgradingOverlayProps {
  serverStatus: ServerStatus;
  resizeElapsed: number;
}

export function UpgradingOverlay({ serverStatus, resizeElapsed }: UpgradingOverlayProps) {
  const t = useTranslations("console.transitions.upgrade");
  if (serverStatus.state !== "upgrading") return null;

  const targetTier = serverStatus.server?.tierTransitionTarget;

  const tierNameKey = (id: string | null | undefined): "hobby" | "pro" | "shieldPro" | null => {
    if (id === "cloud_platform:hobby") return "hobby";
    if (id === "cloud_platform:pro") return "pro";
    if (id === "shield_proxy:pro") return "shieldPro";
    return null;
  };
  const tierKey = tierNameKey(targetTier);
  const targetName = tierKey ? t(`tierName.${tierKey}` as "tierName.hobby") : (targetTier ?? t("fallbackTier"));
  const capacity = tierKey ? t(`tierCapacity.${tierKey}` as "tierCapacity.hobby") : null;

  const progressPercent =
    resizeElapsed < 60
      ? Math.min(Math.round((resizeElapsed / 60) * 70), 70)
      : Math.min(70 + Math.round(((resizeElapsed - 60) / 840) * 25), 95);

  const getUpgradeStep = (): { label: string; detail: string } => {
    if (resizeElapsed < 5) return { label: t("step.preparing"), detail: t("step.preparingDetail") };
    if (resizeElapsed < 15) return { label: t("step.allocating"), detail: t("step.allocatingDetail") };
    if (resizeElapsed < 35) return { label: t("step.storage"), detail: t("step.storageDetail") };
    if (resizeElapsed < 90) return { label: t("step.transfer"), detail: t("step.transferDetail") };
    if (resizeElapsed < 180) return { label: t("step.configuring"), detail: t("step.configuringDetail") };
    if (resizeElapsed < 600) return { label: t("step.provisioning"), detail: t("step.provisioningDetail") };
    return { label: t("step.finalizing"), detail: t("step.finalizingDetail") };
  };
  const step = getUpgradeStep();

  return (
    <div className="fixed inset-0 flex items-center justify-center z-10 bg-background/95 backdrop-blur-sm p-4">
      <div className="max-w-lg w-full">
        <div className="panel-ascente p-6 sm:p-10">
          <div className="flex items-center justify-center py-6">
            <div className="relative">
              <svg className="w-24 h-24" viewBox="0 0 96 96">
                <circle cx="48" cy="48" r="42" fill="none" stroke="hsl(24, 95%, 53%)" strokeOpacity="0.15" strokeWidth="4" />
                <circle
                  cx="48" cy="48" r="42" fill="none"
                  stroke="url(#upgrade-gradient)" strokeWidth="4" strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 42}`}
                  strokeDashoffset={`${2 * Math.PI * 42 * (1 - progressPercent / 100)}`}
                  transform="rotate(-90 48 48)"
                  className="transition-all duration-1000 ease-out"
                />
                <defs>
                  <linearGradient id="upgrade-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="hsl(24, 95%, 53%)" />
                    <stop offset="100%" stopColor="#F4B873" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <Rocket className="h-8 w-8 text-sodium animate-pulse" />
              </div>
            </div>
          </div>

          <h2 className="mb-2 text-2xl font-semibold text-center text-cream">{t("title")}</h2>

          {targetTier && (
            <div className="flex items-center justify-center gap-2 mb-4">
              <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-cream/5 border border-cream/10 text-cream/60">{t("freeBadge")}</span>
              <svg className="w-4 h-4 text-sodium" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 8h10M9 4l4 4-4 4" />
              </svg>
              <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-sodium/10 border border-sodium/30 text-sodium">{targetName}</span>
            </div>
          )}

          <p className="text-center text-sodium text-sm font-medium mb-0.5">{step.label}</p>
          <p className="text-center text-cream/45 text-xs mb-3">{step.detail}</p>

          <div className="max-w-xs mx-auto mb-4">
            <div className="w-full h-1.5 bg-cream/5 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-sodium transition-all duration-1000 ease-out" style={{ width: `${progressPercent}%` }} />
            </div>
          </div>

          <p className="text-center text-cream/45 text-xs mb-6">
            {resizeElapsed > 0 && `${resizeElapsed}s ${t("elapsedSuffix")}`}
            {resizeElapsed >= 900 && <span className="text-cream/35"> · {t("longerThanExpected")}</span>}
          </p>

          {capacity && (
            <div className="rounded-xl border border-sodium/10 bg-sodium/[0.03] p-4 mb-4">
              <p className="text-[11px] font-medium text-cream/45 uppercase tracking-wider mb-2 text-center">{t("newPlanLabel")}</p>
              <p className="text-sm font-semibold text-cream text-center">{capacity}</p>
            </div>
          )}

          <div className="flex items-center justify-center gap-2 text-[11px] text-cream/45">
            <Shield className="h-3.5 w-3.5 text-sodium/60" />
            <span>{t("preserved")}</span>
          </div>

          {resizeElapsed > 900 && (
            <div className="mt-6 text-center">
              <Button variant="outline" size="sm" className="border-cream/[0.08] text-cream/75" onClick={() => window.location.reload()}>
                <RefreshCw className="mr-2 h-3 w-3" />
                {t("refreshPage")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Waking / Hibernated ──────────────────────────────────────────

interface WakingOverlayProps {
  serverStatus: ServerStatus;
  wakeElapsed: number;
  wakeServerMutation: UseMutationResult<unknown, Error, void>;
  unlockError: string | null;
  setAutoWakeTriggered: (v: boolean) => void;
  setWakeStartedAt: (v: number) => void;
  setWakeElapsed: (v: number) => void;
  setUnlockError: (v: string | null) => void;
  prfKeyRef: React.MutableRefObject<string | null>;
}

export function WakingOverlay({
  serverStatus, wakeElapsed, wakeServerMutation, unlockError,
  setAutoWakeTriggered, setWakeStartedAt, setWakeElapsed, setUnlockError, prfKeyRef,
}: WakingOverlayProps) {
  const t = useTranslations("console.transitions.wake");
  if (serverStatus.state !== "hibernated" && serverStatus.state !== "waking") return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center z-10 bg-background/95 backdrop-blur-sm p-4">
      <div className="max-w-lg w-full">
        <div className="panel-ascente p-6 sm:p-10">
          <div className="flex items-center justify-center py-6">
            <div className="relative">
              <div className="w-20 h-20 rounded-full border-4 border-sodium/20" />
              <div className="absolute inset-0 w-20 h-20 rounded-full border-4 border-sodium border-t-transparent animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center">
                <EllulLogo className="h-7 w-7 text-sodium" />
              </div>
            </div>
          </div>
          <h2 className="mb-3 text-2xl font-semibold text-center text-cream">
            {wakeElapsed > 60 ? t("titleSetup") : t("titleWaking")}
          </h2>
          <p className="text-center text-sodium text-sm font-medium mb-2">
            {serverStatus.state === "waking" || wakeServerMutation.isPending
              ? wakeElapsed > 60 ? t("provisioning") : t("restoring")
              : wakeServerMutation.error ? t("wakeFailed")
              : unlockError ? t("passkeyFailed")
              : t("preparing")}
          </p>
          <p className="text-center text-cream/60 text-sm mb-6">
            {wakeElapsed > 120 ? t("coldProvisioning")
              : wakeElapsed > 60 ? t("settingUpFresh")
              : wakeElapsed > 30 ? t("takingMoment")
              : wakeElapsed > 0 ? `${wakeElapsed}s ${t("elapsedSuffix")}`
              : serverStatus.server?.volumeSecurityMode === "sovereign" ? t("tapPasskey")
              : t("usuallyFew")}
          </p>

          {(wakeServerMutation.error || unlockError) ? (
            <div className="mt-2 p-3 rounded-lg bg-terra/10 border border-terra/20 text-center">
              <p className="text-sm text-terra mb-3">{wakeServerMutation.error?.message || unlockError}</p>
              <Button variant="outline" size="sm" className="border-terra/30 text-terra" onClick={() => {
                setAutoWakeTriggered(false);
                setWakeStartedAt(Date.now());
                setWakeElapsed(0);
                setUnlockError(null);
                prfKeyRef.current = null;
                wakeServerMutation.mutate();
              }}>
                {t("retry")}
              </Button>
            </div>
          ) : wakeElapsed > 15 ? (
            <div className="text-center">
              <Button variant="outline" size="sm" className="border-cream/[0.08] text-cream/75" onClick={() => window.location.reload()}>
                <RefreshCw className="mr-2 h-3 w-3" />
                {t("refreshPage")}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Hibernating ──────────────────────────────────────────────────

interface HibernatingOverlayProps {
  serverStatus: ServerStatus;
}

export function HibernatingOverlay({ serverStatus }: HibernatingOverlayProps) {
  const t = useTranslations("console.transitions.hibernate");
  const localizedStepLabel = useLocalizedStepLabel();
  if (serverStatus.state !== "hibernating") return null;

  const stepLabel = localizedStepLabel(serverStatus.operation?.step ?? null);

  return (
    <div className="fixed inset-0 flex items-center justify-center z-10 bg-background/95 backdrop-blur-sm p-4">
      <div className="max-w-lg w-full">
        <div className="panel-ascente p-6 sm:p-10">
          <div className="flex items-center justify-center py-6">
            <div className="relative">
              <div className="w-20 h-20 rounded-full border-4 border-blue-500/20" />
              <div className="absolute inset-0 w-20 h-20 rounded-full border-4 border-blue-500 border-t-transparent animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center">
                <EllulLogo className="h-7 w-7 text-blue-500" />
              </div>
            </div>
          </div>
          <h2 className="mb-3 text-2xl font-semibold text-center text-cream">{t("title")}</h2>
          <p className="text-center text-blue-400 text-sm font-medium mb-2">
            {stepLabel || t("saving")}
          </p>
          <p className="text-center text-cream/60 text-sm mb-6">
            {t("subtitle")}
          </p>
        </div>
      </div>
    </div>
  );
}
