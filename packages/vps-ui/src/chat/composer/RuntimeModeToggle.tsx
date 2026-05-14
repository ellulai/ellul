// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { memo } from "react";
import { useTranslations } from "use-intl";
import type { RuntimeMode } from "@ellul.ai/types";
import { Button } from "../ui/button";

export interface RuntimeModeToggleProps {
  mode: RuntimeMode;
  onChange: (mode: RuntimeMode) => void;
  proSlotsAvailable: boolean;
  disabled?: boolean;
}

export const RuntimeModeToggle = memo(function RuntimeModeToggle({
  mode,
  onChange,
  proSlotsAvailable,
  disabled,
}: RuntimeModeToggleProps) {
  const tChat = useTranslations("chat");
  const isPro = mode === "full-access";
  return (
    <div role="group" aria-label={tChat("runtimeModeToggle.groupAria")} className="inline-flex rounded-md border border-border p-0.5">
      <Button
        type="button"
        size="sm"
        variant={!isPro ? "default" : "ghost"}
        className="h-6 px-2 text-xs"
        onClick={() => onChange("read-only" as RuntimeMode)}
        disabled={disabled}
        aria-pressed={!isPro}
      >
        {tChat("runtimeModeToggle.lite")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant={isPro ? "default" : "ghost"}
        className="h-6 px-2 text-xs"
        onClick={() => onChange("full-access" as RuntimeMode)}
        disabled={disabled || !proSlotsAvailable}
        aria-pressed={isPro}
        title={proSlotsAvailable ? tChat("runtimeModeToggle.useProTitle") : tChat("runtimeModeToggle.atCapacityTitle")}
      >
        {tChat("runtimeModeToggle.pro")}
      </Button>
    </div>
  );
});
