// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/components/chat/modelPickerModelHighlights.ts

import type { ProviderKind } from "@ellul.ai/types";

const NEW_MODEL_KEYS = new Set<string>([
  // Add `provider:slug` entries to highlight freshly shipped models.
]);

export function isModelPickerNewModel(provider: ProviderKind, slug: string): boolean {
  return NEW_MODEL_KEYS.has(`${provider}:${slug}`);
}
