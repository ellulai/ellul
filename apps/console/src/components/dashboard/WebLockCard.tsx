// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Lock,
  Shield,
  ShieldCheck,
  ShieldAlert,
  Fingerprint,
  AlertTriangle,
  Check,
  ChevronDown,
  Info,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { API_URL } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useVpsBridge } from "@/lib/vps-bridge";
import { SshKeysManager } from "./SshKeysManager";
import { EnableLockWizard } from "./EnableLockWizard";
import {
  getEnvironmentLockState,
  getLockLevelConfig,
  deriveTierFields,
  type EnvironmentLockLevel,
} from "@/lib/environment-lock";
import { isLockedTier } from "@/lib/tier-utils";
import { SecurityStrengthBar } from "./SecurityStrengthBar";

// ─── Types ──────────────────────────────────────────────────

interface WebLockCardProps {
  serverId: string;
  serverDomain: string;
  serverIp?: string;
  onUpgrade?: () => void;
  volumeSecurityMode?: "standard" | "enhanced" | "sovereign" | null;
  product?: string;
}

type SecurityTier = "standard" | "web_locked" | "private_locked";

interface SecurityStatus {
  tier: SecurityTier;
  label: string;
  description: string;
  breachSafe: boolean;
  userMessage: string;
  webTerminal: "enabled" | "disabled" | "passkey_required";
  sshAccess: "disabled" | "enabled" | "dynamic";
  availableTransitions: SecurityTier[];
  sshKeys: Array<{
    id: string;
    fingerprint: string;
    name: string;
    addedAt: string;
    addedVia: string;
  }>;
  passkeys: Array<{
    id: string;
    name: string;
    registeredAt: string;
    lastUsedAt: string | null;
  }>;
  tierLockedAt: string | null;
  pendingAction: string | null;
}

// ─── Component ──────────────────────────────────────────────

