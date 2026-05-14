// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Per-provider model catalog with capabilities.
 *
 * Each model declares its own supported effort levels. The picker UI
 * filters the effort sub-row by the selected model's capabilities so a
 * user can never pick an effort the model doesn't accept.
 */

import type { CodexReasoningEffort, ClaudeEffort } from './cli-options';

export type ProviderKind = 'claude' | 'codex' | 'cursor' | 'opencode' | 'zeroclaw';

export type ModelBadge = 'new' | 'recommended' | 'preview' | 'deprecated';

export interface ModelCapabilities {
  /** Stable id used as the CLI `--model` flag value or session selector. */
  id: string;
  /** Human-readable name shown in the picker. */
  name: string;
  /** Optional one-line subtitle. */
  description?: string;
  /** Optional badge in the picker sidebar. */
  badge?: ModelBadge;
  /** Effort levels the model accepts. Empty = no effort sub-row. */
  supportedEfforts: readonly string[];
  /** Default effort when the user hasn't picked one. */
  defaultEffort?: string;
  /** True when fast-mode (lower-latency tier) is meaningful for this model. */
  supportsFastMode?: boolean;
  /** Approximate context window in tokens (display only). */
  contextWindow?: number;
}

/**
 * Claude models. Effort spans the full Claude axis where applicable.
 * Haiku skips xhigh/max/ultrathink (no extended thinking on Haiku).
 */
export const CLAUDE_MODELS: readonly ModelCapabilities[] = [
  {
    id: 'claude-opus-4-7',
    name: 'Opus 4.7',
    description: 'Most capable, slowest',
    badge: 'recommended',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'] satisfies ClaudeEffort[],
    defaultEffort: 'medium',
    supportsFastMode: false,
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Sonnet 4.6',
    description: 'Balanced speed + intelligence',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'] satisfies ClaudeEffort[],
    defaultEffort: 'medium',
    supportsFastMode: true,
    contextWindow: 200_000,
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Haiku 4.5',
    description: 'Fastest, no extended thinking',
    supportedEfforts: ['low', 'medium'] satisfies ClaudeEffort[],
    defaultEffort: 'medium',
    supportsFastMode: true,
    contextWindow: 200_000,
  },
];

/**
 * Codex / OpenAI models routed through the Codex CLI. The reasoning
 * effort axis applies to gpt-5 and codex-1; mini/turbo variants cap
 * at medium.
 */
export const CODEX_MODELS: readonly ModelCapabilities[] = [
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    description: 'Full reasoning model',
    badge: 'recommended',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'] satisfies CodexReasoningEffort[],
    defaultEffort: 'medium',
    supportsFastMode: true,
    contextWindow: 400_000,
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    description: 'Faster, lower cost',
    supportedEfforts: ['low', 'medium'] satisfies CodexReasoningEffort[],
    defaultEffort: 'medium',
    supportsFastMode: true,
    contextWindow: 400_000,
  },
  {
    id: 'gpt-5.3-codex',
    name: 'GPT-5.3 Codex',
    description: 'Tuned for code',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'] satisfies CodexReasoningEffort[],
    defaultEffort: 'medium',
    supportsFastMode: true,
    contextWindow: 400_000,
  },
  {
    id: 'gpt-5.2-codex',
    name: 'GPT-5.2 Codex',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'] satisfies CodexReasoningEffort[],
    defaultEffort: 'medium',
    supportsFastMode: true,
    contextWindow: 400_000,
  },
  {
    id: 'gpt-5.2',
    name: 'GPT-5.2',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'] satisfies CodexReasoningEffort[],
    defaultEffort: 'medium',
    supportsFastMode: true,
    contextWindow: 400_000,
  },
];

/**
 * OpenCode models are dynamic (zen models discovered at runtime). The
 * static catalog is empty; the UI merges runtime zen-models into the
 * picker for OpenCode sessions.
 */
export const OPENCODE_MODELS: readonly ModelCapabilities[] = [];

/**
 * Cursor Agent models. The CLI auto-selects the underlying model and doesn't
 * expose an effort knob, so supportedEfforts stays empty.
 */
export const CURSOR_MODELS: readonly ModelCapabilities[] = [
  {
    id: 'cursor-default',
    name: 'Cursor (auto)',
    description: 'Cursor selects the underlying model',
    badge: 'recommended',
    supportedEfforts: [],
    contextWindow: 200_000,
  },
];

/**
 * ZeroClaw is a daemon-managed in-process agent. The daemon picks its own
 * upstream provider/model via its config.toml; the orchestration UI sees
 * a single opaque "default" entry so the picker collapses to one row.
 */
export const ZEROCLAW_MODELS: readonly ModelCapabilities[] = [
  {
    id: 'default',
    name: 'ZeroClaw Default',
    description: 'Daemon-selected model',
    badge: 'recommended',
    supportedEfforts: [],
  },
];

export const MODELS_BY_PROVIDER: Record<ProviderKind, readonly ModelCapabilities[]> = {
  claude: CLAUDE_MODELS,
  codex: CODEX_MODELS,
  cursor: CURSOR_MODELS,
  opencode: OPENCODE_MODELS,
  zeroclaw: ZEROCLAW_MODELS,
};

/** Get the capability record for a given provider+modelId, or null. */
export function getModelCapabilities(
  provider: ProviderKind,
  modelId: string | null | undefined,
): ModelCapabilities | null {
  if (!modelId) return null;
  for (const m of MODELS_BY_PROVIDER[provider] ?? []) {
    if (m.id === modelId) return m;
  }
  return null;
}

/** Return the default model id for a provider (first entry, or null). */
export function defaultModelFor(provider: ProviderKind): string | null {
  return MODELS_BY_PROVIDER[provider]?.[0]?.id ?? null;
}
