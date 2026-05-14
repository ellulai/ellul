// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Lock, AlertTriangle, Fingerprint } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { API_URL } from "@/lib/api";
import { useVpsBridge } from "@/lib/vps-bridge";
import { useVpsFeature } from "@/hooks/useVpsFeature";

interface CertificateQuota {
  used: number;
  limit: number;
  available: number;
  canIssueCertificate: boolean;
  percentUsed: number;
  resetAt: string;
  resetIn: string;
}

interface DeploymentModelCardProps {
  serverId: string;
  securityTier?: "standard" | "web_locked" | "private_locked";
  domain?: string;
}

export function DeploymentModelCard({ serverId, securityTier, domain }: DeploymentModelCardProps) {
  const t = useTranslations("console.tlsCard");
  const queryClient = useQueryClient();
  const [reAuthPending, setReAuthPending] = useState(false);
  const { send: vpsSend } = useVpsBridge();
  const hasBridgeOps = useVpsFeature("bridge-operations");

  const { data: serverData } = useQuery<{ deploymentModel: string }>({
    queryKey: ["server-deployment-model", serverId],
    queryFn: async () => {
      const response = await fetch(`${API_URL}/api/servers/${serverId}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error(t("fetchFailed"));
      const data = await response.json();
      return {
        deploymentModel: data.deploymentModel || "cloudflare",
      };
    },
  });

  // Fetch Let's Encrypt certificate quota
  const { data: certQuota } = useQuery<CertificateQuota>({
    queryKey: ["certificate-quota"],
    queryFn: async () => {
      const response = await fetch(`${API_URL}/api/servers/certificate-quota`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error(t("fetchQuotaFailed"));
      return response.json();
    },
  });

  const currentModel = serverData?.deploymentModel || "cloudflare";
  const canSwitchToDirect = certQuota?.canIssueCertificate !== false;
  const quotaExhausted = certQuota && !certQuota.canIssueCertificate;

  const switchMutation = useMutation({
    mutationFn: async (model: "cloudflare" | "direct") => {
      // Step 1: API switches DNS (Cloudflare API) and returns new domain
      const response = await fetch(`${API_URL}/api/servers/${serverId}/deployment`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      if (!response.ok) {
        const err = await response.json();
        if (response.status === 429 && err.resetIn) {
          throw new Error(t("rateLimited", { error: err.error, resetIn: err.resetIn }));
        }
        throw new Error(err.error || t("switchFailedFallback"));
      }
      const data = await response.json();

      // Step 2: Apply deployment change on VPS via bridge (instant Caddyfile regen)
      if (hasBridgeOps) {
        try {
          await vpsSend("switch_deployment", {
            model,
            domain: data.newDomain || domain,
            serverId,
            cfOriginCert: data.cfOriginCert,
            cfOriginKey: data.cfOriginKey,
            cfAppOriginCert: data.cfAppOriginCert,
            cfAppOriginKey: data.cfAppOriginKey,
          });
        } catch (e) {
          // Bridge call may fail if shield restarts during switch — that's expected
          console.warn("[TLSModeCard] Bridge switch-deployment:", (e as Error).message);
        }
      }

      return data;
    },
    onSuccess: (data: { newDomain?: string }) => {
      queryClient.invalidateQueries({ queryKey: ["server-deployment-model", serverId] });
      queryClient.invalidateQueries({ queryKey: ["certificate-quota"] });

      // Force re-authentication on the new domain when in web_locked mode
      if (securityTier !== "standard" && data.newDomain) {
        setReAuthPending(true);
        // Bridge applies change instantly — just wait for Caddy reload (~3s)
        setTimeout(() => {
          window.location.href = `https://${data.newDomain}/_auth/login?redirect=${encodeURIComponent(`https://${data.newDomain}/`)}`;
        }, hasBridgeOps ? 4000 : 12000);
      }
    },
  });

  const handleSelect = (model: "cloudflare" | "direct") => {
    if (model === currentModel || switchMutation.isPending) return;
    // Block switch to direct if quota exhausted
    if (model === "direct" && !canSwitchToDirect) return;
    switchMutation.mutate(model);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">{t("title")}</CardTitle>
        <CardDescription>
          {t("subtitle")}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Cloudflare Edge option */}
        <button
          type="button"
          onClick={() => handleSelect("cloudflare")}
          disabled={switchMutation.isPending}
          className={`w-full text-left rounded-lg border p-3 sm:p-4 transition-colors min-h-[44px] ${
            currentModel === "cloudflare"
              ? "border-blue-500 bg-blue-500/5 ring-1 ring-blue-500/30"
              : "hover:border-muted-foreground/30 cursor-pointer"
          } ${switchMutation.isPending ? "opacity-60 cursor-not-allowed" : ""}`}
        >
          <div className="flex items-start gap-2 sm:gap-3">
            <div className={`mt-0.5 h-5 w-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
              currentModel === "cloudflare" ? "border-blue-500" : "border-muted-foreground/40"
            }`}>
              {currentModel === "cloudflare" && (
                <div className="h-2 w-2 rounded-full bg-blue-500" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Globe className="h-4 w-4 text-blue-500" />
                <p className="font-medium text-sm">{t("cloudflareTitle")}</p>
                {currentModel === "cloudflare" && (
                  <Badge variant="outline" className="text-xs">{t("active")}</Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("cloudflareDescription")}
              </p>
            </div>
          </div>
        </button>

        {/* Direct Connect option */}
        <button
          type="button"
          onClick={() => handleSelect("direct")}
          disabled={switchMutation.isPending || (currentModel !== "direct" && !canSwitchToDirect)}
          className={`w-full text-left rounded-lg border p-3 sm:p-4 transition-colors min-h-[44px] ${
            currentModel === "direct"
              ? "border-sodium bg-sodium/5 ring-1 ring-sodium/30"
              : quotaExhausted
                ? "opacity-50 cursor-not-allowed border-muted"
                : "hover:border-muted-foreground/30 cursor-pointer"
          } ${switchMutation.isPending ? "opacity-60 cursor-not-allowed" : ""}`}
        >
          <div className="flex items-start gap-2 sm:gap-3">
            <div className={`mt-0.5 h-5 w-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
              currentModel === "direct" ? "border-sodium" : "border-muted-foreground/40"
            }`}>
              {currentModel === "direct" && (
                <div className="h-2 w-2 rounded-full bg-sodium" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Lock className="h-4 w-4 text-sodium" />
                <p className="font-medium text-sm">{t("directTitle")}</p>
                {currentModel === "direct" && (
                  <Badge variant="outline" className="text-xs">{t("active")}</Badge>
                )}
                {quotaExhausted && currentModel !== "direct" && (
                  <Badge variant="destructive" className="text-xs">{t("unavailable")}</Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("directDescription")}
              </p>
            </div>
          </div>
        </button>

        {/* Let's Encrypt Quota Warning */}
        {quotaExhausted && currentModel !== "direct" && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-sodium/10 border border-sodium/20">
            <AlertTriangle className="h-4 w-4 text-sodium shrink-0 mt-0.5" />
            <div className="text-xs">
              <p className="font-medium text-sodium dark:text-sodium">
                {t("quotaExhaustedTitle")}
              </p>
              <p className="text-muted-foreground mt-0.5">
                {t("quotaExhaustedDesc", { used: certQuota?.used ?? 0, limit: certQuota?.limit ?? 0, resetIn: certQuota?.resetIn ?? "" })}
              </p>
            </div>
          </div>
        )}

        {/* Quota indicator when available but low */}
        {certQuota && certQuota.canIssueCertificate && certQuota.percentUsed >= 80 && (
          <p className="text-xs text-muted-foreground">
            {t("quotaIndicator", { used: certQuota.used, limit: certQuota.limit })}
          </p>
        )}

        {(switchMutation.isPending) && !reAuthPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="xs" />
            <span>{t("switchingModel")}</span>
          </div>
        )}

        {reAuthPending && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-sodium/10 border border-sodium/20">
            <Fingerprint className="h-4 w-4 text-cream/65 shrink-0 mt-0.5 animate-pulse" />
            <div className="text-xs">
              <p className="font-medium text-cream/65">
                {t("reauthRequired")}
              </p>
              <p className="text-muted-foreground mt-0.5">
                {t("reauthHint")}
              </p>
            </div>
          </div>
        )}

        {switchMutation.isError && (
          <p className="text-sm text-destructive">
            {switchMutation.error?.message || t("switchFailed")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
