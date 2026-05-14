// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowUp,
  ArrowDown,
  Check,
  AlertTriangle,

  Calendar,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PLATFORM_TIERS, TierCard, tierLabelsFromT, localizeTiers, type TierSpec, type TierCardLabels } from "@ellul.ai/ui/pricing";
// Collapsible removed — plans shown directly
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  useTierOptions,
  usePreviewTierChange,
  type TierChangeResponse,
  type TierId,
  type BillingInterval,
} from "./useTierOptions";
import { useDashboard } from "@/contexts/DashboardContext";
import { api } from "@/lib/api";
import { extractPlan } from "@/lib/tier-utils";

interface TierSelectorProps {
  serverId: string;
}

const RECOMMENDED_TIER = "cloud_platform:pro";

// TierSelector - Server tier upgrade/downgrade UI
export function TierSelector({ serverId }: TierSelectorProps) {
  const t = useTranslations("console.tierSelector");
  const tTier = useTranslations("tier");

  const localizedTier = (spec: TierSpec): TierSpec => localizeTiers([spec], tTier)[0]!;
  const tierLabels: TierCardLabels = tierLabelsFromT(tTier);
  // Plans shown directly (no collapsible)
  const selectedInterval: BillingInterval = "monthly";
  const [confirmDialog, setConfirmDialog] = useState<{
    option: { tier: { id: string; name: string; price: number; description?: string }; type: string };
  } | null>(null);
  const [successResult, setSuccessResult] = useState<TierChangeResponse | null>(null);
  // Track last selected tier so checkout fallback works even after confirmDialog is cleared (e.g. passkey flow)
  const lastSelectedTierRef = useRef<TierId | null>(null);

  const { data, isLoading, error } = useTierOptions(serverId);
  const { onChangeTier, isChangingTier, changeTierError, changeTierData, resetChangeTier, onCancelDowngrade, isCancellingDowngrade, serverStatus } = useDashboard();
  const isOperationActive = ["upgrading", "downgrading", "waking", "hibernating", "creating", "provisioning"].includes(serverStatus?.state || "");
  const previewMutation = usePreviewTierChange();

  // Close dialog and show success when tier change completes
  useEffect(() => {
    if (changeTierData && confirmDialog) {
      setConfirmDialog(null);
      setSuccessResult(changeTierData as TierChangeResponse);
      resetChangeTier();
    }
  }, [changeTierData, confirmDialog, resetChangeTier]);

  // Close confirm dialog when passkey dialog opens (layout takes over)
  useEffect(() => {
    if (changeTierError?.message === "PASSKEY_REQUIRED" && confirmDialog) {
      setConfirmDialog(null);
    }
  }, [changeTierError, confirmDialog]);

  // Fetch preview when dialog opens
  useEffect(() => {
    if (confirmDialog) {
      const tierId = confirmDialog.option.tier.id;
      previewMutation.mutate({
        serverId,
        newPlan: extractPlan(tierId),
        newInterval: selectedInterval,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmDialog?.option.tier.id, selectedInterval, serverId]);

  const handleTierChange = (option: { tier: { id: string; name: string; price: number }; type: string }) => {
    lastSelectedTierRef.current = option.tier.id as TierId;
    setConfirmDialog({ option });
  };

  const confirmTierChange = async () => {
    if (!confirmDialog) return;
    const tier = confirmDialog.option.tier.id as TierId;

    onChangeTier({
      newTier: tier,
      newInterval: selectedInterval,
    });
  };

  // Uses lastSelectedTierRef instead of confirmDialog because confirmDialog gets
  // to never fire when the passkey-retried change-tier returns 402.
  useEffect(() => {
    const tier = lastSelectedTierRef.current;
    if (changeTierError && changeTierError.message !== "PASSKEY_REQUIRED" && changeTierError.message.includes("subscription") && tier) {
      lastSelectedTierRef.current = null; // prevent re-trigger
      (async () => {
        try {
          const res = await api.api.stripe.checkout.$post({
            json: {
              product: (serverStatus?.server?.product || "cloud_platform") as "cloud_platform" | "shield_proxy",
              plan: extractPlan(tier) as "hobby" | "pro",
              interval: selectedInterval,
            },
          });
          if (res.ok) {
            const checkoutData = await res.json() as { url: string };
            window.location.href = checkoutData.url;
          }
        } catch {}
      })();
    }
  }, [changeTierError, selectedInterval]);

  // Loading state
  if (isLoading) {
    return (
      <div className="py-2">
        <div className="flex items-center gap-2">
          <Spinner size="sm" delay={300} />
          <span className="text-xs text-cream/60">{t("loadingPlans")}</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error || !data) {
    return (
      <div className="py-2">
        <div className="flex items-center gap-2 text-terra">
          <AlertTriangle className="h-4 w-4" />
          <span className="text-xs">{t("loadFailed")}</span>
        </div>
      </div>
    );
  }

  const { currentTier, options, pendingDowngrade, pendingUpgrade } = data;

  return (
    <>
      <div className="space-y-4">
              {/* Pending Downgrade Banner */}
              {pendingDowngrade && (
                <div className="rounded-xl border border-sodium/20 bg-sodium/5 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-lg bg-sodium/10 flex items-center justify-center shrink-0">
                        <Calendar className="h-4 w-4 text-sodium" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-sodium">
                          {t("downgradeScheduled")}
                        </p>
                        <p className="text-xs text-cream/60 mt-1">
                          {t.rich("downgradeScheduledBody", {
                            plan: () => <span className="text-sodium font-medium">{pendingDowngrade.targetPlan}</span>,
                            date: () => (
                              <span className="text-sodium font-medium">
                                {new Date(pendingDowngrade.effectiveDate || Date.now()).toLocaleDateString(undefined, {
                                  month: "long",
                                  day: "numeric",
                                  year: "numeric",
                                })}
                              </span>
                            ),
                            interval: pendingDowngrade.interval,
                          }) as React.ReactNode}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs text-sodium hover:text-sodium hover:bg-sodium/10 shrink-0"
                      onClick={() => onCancelDowngrade()}
                      disabled={isCancellingDowngrade}
                    >
                      {isCancellingDowngrade ? (
                        <Spinner size="xs" />
                      ) : (
                        <X className="h-3 w-3" />
                      )}
                      <span className="ml-1">{t("cancel")}</span>
                    </Button>
                  </div>
                </div>
              )}

              {/* Pending Upgrade Banner */}
              {pendingUpgrade && (
                <div className="rounded-xl border border-sodium/20 bg-sodium/5 p-4">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-sodium/10 flex items-center justify-center shrink-0">
                      <Spinner size="sm" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-sodium">
                        {t("upgradeInProgress")}
                      </p>
                      <p className="text-xs text-cream/60 mt-1">
                        {t.rich("upgradeInProgressBody", {
                          plan: () => <span className="text-sodium font-medium">{pendingUpgrade.targetPlan}</span>,
                        }) as React.ReactNode}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Success Message */}
              {successResult && (
                <div className="rounded-xl border border-sodium/20 bg-sodium/5 p-4">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-sodium/10 flex items-center justify-center shrink-0">
                      <Check className="h-4 w-4 text-sodium" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-sodium">
                        {successResult.scheduled
                          ? t("downgradeScheduledSuccess")
                          : successResult.pending
                          ? t("paymentConfirmed")
                          : t("planChangedSuccess")}
                      </p>
                      <p className="text-xs text-cream/60 mt-1">
                        {successResult.message}
                      </p>
                      {successResult.billing?.amountCharged != null && successResult.billing.amountCharged > 0 && (
                        <p className="text-xs text-cream/45 mt-1">
                          {t("chargedAmount", { amount: successResult.billing.amountCharged.toFixed(2) })}
                        </p>
                      )}
                      {successResult.credentials && (
                        <div className="mt-3 p-3 rounded-lg bg-sodium/10 border border-sodium/20">
                          <p className="text-xs text-sodium font-medium">
                            {t("newAiProxyToken")}
                          </p>
                          <code className="text-[10px] text-sodium break-all block mt-1 font-mono">
                            {successResult.credentials.aiProxyToken}
                          </code>
                        </div>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs text-cream/45 hover:text-cream/75 shrink-0"
                      onClick={() => setSuccessResult(null)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              )}

              {/* Mutation Error */}
              {changeTierError && changeTierError.message !== "PASSKEY_REQUIRED" && (
                <div className="rounded-xl border border-terra/20 bg-terra/5 p-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-4 w-4 text-terra mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-terra">
                        {t("planChangeFailed")}
                      </p>
                      <p className="text-xs text-terra/70 mt-1">
                        {changeTierError.message}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Plans — current + alternatives in one consistent grid */}
              {/* TODO: Re-add Monthly/Annual billing toggle when annual billing is ready */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 max-w-2xl mx-auto">
                {PLATFORM_TIERS.map((spec) => {
                  const isCurrent = spec.id === currentTier.id;
                  const option = options.find((o) => o.tier.id === spec.id);
                  const isScheduledTarget = pendingDowngrade?.targetPlan === spec.id;

                  if (isCurrent) {
                    return (
                      <TierCard
                        key={spec.id}
                        tier={localizedTier(spec)}
                        badge="current"
                        hideCta
                        labels={tierLabels}
                      />
                    );
                  }

                  if (!option || option.type === "same") return null;

                  const isUpgrade = option.type === "upgrade";
                  return (
                    <TierCard
                      key={spec.id}
                      tier={localizedTier(spec)}
                      onClick={() => handleTierChange(option)}
                      ctaLabel={isScheduledTarget ? t("ctaScheduled") : isUpgrade ? t("ctaUpgrade") : t("ctaDowngrade")}
                      badge={isScheduledTarget ? "scheduled" : spec.id === RECOMMENDED_TIER ? "recommended" : null}
                      disabled={isChangingTier || isOperationActive || isScheduledTarget}
                      labels={tierLabels}
                    />
                  );
                })}
              </div>

              {/* Manage Subscription */}
              <div className="flex items-center justify-center pt-4">
                <button
                  type="button"
                  className="text-[11px] text-cream/45 hover:text-cream/75 underline underline-offset-4 decoration-cream/20 hover:decoration-cream/40 transition-colors"
                  onClick={async () => {
                    try {
                      const response = await api.api.stripe.portal.$post();
                      if (response.ok) {
                        const data = await response.json() as { url: string };
                        window.location.href = data.url;
                      }
                    } catch {}
                  }}
                >
                  {t("manageSubscription")}
                </button>
              </div>
      </div>

      {/* Confirmation Dialog with Preview */}
      <Dialog open={!!confirmDialog} onOpenChange={(open) => !open && setConfirmDialog(null)}>
        <DialogContent className="bg-card border-border text-cream max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg">
              {previewMutation.data?.changeType === "downgrade" ? (
                <>
                  <div className="w-8 h-8 rounded-lg bg-sodium/10 flex items-center justify-center">
                    <ArrowDown className="h-4 w-4 text-sodium" />
                  </div>
                  <span>{t("downgradeTo", { name: confirmDialog?.option.tier.name ?? "" })}</span>
                </>
              ) : (
                <>
                  <div className="w-8 h-8 rounded-lg bg-sodium/10 flex items-center justify-center">
                    <ArrowUp className="h-4 w-4 text-sodium" />
                  </div>
                  <span>{t("upgradeTo", { name: confirmDialog?.option.tier.name ?? "" })}</span>
                </>
              )}
            </DialogTitle>
            <DialogDescription className="text-cream/60 text-sm">
              {confirmDialog?.option.tier.description}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 my-2">
            {/* Preview Loading */}
            {previewMutation.isPending && (
              <div className="flex items-center gap-2 p-4 rounded-xl border border-border bg-secondary/30">
                <Spinner size="sm" />
                <span className="text-xs text-cream/60">{t("calculatingCost")}</span>
              </div>
            )}

            {/* Preview Data */}
            {previewMutation.data && (
              <div className="rounded-xl border border-border bg-secondary/30 p-4">
                {previewMutation.data.changeType === "upgrade" ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-cream/60">{t("dueTodayProrated")}</span>
                      <span className="text-sm font-semibold text-cream">
                        ${previewMutation.data.immediateCharge?.toFixed(2)}
                      </span>
                    </div>
                    <div className="h-px bg-secondary" />
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-cream/60">
                        {previewMutation.data.newInterval === "annual" ? t("thenAnnually") : t("thenMonthly")}
                      </span>
                      <span className="text-sm font-medium text-cream/75">
                        ${previewMutation.data.newRecurringAmount}{previewMutation.data.newInterval === "annual" ? t("perYear") : t("perMonth")}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-cream/60">{t("takesEffectOn")}</span>
                      <span className="text-sm font-semibold text-cream">
                        {new Date(previewMutation.data.effectiveDate!).toLocaleDateString(undefined, {
                          month: "short", day: "numeric", year: "numeric",
                        })}
                      </span>
                    </div>
                    <div className="h-px bg-secondary" />
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-cream/60">
                        {previewMutation.data.newInterval === "annual" ? t("newAnnualRate") : t("newMonthlyRate")}
                      </span>
                      <span className="text-sm font-medium text-cream/75">
                        ${previewMutation.data.newRecurringAmount}{previewMutation.data.newInterval === "annual" ? t("perYear") : t("perMonth")}
                      </span>
                    </div>
                    <div className="h-px bg-secondary" />
                    <div className="flex items-center gap-2 text-sodium">
                      <Check className="h-3.5 w-3.5" />
                      <span className="text-xs">{t("keepFullAccess")}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Preview Error */}
            {previewMutation.error && (
              <div className="rounded-xl border border-terra/20 bg-terra/5 p-3">
                <p className="text-xs text-terra">
                  {previewMutation.error.message}
                </p>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setConfirmDialog(null)}
              className="text-cream/60 hover:text-cream"
              disabled={isChangingTier || isOperationActive}
            >
              {t("cancel")}
            </Button>
            <Button
              onClick={confirmTierChange}
              disabled={isChangingTier || isOperationActive || previewMutation.isPending}
              className={
                previewMutation.data?.changeType === "downgrade"
                  ? "bg-sodium hover:bg-sodium text-ink"
                  : "bg-sodium hover:bg-sodium text-ink"
              }
            >
              {isChangingTier ? (
                <>
                  <Spinner size="sm" className="mr-2" />
                  {t("processing")}
                </>
              ) : previewMutation.data?.changeType === "downgrade" ? (
                t("scheduleDowngrade")
              ) : (
                t("confirmUpgrade")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

