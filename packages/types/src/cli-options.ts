// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Per-CLI tunable options stored per-thread. Each provider exposes its
 * own option keys; the UI offers only the keys that apply to the
 * currently-selected provider.
 *
 * On the wire as `ThreadCliOptions`; persisted on the threads row as
 * a single `cli_options_json` blob.
 */

export const CODEX_REASONING_EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh'] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];

export const CLAUDE_EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORT_OPTIONS)[number];

export const INTERACTION_MODES = ['default', 'plan'] as const;
export type InteractionMode = (typeof INTERACTION_MODES)[number];

export const RUNTIME_MODES = ['approval-required', 'auto-accept-edits', 'full-access'] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

interface SharedProviderOptions {
  /** Per-provider — "plan" means the agent describes a plan before executing. */
  interactionMode?: InteractionMode;
  /** Per-provider — how aggressively approvals are auto-granted. */
  runtimeMode?: RuntimeMode;
}

export interface CodexOptions extends SharedProviderOptions {
  /** CLI `--model` flag value (e.g. "gpt-5", "gpt-5-codex"). */
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  /** When true, ask Codex to use the lower-latency service tier. */
  fastMode?: boolean;
}

export interface ClaudeOptions extends SharedProviderOptions {
  /** CLI `--model` flag value (e.g. "claude-opus-4-7"). */
  model?: string;
  /** Coarse thinking-budget knob. `ultrathink` injects a system primer. */
  effort?: ClaudeEffort;
  /** When true, prefer faster (smaller) variants. */
  fastMode?: boolean;
  /** When true, always prepend a "think" escalation prefix. */
  alwaysThink?: boolean;
  /** Per-model extended-thinking flag (SDK-native, independent of alwaysThink prefix). */
  thinking?: boolean;
}

export interface OpenCodeOptions extends SharedProviderOptions {
  /** OpenCode model id (e.g. "anthropic/claude-3-5-sonnet-20241022"). */
  model?: string;
  /** Optional model variant override (e.g. high-reasoning subvariant). */
  variant?: string;
  /** Optional named agent override. */
  agent?: string;
}

export interface CursorOptions extends SharedProviderOptions {
  model?: string;
  reasoning?: 'low' | 'medium' | 'high' | 'max' | 'xhigh';
  fastMode?: boolean;
  thinking?: boolean;
}

export interface ThreadCliOptions {
  codex?: CodexOptions;
  claude?: ClaudeOptions;
  opencode?: OpenCodeOptions;
  cursor?: CursorOptions;
}

/**
 * What the UI offers per provider — one source of truth for the
 * picker. Empty array = no effort sub-row.
 */
export const EFFORT_LEVELS_BY_PROVIDER: Record<string, readonly string[]> = {
  codex: CODEX_REASONING_EFFORT_OPTIONS,
  claude: CLAUDE_EFFORT_OPTIONS,
  opencode: [],
  cursor: [],
};

export function isCodexReasoningEffort(v: unknown): v is CodexReasoningEffort {
  return typeof v === 'string' && (CODEX_REASONING_EFFORT_OPTIONS as readonly string[]).includes(v);
}

export function isClaudeEffort(v: unknown): v is ClaudeEffort {
  return typeof v === 'string' && (CLAUDE_EFFORT_OPTIONS as readonly string[]).includes(v);
}
