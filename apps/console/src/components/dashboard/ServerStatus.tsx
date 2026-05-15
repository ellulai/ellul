// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Copy,
  CheckCircle2,
  ExternalLink,
  Terminal,
  Globe,

  AlertTriangle,
  RefreshCw,
  Zap,
  Clock,
} from "lucide-react";
import { api } from "@/lib/api";
import { EllulLogo } from "@ellul.ai/ui/ellul-logo";

interface Server {
  id: string;
  ipAddress: string | null;
  domain: string | null;
  createdAt: string;
  performanceStatus: "good" | "struggling";
  healthFlags?: string[] | null;
  size: string;
  sshEnabled: boolean;
  terminalEnabled: boolean;
  tier?: string;
  product?: string;
  serverPlan?: "free" | "hobby" | "pro";
  runtimeTier?: "shared" | "dedicated";
}

interface ServerStatusProps {
  server: Server;
  onRefresh?: () => void;
}

export function ServerStatus({ server, onRefresh }: ServerStatusProps) {
  const tStep = useTranslations("console.serverStatus.stepLabels");
  const t = useTranslations("console.serverStatus");
  const [copiedIP, setCopiedIP] = useState(false);
  const [copiedURL, setCopiedURL] = useState(false);

  // Server status (SSE pushes real-time updates via setQueryData)
  const { data: statusData, isLoading } = useQuery({
    queryKey: ["server-status"],
    queryFn: async () => {
      const response = await api.api.servers.status.$get();
      if (!response.ok) {
        throw new Error(t("fetchFailed"));
      }
      return response.json();
    },
    staleTime: Infinity, // SSE pushes updates — no need for background refetches
  });

  const currentServer = (statusData as { server?: Server })?.server || server;
  const state = (statusData as { state?: string })?.state || "provisioning";
  const operation = (statusData as { operation?: { step: string; label: string; isReady: boolean } })?.operation;

  // Only consider "running" when provisioning is fully complete
  const isReady = operation?.isReady ?? false;
  const isProvisioning = state === "provisioning" || state === "creating" || (state === "running" && !isReady);
  const isActive = state === "running" && isReady;
  const isError = state === "error";

  // Calculate progress percentage based on step
  const operationSteps = ["starting", "packages", "nodejs", "devtools", "configuring", "ready"];
  const currentStepIndex = operationSteps.indexOf(operation?.step || "starting");
  const progressPercent = Math.round(((currentStepIndex + 1) / operationSteps.length) * 100);

  // Use domain from API (Cloudflare custom domain or sslip.io fallback)
  const serverDomain = currentServer.domain || (currentServer.ipAddress
    ? `${currentServer.ipAddress.replace(/\./g, "-")}.sslip.io`
    : null);

  const liveUrl = serverDomain ? `https://${serverDomain}` : null;
  const sshUser = currentServer.serverPlan === "free" ? "coder" : "dev";
  const sshUri = currentServer.ipAddress
    ? `ssh://${sshUser}@${currentServer.ipAddress}`
    : null;

  const copyToClipboard = async (text: string, type: "ip" | "url") => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === "ip") {
        setCopiedIP(true);
        setTimeout(() => setCopiedIP(false), 2000);
      } else {
        setCopiedURL(true);
        setTimeout(() => setCopiedURL(false), 2000);
      }
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  };

  const handleOpenTermius = () => {
    if (sshUri) {
      window.location.href = sshUri;
    }
  };

  const handleOpenLiveUrl = () => {
    if (liveUrl) {
      window.open(liveUrl, "_blank");
    }
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <EllulLogo className="h-5 w-5 text-primary" />
            <CardTitle>{t("title")}</CardTitle>
          </div>
          <Badge
            variant={
              isActive ? "default" : isError ? "destructive" : "secondary"
            }
            className="capitalize"
          >
            {isProvisioning && <Spinner size="xs" className="mr-1" />}
            {isActive && <CheckCircle2 className="h-3 w-3 mr-1" />}
            {isError && <AlertTriangle className="h-3 w-3 mr-1" />}
            {state === "running" ? t("stateActive") : state}
          </Badge>
        </div>
        <CardDescription>
          {isProvisioning
            ? t("descriptionProvisioning")
            : isActive
              ? t("descriptionActive")
              : t("descriptionError")}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Provisioning Progress */}
        {isProvisioning && (
          <div className="space-y-6">
            <div className="flex items-center justify-center py-6">
              <div className="relative">
                <div className="w-16 h-16 rounded-full border-4 border-primary/20" />
                <div className="absolute inset-0 w-16 h-16 rounded-full border-4 border-primary border-t-transparent animate-spin" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <EllulLogo className="h-6 w-6 text-primary" />
                </div>
              </div>
            </div>

            {/* Progress bar */}
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{(() => {
                  // Re-derive the label from operation.step rather than trusting
                  // operation.label, which on the initial /api/servers/status
                  // fetch comes back baked in English from the API server.
                  const step = operation?.step;
                  if (step === "starting") return tStep("starting_dots");
                  if (step === "writing_files") return tStep("writing_files");
                  if (step === "packages") return tStep("packages_dots");
                  if (step === "nodejs") return tStep("nodejs_dots");
                  if (step === "devtools") return tStep("devtools");
                  if (step === "opencode") return tStep("opencode_dots");
                  if (step === "configuring") return tStep("configuring_dots");
                  if (step === "services") return tStep("services");
                  if (step === "ready") return tStep("ready");
                  return tStep("starting_dots");
                })()}</span>
                <span>{progressPercent}%</span>
              </div>
              <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                <div
                  className="bg-primary h-full rounded-full transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>

            {/* Step indicators */}
            <div className="space-y-2">
              {[
                { key: "starting", label: tStep("starting") },
                { key: "packages", label: tStep("packages") },
                { key: "nodejs", label: tStep("nodejs") },
                { key: "devtools", label: tStep("opencode") },
                { key: "configuring", label: tStep("configuring") },
              ].map((step, index) => {
                const stepIndex = operationSteps.indexOf(step.key);
                const isComplete = currentStepIndex > stepIndex;
                const isCurrent = currentStepIndex === stepIndex;
                return (
                  <div
                    key={step.key}
                    className={`flex items-center gap-2 text-sm ${
                      isComplete
                        ? "text-primary"
                        : isCurrent
                          ? "text-foreground"
                          : "text-muted-foreground"
                    }`}
                  >
                    {isComplete ? (
                      <CheckCircle2 className="h-4 w-4 text-sodium" />
                    ) : isCurrent ? (
                      <Spinner size="sm" />
                    ) : (
                      <div className="h-4 w-4 rounded-full border border-muted-foreground/30" />
                    )}
                    <span>{step.label}</span>
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-center text-muted-foreground">
              {t("estimatedTime")}
            </p>
          </div>
        )}

        {/* Error State */}
        {isError && (
          <div className="space-y-4">
            <div className="flex items-center justify-center py-8">
              <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
                <AlertTriangle className="h-8 w-8 text-destructive" />
              </div>
            </div>
            <p className="text-sm text-center text-muted-foreground">
              {(statusData as { errorReason?: string })?.errorReason ||
                t("errorFallback")}
            </p>
            <Button
              variant="outline"
              className="w-full"
              onClick={async () => {
                try {
                  const serverId = (statusData as { server?: { id: string } })?.server?.id;
                  if (!serverId) { onRefresh?.(); return; }
                  const res = await fetch(`/api/servers/${serverId}/retry`, {
                    method: "POST",
                    credentials: "include",
                  });
                  if (res.ok) {
                    onRefresh?.();
                  } else {
                    const data = await res.json().catch(() => ({}));
                    console.error("Retry failed:", data.error || res.statusText);
                    onRefresh?.();
                  }
                } catch {
                  onRefresh?.();
                }
              }}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              {t("retry")}
            </Button>
          </div>
        )}

        {/* Active Server Details */}
        {isActive && currentServer.ipAddress && (
          <div className="space-y-4">
            {/* IP Address */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground">
                {t("ipAddressLabel")}
              </label>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-muted rounded-md font-mono text-sm">
                  {currentServer.ipAddress}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copyToClipboard(currentServer.ipAddress!, "ip")}
                  className="shrink-0"
                >
                  {copiedIP ? (
                    <CheckCircle2 className="h-4 w-4 text-sodium" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="grid grid-cols-2 gap-3">
              {/* Open in Termius */}
              <Button
                variant="default"
                onClick={handleOpenTermius}
                className="gap-2"
              >
                <Terminal className="h-4 w-4" />
                {t("openTermius")}
              </Button>

              {/* Live URL */}
              <Button
                variant="outline"
                onClick={handleOpenLiveUrl}
                className="gap-2"
              >
                <Globe className="h-4 w-4" />
                {t("liveUrl")}
                <ExternalLink className="h-3 w-3" />
              </Button>
            </div>

            {/* Live URL Display */}
            {liveUrl && (
              <div className="space-y-2">
                <label className="text-sm font-medium text-muted-foreground">
                  {t("siteUrlLabel")}
                </label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-muted rounded-md font-mono text-xs truncate">
                    {liveUrl}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => copyToClipboard(liveUrl, "url")}
                    className="shrink-0"
                  >
                    {copiedURL ? (
                      <CheckCircle2 className="h-4 w-4 text-sodium" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("siteUrlHint")}
                </p>
              </div>
            )}

            {/* Degraded Subsystem Warnings */}
            {currentServer.healthFlags && currentServer.healthFlags.length > 0 && (
              <div className="rounded-lg border border-sodium bg-sodium/[0.08] dark:border-sodium dark:bg-sodium/[0.06] p-3">
                <p className="text-sm text-sodium dark:text-sodium flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  {t("degradedSubsystems", {
                    flags: currentServer.healthFlags
                      .map((f) => f.replace("error_", ""))
                      .join(", "),
                  })}
                </p>
              </div>
            )}

            {/* Performance Warning */}
            {currentServer.performanceStatus === "struggling" && (
              <div className="rounded-lg border border-sodium bg-sodium/[0.08] dark:border-sodium dark:bg-sodium/[0.06] p-3">
                <p className="text-sm text-sodium dark:text-sodium flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                  {t("performanceWarning")}
                </p>
              </div>
            )}

            {/* Connection Info */}
            <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
              <p className="text-sm font-medium">{t("sshConnection")}</p>
              <code className="block text-xs font-mono text-muted-foreground">
                ssh {sshUser}@{currentServer.ipAddress}
              </code>
              <p className="text-xs text-muted-foreground">
                {t("teleportNote")}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
