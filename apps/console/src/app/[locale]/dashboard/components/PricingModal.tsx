// SPDX-License-Identifier: MIT
"use client";

import { useTranslations } from "next-intl";
import { PLATFORM_TIERS, TierGrid, tierLabelsFromT, localizeTiers } from "@ellul.ai/ui/pricing";

interface PricingModalProps {
  selectedTier: string;
  setSelectedTier: (tier: string) => void;
}

// Tier selection card grid for the server creation flow.
export function PricingModal({ selectedTier, setSelectedTier }: PricingModalProps) {
  const t = useTranslations("tier");

  const localizedTiers = localizeTiers(PLATFORM_TIERS, t);

  return (
    <TierGrid
      tiers={localizedTiers}
      onSelect={(tier) => setSelectedTier(tier.id)}
      isSelected={(tier) => tier.id === selectedTier}
      getCtaLabel={(tier) => (tier.id === selectedTier ? t("cta.selected") : t("cta.select"))}
      labels={tierLabelsFromT(t)}
    />
  );
}
