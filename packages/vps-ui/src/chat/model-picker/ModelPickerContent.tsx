// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { ProviderKind } from "@ellul.ai/types";
import { memo, useCallback } from "react";
import { useTranslations } from "use-intl";
import { cn } from "@shared/utils";
import { ModelListRow } from "./ModelListRow";
import { isModelPickerNewModel } from "../lib/model-picker-highlights";
import { type ModelEsque } from "../lib/provider-icon-utils";
import { Combobox, ComboboxEmpty, ComboboxList } from "../ui/combobox";
import { TooltipProvider } from "../ui/tooltip";

export interface ModelPickerContentProps {
  provider: ProviderKind;
  model: string;
  models: ReadonlyArray<ModelEsque>;
  pinnedModelSlug: string | null;
  onTogglePin: (model: string) => void;
  onRequestClose?: () => void;
  onModelChange: (model: string) => void;
}

export const ModelPickerContent = memo(function ModelPickerContent(props: ModelPickerContentProps) {
  const tChat = useTranslations("chat");
  const { models, onModelChange, onTogglePin, provider } = props;

  const modelKeys = models.map((model) => `${provider}:${model.slug}`);

  const handleSelect = useCallback(
    (modelKey: string) => {
      const slug = modelKey.slice(provider.length + 1);
      const match = models.find((entry) => entry.slug === slug);
      if (match) onModelChange(match.slug);
    },
    [models, onModelChange, provider],
  );

  return (
    <TooltipProvider delay={0}>
      <div
        className={cn(
          "relative flex w-screen max-w-[280px] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-panel-lift",
        )}
      >
        <Combobox
          inline
          items={modelKeys}
          filteredItems={modelKeys}
          filter={null}
          autoHighlight
          open
          value={`${provider}:${props.model}`}
          onValueChange={(modelKey) => {
            if (typeof modelKey === "string") handleSelect(modelKey);
          }}
        >
          <div className="flex max-h-96 min-h-0 flex-col overflow-hidden">
            <ComboboxList className="model-picker-list size-full divide-y divide-border/40 px-2 py-1">
              {models.map((model, index) => (
                <ModelListRow
                  key={model.slug}
                  index={index}
                  model={model}
                  providerSlug={provider}
                  isPinned={props.pinnedModelSlug === model.slug}
                  preferShortName
                  showNewBadge={isModelPickerNewModel(provider, model.slug)}
                  onTogglePin={() => onTogglePin(model.slug)}
                />
              ))}
            </ComboboxList>
            <ComboboxEmpty className="py-6 text-xs font-normal leading-snug">
              {tChat("ui.modelPicker.noModels")}
            </ComboboxEmpty>
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
