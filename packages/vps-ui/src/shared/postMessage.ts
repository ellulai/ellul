// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { isOriginTrusted } from "./security";
import type { IncomingMessage, OutgoingMessage } from "./types";

type MessageHandler = (msg: IncomingMessage) => void;

let handler: MessageHandler | null = null;

// Embedder hands us its origin via the `parentOrigin` URL parameter so we
// can target postMessage to a specific origin (never "*" — outgoing messages
// can include source-code snippets via ask_ai/fix_request). The value is
// validated against the platform allowlist so a hostile embedder can't
// redirect outbound messages to an attacker-controlled origin. Persisted to
// sessionStorage so intra-iframe navigation and reloads keep working even if
// the in-iframe router strips the query string.
const PARENT_ORIGIN_KEY = "ellul.parentOrigin";

function resolveParentOrigin(): string | null {
  if (typeof window === "undefined") return null;
  let fromUrl: string | null = null;
  try {
    fromUrl = new URL(window.location.href).searchParams.get("parentOrigin");
  } catch {
    fromUrl = null;
  }
  if (fromUrl && isOriginTrusted(fromUrl)) {
    try { window.sessionStorage.setItem(PARENT_ORIGIN_KEY, fromUrl); } catch {}
    return fromUrl;
  }
  let fromStorage: string | null = null;
  try {
    fromStorage = window.sessionStorage.getItem(PARENT_ORIGIN_KEY);
  } catch {
    fromStorage = null;
  }
  if (fromStorage && isOriginTrusted(fromStorage)) return fromStorage;
  return null;
}

const PARENT_ORIGIN = resolveParentOrigin();

function onMessage(event: MessageEvent) {
  if (!isOriginTrusted(event.origin)) return;
  if (!event.data || typeof event.data.type !== "string") return;
  handler?.(event.data as IncomingMessage);
}

// Register a handler for incoming postMessage from the dashboard
export function listenForMessages(fn: MessageHandler): () => void {
  handler = fn;
  window.addEventListener("message", onMessage);
  return () => {
    handler = null;
    window.removeEventListener("message", onMessage);
  };
}

// Send a message to the parent dashboard. Drops silently if not embedded or
// the embedder didn't supply a trusted parentOrigin.
export function sendToParent(msg: OutgoingMessage): void {
  if (window.parent === window) return;
  if (!PARENT_ORIGIN) return;
  window.parent.postMessage(msg, PARENT_ORIGIN);
}
