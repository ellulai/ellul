// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, KeyRound, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useVpsBridge } from "@/lib/vps-bridge";

interface AuthWallProps {
  // Whether to show the auth wall
  show: boolean;
  // Optional custom message
  message?: string;
  // Callback after successful reauthentication
  onReauthenticated?: () => void;
  // Whether this is a connection error vs auth error
  isConnectionError?: boolean;
}

// AuthWall - Unified authentication wall overlay for all tabs.
export function AuthWall({
  show,
  message,
  onReauthenticated,
  isConnectionError = false,
}: AuthWallProps) {
  const t = useTranslations("console.authWall");
  // Native passkey auth — RP_ID = "ellul.ai" allows Touch ID/Face ID directly
  const { reauthenticate } = useVpsBridge();
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const handleReauthenticate = useCallback(async () => {
    setIsAuthenticating(true);
    setAuthError(null);
    try {
      await reauthenticate();
      onReauthenticated?.();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : t("authFailed"));
    } finally {
      setIsAuthenticating(false);
    }
  }, [reauthenticate, onReauthenticated, t]);

  if (!show) return null;

  return (
    <div className="absolute inset-0 bg-card/95 backdrop-blur-sm flex items-center justify-center z-20">
      <div className="text-center max-w-sm p-6">
        <div className="w-16 h-16 rounded-2xl bg-sodium/10 border border-sodium/20 flex items-center justify-center mx-auto mb-4">
          {isConnectionError ? (
            <WifiOff className="h-8 w-8 text-sodium" />
          ) : (
            <AlertCircle className="h-8 w-8 text-sodium" />
          )}
        </div>

        <h3 className="text-base font-medium text-cream/85 mb-2">
          {isConnectionError ? t("connectionLost") : t("sessionExpired")}
        </h3>

        <p className="text-sm text-cream/60 leading-relaxed mb-6">
          {message || (isConnectionError
            ? t("connectionMessage")
            : t("sessionMessage")
          )}
        </p>

        <div className="flex flex-col gap-3">
          <Button
            onClick={handleReauthenticate}
            disabled={isAuthenticating}
            className="w-full bg-sodium hover:bg-sodium text-ink"
          >
            {isAuthenticating ? (
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <KeyRound className="h-4 w-4 mr-2" />
            )}
            {isAuthenticating ? t("authenticating") : t("loginPasskey")}
          </Button>
          {authError && (
            <p className="text-xs text-terra text-center">{authError}</p>
          )}

          <Button
            onClick={() => window.location.reload()}
            variant="outline"
            className="w-full border-border hover:bg-secondary/50 text-cream/75"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            {t("refreshPage")}
          </Button>
        </div>
      </div>
    </div>
  );
}
