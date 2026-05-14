// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type {
  CanonicalItemType,
  RuntimeItemStatus,
  RuntimePlanStep,
  RuntimeTurnState,
} from "@ellul.ai/types";
import {
  classifyToolItemType,
  extractExitPlanModePlan,
  extractPlanStepsFromTodoInput,
  isExitPlanModeTool,
  isTodoTool,
  summarizeToolRequest,
  titleForTool,
  toolInputFingerprint,
} from "./tool-classify";

export type ClaudeTextStreamKind = "assistant_text" | "reasoning_text";

export interface ClaudeStreamState {
  sessionId: string | null;
  // Active assistant message id; bumped when a new `assistant` event with
  // a different id arrives. Block index 0 in a new message is a fresh
  // block, not the same block as index 0 in the prior message.
  currentMessageId: string | null;
  // Blocks of the current message keyed by local block index.
  blocks: Map<number, BlockRecord>;
  // Tool_use records from any message in this turn. Survives message
  // boundaries so a tool_result later in the turn can find its tool_use.
  toolUseIdToBlock: Map<string, BlockRecord>;
  emittedTextByItemId: Map<string, string>;
  emittedInputFingerprintByItemId: Map<string, string>;
  result: ClaudeStreamResult | null;
  hasCompletedToolUse: boolean;
}

export interface BlockRecord {
  index: number;
  type: "text" | "thinking" | "tool_use" | "unknown";
  itemId: string;
  toolUseId: string | null;
  toolName: string | null;
  itemType: CanonicalItemType | null;
  partialInputJson: string;
  input: Record<string, unknown> | null;
  startedEmitted: boolean;
  completedEmitted: boolean;
}

export interface ClaudeStreamResult {
  status: "success" | "error" | "interrupted";
  errorMessage: string | null;
  totalCostUsd: number | null;
  durationMs: number | null;
  resultText: string | null;
  modelUsage: Record<string, unknown> | null;
  numTurns: number | null;
}

export interface ClaudeBlockParserDeps {
  readonly genItemId: () => string;
}

export type ParsedClaudeEvent =
  | ParsedSessionId
  | ParsedTextDelta
  | ParsedItemStarted
  | ParsedItemUpdated
  | ParsedItemCompleted
  | ParsedPlanUpdated
  | ParsedProposedPlan
  | ParsedTurnCompleted
  | ParsedRuntimeWarning;

export interface ParsedSessionId {
  kind: "session.id";
  sessionId: string;
}

export interface ParsedTextDelta {
  kind: "content.delta";
  itemId: string;
  streamKind: ClaudeTextStreamKind;
  delta: string;
  contentIndex: number;
}

export interface ParsedItemStarted {
  kind: "item.started";
  itemId: string;
  itemType: CanonicalItemType;
  toolUseId: string;
  toolName: string;
  title: string;
  detail: string;
  input: Record<string, unknown>;
}

export interface ParsedItemUpdated {
  kind: "item.updated";
  itemId: string;
  itemType: CanonicalItemType;
  toolUseId: string;
  input: Record<string, unknown>;
  title: string;
  detail: string;
}

export interface ParsedItemCompleted {
  kind: "item.completed";
  itemId: string;
  itemType: CanonicalItemType;
  toolUseId: string;
  status: RuntimeItemStatus;
  output: string;
  isError: boolean;
}

export interface ParsedPlanUpdated {
  kind: "turn.plan.updated";
  plan: ReadonlyArray<RuntimePlanStep>;
  explanation?: string | null;
}

export interface ParsedProposedPlan {
  kind: "turn.proposed.completed";
  planMarkdown: string;
}

export interface ParsedTurnCompleted {
  kind: "turn.completed";
  state: RuntimeTurnState;
  errorMessage: string | null;
  totalCostUsd: number | null;
  durationMs: number | null;
  modelUsage: Record<string, unknown> | null;
  resultText: string | null;
}

export interface ParsedRuntimeWarning {
  kind: "runtime.warning";
  message: string;
  raw?: unknown;
}

export function newClaudeStreamState(): ClaudeStreamState {
  return {
    sessionId: null,
    currentMessageId: null,
    blocks: new Map(),
    toolUseIdToBlock: new Map(),
    emittedTextByItemId: new Map(),
    emittedInputFingerprintByItemId: new Map(),
    result: null,
    hasCompletedToolUse: false,
  };
}

