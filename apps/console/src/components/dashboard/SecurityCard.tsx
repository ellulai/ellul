// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Shield,
  Terminal,
  Key,
  Copy,
  Check,
  AlertTriangle,
  Wifi,
  WifiOff,
  Power,
  Unplug,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { API_URL } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useVpsBridge } from "@/lib/vps-bridge";

interface SecurityCardProps {
  serverId: string;
  ipAddress: string;
  tier?: string;
}

interface AccessStatus {
  terminalEnabled: boolean;
  sshEnabled: boolean;
  hasSshKey: boolean;
  lastSyncAt: string | null;
  isSovereign: boolean;
}

export function SecurityCard({ serverId, ipAddress, tier }: SecurityCardProps) {
  const t = useTranslations("console.securityCard");
  // SSH user: free plan uses restricted "coder", everything else uses "dev"
  const sshUser = !tier || tier === "free" || tier.endsWith(":free") ? "coder" : "dev";
  const queryClient = useQueryClient();
  const bridge = useVpsBridge();
  const [copied, setCopied] = useState<string | null>(null);
  const [lastSyncAgo, setLastSyncAgo] = useState<string>("--");

  // Fetch current access status from VPS via bridge
  const { data: status, isLoading } = useQuery<AccessStatus>({
    queryKey: ["access-status", serverId],
    queryFn: async () => {
      try {
        const result = await bridge.send<{ terminalEnabled: boolean; sshEnabled: boolean }>("get_settings");
        return {
          terminalEnabled: result.terminalEnabled,
          sshEnabled: result.sshEnabled,
          hasSshKey: false, // SSH keys managed via SshKeysManager
          lastSyncAt: new Date().toISOString(),
          isSovereign: false,
        };
      } catch {
        // Fallback to API if bridge unavailable (e.g., no passkey yet)
        const response = await fetch(`${API_URL}/api/servers/${serverId}/terminal`, {
          credentials: "include",
        });
        if (!response.ok) throw new Error("Failed to fetch access status");
        const data = await response.json();
        return {
          terminalEnabled: data.terminal?.terminalEnabled ?? true,
          sshEnabled: data.terminal?.sshEnabled ?? false,
          hasSshKey: data.terminal?.hasSshKey ?? false,
          lastSyncAt: data.terminal?.lastSyncAt ?? null,
          isSovereign: data.terminal?.isSovereign ?? false,
        };
      }
    },
    enabled: bridge.ready,
  });

  // Update last sync time display
  useEffect(() => {
    const updateSyncAgo = () => {
      if (!status?.lastSyncAt) {
        setLastSyncAgo("--");
        return;
      }
      const diff = Date.now() - new Date(status.lastSyncAt).getTime();
      const seconds = Math.floor(diff / 1000);
      if (seconds < 60) {
        setLastSyncAgo(t("secondsAgo", { count: seconds }));
      } else if (seconds < 3600) {
        setLastSyncAgo(t("minutesAgo", { count: Math.floor(seconds / 60) }));
      } else {
        setLastSyncAgo(t("hoursAgo", { count: Math.floor(seconds / 3600) }));
      }
    };

    updateSyncAgo();
    const interval = setInterval(updateSyncAgo, 5000);
    return () => clearInterval(interval);
  }, [status?.lastSyncAt, t]);

  // Toggle terminal access via VPS bridge (passkey-authenticated)
  const toggleTerminalMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      return bridge.send("toggle_terminal", { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["access-status", serverId] });
    },
  });

  // Toggle SSH access via VPS bridge (passkey-authenticated)
  const toggleSshMutation = useMutation({
    mutationFn: async ({ enabled }: { enabled: boolean }) => {
      return bridge.send("toggle_ssh", { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["access-status", serverId] });
    },
  });

  const handleCopy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };


  // Handle SSH toggle — SSH keys are managed via SshKeysManager
  const handleSshToggle = (enabled: boolean) => {
    toggleSshMutation.mutate({ enabled });
  };

  // Calculate connection status
  const isConnected = status?.lastSyncAt
    ? Date.now() - new Date(status.lastSyncAt).getTime() < 5 * 60 * 1000
    : false;

  const isSovereign = status?.isSovereign ?? false;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Spinner size="lg" delay={300} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">{t("title")}</CardTitle>
          </div>
          {/* Heartbeat Status */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium",
                    isConnected
                      ? "bg-sodium/30 text-sodium"
                      : isSovereign
                        ? "bg-sodium text-cream/65 dark:bg-ink-2/30 dark:text-cream/65"
                        : "bg-terra text-terra dark:bg-terra/30 dark:text-terra"
                  )}
                >
                  {isConnected ? (
                    <Wifi className="h-3 w-3" />
                  ) : isSovereign ? (
                    <Unplug className="h-3 w-3" />
                  ) : (
                    <WifiOff className="h-3 w-3" />
                  )}
                  <span>
                    {isConnected ? t("connected") : isSovereign ? t("airGapped") : t("disconnected")}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                {isConnected ? (
                  <p>
                    {t("tooltipConnected")}
                    <br />
                    <span className="text-muted-foreground">
                      {t("lastSyncPrefix")} {lastSyncAgo}
                    </span>
                  </p>
                ) : isSovereign ? (
                  <p>
                    {t("tooltipAirGapped").split("\n").map((line, i, arr) => (
                      <span key={i}>{line}{i < arr.length - 1 && <br />}</span>
                    ))}
                  </p>
                ) : (
                  <p>
                    {t("tooltipDisconnected")}
                    <br />
                    <span className="text-muted-foreground">
                      {t("lastSyncPrefix")} {lastSyncAgo}
                    </span>
                  </p>
                )}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <CardDescription>
          {t("subtitle")}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Sovereign Mode Banner */}
        {isSovereign && (
          <div className="rounded-lg border border-sodium bg-sodium p-4 dark:border-sodium/50 dark:bg-ink-2/20">
            <div className="flex gap-3">
              <Unplug className="h-5 w-5 shrink-0 text-cream/65 dark:text-cream/65" />
              <div>
                <p className="font-medium text-cream/65 dark:text-cream/65">
                  {t("sovereignActive")}
                </p>
                <p className="mt-1 text-sm text-cream/65 dark:text-cream/65">
                  {t.rich("sovereignActiveBody", {
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Web Terminal Toggle */}
        <div className="rounded-lg border p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div
                className={cn(
                  "rounded-full p-2",
                  status?.terminalEnabled
                    ? "bg-sodium/30"
                    : "bg-muted"
                )}
              >
                <Terminal
                  className={cn(
                    "h-4 w-4",
                    status?.terminalEnabled
                      ? "text-sodium"
                      : "text-muted-foreground"
                  )}
                />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{t("webTerminalAccess")}</p>
                  <Badge
                    variant={status?.terminalEnabled ? "default" : "secondary"}
                    className="text-xs"
                  >
                    {status?.terminalEnabled ? t("enabled") : t("disabled")}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {status?.terminalEnabled ? (
                    t("webTerminalEnabledBody")
                  ) : (
                    t.rich("webTerminalDisabledBody", {
                      code: (chunks) => <code className="text-xs">{chunks}</code>,
                      strong: (chunks) => <strong>{chunks}</strong>,
                    })
                  )}
                </p>
              </div>
            </div>
            <Switch
              checked={status?.terminalEnabled ?? true}
              onCheckedChange={(checked: boolean) => toggleTerminalMutation.mutate(checked)}
              disabled={
                toggleTerminalMutation.isPending ||
                isSovereign ||
                !isConnected
              }
            />
          </div>

          {/* Process Status Indicator */}
          <div className="mt-3 flex items-center gap-2 rounded bg-muted/50 px-3 py-2 text-xs">
            <Power
              className={cn(
                "h-3 w-3",
                status?.terminalEnabled ? "text-sodium" : "text-muted-foreground"
              )}
            />
            <span className="text-muted-foreground">
              {t("ttydProcess")}{" "}
              <span
                className={
                  status?.terminalEnabled
                    ? "font-medium text-sodium"
                    : "font-medium text-muted-foreground"
                }
              >
                {status?.terminalEnabled ? t("running") : t("stopped")}
              </span>
            </span>
          </div>
        </div>

        {/* SSH Toggle */}
        <div className="rounded-lg border p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div
                className={cn(
                  "rounded-full p-2",
                  status?.sshEnabled
                    ? "bg-sodium dark:bg-sodium/30"
                    : "bg-muted"
                )}
              >
                <Key
                  className={cn(
                    "h-4 w-4",
                    status?.sshEnabled
                      ? "text-sodium dark:text-sodium"
                      : "text-muted-foreground"
                  )}
                />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{t("sshAccessTitle")}</p>
                  <Badge
                    variant={status?.sshEnabled ? "default" : "secondary"}
                    className="text-xs"
                  >
                    {status?.sshEnabled ? t("port22Open") : t("port22Closed")}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {status?.sshEnabled ? (
                    t("sshEnabledBody")
                  ) : (
                    t.rich("sshDisabledBody", {
                      strong: (chunks) => <strong>{chunks}</strong>,
                    })
                  )}
                </p>
                {status?.sshEnabled && (
                  <div className="mt-2 flex items-center gap-2">
                    <code className="rounded bg-muted px-2 py-1 text-xs">
                      ssh {sshUser}@{ipAddress}
                    </code>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => handleCopy(`ssh ${sshUser}@${ipAddress}`, "ssh")}
                    >
                      {copied === "ssh" ? (
                        <Check className="h-3 w-3 text-sodium" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </Button>
                  </div>
                )}
                {status?.hasSshKey && (
                  <div className="mt-3 rounded bg-sodium/[0.08] dark:bg-sodium/20 p-2.5 text-xs text-sodium dark:text-sodium">
                    <p className="font-medium">{t("sshKeyLockedTitle")}</p>
                    <p className="mt-1 text-sodium dark:text-sodium">
                      {t("sshKeyLockedBody")}
                    </p>
                    <code className="mt-1.5 block rounded bg-sodium dark:bg-sodium/40 px-2 py-1">
                      sudo setup-ssh-key &quot;ssh-ed25519 AAAA...&quot;
                    </code>
                  </div>
                )}
              </div>
            </div>
            <Switch
              checked={status?.sshEnabled ?? false}
              onCheckedChange={handleSshToggle}
              disabled={
                toggleSshMutation.isPending ||
                isSovereign ||
                !isConnected
              }
            />
          </div>

          {/* Firewall Status Indicator */}
          <div className="mt-3 flex items-center gap-2 rounded bg-muted/50 px-3 py-2 text-xs">
            <Power
              className={cn(
                "h-3 w-3",
                status?.sshEnabled ? "text-sodium" : "text-muted-foreground"
              )}
            />
            <span className="text-muted-foreground">
              {t("port22Label")}{" "}
              <span
                className={
                  status?.sshEnabled
                    ? "font-medium text-sodium dark:text-sodium"
                    : "font-medium text-muted-foreground"
                }
              >
                {status?.sshEnabled ? t("open") : t("closed")}
              </span>
            </span>
          </div>
        </div>

        {/* Enforcement Notice */}
        <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">
            {t.rich("enforcementNotice", {
              strong: (chunks) => <strong>{chunks}</strong>,
              code: (chunks) => <code className="text-xs">{chunks}</code>,
            })}
          </p>
        </div>


        {/* Sovereign Security Warning */}
        <div className="rounded-lg border border-sodium bg-sodium/[0.08] p-4 dark:border-sodium/50 dark:bg-sodium/20">
          <div className="flex gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0 text-sodium dark:text-sodium" />
            <div>
              <p className="font-medium text-sodium dark:text-sodium">
                {t("sovereignSecurityNotice")}
              </p>
              <p className="mt-1 text-sm text-sodium dark:text-sodium">
                {t.rich("sovereignSecurityBody", {
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
            </div>
          </div>
        </div>
      </CardContent>

    </Card>
  );
}
