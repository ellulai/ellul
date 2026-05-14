// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Shield, Lock, Unlock, Eye, Terminal, Database, Clock, X, AlertTriangle, GitBranch, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useWorkbenchOptional, type GateType } from "@/contexts/WorkbenchContext";
import { usePermissionInboxOptional, type InboxRequest } from "@/contexts/PermissionInboxContext";

// Visual + behavioural metadata only. User-visible label / description /
// warning / TTL strings live in console.gates.{gate}.* — consumers read
// them via tGates(). Kept here so the dashboard can pick the right icon,
// risk variant, and one-time-vs-window flow per gate without a JSON round
// trip.
export const GATE_CONFIG: Record<GateType, {
  icon: typeof Eye;
  color: string;        // tailwind color token (orange, red, amber)
  bgRing: string;       // icon container bg
  iconColor: string;    // icon color class
  riskLevel: "elevated" | "high";
  riskVariant: "warning" | "destructive";
  accessModel: "timed_window" | "one_time_token";
}> = {
  logs: {
    icon: Eye,
    color: "orange",
    bgRing: "bg-sodium/30",
    iconColor: "text-sodium",
    riskLevel: "elevated",
    riskVariant: "warning",
    accessModel: "timed_window",
  },
  env: {
    icon: Terminal,
    color: "red",
    bgRing: "bg-terra/[0.08]",
    iconColor: "text-terra",
    riskLevel: "high",
    riskVariant: "destructive",
    accessModel: "timed_window",
  },
  db: {
    icon: Database,
    color: "amber",
    bgRing: "bg-sodium/[0.06]",
    iconColor: "text-sodium",
    riskLevel: "elevated",
    riskVariant: "warning",
    accessModel: "timed_window",
  },
  db_read: {
    icon: Database,
    color: "amber",
    bgRing: "bg-sodium/[0.06]",
    iconColor: "text-sodium",
    riskLevel: "elevated",
    riskVariant: "warning",
    accessModel: "timed_window",
  },
  db_write: {
    icon: Database,
    color: "amber",
    bgRing: "bg-sodium/[0.06]",
    iconColor: "text-sodium",
    riskLevel: "high",
    riskVariant: "destructive",
    accessModel: "timed_window",
  },
  db_migrate: {
    icon: Database,
    color: "red",
    bgRing: "bg-terra/[0.08]",
    iconColor: "text-terra",
    riskLevel: "high",
    riskVariant: "destructive",
    accessModel: "one_time_token",
  },
  db_full: {
    icon: Database,
    color: "red",
    bgRing: "bg-terra/[0.08]",
    iconColor: "text-terra",
    riskLevel: "high",
    riskVariant: "destructive",
    accessModel: "one_time_token",
  },
  git: {
    icon: GitBranch,
    color: "purple",
    bgRing: "bg-sodium/30",
    iconColor: "text-cream/65",
    riskLevel: "high",
    riskVariant: "destructive",
    accessModel: "one_time_token",
  },
  deploy: {
    icon: Rocket,
    color: "red",
    bgRing: "bg-terra/[0.08]",
    iconColor: "text-terra",
    riskLevel: "high",
    riskVariant: "destructive",
    accessModel: "one_time_token",
  },
};

