// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Clock,
  Copy,
  CheckCircle,
  AlertTriangle,
  Trash2,
  Activity,
  RotateCcw,
  History,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WebLockCard } from "../WebLockCard";
import { TunnelCard } from "../TunnelCard";
import { getRegionDisplayName } from "@/lib/region-names";
import { getRuntimeTierLabel, isDedicatedRuntime } from "@/lib/tier-utils";
import { TierSelector } from "../TierSelector";
import { VpsUpdateBanner } from "../VpsUpdateBanner";
import { AgentUpdateBanner } from "../AgentUpdateBanner";
import { AdapterUpdateBanner } from "../AdapterUpdateBanner";
import { BuildAttestationBadge } from "../BuildAttestationBadge";
import type { ServerStatus } from "@/contexts/DashboardContext";
import { isLocalServer } from "@/lib/domains";
import { LanguagePicker } from "../LanguagePicker";
import { toast } from "sonner";

const PLAN_DISPLAY: Record<string, { capacity: string; label: string }> = {
  "cloud_platform:hobby": { capacity: "1 workspace", label: "Hobby" },
  "cloud_platform:pro": { capacity: "5 workspaces", label: "Pro" },
  "shield_proxy:pro": { capacity: "Proxy only", label: "Shield Gateway" },
  "byos:pro": { capacity: "Unlimited workspaces", label: "BYOS" },
};

interface TabHomeProps {
  server: {
    id: string;
    ipAddress: string;
    domain?: string;
    state: string;
    performanceStatus: "good" | "struggling";
    size: string;
    createdAt: string;
    terminalEnabled: boolean;
    sshEnabled: boolean;
    securityTier?: "standard" | "web_locked" | "private_locked";
    serverPlan?: "free" | "hobby" | "pro";
    runtimeTier?: "shared" | "dedicated";
    product?: string;
    platformVersion?: string | null;
    volumeSecurityMode?: "standard" | "enhanced" | "sovereign" | null;
    region?: string | null;
  };
  plan: string;
  onDeleteServer: () => void;
  isDeleting?: boolean;
  onRebuildServer?: () => void;
  isRebuilding?: boolean;
  onRollbackServer?: () => void;
  isRollingBack?: boolean;
  // Pre-rebuild snapshot expiry (used by the rebuild-rollback dialog). Independent of agent manifest.
  snapshotExpiresAt?: string | null;
  agentUpdate?: ServerStatus["agentUpdate"];
  adapterUpdates?: ServerStatus["adapterUpdates"];
  onUpdateServer?: () => void;
  isUpdating?: boolean;
  onSetAgentUpdateMode?: (mode: "auto" | "manual") => void;
  isSettingAgentUpdateMode?: boolean;
  onUpgrade?: () => void;
  onResetWorkspace?: () => Promise<void>;
  // Render only a specific section of the settings. Omit to render all.
  section?: "server" | "billing";
}

