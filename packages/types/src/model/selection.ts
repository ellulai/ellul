// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { Schema } from "effect";
import { TrimmedNonEmptyString } from "../ids";
import type { ProviderKind } from "../provider/kind";
import {
  ClaudeModelOptions,
  CodexModelOptions,
  CursorModelOptions,
  OpenCodeModelOptions,
  ZeroClawModelOptions,
} from "./options";

export const CodexModelSelection = Schema.Struct({
  provider: Schema.Literal("codex"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(CodexModelOptions),
});
export type CodexModelSelection = typeof CodexModelSelection.Type;

export const ClaudeModelSelection = Schema.Struct({
  provider: Schema.Literal("claudeAgent"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ClaudeModelOptions),
});
export type ClaudeModelSelection = typeof ClaudeModelSelection.Type;

export const CursorModelSelection = Schema.Struct({
  provider: Schema.Literal("cursor"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(CursorModelOptions),
});
export type CursorModelSelection = typeof CursorModelSelection.Type;

export const OpenCodeModelSelection = Schema.Struct({
  provider: Schema.Literal("opencode"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(OpenCodeModelOptions),
});
export type OpenCodeModelSelection = typeof OpenCodeModelSelection.Type;

export const ZeroClawModelSelection = Schema.Struct({
  provider: Schema.Literal("zeroclaw"),
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ZeroClawModelOptions),
});
export type ZeroClawModelSelection = typeof ZeroClawModelSelection.Type;

export const ModelSelection = Schema.Union([
  CodexModelSelection,
  ClaudeModelSelection,
  CursorModelSelection,
  OpenCodeModelSelection,
  ZeroClawModelSelection,
]);
export type ModelSelection = typeof ModelSelection.Type;

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "gpt-5.4",
  claudeAgent: "claude-opus-4-7",
  cursor: "auto",
  // Must exist in opencode-zen's connected list; gpt-5 is paid-only.
  opencode: "opencode/minimax-m2.5-free",
  zeroclaw: "default",
};

export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;

export const DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "gpt-5.4-mini",
  claudeAgent: "claude-haiku-4-5",
  cursor: "composer-2",
  opencode: "opencode/minimax-m2.5-free",
  zeroclaw: "default",
};

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<ProviderKind, Record<string, string>> = {
  codex: {
    "gpt-5-codex": "gpt-5.4",
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  claudeAgent: {
    opus: "claude-opus-4-7",
    "opus-4.7": "claude-opus-4-7",
    "claude-opus-4.7": "claude-opus-4-7",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4-6-20251117": "claude-opus-4-6",
    sonnet: "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
  cursor: {
    composer: "composer-2",
    "composer-1.5": "composer-1.5",
    "composer-1": "composer-1.5",
    "opus-4.6-thinking": "claude-opus-4-6",
    "opus-4.6": "claude-opus-4-6",
    "sonnet-4.6-thinking": "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "opus-4.5-thinking": "claude-opus-4-5",
    "opus-4.5": "claude-opus-4-5",
  },
  opencode: {},
  zeroclaw: {},
};
