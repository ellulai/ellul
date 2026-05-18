// SPDX-License-Identifier: MIT
"use client";

// One passkey registration handles both access security and volume encryption:

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  KeyRound,
  FileText,
  Fingerprint,
  Check,
  Copy,
  AlertTriangle,
  Lock,
  ShieldCheck,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useVpsBridge } from "@/lib/vps-bridge";
import { useEncryptionPasskey } from "@/hooks/useEncryptionPasskey";
import { isTauriApp } from "@/lib/utils";

// Resolve translated lock name based on product
function useLockNames(product: string | undefined) {
  const t = useTranslations("console.webLockCard");
  const isCli = product === "shield_proxy";
  return {
    lockName: isCli ? t("lockNameCli") : t("lockNameDefault"),
    privacyName: isCli ? t("privacyNameCli") : t("privacyNameDefault"),
    subject: isCli ? t("subjectCli") : t("subjectDefault"),
  };
}


// ─── Types ──────────────────────────────────────────────────

type WizardStep = "intro" | "registering" | "encrypting" | "done";

interface EnableLockWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  serverDomain: string;
  // If true, skip auth passkey step (already registered)
  isPartialSetup: boolean;
  onComplete: () => void;
  product?: string;
  // Which tier is being enabled: "web_lock" (reversible) or "privacy_lock" (permanent)
  mode?: "web_lock" | "privacy_lock";
}

// ─── Component ──────────────────────────────────────────────