/** Caller is responsible for line-buffering across stdout chunks. */
export function parseClaudeStreamLine(
  state: ClaudeStreamState,
  line: string,
  deps: ClaudeBlockParserDeps,
): ReadonlyArray<ParsedClaudeEvent> {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    return [
      {
        kind: "runtime.warning",
        message: `Claude stream-json parse error: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        raw: trimmed.slice(0, 500),
      },
    ];
  }

  if (!parsed || typeof parsed !== "object") return [];
  const message = parsed as Record<string, unknown>;
  const messageType = typeof message.type === "string" ? message.type : null;
  if (!messageType) return [];

  switch (messageType) {
    case "system":
      return handleSystemMessage(state, message);
    case "assistant":
      return handleAssistantMessage(state, message, deps);
    case "user":
      return handleUserMessage(state, message);
    case "result":
      return handleResultMessage(state, message);
    case "stream_event":
      return handleStreamEvent(state, message, deps);
    default:
      return [];
  }
}

/** Clear turn-scoped fields between turns; sessionId is process-scoped and kept. */
export function resetClaudeStreamTurn(state: ClaudeStreamState): void {
  state.currentMessageId = null;
  state.blocks.clear();
  state.toolUseIdToBlock.clear();
  state.emittedTextByItemId.clear();
  state.emittedInputFingerprintByItemId.clear();
  state.result = null;
  state.hasCompletedToolUse = false;
}

export function flushClaudeStreamOnAbort(reason: string): ParsedTurnCompleted {
  return {
    kind: "turn.completed",
    state: "failed",
    errorMessage: reason,
    totalCostUsd: null,
    durationMs: null,
    modelUsage: null,
    resultText: null,
  };
}

function handleSystemMessage(
  state: ClaudeStreamState,
  message: Record<string, unknown>,
): ReadonlyArray<ParsedClaudeEvent> {
  if (message.subtype === "init" && typeof message.session_id === "string") {
    state.sessionId = message.session_id;
    return [{ kind: "session.id", sessionId: message.session_id }];
  }
  return [];
}

function handleAssistantMessage(
  state: ClaudeStreamState,
  message: Record<string, unknown>,
  deps: ClaudeBlockParserDeps,
): ReadonlyArray<ParsedClaudeEvent> {
  const innerMessage = message.message as Record<string, unknown> | undefined;
  if (!innerMessage) return [];
  const content = innerMessage.content;
  if (!Array.isArray(content)) return [];

  const messageId = typeof innerMessage.id === "string" ? innerMessage.id : null;
  if (messageId !== null && messageId !== state.currentMessageId) {
    // New message boundary — block indices restart at 0. Drop the
    // current-message dedupe maps but keep `toolUseIdToBlock` so a
    // tool_result later in the turn still finds its tool_use record.
    state.currentMessageId = messageId;
    state.blocks.clear();
  }

  const events: ParsedClaudeEvent[] = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block || typeof block !== "object") continue;
    const blockEvents = handleAssistantBlock(state, block as Record<string, unknown>, i, deps);
    events.push(...blockEvents);
  }
  return events;
}

function handleAssistantBlock(
  state: ClaudeStreamState,
  block: Record<string, unknown>,
  blockIndex: number,
  deps: ClaudeBlockParserDeps,
): ReadonlyArray<ParsedClaudeEvent> {
  const blockType = typeof block.type === "string" ? block.type : null;

  if (blockType === "text" && typeof block.text === "string") {
    const record = ensureBlock(state, blockIndex, "text", deps);
    return emitTextProgress(state, record, "assistant_text", block.text);
  }

  if (blockType === "thinking" && typeof block.thinking === "string") {
    const record = ensureBlock(state, blockIndex, "thinking", deps);
    return emitTextProgress(state, record, "reasoning_text", block.thinking);
  }

  if (blockType === "tool_use") {
    const toolUseId = typeof block.id === "string" ? block.id : null;
    const toolName = typeof block.name === "string" ? block.name : null;
    if (!toolUseId || !toolName) return [];

    const record = ensureBlock(state, blockIndex, "tool_use", deps);
    record.toolUseId = toolUseId;
    record.toolName = toolName;
    record.itemType = classifyToolItemType(toolName);
    state.toolUseIdToBlock.set(toolUseId, record);

    const input =
      block.input && typeof block.input === "object" && !Array.isArray(block.input)
        ? (block.input as Record<string, unknown>)
        : {};
    record.input = input;

    const fingerprint = toolInputFingerprint(input);
    const lastFingerprint = state.emittedInputFingerprintByItemId.get(record.itemId);
    if (fingerprint !== undefined && fingerprint === lastFingerprint) {
      return [];
    }
    if (fingerprint !== undefined) {
      state.emittedInputFingerprintByItemId.set(record.itemId, fingerprint);
    }

    const events: ParsedClaudeEvent[] = [];
    const detail = summarizeToolRequest(toolName, input);
    const title = titleForTool(record.itemType);

    if (!record.startedEmitted) {
      record.startedEmitted = true;
      events.push({
        kind: "item.started",
        itemId: record.itemId,
        itemType: record.itemType,
        toolUseId,
        toolName,
        title,
        detail,
        input,
      });
    } else {
      events.push({
        kind: "item.updated",
        itemId: record.itemId,
        itemType: record.itemType,
        toolUseId,
        input,
        title,
        detail,
      });
    }

    if (isTodoTool(toolName)) {
      const steps = extractPlanStepsFromTodoInput(input);
      if (steps && steps.length > 0) {
        events.push({ kind: "turn.plan.updated", plan: steps });
      }
    }

    if (isExitPlanModeTool(toolName)) {
      const plan = extractExitPlanModePlan(input);
      if (plan) {
        events.push({ kind: "turn.proposed.completed", planMarkdown: plan });
      }
    }

    return events;
  }

  return [];
}

function handleUserMessage(
  state: ClaudeStreamState,
  message: Record<string, unknown>,
): ReadonlyArray<ParsedClaudeEvent> {
  const innerMessage = message.message as Record<string, unknown> | undefined;
  if (!innerMessage) return [];
  const content = innerMessage.content;
  if (!Array.isArray(content)) return [];

  // The optional `tool_use_result` field at the top level carries the
  // exec details from the inner sandbox (stdout/stderr/exit_code). When
  // present, prefer it over the textual block content for richer output.
  const topLevelToolResult = (message as { tool_use_result?: unknown }).tool_use_result;
  const exec =
    topLevelToolResult && typeof topLevelToolResult === "object" && !Array.isArray(topLevelToolResult)
      ? (topLevelToolResult as { stdout?: unknown; stderr?: unknown; exit_code?: unknown })
      : null;

  const events: ParsedClaudeEvent[] = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") continue;
    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
    if (!toolUseId) continue;

    const record = state.toolUseIdToBlock.get(toolUseId);
    if (!record || record.type !== "tool_use" || !record.itemType) continue;
    if (record.completedEmitted) continue;

    const isError = block.is_error === true;
    const blockOutput = extractToolResultText(block.content);

    let output = blockOutput;
    let resolvedIsError = isError;
    if (exec) {
      const stdout = typeof exec.stdout === "string" ? exec.stdout : "";
      const stderr = typeof exec.stderr === "string" ? exec.stderr : "";
      if (stdout || stderr) {
        output = [stdout, stderr].filter(Boolean).join("\n");
        if (!stdout && stderr && !resolvedIsError) {
          resolvedIsError = true;
        }
      }
      const exitCode = typeof exec.exit_code === "number" ? exec.exit_code : null;
      if (exitCode !== null && exitCode !== 0 && !resolvedIsError) {
        resolvedIsError = true;
      }
    }

    record.completedEmitted = true;
    state.hasCompletedToolUse = true;

    const status: RuntimeItemStatus = resolvedIsError ? "failed" : "completed";

    events.push({
      kind: "item.completed",
      itemId: record.itemId,
      itemType: record.itemType,
      toolUseId,
      status,
      output,
      isError: resolvedIsError,
    });
  }

  return events;
}

function handleResultMessage(
  state: ClaudeStreamState,
  message: Record<string, unknown>,
): ReadonlyArray<ParsedClaudeEvent> {
  const subtype = typeof message.subtype === "string" ? message.subtype : "success";
  const isErrorField = message.is_error === true;
  const resultText = typeof message.result === "string" ? message.result : null;
  const totalCostUsd =
    typeof message.total_cost_usd === "number" && Number.isFinite(message.total_cost_usd)
      ? message.total_cost_usd
      : null;
  const durationMs =
    typeof message.duration_ms === "number" && Number.isFinite(message.duration_ms)
      ? message.duration_ms
      : null;
  const modelUsage =
    message.modelUsage && typeof message.modelUsage === "object" && !Array.isArray(message.modelUsage)
      ? (message.modelUsage as Record<string, unknown>)
      : null;
  const numTurns =
    typeof message.num_turns === "number" && Number.isFinite(message.num_turns)
      ? message.num_turns
      : null;

  const errorsText = readResultErrorsText(message);
  const interrupted =
    errorsText.includes("interrupt") ||
    errorsText.includes("aborted") ||
    errorsText.includes("interrupted by user");

  const status: ClaudeStreamResult["status"] = interrupted
    ? "interrupted"
    : isErrorField || subtype === "error_during_execution"
      ? "error"
      : "success";

  const errorMessage = status === "success" ? null : errorsText.trim() || resultText || subtype;

  state.result = {
    status,
    errorMessage,
    totalCostUsd,
    durationMs,
    resultText,
    modelUsage,
    numTurns,
  };

  const turnState: RuntimeTurnState =
    status === "success" ? "completed" : status === "interrupted" ? "interrupted" : "failed";

  return [
    {
      kind: "turn.completed",
      state: turnState,
      errorMessage,
      totalCostUsd,
      durationMs,
      modelUsage,
      resultText,
    },
  ];
}

function handleStreamEvent(
  state: ClaudeStreamState,
  message: Record<string, unknown>,
  deps: ClaudeBlockParserDeps,
): ReadonlyArray<ParsedClaudeEvent> {
  const event = message.event as Record<string, unknown> | undefined;
  if (!event) return [];
  const eventType = typeof event.type === "string" ? event.type : null;
  if (eventType !== "content_block_delta") return [];

  const blockIndex = typeof event.index === "number" ? event.index : null;
  if (blockIndex === null) return [];
  const delta = event.delta as Record<string, unknown> | undefined;
  if (!delta) return [];
  const deltaType = typeof delta.type === "string" ? delta.type : null;

  if (deltaType === "text_delta" && typeof delta.text === "string") {
    const record = ensureBlock(state, blockIndex, "text", deps);
    return emitTextDelta(state, record, "assistant_text", delta.text);
  }
  if (deltaType === "thinking_delta" && typeof delta.thinking === "string") {
    const record = ensureBlock(state, blockIndex, "thinking", deps);
    return emitTextDelta(state, record, "reasoning_text", delta.thinking);
  }
  if (deltaType === "input_json_delta" && typeof delta.partial_json === "string") {
    // Accumulate; emit item.updated only on the full assistant re-emit
    // since partial JSON isn't safely parseable.
    const record = ensureBlock(state, blockIndex, "tool_use", deps);
    record.partialInputJson += delta.partial_json;
    return [];
  }

  return [];
}

function ensureBlock(
  state: ClaudeStreamState,
  blockIndex: number,
  type: BlockRecord["type"],
  deps: ClaudeBlockParserDeps,
): BlockRecord {
  const existing = state.blocks.get(blockIndex);
  if (existing) {
    if (existing.type !== type && type !== "unknown" && existing.type === "unknown") {
      existing.type = type;
    }
    return existing;
  }
  const record: BlockRecord = {
    index: blockIndex,
    type,
    itemId: deps.genItemId(),
    toolUseId: null,
    toolName: null,
    itemType: null,
    partialInputJson: "",
    input: null,
    startedEmitted: false,
    completedEmitted: false,
  };
  state.blocks.set(blockIndex, record);
  return record;
}

function emitTextProgress(
  state: ClaudeStreamState,
  record: BlockRecord,
  streamKind: ClaudeTextStreamKind,
  fullText: string,
): ReadonlyArray<ParsedClaudeEvent> {
  const previous = state.emittedTextByItemId.get(record.itemId) ?? "";
  if (fullText === previous) return [];
  const delta = fullText.startsWith(previous) ? fullText.slice(previous.length) : fullText;
  state.emittedTextByItemId.set(record.itemId, fullText);
  if (delta.length === 0) return [];
  return [
    {
      kind: "content.delta",
      itemId: record.itemId,
      streamKind,
      delta,
      contentIndex: record.index,
    },
  ];
}

function emitTextDelta(
  state: ClaudeStreamState,
  record: BlockRecord,
  streamKind: ClaudeTextStreamKind,
  delta: string,
): ReadonlyArray<ParsedClaudeEvent> {
  if (!delta) return [];
  const previous = state.emittedTextByItemId.get(record.itemId) ?? "";
  state.emittedTextByItemId.set(record.itemId, previous + delta);
  return [
    {
      kind: "content.delta",
      itemId: record.itemId,
      streamKind,
      delta,
      contentIndex: record.index,
    },
  ];
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object" && "text" in c) {
        const text = (c as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function readResultErrorsText(message: Record<string, unknown>): string {
  const errors = message.errors;
  if (!Array.isArray(errors)) return "";
  return errors
    .map((e) => (typeof e === "string" ? e : JSON.stringify(e)))
    .join(" ")
    .toLowerCase();
}
