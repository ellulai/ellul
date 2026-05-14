// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/chat/ContextWindowMeter.tsx

import { useTranslations } from "use-intl";
import { cn } from "@shared/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "../lib/context-window";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: { usage: ContextWindowSnapshot }) {
  const tChat = useTranslations("chat");
  const { usage } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="group inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-85"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? tChat("contextWindow.usedAria", { percent: usedPercentage })
                : tChat("contextWindow.tokensUsedAria", {
                    tokens: formatContextWindowTokens(usage.usedTokens),
                  })
            }
          >
            <span className="relative flex h-6 w-6 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted) 70%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="var(--color-muted-foreground)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
              <span
                className={cn(
                  "relative flex h-[15px] w-[15px] items-center justify-center rounded-full bg-background text-[8px] font-medium",
                  "text-muted-foreground",
                )}
              >
                {usage.usedPercentage !== null
                  ? Math.round(usage.usedPercentage)
                  : formatContextWindowTokens(usage.usedTokens)}
              </span>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            {tChat("contextWindow.label")}
          </div>
          {usage.maxTokens !== null && usedPercentage ? (
            <div className="whitespace-nowrap text-xs font-medium text-foreground">
              <span>{usedPercentage}</span>
              <span className="mx-1">⋅</span>
              {tChat("contextWindow.contextUsed", {
                used: formatContextWindowTokens(usage.usedTokens),
                total: formatContextWindowTokens(usage.maxTokens ?? null),
              })}
            </div>
          ) : (
            <div className="text-sm text-foreground">
              {tChat("contextWindow.tokensUsedSoFar", {
                tokens: formatContextWindowTokens(usage.usedTokens),
              })}
            </div>
          )}
          {(usage.totalProcessedTokens ?? null) !== null &&
          (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
            <div className="text-xs text-muted-foreground">
              {tChat("contextWindow.totalProcessed", {
                tokens: formatContextWindowTokens(usage.totalProcessedTokens ?? null),
              })}
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="text-xs text-muted-foreground">
              {tChat("contextWindow.autoCompacts")}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