export function EnableLockWizard({
  open,
  onOpenChange,
  serverId,
  serverDomain,
  isPartialSetup,
  onComplete,
  product,
  mode = "web_lock",
}: EnableLockWizardProps) {
  const t = useTranslations("console.enableLock");
  const { registerNative } = useVpsBridge();
  const {
    webauthnSupported,
    syncCredential,
    initVolume,
    getPrfKey,
  } = useEncryptionPasskey();

  const { lockName, privacyName, subject: subj } = useLockNames(product);

  // ─── State ──────────────────────────────────────────────
  const [step, setStep] = useState<WizardStep>("intro");
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Recovery artifacts
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [copiedCodes, setCopiedCodes] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);

  // No transition timer needed - single-step flow

  // Reset wizard when opening
  useEffect(() => {
    if (open) {
      setStep(isPartialSetup ? "encrypting" : "intro");
      setError(null);
      setRecoveryCodes(null);
      setRecoveryKey(null);
      setCopiedCodes(false);
      setCopiedKey(false);
      setIsProcessing(false);
    }
  }, [open, isPartialSetup]);

  // ─── Enable handler: different flow per mode ─────────────
  const handleEnable = useCallback(async () => {
    setError(null);
    setIsProcessing(true);

    try {
      if (mode === "web_lock") {
        setStep("registering");
        console.log("[lock-wizard] web_lock mode, isTauriApp=", isTauriApp(), "serverDomain=", serverDomain);

        // In Tauri, WKWebView can't do WebAuthn — use native ASAuthorizationController
        // JS handles HTTP (WKWebView has the VPS session cookies), Rust does Touch ID
        if (isTauriApp()) {
          const vpsBase = `https://${serverDomain}`;
          const invoke = (window as any).__TAURI_INTERNALS__.invoke;
          console.log("[lock-wizard] Tauri path: vpsBase=", vpsBase, "invoke=", typeof invoke);

          // 1. Get registration options from VPS (JWT cookie from connect flow)
          console.log("[lock-wizard] Step 1: fetching upgrade-to-web-locked options...");
          const optRes = await fetch(`${vpsBase}/_auth/upgrade-to-web-locked`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Passkey" }),
            credentials: "include",
          });
          console.log("[lock-wizard] Step 1 response:", optRes.status, optRes.statusText);
          if (!optRes.ok) {
            const errBody = await optRes.text().catch(() => "");
            console.error("[lock-wizard] Step 1 FAILED:", optRes.status, errBody);
            throw new Error(`Options: HTTP ${optRes.status} — ${errBody}`);
          }
          const optData = await optRes.json();
          const { options } = optData;
          console.log("[lock-wizard] Step 1 OK, challenge=", options?.challenge?.slice(0, 20), "rpId=", options?.rp?.id);

          // 2. Native passkey ceremony via ASAuthorizationController (Touch ID)
          console.log("[lock-wizard] Step 2: invoking native credential create...");
          const attestation = await invoke(
            "plugin:shield|shield_native_credential_create",
            { optionsJson: JSON.stringify(options) },
          );
          console.log("[lock-wizard] Step 2 OK, attestation id=", (attestation as Record<string, unknown>)?.id);

          // 3. Verify with VPS (authenticated via WKWebView cookies)
          console.log("[lock-wizard] Step 3: verifying with VPS...");
          const extResults = (attestation as Record<string, unknown>)?.clientExtensionResults as Record<string, unknown> | undefined;
          const prfEnabled = (extResults?.prf as { enabled?: boolean } | undefined)?.enabled === true;
          const verRes = await fetch(`${vpsBase}/_auth/upgrade-to-web-locked/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ attestation, name: "Passkey", prfEnabled }),
            credentials: "include",
          });
          console.log("[lock-wizard] Step 3 response:", verRes.status, verRes.statusText);
          if (!verRes.ok) {
            const errBody = await verRes.text().catch(() => "");
            console.error("[lock-wizard] Step 3 FAILED:", verRes.status, errBody);
            throw new Error(`Verify: HTTP ${verRes.status} — ${errBody}`);
          }
          const result = await verRes.json() as {
            recoveryCodes?: string[];
          };
          console.log("[lock-wizard] Step 3 OK, has recovery codes:", !!(result.recoveryCodes?.length));

          if (result.recoveryCodes && result.recoveryCodes.length > 0) {
            setRecoveryCodes(result.recoveryCodes);
          }
          setStep("done");
          return;
        }

        // Web Lock: register passkey on VPS, sync credential to API
        const result = await registerNative("Passkey") as {
          verified?: boolean;
          success?: boolean;
          recoveryCodes?: string[];
          credentialSynced?: boolean;
          credential?: {
            id: string;
            publicKey: string;
            counter: number;
            transports: string[];
            aaguid: string;
            prfSupported: boolean;
          };
        };

        if (result.recoveryCodes && result.recoveryCodes.length > 0) {
          setRecoveryCodes(result.recoveryCodes);
        }

        // Primary path: VPS synced credential to API transactionally.
        let encryptionReady = result.credentialSynced === true;

        if (!encryptionReady && result.credential) {
          try {
            await syncCredential({
              credentialId: result.credential.id,
              publicKey: result.credential.publicKey,
              counter: result.credential.counter,
              transports: result.credential.transports,
              aaguid: result.credential.aaguid,
              prfSupported: result.credential.prfSupported,
              name: t("passkey"),
            });
            encryptionReady = true;
          } catch (err) {
            console.warn("[lock-wizard] Fallback credential sync also failed:", err);
          }
        }

        if (!encryptionReady) {
          setError(t("errors.syncPending"));
        }

        setStep("done");
      } else {
        // Privacy Lock: derive PRF key from auth passkey, then encrypt volume.
        const prfKey = await getPrfKey();
        setStep("encrypting");
        const encResult = await initVolume({ serverId, prfKey });

        setRecoveryKey(encResult.recoveryKey);
        setStep("done");
      }
    } catch (err) {
      console.error("[lock-wizard] CATCH:", err);
      const msg = err instanceof Error ? err.message : t("errors.setupFailed");
      if (err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError")) {
        setError(t("errors.cancelled"));
      } else {
        setError(msg);
      }
      setStep("intro");
    } finally {
      setIsProcessing(false);
    }
  }, [mode, registerNative, syncCredential, initVolume, getPrfKey, serverId, t]);

  // ─── Copy Helpers ───────────────────────────────────────
  const handleCopyCodes = async () => {
    if (!recoveryCodes) return;
    const text = `${t("recoveryCodesHeader", { lockName })}\n` +
      "======================================\n" +
      recoveryCodes.join("\n") +
      `\n======================================\n${t("recoveryCodesFooter")}`;
    await navigator.clipboard.writeText(text);
    setCopiedCodes(true);
    setTimeout(() => setCopiedCodes(false), 2000);
  };

  const handleCopyKey = async () => {
    if (!recoveryKey) return;
    await navigator.clipboard.writeText(recoveryKey);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  // ─── Browser Check ──────────────────────────────────────
  if (!webauthnSupported) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="bg-card border-border z-[200]">
          <DialogHeader>
            <DialogTitle>{t("browserNotSupportedTitle")}</DialogTitle>
            <DialogDescription>
              {t("browserNotSupportedBody", { lockName })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>{t("close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ─── Render ─────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={(o) => {
      if (step === "registering" || step === "encrypting") return;
      if (!o && step === "done") {
        onComplete();
        return;
      }
      onOpenChange(o);
    }}>
      <DialogContent className="bg-card border-border z-[200] sm:max-w-md">
        {/* Step: Intro */}
        {step === "intro" && (
          <>
            <DialogHeader>
              <DialogTitle className={cn("flex items-center gap-2", mode === "privacy_lock" ? "text-terra" : "text-sodium")}>
                <Lock className="h-5 w-5" />
                {mode === "privacy_lock" ? t("enableTitlePrivacyLock", { privacyName }) : t("enableTitleWebLock", { lockName })}
              </DialogTitle>
              <DialogDescription className="text-cream/60">
                {mode === "privacy_lock"
                  ? t("encryptDescription", { subject: subj })
                  : t("protectDescription", { subject: subj })}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {mode === "web_lock" ? (
                <div className="rounded-lg bg-sodium/10 p-3 border border-sodium/30">
                  <p className="font-medium text-sodium text-sm">{t("webLockProtects")}</p>
                  <ul className="mt-2 space-y-1.5 text-sodium/80 text-xs">
                    <li>{t("webLockBullet1")}</li>
                    <li>{t("webLockBullet2")}</li>
                    <li>{t("webLockBullet3")}</li>
                    <li>{t("webLockBullet4")}</li>
                  </ul>
                </div>
              ) : (
                <>
                  <div className="rounded-lg bg-terra/10 p-3 border border-terra/30">
                    <p className="font-medium text-terra text-sm">{t("privacyLockEncrypts")}</p>
                    <ul className="mt-2 space-y-1.5 text-terra/80 text-xs">
                      <li>{t("privacyLockBullet1")}</li>
                      <li>{t("privacyLockBullet2")}</li>
                      <li>{t("privacyLockBullet3")}</li>
                      <li>{t("privacyLockBullet4")}</li>
                    </ul>
                    <p className="mt-2 text-terra/60 text-[11px]">
                      {t("privacyLockEncryptedNote")}
                    </p>
                  </div>

                  <div className="rounded-lg bg-sodium/10 p-3 border border-sodium/30">
                    <p className="font-medium text-sodium text-sm flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4" />
                      {t("cannotBeUndone")}
                    </p>
                    <p className="mt-1 text-sodium/80 text-xs">
                      {t("cannotBeUndoneBody")}
                    </p>
                  </div>
                </>
              )}

              <div className="rounded-lg bg-cream/5 p-3 border border-border">
                <p className="text-sm text-cream/75 flex items-center gap-2">
                  <Fingerprint className="h-4 w-4 text-sodium" />
                  {t("oneTapHint")}
                </p>
              </div>

              {error && (
                <div className="rounded-lg bg-terra/10 p-3 border border-terra/30">
                  <p className="text-xs text-terra">{error}</p>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => onOpenChange(false)} className="text-cream/60">
                {t("cancel")}
              </Button>
              <Button
                onClick={handleEnable}
                className={mode === "privacy_lock" ? "bg-terra hover:bg-terra/85 text-ink" : "bg-sodium hover:bg-sodium-strong text-ink"}
              >
                {mode === "privacy_lock" ? (
                  <><Lock className="h-4 w-4 mr-2" />{t("enablePrivacyLock")}</>
                ) : (
                  <><Fingerprint className="h-4 w-4 mr-2" />{t("enable")}</>
                )}
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Step: Registering passkey (processing) */}
        {step === "registering" && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Spinner size="lg" color="primary" />
            <p className="text-sm text-cream/75 font-medium">{t("registeringPasskey")}</p>
            <p className="text-xs text-cream/45">{t("completeBiometric")}</p>
          </div>
        )}

        {/* Step: Encrypting */}
        {step === "encrypting" && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Spinner size="lg" color="primary" />
            <p className="text-sm text-cream/75 font-medium">{t("protectingSubject", { subject: subj })}</p>
            <p className="text-xs text-cream/45">{t("mayTakeMoment")}</p>
          </div>
        )}

        {/* Step: Done - Recovery artifacts */}
        {step === "done" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-sodium">
                <ShieldCheck className="h-5 w-5" />
                {t("lockEnabled", { lockName })}
              </DialogTitle>
              <DialogDescription className="text-cream/60">
                {t("saveRecovery")}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-5">
              {/* Access Recovery - recovery codes */}
              {recoveryCodes && recoveryCodes.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-cream/75">
                    <KeyRound className="h-4 w-4 text-sodium" />
                    {t("accessRecovery")}
                  </div>
                  <p className="text-[11px] text-cream/45">
                    {t("accessRecoveryHint")}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {recoveryCodes.map((code, i) => (
                      <div
                        key={i}
                        className="bg-black/30 border border-cream/5 rounded px-3 py-2 text-center font-mono text-sm text-cream/85 tracking-widest"
                      >
                        {code}
                      </div>
                    ))}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={handleCopyCodes}
                  >
                    {copiedCodes ? (
                      <><Check className="h-3.5 w-3.5 mr-2 text-sodium" />{t("copied")}</>
                    ) : (
                      <><Copy className="h-3.5 w-3.5 mr-2" />{t("copyAccessCodes")}</>
                    )}
                  </Button>
                </div>
              )}

              {/* Access Recovery - reminder for privacy lock (codes were shown at web lock) */}
              {!recoveryCodes && mode === "privacy_lock" && (
                <div className="rounded-lg bg-cream/[0.03] border border-cream/[0.08]/10 p-3">
                  <p className="text-xs text-cream/60">
                    {t("privacyLockRecoveryNote")}
                  </p>
                </div>
              )}

              {/* Data Recovery - recovery key */}
              {recoveryKey && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-cream/75">
                    <FileText className="h-4 w-4 text-sodium" />
                    {t("dataRecovery")}
                  </div>
                  <p className="text-[11px] text-cream/45">
                    {t("dataRecoveryHint")}
                  </p>
                  <div className="p-3 rounded-lg bg-black/30 border border-cream/5 font-mono text-center text-sm tracking-wider break-all text-cream/85">
                    {recoveryKey}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={handleCopyKey}
                  >
                    {copiedKey ? (
                      <><Check className="h-3.5 w-3.5 mr-2 text-sodium" />{t("copied")}</>
                    ) : (
                      <><Copy className="h-3.5 w-3.5 mr-2" />{t("copyRecoveryKey")}</>
                    )}
                  </Button>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                className="w-full bg-sodium hover:bg-sodium"
                onClick={() => {
                  onComplete();
                  onOpenChange(false);
                }}
              >
                {t("savedEverything")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
