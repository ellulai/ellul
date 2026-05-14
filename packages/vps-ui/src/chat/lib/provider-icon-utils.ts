// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/chat/providerIconUtils.ts

import type { FC, SVGProps } from "react";
import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@ellul.ai/types";
import {
  ClaudeLogo,
  CursorLogo,
  OpenAILogo,
  OpenCodeLogo,
  ZeroClawLogo,
} from "@shared/ui/ai-logos";
import { PROVIDER_OPTIONS } from "./session-logic";

export type Icon = FC<SVGProps<SVGSVGElement>>;

export const PROVIDER_ICON_BY_PROVIDER: Record<ProviderKind, Icon> = {
  codex: OpenAILogo,
  claudeAgent: ClaudeLogo,
  opencode: OpenCodeLogo,
  cursor: CursorLogo,
  zeroclaw: ZeroClawLogo,
};

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
};

export function getProviderLabel(provider: ProviderKind, model: ModelEsque): string {
  const providerLabel = PROVIDER_DISPLAY_NAMES[provider];
  return model.subProvider ? `${providerLabel} · ${model.subProvider}` : providerLabel;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  if (options?.preferShortName && model.shortName) return model.shortName;
  return model.name;
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  const title = getTriggerDisplayModelName(model);
  return model.subProvider ? `${model.subProvider} · ${title}` : title;
}