export function formatRemaining(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min > 0) return `${min}m ${sec.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}

// `selectThread` so we never show a modal scoped to a thread that isn't
// active. This effect doubles as a belt-and-braces check.
export function GateRequestDialog() {
  const t = useTranslations("console.gates.request");
  const tGates = useTranslations("console.gates");
  const ctx = useWorkbenchOptional();
  const inbox = usePermissionInboxOptional();
  const [responding, setResponding] = useState<string | null>(null);
  const [dismissedRequestId, setDismissedRequestId] = useState<string | null>(null);

  const respondToGateRequest = ctx?.respondToGateRequest;
  const activeThreadId = ctx?.activeThreadId ?? null;
  const gateGrantError = ctx?.gateGrantError ?? null;

  useEffect(() => {
    setDismissedRequestId(null);
  }, [activeThreadId]);

  const pending: InboxRequest | null = activeThreadId
    ? (inbox?.byThread(activeThreadId)[0] ?? null)
    : null;
  const showModal = pending && pending.id !== dismissedRequestId;

  useEffect(() => {
    setResponding(null);
  }, [pending?.id]);

  useEffect(() => {
    if (!pending) return;
    inbox?.markSeen(pending.id);
  }, [pending?.id, inbox]);

  const handleRespond = useCallback(async (action: "grant_timed" | "grant_session" | "grant_always" | "deny" | "deny_always") => {
    if (!pending || !respondToGateRequest) return;
    const gateLabel = tGates(`${pending.gate}.label` as `logs.label`);
    const scope = pending.sandboxId || t("thisSandbox");
    setResponding(action);
    const ok = await respondToGateRequest(pending.id, action);
    if (!ok) {
      setResponding(null);
      return;
    }
    if (action === "deny") {
      toast.error(t("deniedToast", { gate: gateLabel }));
    } else if (action === "deny_always") {
      toast.error(t("neverAllowToast", { gate: gateLabel, scope }));
    } else if (action === "grant_always") {
      toast.success(t("alwaysApproveToast", { gate: gateLabel, scope }));
    } else {
      toast.success(t("grantedToast", { gate: gateLabel }));
    }
  }, [pending, respondToGateRequest, t, tGates]);

  if (!showModal || !pending) return null;

  const gateKey = pending.gate as GateType;
  const config = GATE_CONFIG[gateKey];
  if (!config) return null;
  const Icon = config.icon;
  const gateLabel = tGates(`${gateKey}.label` as `logs.label`);
  const gateDescription = tGates(`${gateKey}.description` as `logs.description`);
  const gateTtl = tGates(`${gateKey}.ttl` as `logs.ttl`);
  let gateWarning: string | null = null;
  try {
    gateWarning = tGates(`${gateKey}.warning` as `env.warning`);
  } catch {
    gateWarning = null;
  }
  const scope = pending.sandboxId || t("thisSandbox");

  return (
    <Dialog open onOpenChange={(open) => { if (!open) setDismissedRequestId(pending.id); }}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle className="flex items-center gap-2">
              <Shield className={`h-5 w-5 ${config.iconColor}`} />
              {t("title", { gate: gateLabel })}
            </DialogTitle>
            <Badge variant={config.riskVariant}>
              {config.riskLevel === "high" ? t("highRisk") : t("elevatedRisk")}
            </Badge>
          </div>
          <DialogDescription>
            {t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="flex items-start gap-3 rounded-lg border border-cream/[0.08] bg-cream/[0.03] p-3">
            <div className={`rounded-full p-2 ${config.bgRing}`}>
              <Icon className={`h-4 w-4 ${config.iconColor}`} />
            </div>
            <div className="flex-1">
              <p className="font-medium text-sm">{gateDescription}</p>
              <div className="flex items-center gap-1.5 mt-1 text-xs text-cream/60">
                <Clock className="h-3 w-3" />
                <span>{t("expiresAfter", { ttl: gateTtl })}</span>
              </div>
            </div>
          </div>

          {gateWarning && (
            <div className="flex items-start gap-2 rounded-lg border border-terra/20 bg-terra/5 p-3">
              <AlertTriangle className="h-4 w-4 text-terra shrink-0 mt-0.5" />
              <p className="text-xs text-terra/90">{gateWarning}</p>
            </div>
          )}

          {config.accessModel === "one_time_token" && (
            <div className="flex items-start gap-2 rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-3">
              <Shield className="h-4 w-4 text-cream/60 shrink-0 mt-0.5" />
              <p className="text-xs text-cream/60">
                {t("alwaysApproveExplainer")}
              </p>
            </div>
          )}

          {pending.reason && (
            <div className="rounded-lg bg-cream/[0.03] border border-cream/[0.06] p-3">
              <p className="text-xs text-cream/45 uppercase tracking-wide mb-1">{t("agentReason")}</p>
              <p className="text-sm text-cream/75 italic">&ldquo;{pending.reason}&rdquo;</p>
            </div>
          )}

          {gateGrantError && (
            <div className="flex items-start gap-2 rounded-lg border border-terra/20 bg-terra/5 p-3">
              <AlertTriangle className="h-4 w-4 text-terra shrink-0 mt-0.5" />
              <p className="text-xs text-terra/90">{gateGrantError}</p>
            </div>
          )}
        </div>

        <DialogFooter className="grid grid-cols-2 gap-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  onClick={() => handleRespond("deny")}
                  loading={responding === "deny"}
                  className="w-full"
                >
                  <Lock className="h-3.5 w-3.5 mr-1.5" />
                  {t("deny")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("denyTooltip")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  onClick={() => handleRespond("grant_timed")}
                  loading={responding === "grant_timed"}
                  className="w-full"
                >
                  <Unlock className="h-3.5 w-3.5 mr-1.5" />
                  {t("allowOnce")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("allowOnceTooltip", { ttl: gateTtl })}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  onClick={() => handleRespond("deny_always")}
                  loading={responding === "deny_always"}
                  className="w-full border-terra/30 text-terra hover:bg-terra/10"
                >
                  <Lock className="h-3.5 w-3.5 mr-1.5" />
                  {t("neverAllow")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("neverAllowTooltip", { scope })}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={() => handleRespond("grant_always")}
                  loading={responding === "grant_always"}
                  className="w-full"
                >
                  <Shield className="h-3.5 w-3.5 mr-1.5" />
                  {t("alwaysApprove")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("alwaysApproveTooltip", { scope })}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// GateStatusBar: compact status indicator for active gates.
export function GateStatusBar() {
  const t = useTranslations("console.gates.statusBar");
  const tGates = useTranslations("console.gates");
  const ctx = useWorkbenchOptional();
  const [now, setNow] = useState(Date.now());

  const gateStatus = ctx?.gateStatus;
  const revokeGate = ctx?.revokeGate;

  const openGates = gateStatus
    ? (Object.entries(gateStatus) as [GateType, typeof gateStatus.logs][]).filter(([, info]) => info.active)
    : [];

  // Drop gates whose TTL has visually expired — the server still reports them
  const visibleGates = openGates.filter(([, info]) =>
    info.expiresAt == null || info.expiresAt - now > 0,
  );

  // Tick every second for countdown
  useEffect(() => {
    if (openGates.length === 0) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [openGates.length]);

  if (visibleGates.length === 0) return null;

  return (
    <TooltipProvider>
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-sodium/10 border border-sodium/20 text-xs">
        <Shield className="h-3 w-3 text-sodium" />
        <span className="text-sodium font-medium">{t("open")}</span>
        {visibleGates.map(([gate, info]) => {
          const config = GATE_CONFIG[gate];
          const Icon = config.icon;
          const remaining = info.expiresAt ? info.expiresAt - now : null;
          const isUrgent = remaining !== null && remaining < 30_000;
          const gateLabel = tGates(`${gate}.label` as `logs.label`);

          return (
            <Tooltip key={gate}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => revokeGate?.(gate)}
                  className={`flex items-center gap-1 px-2 py-0.5 rounded-full transition-colors cursor-pointer ${
                    isUrgent
                      ? "bg-terra/15 text-terra hover:bg-terra/25"
                      : "bg-cream/[0.06] text-cream/75 hover:bg-cream/[0.12]"
                  }`}
                >
                  <Icon className="h-3 w-3" />
                  <span>{gateLabel}</span>
                  {remaining !== null && (
                    <span className="tabular-nums font-mono text-[10px] opacity-80">
                      {formatRemaining(remaining)}
                    </span>
                  )}
                  <X className="h-2.5 w-2.5 opacity-50" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("revokeTooltip", { gate: gateLabel })}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