export function WebLockCard({
  serverId,
  serverDomain,
  serverIp,
  onUpgrade,
  volumeSecurityMode,
  product,
}: WebLockCardProps) {
  const t = useTranslations("console.webLockCard");
  const queryClient = useQueryClient();
  const {
    ready: bridgeReady,
    send: bridgeSend,
    reload: reloadBridge,
    registerNative,
  } = useVpsBridge();

  // Localized lock names + level overrides
  const isCli = product === "shield_proxy";
  const lockName = isCli ? t("lockNameCli") : t("lockNameDefault");
  const subj = isCli ? t("subjectCli") : t("subjectDefault");

  // Build localized override for description / badge / recoveryLine / cta per level.
  // Icons + colors come from the underlying config; strings come from the t namespace.
  const levelOverrides: Record<EnvironmentLockLevel, { description: string; badge: string | null; recoveryLine: string | null; cta: string }> = {
    off: {
      description: t("levelDescription.off", { subject: subj }),
      badge: null,
      recoveryLine: null,
      cta: t("cta.enableWebLock"),
    },
    web_locked: {
      description: t("levelDescription.webLocked", { subject: subj }),
      badge: t("active"),
      recoveryLine: null,
      cta: t("cta.enablePrivacyLock"),
    },
    privacy_locked: {
      description: t("levelDescription.privacyLocked", { subject: subj }),
      badge: t("permanent"),
      recoveryLine: t("recoveryCodesAvailable"),
      cta: t("cta.manageSecurity"),
    },
    setup_incomplete: {
      description: t("levelDescription.setupIncomplete", { subject: subj }),
      badge: t("incomplete"),
      recoveryLine: null,
      cta: t("cta.completeSetup"),
    },
    transitioning: {
      description: t("levelDescription.transitioning", { subject: subj }),
      badge: t("settingUpEllipsis"),
      recoveryLine: null,
      cta: t("cta.pleaseWait"),
    },
  };

  // ─── State ──────────────────────────────────────────────
  const [showEnableLockWizard, setShowEnableLockWizard] = useState(false);
  const [wizardMode, setWizardMode] = useState<"web_lock" | "privacy_lock">("web_lock");
  const [showDisableDialog, setShowDisableDialog] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [isDisabling, setIsDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      clearTimeout(successTimerRef.current);
      clearTimeout(fallbackTimerRef.current);
    };
  }, []);

  const showSuccess = useCallback((message: string) => {
    clearTimeout(successTimerRef.current);
    setSuccessMessage(message);
    successTimerRef.current = setTimeout(() => setSuccessMessage(null), 6000);
  }, []);

  const scheduleFallbackSync = useCallback(() => {
    clearTimeout(fallbackTimerRef.current);
    fallbackTimerRef.current = setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ["security-tier", serverId] });
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
    }, 30_000);
  }, [queryClient, serverId]);

  // ─── Data ───────────────────────────────────────────────
  const { data: security, isLoading: securityLoading } =
    useQuery<SecurityStatus>({
      queryKey: ["security-tier", serverId],
      queryFn: async () => {
        const response = await fetch(
          `${API_URL}/api/servers/${serverId}/security`,
          {
            credentials: "include",
          },
        );
        if (!response.ok) throw new Error("Failed to fetch security status");
        return response.json();
      },
      staleTime: 5 * 60 * 1000,
    });

  // ─── Derived State ──────────────────────────────────────
  const lockState = getEnvironmentLockState({
    securityTier: security?.tier,
    volumeSecurityMode,
  });

  const levelConfig = getLockLevelConfig(product);
  const baseConfig = levelConfig[lockState.level];
  const override = levelOverrides[lockState.level];
  const config = {
    ...baseConfig,
    description: override.description,
    badge: override.badge,
    recoveryLine: override.recoveryLine,
    cta: override.cta,
  };
  const LevelIcon = config.icon;

  // ─── Downgrade to Standard (Web Lock only) ────────
  const handleDowngrade = useCallback(async () => {
    if (!bridgeReady) return;
    setIsDisabling(true);
    setDisableError(null);

    try {
      queryClient.cancelQueries({ queryKey: ["file-tree"] });
      queryClient.cancelQueries({ queryKey: ["git-status"] });

      await bridgeSend("downgrade_to_standard");

      setShowDisableDialog(false);
      showSuccess(t("downgradedToast"));

      queryClient.setQueryData(["security-tier", serverId], (old: SecurityStatus | undefined) => {
        if (!old) return old;
        return {
          ...old,
          tier: "standard" as SecurityTier,
          ...deriveTierFields("standard"),
          sshKeys: [],
          passkeys: [],
        };
      });
      queryClient.setQueryData(["server-status"], (old: Record<string, unknown> | undefined) => {
        if (!old) return old;
        const server = (old.server || {}) as Record<string, unknown>;
        return { ...old, server: { ...server, securityTier: "standard" } };
      });
      reloadBridge();
      scheduleFallbackSync();
    } catch (err) {
      setDisableError(err instanceof Error ? err.message : t("downgradeFailed"));
    } finally {
      setIsDisabling(false);
    }
  }, [bridgeReady, bridgeSend, queryClient, serverId, showSuccess, reloadBridge, scheduleFallbackSync, t]);

  // ─── Enable Lock Wizard Complete ────────────────────────
  const handleLockEnabled = useCallback(() => {
    setShowEnableLockWizard(false);
    showSuccess(t("lockEnabledToast", { lockName }));

    // Optimistic UI update — tier depends on which lock was enabled
    const newTier: SecurityTier = wizardMode === "privacy_lock" ? "private_locked" : "web_locked";
    queryClient.setQueryData(
      ["security-tier", serverId],
      (old: SecurityStatus | undefined) => {
        if (!old) return old;
        return { ...old, tier: newTier, ...deriveTierFields(newTier) };
      },
    );
    queryClient.setQueryData(
      ["server-status"],
      (old: Record<string, unknown> | undefined) => {
        if (!old) return old;
        const server = (old.server || {}) as Record<string, unknown>;
        return {
          ...old,
          server: {
            ...server,
            securityTier: newTier,
            ...(wizardMode === "privacy_lock" && {
              volumeSecurityMode: "enhanced",
            }),
          },
        };
      },
    );
    reloadBridge();
    scheduleFallbackSync();
  }, [queryClient, serverId, showSuccess, reloadBridge, scheduleFallbackSync, wizardMode, lockName, t]);

  // ─── Manage Lock → auto-expand advanced ─────────────────
  const handleManageLock = () => {
    setAdvancedOpen(true);
  };

  // ─── Loading ────────────────────────────────────────────
  if (securityLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Spinner size="default" color="muted" delay={300} />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Lock className="h-5 w-5 text-primary" />
              <CardTitle className="text-lg">{lockName}</CardTitle>
            </div>
            {config.badge && (
              <Badge
                className={cn(
                  "gap-1 border",
                  config.badgeBg,
                  config.badgeColor,
                )}
              >
                <LevelIcon className="h-3 w-3" />
                {config.badge}
              </Badge>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {/* Security Strength Bar */}
          <SecurityStrengthBar
            currentLevel={lockState.securityLevel}
            expanded={lockState.level === "off"}
          />

          <div className="h-px bg-cream/[0.06]" />
          {/* Description */}
          <p className="text-sm text-cream/60">{config.description}</p>

          {/* Recovery line */}
          {config.recoveryLine && (
            <div className="flex items-center gap-2 text-xs text-cream/45">
              <ShieldCheck className="h-3 w-3" />
              <span>{config.recoveryLine}</span>
            </div>
          )}

          {lockState.isLegacyEncrypted && (
            <div className="flex items-center gap-2 text-xs text-cream/45">
              <Info className="h-3 w-3" />
              <span>{t("volumeEncryptionActive")}</span>
            </div>
          )}

          {/* Subtle info notes for locked states */}
          {lockState.level === "privacy_locked" && (
            <div className="space-y-2">
              <div className="rounded-md bg-sodium/5 border border-sodium/10 p-2.5 space-y-1.5">
                <p className="text-[11px] text-cream/65/80">
                  {t("encryptedAtRest")}
                </p>
                <p className="text-[11px] text-cream/65/60">
                  {t("privacyLockPermanent")}
                </p>
              </div>
              <div className="rounded-md bg-cream/[0.02] border border-cream/[0.04] p-2.5">
                <p className="text-[11px] font-medium text-cream/60 mb-1">{t("lostPasskey")}</p>
                <p className="text-[10px] text-cream/45 leading-relaxed">
                  {t("lostPasskeyHint")}
                </p>
              </div>
            </div>
          )}
          {lockState.level === "web_locked" && (
            <div className="rounded-md bg-sodium/5 border border-sodium/10 p-2.5">
              <p className="text-[11px] text-sodium/70">
                {t("passkeyProtects")}
              </p>
            </div>
          )}
          {lockState.level === "off" && (
            <div className="rounded-md bg-cream/[0.02] border border-cream/[0.04] p-2.5">
              <p className="text-[11px] text-cream/45 leading-relaxed">
                {t("standardSecurityNote")}
              </p>
            </div>
          )}

          {/* Success feedback */}
          {successMessage && (
            <div className="flex items-center gap-2 rounded-md bg-green-500/10 px-3 py-2 text-xs text-green-400">
              <Check className="h-4 w-4" />
              <span>{successMessage}</span>
            </div>
          )}

          {/* Primary CTA */}
          <div className="pt-1 space-y-2">
            {lockState.canEnableWebLock && (
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-center gap-2 text-sodium border-sodium/30 hover:bg-sodium/10"
                onClick={() => { setWizardMode("web_lock"); setShowEnableLockWizard(true); }}
                disabled={!bridgeReady}
              >
                <Fingerprint className="h-3.5 w-3.5" />
                {bridgeReady ? t("cta.enableWebLock") : t("connecting")}
              </Button>
            )}

            {lockState.canEnablePrivacyLock && (
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-center gap-2 text-cream/65 border-sodium/30 hover:bg-sodium/10"
                onClick={() => { setWizardMode("privacy_lock"); setShowEnableLockWizard(true); }}
              >
                <Lock className="h-3.5 w-3.5" />
                {t("cta.enablePrivacyLock")}
              </Button>
            )}

            {lockState.canDowngrade && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-center gap-2 text-cream/45 hover:text-cream/60"
                onClick={() => setShowDisableDialog(true)}
              >
                {t("downgradeToStandard")}
              </Button>
            )}

            {/* Legacy: complete setup button - should not appear with new model */}
            {lockState.isPartialSetup && (
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-center gap-2 text-sodium border-sodium/30 hover:bg-sodium/10"
                onClick={() => setShowEnableLockWizard(true)}
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                {t("cta.completeSetup")}
              </Button>
            )}

            {!lockState.canEnableWebLock &&
              !lockState.canEnablePrivacyLock &&
              !lockState.isPartialSetup &&
              lockState.level !== "off" && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-center gap-2"
                  onClick={handleManageLock}
                >
                  <Shield className="h-3.5 w-3.5" />
                  {t("manageLock")}
                </Button>
              )}
          </div>

          {/* ─── Advanced Section ──────────────────────────── */}
          {lockState.level !== "off" && (
            <div className="pt-2 border-t border-border">
              <button
                onClick={() => setAdvancedOpen(!advancedOpen)}
                className="flex items-center gap-1.5 text-xs text-cream/45 hover:text-cream/75 transition-colors w-full"
              >
                <ChevronDown
                  className={cn(
                    "h-3 w-3 transition-transform",
                    advancedOpen && "rotate-180",
                  )}
                />
                {t("advanced")}
              </button>

              {advancedOpen && (
                <div className="mt-3 space-y-3">
                  {/* Access Status Grid */}
                  {security && (
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-md bg-cream/5 px-3 py-2">
                        <span className="text-cream/60">{t("webTerminalLabel")}</span>
                        <span className="ml-2 font-medium">
                          {security.webTerminal === "enabled" && (
                            <span className="text-sodium">{t("webTerminalEnabled")}</span>
                          )}
                          {security.webTerminal === "passkey_required" && (
                            <span className="text-cream/65">
                              {t("webTerminalPasskeyRequired")}
                            </span>
                          )}
                          {security.webTerminal === "disabled" && (
                            <span className="text-cream/60">{t("webTerminalDisabled")}</span>
                          )}
                        </span>
                      </div>
                      <div className="rounded-md bg-cream/5 px-3 py-2">
                        <span className="text-cream/60">{t("sshAccessLabel")}</span>
                        <span className="ml-2 font-medium">
                          {security.sshAccess === "enabled" && (
                            <span className="text-sodium">{t("sshEnabled")}</span>
                          )}
                          {security.sshAccess === "disabled" && (
                            <span className="text-cream/60">{t("sshDisabled")}</span>
                          )}
                          {security.sshAccess === "dynamic" && (
                            <span className="text-cream/65">{t("sshDynamic")}</span>
                          )}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Breach Safety Banner */}
                  {security && (
                    <div
                      className={cn(
                        "flex items-center gap-2 rounded-md px-3 py-2.5 text-xs",
                        security.breachSafe
                          ? "bg-sodium/10 text-sodium"
                          : "bg-sodium/10 text-sodium",
                      )}
                    >
                      {security.breachSafe ? (
                        <ShieldCheck className="h-4 w-4" />
                      ) : (
                        <ShieldAlert className="h-4 w-4" />
                      )}
                      <span>
                        {security.breachSafe ? t("safeIfBreached") : t("atRiskIfBreached")}
                      </span>
                    </div>
                  )}

                  {/* SSH Keys Manager */}
                  {security && isLockedTier(security.tier) && (
                    <SshKeysManager
                      tier={security.tier}
                      serverDomain={serverDomain}
                      serverIp={serverIp || serverDomain}
                      initialKeys={security.sshKeys}
                      onKeysChange={() =>
                        queryClient.invalidateQueries({
                          queryKey: ["security-tier", serverId],
                        })
                      }
                    />
                  )}

                  {/* Privacy Lock info */}
                  {lockState.level === "privacy_locked" && (
                    <div className="rounded-md bg-sodium/5 px-3 py-2 text-xs text-cream/65/70">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{t("privacyLockActive")}</span>
                        <Badge
                          variant="outline"
                          className="text-[10px] px-1.5 py-0 text-cream/65 border-sodium/30"
                        >
                          {t("permanent")}
                        </Badge>
                      </div>
                      <p className="mt-1 text-[11px] text-cream/65/50">
                        {t("dataEncryptedNote")}
                      </p>
                    </div>
                  )}

                  {/* Disable Lock */}
                  {/* Lock cannot be disabled once enabled - security only goes up */}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── Enable Lock Wizard ──────────────────────────────── */}
      <EnableLockWizard
        open={showEnableLockWizard}
        onOpenChange={setShowEnableLockWizard}
        serverId={serverId}
        serverDomain={serverDomain}
        isPartialSetup={lockState.isPartialSetup}
        onComplete={handleLockEnabled}
        product={product}
        mode={wizardMode}
      />

      {/* Downgrade Confirmation Dialog (Web Lock → Standard only) */}
      {lockState.canDowngrade && (
        <Dialog open={showDisableDialog} onOpenChange={(open) => {
          setShowDisableDialog(open);
          if (!open) setDisableError(null);
        }}>
          <DialogContent className="bg-card border-border z-[200]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-sodium">
                <AlertTriangle className="h-5 w-5" />
                {t("downgradeToStandard")}
              </DialogTitle>
              <DialogDescription className="text-cream/60">
                {t("removePasskeyFrom", { subject: subj })}
              </DialogDescription>
            </DialogHeader>

            {isDisabling ? (
              <div className="flex flex-col items-center justify-center py-8 gap-3">
                <Spinner size="lg" color="primary" />
                <p className="text-sm text-cream/75">{t("downgrading")}</p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-lg bg-sodium/10 p-4 border border-sodium/30">
                  <p className="font-medium text-sodium text-sm flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    {t("downgradeWillReduce")}
                  </p>
                  <p className="mt-2 text-sodium/80 text-xs">
                    {t("downgradeWillReduceBody", { subject: subj })}
                  </p>
                </div>

                {disableError && (
                  <div className="rounded-lg bg-terra/10 p-3 border border-terra/30">
                    <p className="text-xs text-terra">{disableError}</p>
                  </div>
                )}
              </div>
            )}

            {!isDisabling && (
              <DialogFooter>
                <Button variant="ghost" onClick={() => setShowDisableDialog(false)} className="text-cream/60">
                  {t("cancel")}
                </Button>
                <Button onClick={handleDowngrade} className="bg-sodium hover:bg-sodium">
                  <Fingerprint className="h-4 w-4 mr-2" />
                  {t("confirmDowngrade")}
                </Button>
              </DialogFooter>
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
