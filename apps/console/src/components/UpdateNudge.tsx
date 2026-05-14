// SPDX-License-Identifier: MIT
"use client";

import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useDashboard } from "@/contexts/DashboardContext";
import { useVpsCapability } from "@/hooks/useVpsCapability";
import type { CapabilityId } from "@/lib/vps-capabilities";

// Inline upgrade prompt rendered when a VPS-gated feature can't run

interface UpdateNudgeProps {
  capability: CapabilityId;
  featureLabel: string;
  description?: string;
  compact?: boolean;
}

export function UpdateNudge({
  capability,
  featureLabel,
  description,
  compact,
}: UpdateNudgeProps) {
  const t = useTranslations("console.updateNudge");
  const { agentUpdate, onUpdateServer, isUpdating } = useDashboard();
  const { supported, requiresUpdate } = useVpsCapability(capability);
  if (supported || !requiresUpdate) return null;

  const installed = agentUpdate?.installedEnforcerVersion ?? "unknown";
  const latest = agentUpdate?.latestEnforcerVersion ?? "latest";
  const hasPending = agentUpdate?.pendingUpdateVersion != null;
  const isApplying = agentUpdate?.applyInProgress === true;

  if (compact) {
    return (
      <div className="inline-flex items-start gap-2 rounded-md border border-sodium/20 bg-sodium/[0.04] px-2.5 py-1.5 text-[11px]">
        <AlertTriangle
          className="h-3 w-3 text-sodium shrink-0 mt-0.5"
          aria-hidden="true"
        />
        <span className="text-sodium">
          {t("requiresUpdate", { feature: featureLabel })}
        </span>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="rounded-lg border border-sodium/20 bg-sodium/[0.04] px-3 py-2.5"
    >
      <div className="flex items-start gap-2.5">
        <div className="w-6 h-6 rounded-md bg-sodium/10 flex items-center justify-center shrink-0 mt-0.5">
          <AlertTriangle
            className="h-3.5 w-3.5 text-sodium"
            aria-hidden="true"
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-sodium">
            {t("requiresUpdate", { feature: featureLabel })}
          </p>
          {description && (
            <p className="text-[11px] text-cream/60 mt-0.5 leading-snug">
              {description}
            </p>
          )}
          <p className="text-[11px] text-cream/45 mt-1 font-mono">
            enforcer {installed}
            <span className="mx-1.5 text-cream/35">→</span>
            {latest}
          </p>
          {hasPending && onUpdateServer && !isApplying && (
            <Button
              size="sm"
              className="mt-2 bg-sodium hover:bg-sodium text-ink text-[11px] h-6 px-2"
              onClick={onUpdateServer}
              disabled={isUpdating}
              aria-label={`Apply pending update to enable ${featureLabel}`}
            >
              {isUpdating ? (
                <>
                  <Spinner size="sm" delay={300} className="mr-1.5" />
                  {t("applying")}
                </>
              ) : (
                t("updateNow")
              )}
            </Button>
          )}
          {!hasPending && (
            <p className="text-[11px] text-cream/45 mt-1.5">
              {t("willStage")}
            </p>
          )}
          {isApplying && (
            <p className="text-[11px] text-blue-400 mt-1.5 flex items-center gap-1.5">
              <Spinner size="sm" delay={300} />
              {t("inProgress")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
