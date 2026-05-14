// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
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
import { useVpsBridge } from "@/lib/vps-bridge";
import { CliConnectors } from "../CliConnectors";
import { AIToolsCard } from "../AIToolsCard";

interface AiQuota {
  used: number;
  limit: number;
  remaining: number;
  percentUsed: number;
  resetsIn: string;
  resetAt: string;
}

interface ConnectorInfo {
  connected: boolean;
  hasApiKey: boolean;
  hasSignIn: boolean;
}

interface FeaturesResponse {
  gbrain: { enabled: boolean; available: boolean; ramMb: number; provider: string };
  gstack: { enabled: boolean; available: boolean };
  zeroclaw: { provider: string };
  providers: Record<string, { connected: boolean }>;
  connectors: Record<string, ConnectorInfo>;
}

interface TabAIProps {
  serverId: string;
  serverDomain: string;
  aiQuota?: AiQuota;
}

export function TabAI({ serverId, serverDomain, aiQuota }: TabAIProps) {
  const t = useTranslations("console.tabHome");
  const tAI = useTranslations("console.tabAI");
  const queryClient = useQueryClient();
  const { send: vpsSend } = useVpsBridge();
  const [showWipeDialog, setShowWipeDialog] = useState(false);
  const showAiUsage = aiQuota && aiQuota.used > 0;

  const { data: features, isLoading: featuresLoading } = useQuery<FeaturesResponse>({
    queryKey: ["vps-features", serverDomain],
    queryFn: () => vpsSend<FeaturesResponse>("features_get"),
    refetchInterval: 30_000,
  });

  const wipeMutation = useMutation({
    mutationFn: () => vpsSend("gbrain_wipe"),
    onSuccess: () => {
      setShowWipeDialog(false);
      queryClient.invalidateQueries({ queryKey: ["vps-features", serverDomain] });
    },
  });

  const gbrainEnabled = features?.gbrain.enabled === true;

  return (
    <div className="p-4 sm:p-5 space-y-5">
      {/* Connectors */}
      <section className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] overflow-hidden">
        <div className="px-4 py-3 border-b border-cream/[0.06]">
          <h3 className="text-sm font-medium text-cream">{tAI("connectorsTitle")}</h3>
          <p className="text-[10px] text-cream/45 mt-0.5">{tAI("connectorsDescription")}</p>
        </div>
        <div className="p-4">
          <CliConnectors
            serverDomain={serverDomain}
            connectors={features?.connectors}
            providers={features?.providers}
            isLoading={featuresLoading}
          />
        </div>
      </section>

      {/* AI Tools */}
      <section className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] overflow-visible">
        <div className="px-4 py-3 border-b border-cream/[0.06]">
          <h3 className="text-sm font-medium text-cream">{tAI("toolsTitle")}</h3>
          <p className="text-[10px] text-cream/45 mt-0.5">{tAI("toolsDescription")}</p>
        </div>
        <div className="p-4">
          <AIToolsCard serverDomain={serverDomain} />
        </div>
      </section>

      {/* AI Usage */}
      {showAiUsage && aiQuota && (
        <section className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] overflow-hidden">
          <div className="px-4 py-3 border-b border-cream/[0.04]">
            <h3 className="text-sm font-medium text-cream">{t("aiTokenUsage")}</h3>
            <p className="text-[10px] text-cream/45 mt-0.5">{t("aiCurrentPeriod")}</p>
          </div>

          <div className="p-4 space-y-3">
            <div>
              <div className="h-2 bg-cream/[0.06] rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    aiQuota.percentUsed > 90
                      ? "bg-terra"
                      : aiQuota.percentUsed > 70
                      ? "bg-sodium"
                      : "bg-ink-1"
                  }`}
                  style={{ width: `${Math.min(aiQuota.percentUsed, 100)}%` }}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-cream/60">{t("used")}</span>
                <span className="text-cream/85 font-mono">
                  {(aiQuota.used / 1_000_000).toFixed(2)}M / {(aiQuota.limit / 1_000_000).toFixed(0)}M
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-cream/60">{t("remaining")}</span>
                <span className={`font-mono ${
                  aiQuota.percentUsed > 90 ? "text-terra" : "text-cream/85"
                }`}>
                  {t("remainingTokens", { value: (aiQuota.remaining / 1_000_000).toFixed(2) })}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs pt-2 border-t border-cream/[0.04]">
                <span className="text-cream/60">{t("resetsIn")}</span>
                <span className="text-cream/60">{aiQuota.resetsIn}</span>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Danger Zone */}
      {gbrainEnabled && (
        <section className="rounded-xl border border-terra/20 bg-terra/[0.03] overflow-hidden">
          <div className="px-4 py-3 border-b border-terra/10">
            <h3 className="text-sm font-medium text-terra">{tAI("dangerZone")}</h3>
          </div>
          <div className="p-4">
            <Button
              variant="outline"
              size="sm"
              className="w-full border-terra/20 text-terra hover:bg-terra/10 hover:text-terra text-xs"
              onClick={() => setShowWipeDialog(true)}
              disabled={wipeMutation.isPending}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              {tAI("wipeGbrainTitle")}
            </Button>
            <p className="text-[10px] text-cream/35 mt-2">
              {tAI("wipeGbrainDescription")}
            </p>
          </div>
        </section>
      )}

      {/* Wipe Confirmation Dialog */}
      <Dialog open={showWipeDialog} onOpenChange={setShowWipeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tAI("wipeGbrainConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {tAI("wipeGbrainConfirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowWipeDialog(false)}
              disabled={wipeMutation.isPending}
            >
              {tAI("cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => wipeMutation.mutate()}
              disabled={wipeMutation.isPending}
            >
              {wipeMutation.isPending ? (
                <><Spinner size="sm" className="mr-2" /> {tAI("wiping")}</>
              ) : (
                tAI("wipeAllMemory")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
