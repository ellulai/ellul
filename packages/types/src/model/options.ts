// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { Schema } from "effect";
import { TrimmedNonEmptyString } from "../ids";

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export const CodexReasoningEffort = Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS);
export type CodexReasoningEffort = typeof CodexReasoningEffort.Type;

export const CLAUDE_AGENT_EFFORT_OPTIONS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultrathink",
] as const;
export const ClaudeAgentEffort = Schema.Literals(CLAUDE_AGENT_EFFORT_OPTIONS);
export type ClaudeAgentEffort = typeof ClaudeAgentEffort.Type;

export const CURSOR_REASONING_OPTIONS = ["low", "medium", "high", "max", "xhigh"] as const;
export const CursorReasoningOption = Schema.Literals(CURSOR_REASONING_OPTIONS);
export type CursorReasoningOption = typeof CursorReasoningOption.Type;

export type ProviderReasoningEffort =
  | CodexReasoningEffort
  | ClaudeAgentEffort
  | CursorReasoningOption;

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(CodexReasoningEffort),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const ClaudeModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
  effort: Schema.optional(ClaudeAgentEffort),
  fastMode: Schema.optional(Schema.Boolean),
  contextWindow: Schema.optional(Schema.String),
});
export type ClaudeModelOptions = typeof ClaudeModelOptions.Type;

export const CursorModelOptions = Schema.Struct({
  reasoning: Schema.optional(CursorReasoningOption),
  fastMode: Schema.optional(Schema.Boolean),
  thinking: Schema.optional(Schema.Boolean),
  contextWindow: Schema.optional(Schema.String),
});
export type CursorModelOptions = typeof CursorModelOptions.Type;

export const OpenCodeModelOptions = Schema.Struct({
  variant: Schema.optional(TrimmedNonEmptyString),
  agent: Schema.optional(TrimmedNonEmptyString),
});
export type OpenCodeModelOptions = typeof OpenCodeModelOptions.Type;

// ZeroClaw is a daemon-managed in-process agent — no model variants, no
// reasoning effort, no thinking toggle. The struct exists so the discriminated
// ProviderModelOptions union has a slot for "zeroclaw" and downstream
// type narrowing stays exhaustive.
export const ZeroClawModelOptions = Schema.Struct({});
export type ZeroClawModelOptions = typeof ZeroClawModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  claudeAgent: Schema.optional(ClaudeModelOptions),
  cursor: Schema.optional(CursorModelOptions),
  opencode: Schema.optional(OpenCodeModelOptions),
  zeroclaw: Schema.optional(ZeroClawModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

export const EffortOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type EffortOption = typeof EffortOption.Type;

export const ContextWindowOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type ContextWindowOption = typeof ContextWindowOption.Type;

export const ModelCapabilities = Schema.Struct({
  reasoningEffortLevels: Schema.Array(EffortOption),
  supportsFastMode: Schema.Boolean,
  supportsThinkingToggle: Schema.Boolean,
  contextWindowOptions: Schema.Array(ContextWindowOption),
  promptInjectedEffortLevels: Schema.Array(TrimmedNonEmptyString),
  variantOptions: Schema.optional(Schema.Array(EffortOption)),
  agentOptions: Schema.optional(Schema.Array(EffortOption)),
});
export type ModelCapabilities = typeof ModelCapabilities.Type;
