// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowUpCircle,
  ShieldCheck,
  AlertTriangle,
  Info,
  CheckCircle2,
  Loader2,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ServerStatus } from "@/contexts/DashboardContext";

type AgentUpdate = NonNullable<ServerStatus["agentUpdate"]>;

interface AgentUpdateBannerProps {
  agentUpdate: AgentUpdate;
  onUpdateServer?: () => void;
  isUpdating?: boolean;
  // Toggle between Auto and Manual update modes. Passkey-gated on web_locked.
  onSetMode?: (mode: "auto" | "manual") => void;
  isSettingMode?: boolean;
  // Destructive actions are disabled while the server is provisioning/waking/etc.
  isOperationActive?: boolean;
}

// The banner never renders a write toggle for Auto/Manual mode —
export function AgentUpdateBanner({
  agentUpdate,
  onUpdateServer,
  isUpdating,
  onSetMode,
  isSettingMode,
  isOperationActive,
}: AgentUpdateBannerProps) {
  const t = useTranslations("console.agentUpdateBanner");
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [showModeDialog, setShowModeDialog] = useState<"auto" | "manual" | null>(null);

  const {
    appliedManifestVersion,
    latestManifestVersion,
    installedEnforcerVersion,
    latestEnforcerVersion,
    pendingUpdateVersion,
    autoUpdateEffective,
    healthStatus,
    lastInstallOutcome,
    lastInstallError,
    liveness,
    applyInProgress,
    applyInProgressVersion,
  } = agentUpdate;

  // Survives page refresh / tab switch / SSE blip because it's read
  const isApplying = applyInProgress === true;

  const hasPending =
    !isApplying && pendingUpdateVersion != null && onUpdateServer != null;
  const hasFailed =
    lastInstallOutcome === "failed" || lastInstallOutcome === "partial";
  const wasRolledBack = lastInstallOutcome === "rolled_back";
  const isCurrent =
    appliedManifestVersion != null &&
    latestManifestVersion != null &&
    appliedManifestVersion === latestManifestVersion &&
    lastInstallOutcome === "success";
  // "Never reported" is only true when the VPS has literally never
  // or "up to date" (once an install report follows), but NEVER to
  const hasNeverPinged = liveness === "unknown";
  // VPS has pinged (we know it's alive) but hasn't reported a manifest
  const isOnlinePreApply =
    !hasNeverPinged &&
    appliedManifestVersion == null &&
    pendingUpdateVersion == null &&
    !hasFailed &&
    !wasRolledBack;

  const modeBadge = <ModeBadge autoUpdateEffective={autoUpdateEffective} />;

  const handleModeChange = (mode: "auto" | "manual") => {
    setShowModeDialog(mode);
  };

  const modeToggleRow = (
    <ModeToggleRow
      autoUpdateEffective={autoUpdateEffective}
      onRequestToggle={onSetMode ? handleModeChange : undefined}
      isBusy={isSettingMode}
    />
  );

  // Mode-switch confirmation dialog — rendered alongside every banner
  const modeDialog = (
    <Dialog open={showModeDialog !== null} onOpenChange={(open) => !open && setShowModeDialog(null)}>
      <DialogContent className="bg-card border-border text-cream">
        <DialogHeader>
          <DialogTitle
            className={showModeDialog === "auto" ? "text-sodium" : "text-blue-300"}
          >
            {showModeDialog === "auto" ? t("modeSwitchAuto") : t("modeSwitchManual")}
          </DialogTitle>
          <DialogDescription className="text-cream/60">
            {showModeDialog === "auto"
              ? t("modeAutoDescription")
              : t("modeManualDescription")}
          </DialogDescription>
        </DialogHeader>
        <div
          className={`rounded-lg border p-3 my-2 ${
            showModeDialog === "auto"
              ? "border-sodium/20 bg-sodium/[0.05]"
              : "border-blue-500/20 bg-blue-500/[0.05]"
          }`}
        >
          <p className="text-xs text-cream/75">
            {showModeDialog === "auto" ? t("securityNoteAuto") : t("headsUpManual")}
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            onClick={() => setShowModeDialog(null)}
            className="text-cream/60 hover:text-cream"
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={() => {
              if (showModeDialog && onSetMode) {
                onSetMode(showModeDialog);
              }
              setShowModeDialog(null);
            }}
            disabled={isSettingMode || !onSetMode}
            className={
              showModeDialog === "auto"
                ? "bg-sodium hover:bg-sodium"
                : "bg-blue-600 hover:bg-blue-500"
            }
          >
            {isSettingMode ? (
              <>
                <Spinner size="sm" delay={300} className="mr-2" />
                {t("switching")}
              </>
            ) : (
              <>
                <ShieldCheck className="h-4 w-4 mr-2" aria-hidden="true" />
                {showModeDialog === "auto" ? t("enableAuto") : t("enableManual")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Wrap each banner state with the shared mode-switch dialog.
  const withDialog = (banner: React.ReactNode) => (
    <>
      {banner}
      {modeDialog}
    </>
  );

  // ── State 0: apply in progress (highest priority) ─────────────────
  // the user clicked Update Now (or manual-mode auto-apply raced in)
  if (isApplying) {
    const targetLabel =
      applyInProgressVersion != null ? `v${applyInProgressVersion}` : t("applyTargetFallback");
    return withDialog(
      <div
        role="status"
        aria-busy="true"
        aria-label={t("ariaApplyInProgress")}
        className="rounded-xl border border-blue-500/20 bg-blue-500/[0.04]"
      >
        <div className="px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0 mt-0.5">
              <Loader2
                className="h-4 w-4 text-blue-400 animate-spin"
                aria-hidden="true"
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-medium text-cream">
                  {t("applyTitle")}
                </h3>
                <LivenessPill liveness={liveness} />
                {modeBadge}
              </div>
              <p className="text-xs text-cream/60 mt-0.5">
                {t("applyDescription", { target: targetLabel })}
              </p>
              {installedEnforcerVersion && applyInProgressVersion != null && (
                <p className="text-[11px] text-cream/45 mt-1.5 font-mono">
                  enforcer {installedEnforcerVersion}
                  <span className="mx-1.5 text-cream/35">→</span>
                  manifest v{applyInProgressVersion}
                </p>
              )}
              {/*
                Mode toggle is rendered but disabled mid-apply — toggling
                the auto/manual flag during an in-flight apply is a recipe
                for confusing state. Defer until the command completes.
              */}
              <ModeToggleRow
                autoUpdateEffective={autoUpdateEffective}
                onRequestToggle={undefined}
                isBusy
              />
            </div>
          </div>
        </div>
      </div>,
    );
  }

  // ── State 1: pending update, Manual mode (the main action) ─────────
  if (hasPending) {
    return withDialog(
      <>
        <div
          role="region"
          aria-label={t("ariaPendingUpdate")}
          className="rounded-xl border border-sodium/20 bg-sodium/[0.04]"
        >
          <div className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-sodium/10 flex items-center justify-center shrink-0 mt-0.5">
                  <ArrowUpCircle
                    className="h-4 w-4 text-sodium"
                    aria-hidden="true"
                  />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-medium text-cream">
                      {t("pendingTitle")}
                    </h3>
                    {modeBadge}
                  </div>
                  <p className="text-xs text-cream/60 mt-0.5">
                    {t("pendingDescription", { version: String(pendingUpdateVersion ?? "") })}
                  </p>
                  {(installedEnforcerVersion || latestEnforcerVersion) && (
                    <p className="text-[11px] text-cream/45 mt-1.5 font-mono">
                      {installedEnforcerVersion ?? "unknown"}
                      <span className="mx-1.5 text-cream/35">→</span>
                      {latestEnforcerVersion ?? "?"}
                    </p>
                  )}
                </div>
              </div>
              <Button
                size="sm"
                className="bg-sodium hover:bg-sodium text-ink text-xs shrink-0"
                onClick={() => setShowConfirmDialog(true)}
                disabled={isUpdating || isOperationActive}
                aria-label={t("ariaApplyPending", { version: String(pendingUpdateVersion ?? "") })}
              >
                {isUpdating ? (
                  <>
                    <Spinner size="sm" delay={300} className="mr-2" />
                    {t("applying")}
                  </>
                ) : (
                  t("updateNow")
                )}
              </Button>
            </div>
            {modeToggleRow}
          </div>
        </div>

        <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
          <DialogContent className="bg-card border-border text-cream">
            <DialogHeader>
              <DialogTitle className="text-sodium">
                {t("applyDialogTitle")}
              </DialogTitle>
              <DialogDescription className="text-cream/60">
                {t("applyDialogDescription", { version: String(pendingUpdateVersion ?? "") })}
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-sodium/20 bg-sodium/5 p-3 my-2 space-y-2">
              <p className="text-xs text-sodium">
                {t("applyWhatHappens")}
              </p>
              <p className="text-xs text-sodium">
                {t("applyIfBreaks")}
              </p>
            </div>
            <DialogFooter className="gap-2">
              <Button
                variant="ghost"
                onClick={() => setShowConfirmDialog(false)}
                className="text-cream/60 hover:text-cream"
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={() => {
                  onUpdateServer?.();
                  setShowConfirmDialog(false);
                }}
                disabled={isUpdating}
                className="bg-sodium hover:bg-sodium"
              >
                {isUpdating ? (
                  <>
                    <Spinner size="sm" delay={300} className="mr-2" />
                    {t("applying")}
                  </>
                ) : (
                  <>
                    <ArrowUpCircle className="h-4 w-4 mr-2" />
                    {t("applyUpdate")}
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>,
    );
  }

  // ── State 2: last install failed (Auto or Manual) ─────────────────
  if (hasFailed) {
    return withDialog(
      <div
        role="alert"
        className="rounded-xl border border-terra/20 bg-terra/[0.04]"
      >
        <div className="px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-terra/10 flex items-center justify-center shrink-0 mt-0.5">
              <AlertTriangle
                className="h-4 w-4 text-terra"
                aria-hidden="true"
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-medium text-terra">
                  {t("lastFailedTitle")}
                </h3>
                {modeBadge}
              </div>
              <p className="text-xs text-cream/60 mt-0.5">
                {lastInstallOutcome === "partial"
                  ? t("lastFailedPartial")
                  : t("lastFailedFull")}
                {t("lastFailedSuffix")}
              </p>
              {lastInstallError && (
                <div className="mt-2 rounded-md border border-terra/10 bg-terra/[0.03] px-2.5 py-1.5">
                  <p className="text-[11px] text-terra/90 font-mono break-all">
                    {lastInstallError}
                  </p>
                </div>
              )}
              <p className="text-[11px] text-cream/45 mt-2">
                {t("lastFailedHint")}
              </p>
              {modeToggleRow}
            </div>
          </div>
        </div>
      </div>,
    );
  }

  // ── State 3: rolled back (health degraded) ────────────────────────
  if (wasRolledBack || healthStatus === "degraded") {
    return withDialog(
      <div
        role="status"
        className="rounded-xl border border-sodium/20 bg-sodium/[0.03]"
      >
        <div className="px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-sodium/10 flex items-center justify-center shrink-0 mt-0.5">
              <Info className="h-4 w-4 text-sodium" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-medium text-sodium">
                  {t("rolledBackTitle")}
                </h3>
                {modeBadge}
              </div>
              <p className="text-xs text-cream/60 mt-0.5">
                {t("rolledBackDescription")}
              </p>
              {modeToggleRow}
            </div>
          </div>
        </div>
      </div>,
    );
  }

  // ── State 4: up to date ──────────────────────────────────────────
  if (isCurrent) {
    return withDialog(
      <div
        role="status"
        aria-label={t("ariaUpToDate")}
        className="rounded-xl border border-cream/[0.06] bg-cream/[0.02]"
      >
        <div className="px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-sodium/10 flex items-center justify-center shrink-0 mt-0.5">
              <CheckCircle2
                className="h-4 w-4 text-sodium"
                aria-hidden="true"
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-medium text-cream">
                  {t("upToDateTitle")}
                </h3>
                <LivenessPill liveness={liveness} />
                {modeBadge}
              </div>
              <p className="text-xs text-cream/60 mt-0.5">
                {t("upToDateDescription", { version: String(appliedManifestVersion ?? "") })}
                {installedEnforcerVersion
                  ? t("upToDateEnforcer", { version: installedEnforcerVersion })
                  : ""}
                .
              </p>
              {modeToggleRow}
            </div>
          </div>
        </div>
      </div>,
    );
  }

  // ── Fallback: lag state (Manual mode, no pending staged yet) ─────
  if (
    autoUpdateEffective === false &&
    appliedManifestVersion != null &&
    latestManifestVersion != null &&
    appliedManifestVersion < latestManifestVersion
  ) {
    return withDialog(
      <div
        role="status"
        className="rounded-xl border border-cream/[0.06] bg-cream/[0.02]"
      >
        <div className="px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-cream/[0.04] flex items-center justify-center shrink-0 mt-0.5">
              <Clock
                className="h-4 w-4 text-cream/60"
                aria-hidden="true"
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-medium text-cream">
                  {t("waitingHeartbeatTitle")}
                </h3>
                <LivenessPill liveness={liveness} />
                {modeBadge}
              </div>
              <p className="text-xs text-cream/60 mt-0.5">
                {t("waitingHeartbeatDescription", { version: String(latestManifestVersion ?? "") })}
              </p>
              {modeToggleRow}
            </div>
          </div>
        </div>
      </div>,
    );
  }

  // and never posts an install report). The liveness ping alone is
  if (isOnlinePreApply) {
    return withDialog(
      <div
        role="status"
        className="rounded-xl border border-cream/[0.06] bg-cream/[0.02]"
      >
        <div className="px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-sodium/10 flex items-center justify-center shrink-0 mt-0.5">
              <CheckCircle2
                className="h-4 w-4 text-sodium"
                aria-hidden="true"
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-medium text-cream">
                  {t("serverOnlineTitle")}
                </h3>
                <LivenessPill liveness={liveness} />
                {modeBadge}
              </div>
              <p className="text-xs text-cream/60 mt-0.5">
                {t("serverOnlineDescription", {
                  enforcer: installedEnforcerVersion ? t("serverOnlineEnforcer", { version: installedEnforcerVersion }) : "",
                })}
              </p>
              {modeToggleRow}
            </div>
          </div>
        </div>
      </div>,
    );
  }

  // ── State: VPS has never pinged. Either it's still provisioning,
  if (hasNeverPinged) {
    return withDialog(
      <div
        role="status"
        className="rounded-xl border border-cream/[0.06] bg-cream/[0.02]"
      >
        <div className="px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-cream/[0.04] flex items-center justify-center shrink-0 mt-0.5">
              <Loader2
                className="h-4 w-4 text-cream/60 animate-spin"
                aria-hidden="true"
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-medium text-cream">
                  {t("waitingFirstPingTitle")}
                </h3>
                <LivenessPill liveness={liveness} />
                {modeBadge}
              </div>
              <p className="text-xs text-cream/60 mt-0.5">
                {t("waitingFirstPingDescription")}
              </p>
              {modeToggleRow}
            </div>
          </div>
        </div>
      </div>,
    );
  }

  return null;
}

// ── Liveness pill (online/stale/offline badge) ────────────
// Passive indicator driven by the server-side `liveness` field, which

function LivenessPill({
  liveness,
}: {
  liveness: "online" | "stale" | "offline" | "unknown";
}) {
  const t = useTranslations("console.agentUpdateBanner.liveness");
  const tBanner = useTranslations("console.agentUpdateBanner");
  if (liveness === "unknown") return null;

  const config = {
    online: {
      label: t("online"),
      classes: "bg-sodium/10 text-sodium border-sodium/20",
      tooltip: t("tooltipOnline"),
    },
    stale: {
      label: t("stale"),
      classes: "bg-sodium/10 text-sodium border-sodium/20",
      tooltip: t("tooltipStale"),
    },
    offline: {
      label: t("offline"),
      classes: "bg-terra/10 text-terra border-terra/20",
      tooltip: t("tooltipOffline"),
    },
  }[liveness];

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide border ${config.classes}`}
            aria-label={tBanner("ariaLiveness", { label: config.label })}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                liveness === "online"
                  ? "bg-sodium animate-pulse"
                  : liveness === "stale"
                    ? "bg-sodium"
                    : "bg-terra"
              }`}
              aria-hidden="true"
            />
            {config.label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">
          {config.tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ── Mode badge (read-only status indicator) ─────────────────────────
// Passive label showing the current Auto/Manual state next to each

function ModeBadge({ autoUpdateEffective }: { autoUpdateEffective: boolean }) {
  const t = useTranslations("console.agentUpdateBanner.mode");
  const tBanner = useTranslations("console.agentUpdateBanner");
  const isAuto = autoUpdateEffective;
  const label = isAuto ? t("auto") : t("manual");
  const tooltip = isAuto ? t("tooltipAuto") : t("tooltipManual");

  const colourClasses = isAuto
    ? "bg-sodium/10 text-sodium border border-sodium/20"
    : "bg-blue-500/10 text-blue-300 border border-blue-500/20";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide ${colourClasses}`}
            aria-label={tBanner("ariaUpdateMode", { label })}
          >
            <ShieldCheck className="h-2.5 w-2.5" aria-hidden="true" />
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ── Mode toggle row ─────────────────────────────────────────────────
// Proper labeled Switch with description. Rendered inside each banner

function ModeToggleRow({
  autoUpdateEffective,
  onRequestToggle,
  isBusy,
}: {
  autoUpdateEffective: boolean;
  onRequestToggle?: (mode: "auto" | "manual") => void;
  isBusy?: boolean;
}) {
  const t = useTranslations("console.agentUpdateBanner");
  if (!onRequestToggle) return null;
  const isAuto = autoUpdateEffective;

  return (
    <div className="mt-3 pt-3 border-t border-cream/[0.06] flex items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Label
            htmlFor="agent-auto-update-switch"
            className="text-xs font-medium text-cream cursor-pointer"
          >
            {t("toggleLabel")}
          </Label>
          {isBusy && <Spinner size="sm" delay={300} />}
        </div>
        <p className="text-[11px] text-cream/60 mt-0.5 leading-snug">
          {isAuto ? t("toggleDescriptionAuto") : t("toggleDescriptionManual")}
        </p>
      </div>
      <Switch
        id="agent-auto-update-switch"
        checked={isAuto}
        disabled={isBusy}
        onCheckedChange={(checked) => onRequestToggle(checked ? "auto" : "manual")}
        aria-label={t("toggleLabel")}
      />
    </div>
  );
}
