// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { memo } from "react";
import { Undo2 } from "lucide-react";
import { useTranslations } from "use-intl";
import { cn } from "@shared/utils";

export interface PerTurnRevertButtonProps {
  turnId: string;
  turnCount: number;
  disabled?: boolean;
  onRevert: (turnId: string) => void;
}

export const PerTurnRevertButton = memo(function PerTurnRevertButton({
  turnId,
  turnCount,
  disabled,
  onRevert,
}: PerTurnRevertButtonProps) {
  const tChat = useTranslations("chat");
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onRevert(turnId)}
      title={tChat("perTurnRevert.tooltip", { count: turnCount })}
      className={cn(
        "inline-flex items-center gap-1 text-[10px] uppercase tracking-wide",
        "text-muted-foreground/60 hover:text-terra transition-colors",
        "disabled:opacity-40 disabled:hover:text-muted-foreground/60",
      )}
    >
      <Undo2 className="h-3 w-3" />
      {tChat("perTurnRevert.label", { count: turnCount })}
    </button>
  );
});
