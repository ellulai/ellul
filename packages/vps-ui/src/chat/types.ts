// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type {
  MessagePart,
  ProviderInteractionMode,
  RuntimeMode,
} from "@ellul.ai/types";

export type { MessagePart } from "@ellul.ai/types";

export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";

export interface ChatImageAttachment {
  type: "image";
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
}

export type ChatAttachment = ChatImageAttachment;

export interface Thread {
  id: string;
  title: string | null;
  // Canonical sandbox-scoped project (e.g. "sbx-xyz").
  project: string | null;
  // Verbatim subdirectory the user was in when the thread was last
  viewScope: string | null;
  lastSession: string;
  lastModel: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  type: "user" | "assistant" | "error" | "system" | "cli_prompt" | "cli_input";
  // Flat preview derived from text parts for assistant messages.
  content: string;
  session: string | null;
  model: string | null;
  // Ordered structured parts for assistant messages; null otherwise.
  parts: MessagePart[] | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  seq: number;
}

export interface ProcessingState {
  isProcessing: boolean;
  // Parts streamed so far for the in-flight assistant message.
  parts: MessagePart[];
  session: string;
  startedAt?: number;
}

export interface CliPromptOption {
  number: string;
  label: string;
  description: string;
}

export interface ChatMessage {
  id: string;
  type: "user" | "assistant" | "error" | "system" | "cli_prompt" | "cli_input";
  // Flat text — derived from text parts for assistant messages, body text for others.
  content: string;
  timestamp: number;
  // Ordered structured parts; only set on assistant messages.
  parts?: MessagePart[];
  promptSession?: string;
  promptOptions?: CliPromptOption[];
  promptInstructions?: string;
  selectionType?: "number" | "arrow";
  inChatAuth?: boolean;
  // True when the user is allowed to type a free-form answer in the chat
  allowCustom?: boolean;
  // OpenCode question request id, used to correlate a free-form answer.
  questionRequestId?: string;
  // Persisted "this picker was answered with X" state. Stored in backend
  respondedValue?: string;
  inputSession?: string;
  inputPrompt?: string;
  inputUrl?: string;
  deviceCode?: string;
}

export interface ZenModel {
  id: string;
  openCodeId: string;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";

export const SESSIONS = [
  { id: "main", label: "Shell", color: "#34d399" },
  { id: "claw", label: "ZeroClaw", color: "#2563EB" },
  { id: "opencode", label: "OpenCode", color: "#B7B1B1" },
  { id: "claude", label: "Claude", color: "#DE7356" },
  { id: "codex", label: "Codex", color: "#38bdf8" },
  { id: "cursor", label: "Cursor", color: "#E5E5E5" },
] as const;

export type SessionId = (typeof SESSIONS)[number]["id"];