export function TabHome({
  server,
  plan,
  onDeleteServer,
  isDeleting,
  onRebuildServer,
  isRebuilding,
  onRollbackServer,
  isRollingBack,
  snapshotExpiresAt,
  agentUpdate,
  adapterUpdates,
  onUpdateServer,
  isUpdating,
  onSetAgentUpdateMode,
  isSettingAgentUpdateMode,
  onUpgrade,
  onResetWorkspace,
  section,
}: TabHomeProps) {
  const t = useTranslations("console.tabHome");
  const tRegions = useTranslations("console.lib.regions");
  const [copiedIP, setCopiedIP] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showRebuildDialog, setShowRebuildDialog] = useState(false);
  const [showRollbackDialog, setShowRollbackDialog] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState("");
  const [isResetting, setIsResetting] = useState(false);

  // Block destructive actions during active operations
  const isOperationActive = ["upgrading", "downgrading", "waking", "hibernating", "creating", "provisioning"].includes(server.state);

  const serverDomain = server.domain || server.ipAddress.replace(/\./g, "-") + ".sslip.io";
  const planKey = server.product ? `${server.product}:${plan}` : `cloud_platform:${plan}`;
  // Map plan key to localized labels.
  const localizedPlanFor = (key: string): { capacity: string; label: string } => {
    if (key === "cloud_platform:pro") return { capacity: t("planDisplay.proCapacity"), label: t("planDisplay.proLabel") };
    if (key === "cloud_platform:hobby") return { capacity: t("planDisplay.hobbyCapacity"), label: t("planDisplay.hobbyLabel") };
    if (key === "shield_proxy:pro") return { capacity: t("planDisplay.shieldGatewayCapacity"), label: t("planDisplay.shieldGatewayLabel") };
    if (key === "byos:pro") return { capacity: t("planDisplay.byosCapacity"), label: t("planDisplay.byosLabel") };
    return PLAN_DISPLAY[key] || { capacity: t("planDisplay.hobbyCapacity"), label: plan === "pro" ? t("planDisplay.proLabel") : t("planDisplay.hobbyLabel") };
  };
  const serverSpecs = localizedPlanFor(planKey);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIP(true);
      toast.success(t("copiedToClipboard"));
      setTimeout(() => setCopiedIP(false), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      toast.success(t("copiedToClipboard"));
    }
  };

  const stats = {
    uptime: getUptime(server.createdAt),
  };

  const isLocal = isLocalServer(server);
  const showServer = !section || section === "server";
  const showBilling = !section || section === "billing";

  return (
    <div>
      {/* Main Content */}
      <div className="p-4 space-y-5">
        {/* Update Banner — shown when VPS is missing newer features */}
        {showServer && !isLocal && <VpsUpdateBanner />}

        {/* Agent manifest self-update — pending manifest + mode badge + Update Now. */}
        {showServer && !isLocal && agentUpdate && (
          <AgentUpdateBanner
            agentUpdate={agentUpdate}
            onUpdateServer={onUpdateServer}
            isUpdating={isUpdating}
            onSetMode={onSetAgentUpdateMode}
            isSettingMode={isSettingAgentUpdateMode}
            isOperationActive={isOperationActive}
          />
        )}

        {/* Adapter version updates (CLI tool auto-update banners) */}
        {showServer && adapterUpdates && Object.keys(adapterUpdates).length > 0 && (
          <AdapterUpdateBanner adapterUpdates={adapterUpdates} />
        )}

        {/* ─── General (Server info) ─── */}
        {showServer && (
          <section id="settings-general" className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] overflow-hidden">
            <div className="px-4 py-3 border-b border-cream/[0.04]">
              <h3 className="text-sm font-medium text-cream">{t("general")}</h3>
              <p className="text-[10px] text-cream/45 mt-0.5">{t("generalSubtitle")}</p>
            </div>

            <div className="p-4 space-y-4">
              {/* Plan & Uptime */}
              <div className={`${isLocal ? "" : "grid grid-cols-2"} gap-3 pb-4 border-b border-cream/[0.04]`}>
                <div className="flex items-center gap-2 sm:gap-3">
                  <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center shrink-0 bg-cream/[0.04]">
                    <Activity className="h-4 w-4 sm:h-5 sm:w-5 text-cream/60" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] sm:text-xs text-cream/60">{t("plan")}</p>
                    <p className="text-base sm:text-lg font-semibold text-cream">{isLocal ? "Free" : serverSpecs.label}</p>
                    {!isLocal && (
                      <div className="flex items-center gap-1.5">
                        <p className="text-[9px] sm:text-[10px] text-cream/45 hidden sm:block">{serverSpecs.capacity}</p>
                        <span className={`text-[9px] sm:text-[10px] px-1.5 py-0.5 rounded-full hidden sm:inline-block ${
                          isDedicatedRuntime(server.runtimeTier)
                            ? "bg-sodium/10 text-sodium"
                            : "bg-cream/[0.04] text-cream/60"
                        }`}>
                          {getRuntimeTierLabel(server.runtimeTier)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                {!isLocal && (
                  <div className="flex items-center gap-2 sm:gap-3">
                    <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center shrink-0 bg-cream/[0.04]">
                      <Clock className="h-4 w-4 sm:h-5 sm:w-5 text-cream/60" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-[10px] sm:text-xs text-cream/60">{t("uptime")}</p>
                      <p className="text-base sm:text-lg font-semibold text-cream">{stats.uptime}</p>
                      <p className="text-[9px] sm:text-[10px] text-cream/45 truncate hidden sm:block">{t("since", { date: new Date(server.createdAt).toLocaleDateString() })}</p>
                    </div>
                  </div>
                )}
              </div>

              {/* IP Address — hidden on local (always localhost) */}
              {!isLocal && (
              <div>
                <label className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">
                  {t("ipAddress")}
                </label>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="flex-1 px-3 py-2 bg-cream/[0.02] border border-cream/[0.06] rounded-lg font-mono text-xs text-cream/85 truncate">
                    {server.ipAddress}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 h-8 w-8 text-cream/60 hover:text-cream hover:bg-cream/[0.06]"
                    onClick={() => copyToClipboard(server.ipAddress)}
                  >
                    {copiedIP ? (
                      <CheckCircle className="h-4 w-4 text-sodium" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
              )}

              {/* Region */}
              {server.region && (
                <div>
                  <label className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">
                    {t("region")}
                  </label>
                  <div className="mt-1.5 px-3 py-2 bg-cream/[0.02] border border-cream/[0.06] rounded-lg text-xs text-cream/85">
                    {getRegionDisplayName(server.region, (key) => tRegions(key as never))}
                  </div>
                </div>
              )}

              {/* Platform version readout — supplementary to the banner above.
                  Always visible so users have a single place to check what's
                  actually running even when no banner is showing. The Build
                  Attestation chip is capability-gated on self-hash-attest.v1
                  and only renders when the VPS is actively stamping a
                  runtime sha256 suffix into its agentVersion ping field. */}
              {server.platformVersion && (
                <div>
                  <label className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">
                    {t("platformVersion")}
                  </label>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    <div className="flex-1 min-w-0 px-3 py-2 bg-cream/[0.02] border border-cream/[0.06] rounded-lg text-xs text-cream/85 font-mono">
                      {server.platformVersion}
                    </div>
                    {agentUpdate && (
                      <HealthChip
                        status={agentUpdate.healthStatus}
                        lastInstallError={agentUpdate.lastInstallError}
                      />
                    )}
                    <BuildAttestationBadge />
                  </div>
                </div>
              )}

              {/* Performance Warning */}
              {server.performanceStatus === "struggling" && (
                <div className="rounded-lg border border-sodium/20 bg-sodium/5 p-3">
                  <div className="flex gap-2">
                    <AlertTriangle className="h-4 w-4 text-sodium shrink-0" />
                    <div>
                      <p className="text-xs font-medium text-sodium">{t("highUsage")}</p>
                      <p className="text-[10px] text-sodium/70 mt-0.5">
                        {t("highUsageHint")}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ─── Billing (Plan & Tier) — hidden in local mode ─── */}
        {showBilling && !isLocal && (
          <section id="settings-billing" className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] overflow-hidden">
            <div className="px-4 py-3 border-b border-cream/[0.04]">
              <h3 className="text-sm font-medium text-cream">{t("billingTitle")}</h3>
              <p className="text-[10px] text-cream/45 mt-0.5">{t("billingSubtitle")}</p>
            </div>
            <div className="p-4 space-y-4">
              <div className="space-y-3">
                <div>
                  <label className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">{t("currentPlan")}</label>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-sm font-semibold text-cream">{serverSpecs.label}</span>
                    <span className="text-xs text-cream/60">{serverSpecs.capacity}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                      isDedicatedRuntime(server.runtimeTier)
                        ? "bg-sodium/10 text-sodium"
                        : "bg-cream/[0.04] text-cream/60"
                    }`}>
                      {getRuntimeTierLabel(server.runtimeTier)}
                    </span>
                  </div>
                </div>
                <TierSelector serverId={server.id} />
              </div>
            </div>
          </section>
        )}

        {/* Rollback Recovery — contextual, cloud VPS only */}
        {showServer && !isLocal && onRollbackServer && (
          <section className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] overflow-hidden">
            <div className="px-4 py-3 border-b border-cream/[0.04]">
              <h3 className="text-sm font-medium text-cream">{t("updateRecovery")}</h3>
              <p className="text-[10px] text-cream/45 mt-0.5">{t("updateRecoverySubtitle")}</p>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-xs text-cream/60">
                {t("updateRecoveryDescription")}
                {snapshotExpiresAt && (
                  <span className="block mt-1 text-cream/45">
                    {t("expires", { date: new Date(snapshotExpiresAt).toLocaleString() })}
                  </span>
                )}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="w-full border-cream/[0.08] text-cream/75 hover:bg-cream/[0.04] hover:text-cream text-xs"
                onClick={() => setShowRollbackDialog(true)}
                disabled={isRollingBack || isOperationActive}
              >
                {isRollingBack ? (
                  <><Spinner size="sm" delay={300} className="mr-2" /> {t("rollingBack")}</>
                ) : (
                  <><History className="h-3.5 w-3.5 mr-2" /> {t("rollback")}</>
                )}
              </Button>
            </div>
          </section>
        )}

        {/* ─── Environment Lock — hidden in local mode ─── */}
        {showServer && !isLocal && (
          <div id="settings-security">
            <WebLockCard serverId={server.id} serverDomain={serverDomain} serverIp={server.ipAddress} onUpgrade={onUpgrade} volumeSecurityMode={server.volumeSecurityMode} product={server.product} />
          </div>
        )}

        {/* ─── Tunnel (Android only — hidden for cloud VPS) ─── */}
        {showServer && !server.domain && (
          <div id="settings-tunnel">
            <TunnelCard />
          </div>
        )}

        {/* ─── Language (local only — merged from appearance tab) ─── */}
        {showServer && isLocal && (
          <section className="rounded-xl border border-cream/[0.06] bg-cream/[0.02]">
            <div className="px-4 py-3 border-b border-cream/[0.04]">
              <h3 className="text-sm font-medium text-cream">Language</h3>
            </div>
            <div className="p-4">
              <LanguagePicker className="w-full" />
            </div>
          </section>
        )}

        {/* ─── Reset Workspace (local only) ─── */}
        {showServer && isLocal && (
          <section id="settings-reset" className="rounded-xl border border-terra/20 bg-terra/[0.03] overflow-hidden">
            <div className="px-4 py-3 border-b border-terra/10">
              <h3 className="text-sm font-medium text-terra">{t("resetWorkspace")}</h3>
              <p className="text-[10px] text-cream/45 mt-0.5">{t("resetWorkspaceSubtitle")}</p>
            </div>
            <div className="p-4">
              <Button
                variant="outline"
                size="sm"
                className="w-full border-terra/20 text-terra hover:bg-terra/10 hover:text-terra text-xs"
                onClick={() => setShowResetDialog(true)}
                disabled={isResetting}
              >
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                {t("resetWorkspaceButton")}
              </Button>
            </div>
          </section>
        )}

        {/* ─── Danger Zone — hidden in local mode ─── */}
        {showServer && !isLocal && <section id="settings-danger" className="rounded-xl border border-terra/20 bg-terra/[0.03] overflow-hidden">
          <div className="px-4 py-3 border-b border-terra/10">
            <h3 className="text-sm font-medium text-terra">{t("dangerZone")}</h3>
            <p className="text-[10px] text-cream/45 mt-0.5">{t("dangerSubtitle")}</p>
          </div>
          <div className="p-4">
          <div className="space-y-2">
            {onRebuildServer && (
              <Button
                variant="outline"
                size="sm"
                className="w-full border-sodium/20 text-sodium hover:bg-sodium/10 hover:text-sodium text-xs"
                onClick={() => setShowRebuildDialog(true)}
                disabled={isOperationActive}
                title={isOperationActive ? t("cannotRebuild", { state: server.state }) : undefined}
              >
                <RotateCcw className="h-3.5 w-3.5 mr-2" />
                {t("rebuildServer")}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="w-full border-terra/20 text-terra hover:bg-terra/10 hover:text-terra text-xs"
              onClick={() => setShowDeleteDialog(true)}
              disabled={isOperationActive}
              title={isOperationActive ? t("cannotDelete", { state: server.state }) : undefined}
            >
              <Trash2 className="h-3.5 w-3.5 mr-2" />
              {t("deleteServer")}
            </Button>
          </div>
          </div>
        </section>}

        {/* ─── Dialogs ─── */}

        {/* Delete Dialog */}
        <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <DialogContent className="bg-card border-border text-cream">
            <DialogHeader>
              <DialogTitle className="text-terra">{t("deleteDialogTitle")}</DialogTitle>
              <DialogDescription className="text-cream/60">
                {t("deleteDialogDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-terra/20 bg-terra/5 p-3 my-2">
              <p className="text-xs text-terra">
                {t("deleteWarning")}
              </p>
            </div>
            <DialogFooter className="gap-2">
              <Button
                variant="ghost"
                onClick={() => setShowDeleteDialog(false)}
                className="text-cream/60 hover:text-cream"
              >
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  onDeleteServer();
                  setShowDeleteDialog(false);
                }}
                disabled={isDeleting}
                className="bg-terra hover:bg-terra"
              >
                {isDeleting ? <Spinner size="sm" delay={300} className="mr-2" /> : null}
                {isDeleting ? t("deleting") : t("deleteServer")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Rebuild Dialog */}
        <Dialog open={showRebuildDialog} onOpenChange={setShowRebuildDialog}>
          <DialogContent className="bg-card border-border text-cream">
            <DialogHeader>
              <DialogTitle className="text-sodium">{t("rebuildDialogTitle")}</DialogTitle>
              <DialogDescription className="text-cream/60">
                {t("rebuildDialogDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-sodium/20 bg-sodium/5 p-3 my-2">
              <p className="text-xs text-sodium">
                {t("rebuildWarning")}
              </p>
            </div>
            <DialogFooter className="gap-2">
              <Button
                variant="ghost"
                onClick={() => setShowRebuildDialog(false)}
                className="text-cream/60 hover:text-cream"
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={() => {
                  onRebuildServer?.();
                  setShowRebuildDialog(false);
                }}
                disabled={isRebuilding}
                className="bg-sodium hover:bg-sodium"
              >
                {isRebuilding ? <Spinner size="sm" delay={300} className="mr-2" /> : <RotateCcw className="h-4 w-4 mr-2" />}
                {isRebuilding ? t("rebuilding") : t("rebuildServer")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Rollback Dialog */}
        <Dialog open={showRollbackDialog} onOpenChange={setShowRollbackDialog}>
          <DialogContent className="bg-card border-border text-cream">
            <DialogHeader>
              <DialogTitle className="text-blue-400">{t("rollbackDialogTitle")}</DialogTitle>
              <DialogDescription className="text-cream/60">
                {t("rollbackDialogDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 my-2">
              <p className="text-xs text-blue-300">
                {t("rollbackWhatHappens")}
              </p>
            </div>
            {snapshotExpiresAt && (
              <p className="text-[10px] text-cream/60">
                {t("rollbackExpires", { date: new Date(snapshotExpiresAt).toLocaleString() })}
              </p>
            )}
            <DialogFooter className="gap-2">
              <Button
                variant="ghost"
                onClick={() => setShowRollbackDialog(false)}
                className="text-cream/60 hover:text-cream"
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={() => {
                  onRollbackServer?.();
                  setShowRollbackDialog(false);
                }}
                disabled={isRollingBack}
                className="bg-blue-600 hover:bg-blue-500"
              >
                {isRollingBack ? <Spinner size="sm" delay={300} className="mr-2" /> : <History className="h-4 w-4 mr-2" />}
                {isRollingBack ? t("rollingBack") : t("rollbackButton")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Reset Workspace Dialog (local only) */}
        <Dialog open={showResetDialog} onOpenChange={(open) => { setShowResetDialog(open); if (!open) setResetConfirmText(""); }}>
          <DialogContent className="bg-card border-border text-cream">
            <DialogHeader>
              <DialogTitle className="text-terra">{t("resetWorkspaceDialogTitle")}</DialogTitle>
              <DialogDescription className="text-cream/60">
                {t("resetWorkspaceDialogDescription")}
              </DialogDescription>
            </DialogHeader>
            <div className="py-2">
              <p className="text-xs text-cream/60 mb-2">{t("resetWorkspaceConfirmLabel")}</p>
              <input
                type="text"
                value={resetConfirmText}
                onChange={(e) => setResetConfirmText(e.target.value)}
                placeholder="RESET"
                className="w-full px-3 py-2 text-sm bg-ink border border-border rounded-lg text-cream placeholder:text-cream/30 focus:outline-none focus:border-terra/40"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setShowResetDialog(false); setResetConfirmText(""); }}>
                {t("cancel")}
              </Button>
              <Button
                onClick={async () => {
                  if (!onResetWorkspace) return;
                  setIsResetting(true);
                  try {
                    await onResetWorkspace();
                    toast.success(t("resetWorkspaceSuccess"));
                    setShowResetDialog(false);
                    setResetConfirmText("");
                  } catch (err) {
                    toast.error(t("resetWorkspaceError"));
                  } finally {
                    setIsResetting(false);
                  }
                }}
                disabled={resetConfirmText !== "RESET" || isResetting || !onResetWorkspace}
                className="bg-terra hover:bg-terra/80"
              >
                {isResetting ? <Spinner size="sm" delay={300} className="mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
                {isResetting ? t("resetting") : t("resetWorkspaceButton")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}


function getUptime(createdAt: string): string {
  const created = new Date(createdAt);
  const now = new Date();
  const diff = now.getTime() - created.getTime();

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// ── Agent-manifest health chip ──────────────────────────────────────
// Passive at-a-glance indicator next to the Platform Version readout.

function HealthChip({
  status,
  lastInstallError,
}: {
  status: "ok" | "degraded" | "failing" | "unknown";
  lastInstallError: string | null;
}) {
  const t = useTranslations("console.tabHome.health");
  const config = {
    ok: {
      label: t("ok"),
      className:
        "bg-sodium/10 text-sodium border-sodium/20",
      tooltip: t("tooltipOk"),
    },
    degraded: {
      label: t("degraded"),
      className: "bg-sodium/10 text-sodium border-sodium/20",
      tooltip: lastInstallError ?? t("tooltipDegraded"),
    },
    failing: {
      label: t("failing"),
      className: "bg-terra/10 text-terra border-terra/20",
      tooltip: lastInstallError ?? t("tooltipFailing"),
    },
    unknown: {
      label: t("unknown"),
      className: "bg-cream/[0.04] text-cream/60 border-cream/[0.08]/20",
      tooltip: t("tooltipUnknown"),
    },
  }[status];

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`shrink-0 inline-flex items-center px-2 py-1 rounded-md text-[10px] font-medium uppercase tracking-wide border cursor-help ${config.className}`}
            aria-label={`Agent health: ${config.label}`}
          >
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
