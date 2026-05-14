// SPDX-License-Identifier: MIT
"use client";

// SecurityStrengthBar - Enterprise-grade security tier visualization.

import { useTranslations } from "next-intl";
import { SECURITY_TIERS, type SecurityLevel } from "@/lib/environment-lock";
import { cn } from "@/lib/utils";

interface SecurityStrengthBarProps {
  currentLevel: SecurityLevel;
  className?: string;
  // Show tier descriptions inline (for first-time/onboarding view)
  expanded?: boolean;
}

export function SecurityStrengthBar({ currentLevel, className, expanded }: SecurityStrengthBarProps) {
  const t = useTranslations("console.webLockCard");
  const currentIndex = SECURITY_TIERS.findIndex((tier) => tier.id === currentLevel);

  // Map tier id → translated short label / description
  const labelMap: Record<SecurityLevel, { short: string; description: string }> = {
    standard: {
      short: t("tierShortLabel.standard"),
      description: t("tierDescription.standard"),
    },
    web_lock: {
      short: t("tierShortLabel.web"),
      description: t("tierDescription.webLock"),
    },
    privacy_lock: {
      short: t("tierShortLabel.privacy"),
      description: t("tierDescription.privacyLock"),
    },
  };

  return (
    <div className={cn("space-y-2.5", className)}>
      {/* Bar */}
      <div className="flex gap-[3px] h-2.5 rounded-full overflow-hidden bg-cream/[0.03] border border-cream/[0.06] p-[2px]">
        {SECURITY_TIERS.map((tier, i) => {
          const isActive = i <= currentIndex;
          const isCurrent = i === currentIndex;
          return (
            <div
              key={tier.id}
              className={cn(
                "flex-1 rounded-full transition-all duration-700 ease-out relative overflow-hidden",
                isActive ? tier.barColor : "bg-cream/[0.02]",
                isActive && "opacity-100",
                !isActive && "opacity-40",
              )}
            >
              {/* Animated pulse on current tier */}
              {isCurrent && (
                <div className={cn(
                  "absolute inset-0 rounded-full animate-pulse",
                  tier.barColor,
                  "opacity-40",
                )} />
              )}
            </div>
          );
        })}
      </div>

      {/* Tier labels */}
      <div className="flex justify-between items-start">
        {SECURITY_TIERS.map((tier, i) => {
          const isActive = i <= currentIndex;
          const isCurrent = i === currentIndex;
          const isNext = i === currentIndex + 1;
          const Icon = tier.icon;
          return (
            <div
              key={tier.id}
              className={cn(
                "flex flex-col items-center gap-1 transition-all duration-300 min-w-0",
                i === 0 && "items-start",
                i === SECURITY_TIERS.length - 1 && "items-end",
              )}
            >
              <div className={cn(
                "flex items-center gap-1.5 transition-all duration-300",
                isCurrent ? tier.color : isActive ? "text-cream/75" : "text-cream/35",
                isNext && "text-cream/45",
              )}>
                <Icon className={cn(
                  "h-3.5 w-3.5 transition-all duration-300",
                  isCurrent && "drop-shadow-[0_0_6px_currentColor]",
                )} />
                <span className={cn(
                  "text-[11px] font-medium tracking-wide uppercase transition-all duration-300",
                  isCurrent && "font-bold text-[11.5px]",
                )}>
                  {labelMap[tier.id].short}
                </span>
                {tier.permanent && isActive && (
                  <span className="text-[8px] bg-sodium/20 text-cream/65 px-1.5 py-0.5 rounded-full border border-sodium/30 font-semibold tracking-wider uppercase">
                    {t("permanent")}
                  </span>
                )}
              </div>

              {/* Description - only shows when expanded (onboarding) */}
              {expanded && (isCurrent || isNext) && (
                <p className={cn(
                  "text-[10px] leading-tight max-w-[120px] transition-all duration-200",
                  i === 0 && "text-left",
                  i === 1 && "text-center",
                  i === SECURITY_TIERS.length - 1 && "text-right",
                  isCurrent ? "text-cream/60" : isActive ? "text-cream/45" : "text-cream/35",
                )}>
                  {labelMap[tier.id].description}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
