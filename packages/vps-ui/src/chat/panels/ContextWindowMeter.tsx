// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { memo } from "react";
import { cn } from "@shared/utils";

export interface ContextWindowMeterProps {
  usedTokens: number;
  maxTokens: number | null;
  label?: string;
}

export const ContextWindowMeter = memo(function ContextWindowMeter({
  usedTokens,
  maxTokens,
  label,
}: ContextWindowMeterProps) {
  if (!maxTokens || maxTokens <= 0) return null;
  const pct = Math.min(1, usedTokens / maxTokens);
  const percentLabel = `${Math.round(pct * 100)}%`;
  const tone = pct >= 0.95 ? "text-terra" : pct >= 0.8 ? "text-amber-400" : "text-muted-foreground/70";
  return (
    <div className="flex items-center gap-2" title={`${usedTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens`}>
      {label && <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/50">{label}</span>}
      <div className="relative h-1.5 w-24 rounded-full bg-muted/50 overflow-hidden">
        <div
          className={cn(
            "absolute inset-y-0 left-0 rounded-full transition-all",
            pct >= 0.95 ? "bg-terra" : pct >= 0.8 ? "bg-amber-400" : "bg-sodium/70",
          )}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
      <span className={cn("text-[10px] font-mono tabular-nums", tone)}>{percentLabel}</span>
    </div>
  );
});
