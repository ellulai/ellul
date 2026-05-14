// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Canonical tool-type classifier.
 *
 * Maps per-provider tool names (`Bash`, `shell`, `bash`, `edit`, `Task`,
 * `WebSearch`, …) onto a closed canonical set used by the UI for
 * rendering + approval routing. Providers agree on shape, not name.
 */

import type { CanonicalToolKind } from '@ellul.ai/types';

export type ApprovalRequestKind =
  | 'command_execution_approval'
  | 'file_read_approval'
  | 'file_change_approval'
  | 'dynamic_tool_call';

export function classifyTool(toolName: string): CanonicalToolKind {
  const n = (toolName || '').toLowerCase();

  // Subagent / Task tools — preferred over generic "agent" contains.
  if (
    n === 'task' ||
    n === 'agent' ||
    n.includes('subagent') ||
    n.includes('sub-agent') ||
    n.includes('collab_agent')
  ) {
    return 'subagent_task';
  }
  if (n.includes('agent')) {
    // Generic `*agent*` (uncommon) treated as subagent.
    return 'subagent_task';
  }

  if (
    n.includes('bash') ||
    n === 'shell' ||
    n === 'exec' ||
    n.includes('command') ||
    n.includes('terminal')
  ) {
    return 'command_execution';
  }

  if (
    n === 'read' ||
    n.includes('file_read') ||
    n === 'view' ||
    n === 'cat'
  ) {
    return 'file_read';
  }

  if (
    n === 'edit' ||
    n === 'write' ||
    n === 'multiedit' ||
    n === 'patch' ||
    n.includes('file_change') ||
    n.includes('replace') ||
    n === 'create_file' ||
    n === 'delete_file'
  ) {
    return 'file_change';
  }

  if (n.startsWith('mcp_') || n.includes('mcp')) {
    return 'mcp_tool_call';
  }

  if (n.includes('websearch') || n.includes('web_search')) {
    return 'web_search';
  }

  if (n === 'webfetch' || n === 'web_fetch') {
    return 'web_fetch';
  }

  if (n.includes('image')) {
    return 'image_view';
  }

  if (n === 'grep' || n === 'glob' || n === 'find' || n === 'search') {
    return 'search';
  }

  if (n.includes('todowrite') || n === 'todo' || n === 'plan') {
    return 'todo_write';
  }

  return 'dynamic_tool_call';
}

/** Is the tool read-only — no state change, doesn't need write approval. */
export function isReadOnlyTool(toolName: string): boolean {
  const kind = classifyTool(toolName);
  return kind === 'file_read' || kind === 'search' || kind === 'web_search' || kind === 'web_fetch' || kind === 'image_view';
}

/** Map a canonical kind to the approval request kind used by the gate system. */
export function approvalKindFor(toolName: string): ApprovalRequestKind {
  const kind = classifyTool(toolName);
  if (kind === 'file_read' || kind === 'search') return 'file_read_approval';
  if (kind === 'command_execution') return 'command_execution_approval';
  if (kind === 'file_change') return 'file_change_approval';
  return 'dynamic_tool_call';
}

/**
 * Produce a short, human-readable title for a tool invocation.
 *
 * Preference order:
 *  1. `command` / `cmd` field (bash-like tools)
 *  2. For subagents: `description` → `prompt` → `input` truncated,
 *     prefixed with `subagent_type` when present
 *  3. For file tools: `file_path` / `path`
 *  4. For web tools: `url` / `query`
 *  5. Fallback: `toolName: <json>` truncated
 */
export function summarizeToolInvocation(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string {
  if (!input) return toolName;

  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;

  const command = str(input.command) ?? str(input.cmd);
  if (command) return `${toolName}: ${command.slice(0, 400)}`;

  const kind = classifyTool(toolName);

  if (kind === 'subagent_task') {
    const description = str(input.description);
    const prompt = str(input.prompt);
    const subagentType = str(input.subagent_type);
    const label = description || (prompt ? prompt.slice(0, 200) : undefined);
    if (label) return subagentType ? `${subagentType}: ${label}` : label;
  }

  if (kind === 'file_read' || kind === 'file_change') {
    const filePath = str(input.file_path) ?? str(input.path) ?? str(input.filename);
    if (filePath) return `${toolName}: ${filePath}`;
  }

  if (kind === 'web_search' || kind === 'web_fetch') {
    const url = str(input.url);
    const query = str(input.query);
    if (url) return `${toolName}: ${url}`;
    if (query) return `${toolName}: ${query}`;
  }

  if (kind === 'search') {
    const pattern = str(input.pattern) ?? str(input.query) ?? str(input.glob);
    if (pattern) return `${toolName}: ${pattern}`;
  }

  const serialized = JSON.stringify(input);
  return serialized.length <= 400
    ? `${toolName}: ${serialized}`
    : `${toolName}: ${serialized.slice(0, 397)}…`;
}

/**
 * Extract PlanStep[] from a TodoWrite-style tool input. Returns null if
 * the tool isn't a todo tool or the input doesn't carry the expected
 * shape. Accepts both Claude's `todos: [{ content, status, ... }]` and
 * plain `steps: [{ step, status }]` payloads.
 */
export function extractPlanSteps(
  toolName: string,
  input: Record<string, unknown> | undefined,
): import('@ellul.ai/types').PlanStep[] | null {
  if (!input) return null;
  if (classifyTool(toolName) !== 'todo_write') return null;

  const source =
    (Array.isArray((input as { todos?: unknown }).todos) && (input as { todos: unknown[] }).todos) ||
    (Array.isArray((input as { steps?: unknown }).steps) && (input as { steps: unknown[] }).steps) ||
    null;
  if (!source || source.length === 0) return null;

  const normalizeStatus = (s: unknown): import('@ellul.ai/types').PlanStepStatus => {
    if (s === 'completed' || s === 'done') return 'completed';
    if (s === 'in_progress' || s === 'inProgress' || s === 'running') return 'inProgress';
    return 'pending';
  };

  return source
    .filter((t): t is Record<string, unknown> => t !== null && typeof t === 'object')
    .map((todo) => {
      const content =
        typeof todo.content === 'string' ? todo.content :
        typeof todo.step === 'string' ? todo.step :
        typeof todo.text === 'string' ? todo.text :
        'Task';
      return {
        step: content.trim() || 'Task',
        status: normalizeStatus(todo.status),
      };
    });
}

/**
 * Pick the rendering kind for a tool's output stream.
 *  - command_execution → `command_output` (streams live, monospaced)
 *  - file_change → `file_change_output` (diff-ish)
 *  - everything else → `text`
 */
export function toolOutputKindFor(toolName: string): import('@ellul.ai/types').ToolOutputKind {
  const kind = classifyTool(toolName);
  if (kind === 'command_execution') return 'command_output';
  if (kind === 'file_change') return 'file_change_output';
  return 'text';
}
