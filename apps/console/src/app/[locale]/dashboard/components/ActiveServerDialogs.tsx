// SPDX-License-Identifier: MIT
"use client";

import {
  ArrowUpDown,
  RefreshCw,
  Shield,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ServerStatus } from "@/contexts/DashboardContext";
import type { VpsAuthDialogState } from "./useServerMutations";
import type { UseMutationResult } from "@tanstack/react-query";

// ── Resize overlay (upgrading/downgrading within active state) ───

export function ResizeOverlay({
  effectiveServerStatus,
  resizeElapsed,
}: {
  effectiveServerStatus: ServerStatus;
  resizeElapsed: number;
}) {
  const t = useTranslations("console.activeServerDialogs.resize");
  const tNames = useTranslations("console.activeServerDialogs.tierNames");
  const tCap = useTranslations("console.activeServerDialogs.tierCapacity");
  if (
    effectiveServerStatus.state !== "upgrading" &&
    effectiveServerStatus.state !== "downgrading"
  ) {
    return null;
  }

  const isUpgrading = effectiveServerStatus.state === "upgrading";
  const estimatedSeconds = 120;
  const targetTier = effectiveServerStatus.server?.tierTransitionTarget;
  const currentPlanKey = effectiveServerStatus.server?.product
    ? `${effectiveServerStatus.server.product}:${effectiveServerStatus.server.serverPlan || "free"}`
    : `cloud_platform:${effectiveServerStatus.server?.serverPlan || "free"}`;

  // tierNames keys map "cloud_platform:hobby" → "cloud_platform_hobby" for JSON.
  type NameKey = Parameters<typeof tNames>[0];
  type CapKey = Parameters<typeof tCap>[0];
  const safeKey = (k: string) => k.replace(/:/g, "_");
  const NAME_KEYS = new Set<string>([
    "cloud_platform_hobby",
    "cloud_platform_pro",
    "shield_proxy_pro",
    "hobby",
    "pro",
  ]);
  const CAP_KEYS = new Set<string>([
    "cloud_platform_hobby",
    "cloud_platform_pro",
    "shield_proxy_pro",
    "hobby",
    "pro",
  ]);
  const lookupName = (k: string | null | undefined): string | null => {
    if (!k) return null;
    const safe = safeKey(k);
    if (!NAME_KEYS.has(safe)) return null;
    return tNames(safe as NameKey);
  };
  const lookupCapacity = (k: string): string | null => {
    const safe = safeKey(k);
    if (!CAP_KEYS.has(safe)) return null;
    return tCap(safe as CapKey);
  };

  const targetName = targetTier ? lookupName(targetTier) || targetTier : tNames("newPlan");
  const currentName = currentPlanKey ? lookupName(currentPlanKey) || currentPlanKey : tNames("currentPlan");
  const capacity = targetTier ? lookupCapacity(targetTier) : null;
  const progressPercent = Math.min(Math.round((resizeElapsed / estimatedSeconds) * 100), 95);

  const getStatusMessage = () => {
    if (resizeElapsed < 15) return isUpgrading ? t("upgradingDots") : t("downgradingDots");
    if (resizeElapsed < 45) return t("applyingConfig");
    if (resizeElapsed < 90) return t("verifyingHealth");
    return t("almostThere");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-sm p-4">
      <div className="max-w-lg w-full">
        <div className="panel-ascente p-6 sm:p-10">
          <div className="flex items-center justify-center py-6">
            <div className="relative">
              <svg className="w-24 h-24" viewBox="0 0 96 96">
                <circle cx="48" cy="48" r="42" fill="none" stroke="hsl(24, 95%, 53%)" strokeOpacity="0.15" strokeWidth="4" />
                <circle
                  cx="48" cy="48" r="42" fill="none"
                  stroke="url(#resize-gradient)" strokeWidth="4" strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 42}`}
                  strokeDashoffset={`${2 * Math.PI * 42 * (1 - progressPercent / 100)}`}
                  transform="rotate(-90 48 48)"
                  className="transition-all duration-1000 ease-out"
                />
                <defs>
                  <linearGradient id="resize-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="hsl(24, 95%, 53%)" />
                    <stop offset="100%" stopColor="#F4B873" />
                  </linearGradient>
                </defs>
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <ArrowUpDown className="h-8 w-8 text-sodium animate-pulse" />
              </div>
            </div>
          </div>

          <h2 className="mb-2 text-2xl font-semibold text-center text-cream">
            {isUpgrading ? t("upgrading") : t("downgrading")}
          </h2>

          {targetTier && currentPlanKey && (
            <div className="flex items-center justify-center gap-2 mb-4">
              <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-cream/5 border border-cream/10 text-cream/60">{currentName}</span>
              <svg className="w-4 h-4 text-sodium" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 8h10M9 4l4 4-4 4" />
              </svg>
              <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-sodium/10 border border-sodium/30 text-sodium">{targetName}</span>
            </div>
          )}

          <p className="text-center text-sodium text-sm font-medium mb-1">{getStatusMessage()}</p>

          <div className="max-w-xs mx-auto mb-4">
            <div className="w-full h-1.5 bg-cream/5 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-sodium transition-all duration-1000 ease-out" style={{ width: `${progressPercent}%` }} />
            </div>
          </div>

          <p className="text-center text-cream/45 text-xs mb-6">
            {resizeElapsed > 0 && t("elapsed", { seconds: resizeElapsed })}
            {resizeElapsed > 0 && resizeElapsed < estimatedSeconds && (
              <span className="text-cream/35">{t("remaining", { seconds: Math.max(estimatedSeconds - resizeElapsed, 5) })}</span>
            )}
            {resizeElapsed >= estimatedSeconds && (
              <span className="text-cream/35">{t("takingLonger")}</span>
            )}
          </p>

          {capacity && (
            <div className="rounded-xl border border-sodium/10 bg-sodium/[0.03] p-4 mb-4">
              <p className="text-[11px] font-medium text-cream/45 uppercase tracking-wider mb-2 text-center">{t("newPlanLabel")}</p>
              <p className="text-sm font-semibold text-cream text-center">{capacity}</p>
            </div>
          )}

          <div className="flex items-center justify-center gap-2 text-[11px] text-cream/45">
            <Shield className="h-3.5 w-3.5 text-sodium/60" />
            <span>{t("preservedNote")}</span>
          </div>

          {resizeElapsed > 180 && (
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

// ── VPS Auth Dialog ──────────────────────────────────────────────

export function VpsAuthDialog({
  vpsAuthDialog,
  setVpsAuthDialog,
  handlePasskeyConfirmation,
  deleteServerMutation,
  rebuildServerMutation,
  updateServerMutation,
  rollbackServerMutation,
  changeTierMutation,
  cancelDowngradeMutation,
}: {
  vpsAuthDialog: VpsAuthDialogState;
  setVpsAuthDialog: React.Dispatch<React.SetStateAction<VpsAuthDialogState>>;
  handlePasskeyConfirmation: () => Promise<void>;
  deleteServerMutation: UseMutationResult<unknown, Error, { serverId: string; passkeyConfirmation?: string }>;
  rebuildServerMutation: UseMutationResult<unknown, Error, { serverId: string; passkeyConfirmation?: string }>;
  updateServerMutation: UseMutationResult<unknown, Error, { serverId: string; passkeyConfirmation?: string }>;
  rollbackServerMutation: UseMutationResult<unknown, Error, { serverId: string; passkeyConfirmation?: string }>;
  changeTierMutation: UseMutationResult<unknown, Error, {
    serverId: string; newTier: string; newInterval: string; forceMigration?: boolean; passkeyConfirmation?: string;
  }>;
  cancelDowngradeMutation: UseMutationResult<unknown, Error, { serverId: string; passkeyConfirmation?: string }>;
}) {
  const t = useTranslations("console.activeServerDialogs.vpsAuth");
  return (
    <Dialog
      open={vpsAuthDialog.open}
      onOpenChange={(open) => {
        if (!open) setVpsAuthDialog({ open: false, operation: null, instructions: "" });
      }}
    >
      <DialogContent className="bg-card border-border text-cream max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sodium">
            {vpsAuthDialog.tier !== "standard" ? t("passkeyTitle") : t("authorizationTitle")}
          </DialogTitle>
          <DialogDescription className="text-cream/60">
            {vpsAuthDialog.tier !== "standard"
              ? t("passkeyDescription", { operation: vpsAuthDialog.operation ?? "" })
              : t("standardDescription", { operation: vpsAuthDialog.operation ?? "" })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 my-4">
          {vpsAuthDialog.tier !== "standard" && (
            <div className="rounded-lg border border-sodium/20 bg-sodium/5 p-4">
              <p className="text-sm text-sodium">
                {t("passkeyHelp")}
              </p>
            </div>
          )}
          {vpsAuthDialog.operation === "rebuild" && (
            <div className="rounded-lg border border-terra/20 bg-terra/5 p-3">
              <p className="text-xs text-terra"><strong>{t("warningPrefix")}</strong>{t("warningRebuild")}</p>
            </div>
          )}
          {vpsAuthDialog.operation === "delete" && (
            <div className="rounded-lg border border-terra/20 bg-terra/5 p-3">
              <p className="text-xs text-terra"><strong>{t("warningPrefix")}</strong>{t("warningDelete")}</p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => setVpsAuthDialog({ open: false, operation: null, instructions: "" })} className="text-cream/60 hover:text-cream">
            {t("cancel")}
          </Button>
          {vpsAuthDialog.tier !== "standard" && (
            <Button
              variant="destructive"
              onClick={handlePasskeyConfirmation}
              disabled={
                vpsAuthDialog.passkeyPending || deleteServerMutation.isPending || rebuildServerMutation.isPending ||
                updateServerMutation.isPending || rollbackServerMutation.isPending ||
                changeTierMutation.isPending || cancelDowngradeMutation.isPending
              }
              className={
                vpsAuthDialog.operation === "delete" ? "bg-terra hover:bg-terra"
                  : vpsAuthDialog.operation === "rebuild" ? "bg-sodium hover:bg-sodium"
                  : "bg-sodium hover:bg-sodium"
              }
            >
              {vpsAuthDialog.passkeyPending ? (
                <><Spinner size="sm" className="mr-2" />{t("waitingForPasskey")}</>
              ) : t("confirmWithPasskey")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
