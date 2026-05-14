// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Message-part taxonomy shared by agent-bridge and the chat iframe.
 * Mirrors OpenCode's message-v2 Part shape. Parts carry a stable `id`
 * across delta + update events and render in emission order.
 */

export type MessageToolStatus = 'pending' | 'running' | 'completed' | 'error';

export interface MessageTextPart {
  id: string;
  type: 'text';
  text: string;
  startedAt?: number;
  endedAt?: number;
}

export interface MessageReasoningPart {
  id: string;
  type: 'reasoning';
  text: string;
  startedAt?: number;
  endedAt?: number;
}

/**
 * How the tool's `output` should be rendered.
 * - `text` (default): plain string, shown in the expandable drawer.
 * - `command_output`: terminal-style stream (bash/shell) — rendered in a
 *   monospaced block and streamed live via tool.output_delta events.
 * - `file_change_output`: structured diff/patch.
 * - `tool_result`: generic structured result (JSON or mixed).
 */
export type ToolOutputKind = 'text' | 'command_output' | 'file_change_output' | 'tool_result';

export interface MessageToolPart {
  id: string;
  type: 'tool';
  callId: string;
  tool: string;
  /**
   * Canonical kind for UI rendering. Stable across providers so Codex
   * `shell`, Claude `Bash`, and OpenCode `bash` all render as a terminal.
   */
  canonicalKind?: CanonicalToolKind;
  status: MessageToolStatus;
  title?: string;
  input?: Record<string, unknown>;
  output?: string;
  outputKind?: ToolOutputKind;
  error?: string;
  metadata?: Record<string, unknown>;
  startedAt?: number;
  endedAt?: number;
}

export type CanonicalToolKind =
  | 'command_execution'
  | 'file_change'
  | 'file_read'
  | 'mcp_tool_call'
  | 'subagent_task'
  | 'web_search'
  | 'web_fetch'
  | 'image_view'
  | 'search'
  | 'todo_write'
  | 'dynamic_tool_call';

export interface MessageFilePart {
  id: string;
  type: 'file';
  mime?: string;
  filename?: string;
  /** Renderers must check the scheme against SAFE_FILE_URL_SCHEMES. */
  url?: string;
}

export interface MessageStepMarkerPart {
  id: string;
  type: 'step-start' | 'step-finish';
}

export type PlanStepStatus = 'pending' | 'inProgress' | 'completed';

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

/**
 * Structured plan surface emitted when a TodoWrite-style tool updates
 * the model's working todo list. Rendered in its own panel, separate
 * from the tool invocation itself.
 */
export interface MessagePlanPart {
  id: string;
  type: 'plan';
  steps: PlanStep[];
  startedAt?: number;
  endedAt?: number;
}

export type MessagePart =
  | MessageTextPart
  | MessageReasoningPart
  | MessageToolPart
  | MessageFilePart
  | MessagePlanPart
  | MessageStepMarkerPart;

export type MessagePartType = MessagePart['type'];

/** Schemes file-part URLs are permitted to use. */
export const SAFE_FILE_URL_SCHEMES = ['http:', 'https:'] as const;

export function isSafeFileUrl(url: string | undefined): boolean {
  if (!url) return false;
  const match = url.match(/^([a-z][a-z0-9+.\-]*:)/i);
  if (!match) return false;
  return (SAFE_FILE_URL_SCHEMES as readonly string[]).includes(match[1]!.toLowerCase());
}

/** Concatenated text preview for an ordered part list. */
export function deriveContentFromParts(parts: readonly MessagePart[]): string {
  const textChunks: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      const trimmed = part.text.trim();
      if (trimmed) textChunks.push(trimmed);
    }
  }
  return textChunks.join('\n\n');
}
