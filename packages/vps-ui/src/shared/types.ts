// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Server-injected settings available synchronously on page load
export interface ShieldSettings {
  desktopViewMode: "focus" | "studio";
  uiMode: "lite" | "pro";
  /**
   * User-identity locale, projected from `users.preferred_locale` (api DB
   * authoritative) via the console iframe's `?locale=` query at HTML-serve
   * time. Required in production; absent only in local Vite dev (no VPS
   * host). vps-ui's IntlRoot reads this; never a fallback chain.
   */
  locale?: string;
}

declare global {
  interface Window {
    __SHIELD_SETTINGS__?: ShieldSettings;
  }
}

// Messages sent FROM the dashboard TO the iframe SPA. Gates and per-tool
// permissions are console-native (operator-signed REST) and are NOT relayed
// through this protocol.
export type IncomingMessage =
  | { type: "set_project"; project: string; projectId?: string | null; monorepoLeafProjectIds?: readonly string[] }
  | { type: "set_session"; session: string }
  | { type: "set_theme"; mode: "dark" | "light" }
  | { type: "set_app"; app: string }
  | { type: "auth_complete" }
  | { type: "set_view"; view: "tree" | "changes" | "search" }
  | { type: "refresh" }
  | { type: "action_result"; action: string; success: boolean; error?: string }
  | { type: "set_view_mode"; mode: "focus" | "studio"; mobile?: boolean }
  | { type: "set_chrome_mode"; mode: "standalone" | "embedded" }
  | { type: "code_context"; file: string; line?: number; endLine?: number; snippet?: string; context?: string }
  | { type: "preview_fix_request"; scope: string; error: string; logTail?: string; kind: "install_failed" | "unit_failed" }
  | { type: "set_locale"; locale: string }
  | { type: "gate_continue"; gate: string; requestId?: string }
  | { type: "select_thread"; threadId: string };

// Messages sent FROM the iframe SPA TO the dashboard
export type OutgoingMessage =
  | { type: "ready" }
  | { type: "auth_needed" }
  | { type: "processing"; active: boolean }
  | { type: "state_update"; view: "tree" | "changes" | "search"; changesCount: number; loading: boolean }
  | { type: "action"; action: string; project: string; gateType?: string }
  | { type: "project_changed"; project: string }
  | { type: "project_list"; apps: ReadonlyArray<string>; active: string | null }
  | { type: "ask_ai"; file: string; line?: number; endLine?: number; snippet?: string; commit?: string; context: "full_file" | "selection" | "search_result" | "blame" | "diff" }
  | { type: "fix_request"; file: string; line?: number; snippet?: string; diff?: string; context: "diff" | "search_result" | "selection" | "full_file" }
  // Iframe → console request to surface a sibling panel. Console decides how
  // to honour it (focus the code panel in studio mode, swap the active iframe
  // in focus mode). Used by Phase 7a-NATIVE Layer 4's WelcomeOverlay so the
  // "Open the code editor" CTA reaches the parent without a same-iframe
  // navigation.
  | { type: "request_panel"; panel: "chat" | "code" }
  | { type: "thread_active"; threadId: string | null };
