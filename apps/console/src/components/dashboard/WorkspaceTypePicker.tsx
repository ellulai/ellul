// SPDX-License-Identifier: MIT
"use client";

import { useTranslations } from "next-intl";
import { resolveIconKey } from "@/lib/workspace-extension-registry";
import { ALL_PRESETS } from "@/lib/workspace-presets";
import { cn } from "@/lib/utils";
import { Check } from "lucide-react";

interface WorkspaceTypePickerProps {
  selectedPresetId: string | null;
  onSelect: (presetId: string) => void;
}

// Workspace type picker shown during sandbox creation.
export function WorkspaceTypePicker({ selectedPresetId, onSelect }: WorkspaceTypePickerProps) {
  const t = useTranslations("console.onboarding.presets");

  const presetCopy = (presetId: string): { label: string; description: string } => {
    if (presetId === "developer") {
      return { label: t("developer.label"), description: t("developer.description") };
    }
    if (presetId === "studio") {
      return { label: t("studio.label"), description: t("studio.description") };
    }
    return { label: presetId, description: "" };
  };

  return (
    <div className="flex flex-col gap-2">
      {ALL_PRESETS.map((preset, index) => {
        const Icon = resolveIconKey(preset.iconKey);
        const isSelected = selectedPresetId === preset.id;
        const copy = presetCopy(preset.id);

        return (
          <button
            key={preset.id}
            onClick={() => onSelect(preset.id)}
            className={cn(
              "group relative flex items-center gap-4 px-4 py-3.5 rounded-xl border transition-all text-left animate-fade-in-up",
              isSelected
                ? "border-sodium/40 bg-sodium/[0.06] ring-1 ring-sodium/20"
                : "border-cream/[0.06] bg-cream/[0.015] hover:bg-cream/[0.04] hover:border-cream/[0.12]"
            )}
            style={{ animationDelay: `${120 + index * 50}ms`, animationFillMode: "backwards" }}
          >
            {/* Icon */}
            <div className={cn(
              "w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-colors",
              isSelected ? "bg-sodium/15" : "bg-cream/[0.04] group-hover:bg-cream/[0.06]"
            )}>
              <Icon className={cn(
                "h-4 w-4 transition-colors",
                isSelected ? "text-sodium" : "text-cream/60 group-hover:text-cream/75"
              )} />
            </div>

            {/* Label + tabs */}
            <div className="flex-1 min-w-0">
              <span className={cn(
                "text-[13px] font-semibold block leading-tight transition-colors",
                isSelected ? "text-cream" : "text-cream/85"
              )}>
                {copy.label}
              </span>
              <span className="text-xs text-cream/45 leading-tight mt-0.5 block">
                {copy.description}
              </span>
            </div>

            {/* Selection indicator */}
            <div className={cn(
              "w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 transition-all",
              isSelected
                ? "border-sodium bg-sodium"
                : "border-cream/[0.12] group-hover:border-cream/[0.25]"
            )}>
              {isSelected && <Check className="h-3 w-3 text-cream" strokeWidth={3} />}
            </div>
          </button>
        );
      })}
    </div>
  );
}
