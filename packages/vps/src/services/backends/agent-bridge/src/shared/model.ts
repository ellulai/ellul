// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — subset of
// pingdotgg/t3code@b0b7b38 packages/shared/src/model.ts

import type { ClaudeAgentEffort, ModelCapabilities, ProviderKind } from "@ellul.ai/types";

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "gpt-5.5",
  claudeAgent: "claude-opus-4-7",
  cursor: "cursor-default",
  opencode: "anthropic/claude-sonnet-4-5",
  zeroclaw: "default",
  grokAgent: "default",
};

// Provider arg kept for parity with upstream signature. We don't ship alias
// tables (MODEL_SLUG_ALIASES_BY_PROVIDER), so this is pass-through after trim.
export function normalizeModelSlug(
  model: string | null | undefined,
  _provider: ProviderKind = "codex",
): string | null {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function hasEffortLevel(caps: ModelCapabilities, value: string): boolean {
  return caps.reasoningEffortLevels.some((l) => l.value === value);
}

export function getDefaultEffort(caps: ModelCapabilities): string | null {
  return caps.reasoningEffortLevels.find((l) => l.isDefault)?.value ?? null;
}

export function resolveEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const defaultValue = getDefaultEffort(caps);
  const trimmed = typeof raw === "string" ? raw.trim() : null;
  if (
    trimmed &&
    !caps.promptInjectedEffortLevels.includes(trimmed) &&
    hasEffortLevel(caps, trimmed)
  ) {
    return trimmed;
  }
  return defaultValue ?? undefined;
}

export function trimOrNull<T extends string>(value: T | null | undefined): T | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim() as T;
  return trimmed || null;
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: ClaudeAgentEffort | null | undefined,
): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (effort !== "ultrathink") {
    return trimmed;
  }
  if (trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }
  return `Ultrathink:\n${trimmed}`;
}
