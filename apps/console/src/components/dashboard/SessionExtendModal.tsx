// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Clock, Zap, CreditCard, Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { API_URL } from "@/lib/api";
import type { SessionInfo } from "@/hooks/useBrowserHeartbeat";

interface SessionExtendModalProps {
  serverId: string;
  sessionInfo: SessionInfo;
  onSessionRenewed: () => void;
  onUpgrade?: () => void;
}

// Displays a countdown timer based on graceRemainingMs.
export function SessionExtendModal({
  serverId,
  sessionInfo,
  onSessionRenewed,
  onUpgrade,
}: SessionExtendModalProps) {
  const t = useTranslations("console.sessionExtend");
  const [isRenewing, setIsRenewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number>(
    Math.ceil((sessionInfo.graceRemainingMs ?? 0) / 1000)
  );

  const visible = sessionInfo.softCapHit && !sessionInfo.expired;

  // Countdown timer
  useEffect(() => {
    if (!visible) return;
    const initial = Math.ceil((sessionInfo.graceRemainingMs ?? 0) / 1000);
    setCountdown(initial);

    const timer = setInterval(() => {
      setCountdown((prev) => Math.max(0, prev - 1));
    }, 1000);

    return () => clearInterval(timer);
  }, [visible, sessionInfo.graceRemainingMs]);

  const minutes = Math.floor(countdown / 60);
  const seconds = countdown % 60;

  // HMAC signing helper
  const signNonce = async (key: string, nonce: string): Promise<string> => {
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(nonce));
    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };

  const handleKeepWorking = useCallback(async () => {
    setIsRenewing(true);
    setError(null);

    try {
      // 1. Get fresh challenge
      const challengeRes = await fetch(
        `${API_URL}/api/servers/${serverId}/heartbeat-challenge`,
        { credentials: "include" }
      );

      if (!challengeRes.ok) throw new Error("Failed to get challenge");

      const { nonce, sessionKey } = await challengeRes.json() as {
        nonce: string;
        sessionKey: string;
      };

      // 2. Sign nonce
      const signature = await signNonce(sessionKey, nonce);

      // 3. Renew session
      const renewRes = await fetch(
        `${API_URL}/api/servers/${serverId}/renew-session`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nonce, signature }),
        }
      );

      if (renewRes.status === 429) {
        const data = await renewRes.json() as { message?: string };
        setError(data.message || t("renewalLimitReached"));
        return;
      }

      if (!renewRes.ok) throw new Error(t("renewFailed"));

      onSessionRenewed();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("renewFailed"));
    } finally {
      setIsRenewing(false);
    }
  }, [serverId, onSessionRenewed, t]);

  // Flash the document title for attention
  useEffect(() => {
    if (!visible) return;
    const originalTitle = document.title;
    let flash = true;
    const timer = setInterval(() => {
      document.title = flash ? t("stillThereTitle") : originalTitle;
      flash = !flash;
    }, 1500);

    return () => {
      clearInterval(timer);
      document.title = originalTitle;
    };
  }, [visible, t]);

  const vh = useVisualViewport();

  if (!visible) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-center" style={{ height: vh }}>
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative mx-4 max-w-md w-full max-h-[90%] overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-sodium/10 flex items-center justify-center">
            <Clock className="h-5 w-5 text-sodium" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-cream">{t("stillWorking")}</h2>
            <p className="text-xs text-cream/60">{t("hibernateSoon")}</p>
          </div>
        </div>

        {/* Countdown */}
        <div className="rounded-xl bg-cream/5 border border-cream/10 p-4 mb-5 text-center">
          <p className="text-sm text-cream/75 mb-1">{t("hibernatingIn")}</p>
          <p className="text-3xl font-bold text-sodium font-mono">
            {minutes}:{seconds.toString().padStart(2, "0")}
          </p>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-terra/20 bg-terra/10 p-3 mb-4">
            <p className="text-xs text-terra">{error}</p>
          </div>
        )}

        {/* Actions */}
        <div className="space-y-2">
          <Button
            className="w-full bg-sodium hover:bg-sodium text-ink h-11"
            onClick={handleKeepWorking}
            disabled={isRenewing || !sessionInfo.canRenew}
          >
            {isRenewing ? (
              <><Spinner size="sm" delay={300} className="mr-2" />{t("renewing")}</>
            ) : (
              <><Zap className="h-4 w-4 mr-2" />{t("keepWorking")}</>
            )}
          </Button>

          {onUpgrade && (
            <Button
              variant="outline"
              className="w-full border-border text-cream/75 hover:text-cream hover:bg-cream/10 h-10"
              onClick={onUpgrade}
            >
              <CreditCard className="h-4 w-4 mr-2" />
              {t("upgradeNoLimits")}
            </Button>
          )}

          <button
            className="w-full text-center text-xs text-cream/45 hover:text-cream/60 py-2"
            onClick={() => {
              // Close modal and let server hibernate naturally
              onSessionRenewed();
            }}
          >
            <Moon className="h-3 w-3 inline mr-1" />
            {t("letItSleep")}
          </button>
        </div>

        {/* Remaining renewals */}
        {sessionInfo.renewalsRemaining > 0 && (
          <p className="text-center text-[10px] text-cream/45 mt-3">
            {t("renewalsRemaining", { count: sessionInfo.renewalsRemaining })}
          </p>
        )}
      </div>
    </div>
  );
}
