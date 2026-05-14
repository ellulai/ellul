// SPDX-License-Identifier: MIT
"use client";

// ShieldSetupFlow — Enterprise provisioning checklist for CLI-originated

import { useEffect, useState, useRef } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Circle, Shield, AlertCircle } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";

// Maximum time to wait for setup token after provisioning completes (ms).
const TOKEN_TIMEOUT_MS = 90_000;

interface ShieldSetupFlowProps {
  // Live provisioning step label from SSE (e.g., "Installing Node.js...")
  operationLabel: string | null;
  // Whether provisioning is complete and server is running
  isReady: boolean;
  // VPS domain (e.g., "srv-abc123.ellul.ai") — available once server is created
  serverDomain: string | null;
  // One-time setup token for passkey registration on the VPS
  setupToken: string | null;
}

type StepStatus = "done" | "active" | "pending" | "error";

interface Step {
  label: string;
  status: StepStatus;
  subLabel?: string;
}

export function ShieldSetupFlow({
  operationLabel,
  isReady,
  serverDomain,
  setupToken,
}: ShieldSetupFlowProps) {
  const t = useTranslations("console.shieldSetup");
  const [redirecting, setRedirecting] = useState(false);
  const [tokenTimedOut, setTokenTimedOut] = useState(false);
  const redirectedRef = useRef(false);
  const readyAtRef = useRef<number | null>(null);

  // Track when provisioning completed to enforce token timeout
  useEffect(() => {
    if (isReady && !readyAtRef.current) {
      readyAtRef.current = Date.now();
    }
  }, [isReady]);

  // Token timeout: if provisioning is done but token hasn't arrived after 90s
  useEffect(() => {
    if (!isReady || setupToken || redirectedRef.current || tokenTimedOut) return;

    const timer = setTimeout(() => {
      if (!setupToken && !redirectedRef.current) {
        setTokenTimedOut(true);
      }
    }, TOKEN_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [isReady, setupToken, tokenTimedOut]);

  // Determine the "waiting for token" sub-state
  const waitingForToken = isReady && !setupToken && !tokenTimedOut && !redirecting;

  // Build step list based on current state
  const steps: Step[] = [
    { label: t("step.accountCreated"), status: "done" },
    { label: t("step.paymentConfirmed"), status: "done" },
    {
      label: t("step.provisioningServer"),
      status: isReady ? "done" : "active",
      subLabel: !isReady ? (operationLabel ?? t("step.provisioningStarting")) : undefined,
    },
    {
      label: t("step.settingUpPasskey"),
      status: tokenTimedOut
        ? "error"
        : redirecting
          ? "active"
          : isReady
            ? (waitingForToken ? "active" : "active")
            : "pending",
      subLabel: waitingForToken ? t("step.connectingToServer") : undefined,
    },
    {
      label: t("step.connectingToCli"),
      status: redirecting ? "active" : "pending",
    },
  ];

  // When provisioning completes AND token arrives, redirect to VPS setup page.
  useEffect(() => {
    if (!isReady || !serverDomain || !setupToken || redirectedRef.current) return;

    const callbackPort = localStorage.getItem("ps_cli_callback_port");
    const callbackNonce = localStorage.getItem("ps_cli_callback_nonce");

    if (!callbackPort || !callbackNonce) return;

    redirectedRef.current = true;
    setRedirecting(true);

    // Clean up localStorage before redirect
    localStorage.removeItem("ps_cli_callback_port");
    localStorage.removeItem("ps_cli_callback_nonce");

    // Validate domain before redirect — defense in depth against compromised API responses
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:-(?:srv|dc))?\.ellul\.ai$/i.test(serverDomain)) {
      console.error("[shield] Invalid server domain:", serverDomain);
      setRedirecting(false);
      redirectedRef.current = false;
      setTokenTimedOut(true);
      return;
    }

    // Redirect to VPS setup page with setup token + localhost callback params
    const vpsSetupUrl = new URL(`https://${serverDomain}/_auth/setup`);
    vpsSetupUrl.searchParams.set("token", setupToken);
    vpsSetupUrl.searchParams.set("callback", "localhost");
    vpsSetupUrl.searchParams.set("port", callbackPort);
    vpsSetupUrl.searchParams.set("nonce", callbackNonce);

    window.location.href = vpsSetupUrl.toString();
  }, [isReady, serverDomain, setupToken]);

  // Retry handler for token timeout
  const handleRetry = () => {
    setTokenTimedOut(false);
    readyAtRef.current = Date.now();
    // Token will arrive via SSE/polling — just reset the timeout
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-10 bg-background/95 backdrop-blur-sm p-4">
      <div className="max-w-md w-full">
        <div className="panel-ascente p-8 sm:p-12">
          {/* Header */}
          <div className="flex items-center justify-center mb-6">
            <div className="h-12 w-12 rounded-full bg-sodium/10 border border-sodium/20 flex items-center justify-center">
              <Shield className="h-6 w-6 text-sodium" />
            </div>
          </div>

          <h2 className="text-2xl font-semibold text-center text-cream mb-1">
            {t("settingUp")}
          </h2>
          <p className="text-sm text-center text-cream/60 mb-8">
            {t("onlyOnce")}
          </p>

          {/* Step checklist */}
          <div className="space-y-4 mb-6">
            {steps.map((step, i) => (
              <div key={i} className="flex items-start gap-3">
                {/* Step icon */}
                {step.status === "done" && (
                  <CheckCircle2 className="h-5 w-5 text-sodium mt-0.5 shrink-0" />
                )}
                {step.status === "active" && (
                  <div className="mt-0.5 shrink-0">
                    <Spinner size="sm" color="primary" />
                  </div>
                )}
                {step.status === "pending" && (
                  <Circle className="h-5 w-5 text-cream/20 mt-0.5 shrink-0" />
                )}
                {step.status === "error" && (
                  <AlertCircle className="h-5 w-5 text-terra mt-0.5 shrink-0" />
                )}

                {/* Step text */}
                <div className="min-w-0">
                  <span
                    className={
                      step.status === "done"
                        ? "text-sm text-cream"
                        : step.status === "active"
                          ? "text-sm text-sodium font-medium"
                          : step.status === "error"
                            ? "text-sm text-terra font-medium"
                            : "text-sm text-cream/45"
                    }
                  >
                    {step.label}
                  </span>
                  {step.subLabel && (
                    <p className="text-xs text-cream/45 mt-0.5">{step.subLabel}</p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Token timeout error */}
          {tokenTimedOut && (
            <div className="rounded-xl border border-terra/20 bg-terra/5 p-4 mb-4">
              <p className="text-sm text-terra mb-3">
                {t("tokenTimeoutBody")}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRetry}
                className="w-full"
              >
                {t("tryAgain")}
              </Button>
            </div>
          )}

          {/* Redirect state */}
          {redirecting && (
            <p className="text-xs text-center text-cream/45">
              {t("redirecting")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
