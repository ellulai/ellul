// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { memo } from "react";
import { PinIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { cn } from "@shared/utils";
import {
  getDisplayModelName,
  getTriggerDisplayModelLabel,
  type ModelEsque,
} from "../lib/provider-icon-utils";
import { ComboboxItem } from "../ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  providerSlug: string;
  isPinned: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  showNewBadge?: boolean;
  onTogglePin: () => void;
}) {
  const tChat = useTranslations("chat");
  const pinLabel = props.isPinned ? tChat("ui.modelPicker.unpinDefault") : tChat("ui.modelPicker.pinDefault");
  return (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={`${props.providerSlug}:${props.model.slug}`}
      contentClassName="flex w-full items-start gap-2"
      className={cn(
        "group w-full cursor-pointer rounded px-3 py-2 transition-colors",
        "data-[highlighted]:bg-sodium/10",
        "data-[selected]:bg-sodium/15 data-[selected]:text-cream",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              className={cn(
                "mt-0.5 shrink-0 cursor-pointer transition-opacity",
                props.isPinned ? "opacity-100" : "opacity-40 group-hover:opacity-100",
              )}
              onClick={(event) => {
                event.stopPropagation();
                props.onTogglePin();
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
              }}
              type="button"
              aria-label={pinLabel}
              aria-pressed={props.isPinned}
            >
              <PinIcon
                className={cn(
                  "size-4 transition-transform",
                  props.isPinned && "fill-current text-sodium -rotate-45",
                )}
              />
            </button>
          }
        />
        <TooltipPopup side="top" align="center">
          {pinLabel}
        </TooltipPopup>
      </Tooltip>

      <div className="min-w-0 flex-1 text-left">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 text-xs font-medium leading-snug">
            <span className="truncate">
              {props.useTriggerLabel
                ? getTriggerDisplayModelLabel(props.model)
                : getDisplayModelName(
                    props.model,
                    props.preferShortName ? { preferShortName: true } : undefined,
                  )}
            </span>
            {props.showNewBadge ? (
              <span
                className="shrink-0 rounded border border-sodium/35 bg-sodium/15 px-1 py-px text-[10px] font-bold uppercase leading-none tracking-wide text-sodium"
                aria-label={tChat("ui.modelPicker.newModelAria")}
              >
                {tChat("ui.modelPicker.newBadge")}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </ComboboxItem>
  );
});
