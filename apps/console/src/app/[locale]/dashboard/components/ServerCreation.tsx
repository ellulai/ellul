// SPDX-License-Identifier: MIT
"use client";

import {
  CreditCard,
  Rocket,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ServerStatus } from "@/contexts/DashboardContext";
import type { UseMutationResult } from "@tanstack/react-query";
import { PricingModal } from "./PricingModal";
import { extractPlan } from "@/lib/tier-utils";

interface ServerCreationProps {
  serverStatus: ServerStatus;
  selectedTier: string;
  setSelectedTier: (tier: string) => void;
  createServerMutation: UseMutationResult<unknown, Error, { product: string; plan?: string }>;
  checkoutMutation: UseMutationResult<{ url: string }, Error, {
    product: "cloud_platform" | "shield_proxy";
    plan?: "hobby" | "pro";
    interval?: "monthly" | "annual";
  }>;
  handleCheckout: (product: "cloud_platform" | "shield_proxy", plan?: "hobby" | "pro") => void;
  setAutoProvisionTriggered: (v: boolean) => void;
}

export function ServerCreation({
  serverStatus,
  selectedTier,
  setSelectedTier,
  createServerMutation,
  checkoutMutation,
  handleCheckout,
  setAutoProvisionTriggered,
}: ServerCreationProps) {
  const t = useTranslations("tier");

  if (serverStatus.hasActiveSubscription) {
    return <AutoProvisionSpinner createServerMutation={createServerMutation} setAutoProvisionTriggered={setAutoProvisionTriggered} />;
  }

  const selectedPlan = extractPlan(selectedTier) as "hobby" | "pro";

  return (
    <div className="flex flex-col items-center gap-8">
      <PricingModal
        selectedTier={selectedTier}
        setSelectedTier={setSelectedTier}
      />

      <Button
        className="w-full sm:w-auto sm:min-w-[200px] bg-sodium hover:brightness-110 text-ink shadow-lg shadow-sodium/25 h-11"
        onClick={() => handleCheckout("cloud_platform", selectedPlan)}
        disabled={checkoutMutation.isPending}
      >
        {checkoutMutation.isPending ? (
          <>
            <Spinner size="sm" className="mr-2" />
            {t("cta.loading")}
          </>
        ) : (
          <>
            <CreditCard className="mr-2 h-4 w-4" />
            {t("cta.subscribe")}
          </>
        )}
      </Button>
    </div>
  );
}

// ─── Auto-provision spinner (subscription exists, server creating) ──

function AutoProvisionSpinner({
  createServerMutation,
  setAutoProvisionTriggered,
}: {
  createServerMutation: UseMutationResult<unknown, Error, { product: string; plan?: string }>;
  setAutoProvisionTriggered: (v: boolean) => void;
}) {
  const t = useTranslations("tier");
  return (
    <div className="flex items-center justify-center" style={{ minHeight: "calc(100vh - 12rem)" }}>
      <div className="max-w-md mx-auto w-full">
        <div className="flex items-center justify-center mb-6">
          <div className="relative">
            <div className="w-16 h-16 rounded-full border-4 border-sodium/20" />
            <div className="absolute inset-0 w-16 h-16 rounded-full border-4 border-sodium border-t-transparent animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <Rocket className="h-6 w-6 text-sodium" />
            </div>
          </div>
        </div>
        <h2 className="text-lg font-semibold text-cream text-center mb-2">
          {t("creating.title")}
        </h2>
        <p className="text-sm text-cream/60 text-center">
          {t("creating.subtitle")}
        </p>
        {createServerMutation.error && (
          <div className="mt-6 p-3 rounded-lg bg-terra/10 border border-terra/20 text-center">
            <p className="text-sm text-terra">
              {createServerMutation.error.message}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 border-terra/30 text-terra"
              onClick={() => setAutoProvisionTriggered(false)}
            >
              {t("creating.retry")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
