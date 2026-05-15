// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { Schema } from "effect";

export const ProviderKind = Schema.Literals([
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
  "zeroclaw",
  "grokAgent",
]);
export type ProviderKind = typeof ProviderKind.Type;

export const DEFAULT_PROVIDER_KIND: ProviderKind = "codex";

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  zeroclaw: "ZeroClaw",
  grokAgent: "Grok Build",
};
