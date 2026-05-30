// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "use-intl";
import { ChevronDown, ChevronRight, ChevronLeft, FileUp, Loader2, MoreVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "./ui/select";
import { ClaudeLogo, GrokLogo, OpenAILogo, CursorLogo, ZeroClawLogo, OpenCodeLogo } from "@shared/ui/ai-logos";
import { cn, randomUUID } from "@shared/utils";
import { useAgentAuth } from "./hooks/useAgentAuth";
import { useIntegrations } from "./hooks/useIntegrations";
import { useProviderStatuses } from "./hooks/useProviderStatuses";
import { ActionsDropdown } from "./components/ActionsDropdown";
import type { ResolvedAction } from "@ellul.ai/types";
import { listenForMessages, sendToParent } from "@shared/postMessage";
import { getBridgeWsUrl } from "@shared/security";
import { useLocale } from "@shared/i18n/useLocale";
import { applyTheme } from "@shared/theme";
import type {
  Thread,
  ConnectionStatus,
  SessionId,
} from "./types";
import { SESSIONS } from "./types";
import { createWsRpcClient, type WsRpcClient } from "./lib/ws-rpc-client";
import type {
  ApprovalRequestId,
  ChatMessage,
  ClientOrchestrationCommand,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderKind,
  ProviderUserInputAnswers,
  RuntimeMode,
  ScopedProjectRef,
  ScopedThreadRef,
  ServerProvider,
  SidebarThreadSummary,
  Thread as StoreThread,
  ThreadId as ThreadIdBrand,
  TurnId,
  UnifiedSettings,
} from "@ellul.ai/types";
import { DEFAULT_MODEL_BY_PROVIDER, DEFAULT_UNIFIED_SETTINGS } from "@ellul.ai/types";
import { getDefaultServerModel } from "./provider-models";
import { createModelSelection } from "./lib/shared-model";
import { useShallow } from "zustand/react/shallow";
import { setActiveEnvironmentClient } from "./lib/environment-api";
import { useComposerDraftStore } from "./composer-draft-store";
import { useStore } from "./state/store";
import {
  selectBootstrapCompleteForActiveEnvironment,
  selectSidebarThreadsForProjectRef,
  selectSidebarThreadsForProjectRefs,
  selectThreadByRef,
} from "./state/store";
import { scopeProjectRef, scopeThreadRef } from "./lib/scoped";
import { MessagesTimeline } from "./timeline/MessagesTimeline";
import { ChatComposer, type ChatComposerHandle } from "./composer/ChatComposer";
import {
  deriveActiveWorkStartedAt,
  deriveCompletionDividerBeforeEntryId,
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveWorkLogEntries,
  inferCheckpointTurnCountByTurnId,
  isLatestTurnSettled,
} from "./lib/session-logic";
import {
  type PendingUserInputDraftAnswer,
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./lib/pending-user-input";
import {
  AnchoredToastProvider,
  stackedThreadToast,
  ThreadIdContext,
  ToastProvider,
  toastManager,
} from "./ui/toast";
import { ProviderStatusBanner } from "./panels/ProviderStatusBanner";
import { ProviderAuthPrompt } from "./panels/ProviderAuthPrompt";
import { AuthSetupModal } from "./panels/AuthSetupModal";
import { ThreadErrorBanner } from "./panels/ThreadErrorBanner";
import { ConnectionStatusBanner } from "./panels/ConnectionStatusBanner";
import { DegradationModeBanner } from "./panels/DegradationModeBanner";
import { QueuedSendPill } from "./composer/QueuedSendPill";
import { ArchiveSection } from "./sidebar/ArchiveSection";
import { SandboxSwitcher } from "./components/SandboxSwitcher";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LegendListRef } from "@legendapp/list/react";

const ELLUL_ENV_ID = "ellul" as EnvironmentId;
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const DEFAULT_INTERACTION_MODE: ProviderInteractionMode = "default";
const EMPTY_PINNED_MODEL_BY_PROVIDER: Partial<Record<ProviderKind, string>> = {};
const EMPTY_SERVER_PROVIDERS: ServerProvider[] = [];
const queryClient = new QueryClient();
const IS_ANDROID = window.__ELLUL_CONFIG__?.platform === "android";

function isTouchDevice() {
  return window.matchMedia("(pointer: coarse)").matches;
}

function providerForSession(session: string): ProviderKind | null {
  switch (session) {
    case "claude":
      return "claudeAgent";
    case "codex":
      return "codex";
    case "cursor":
      return "cursor";
    case "claw":
      return "zeroclaw";
    case "grok":
      return "grokAgent";
    case "opencode":
    case "main":
      return "opencode";
    default:
      return null;
  }
}

// It provides WebSocket PoP challenge-response (SSH-equivalent security)
declare const SESSION_POP: {
  createSignedWebSocket: (url: string, protocols?: string | string[]) => WebSocket;
} | undefined;

// Thread picker sessions — same shape as the console ThreadPicker. Decorated
const _ALL_SESSION_DISPLAY = [
  { id: "claw", label: "ZeroClaw", color: "#2563EB", icon: ZeroClawLogo },
  { id: "opencode", label: "OpenCode", color: "#B7B1B1", icon: OpenCodeLogo },
  { id: "claude", label: "Claude", color: "#DE7356", icon: ClaudeLogo },
  { id: "codex", label: "Codex", color: "#38bdf8", icon: OpenAILogo },
  { id: "cursor", label: "Cursor", color: "#E5E5E5", icon: CursorLogo },
  { id: "grok", label: "Grok Build", color: "#FFFFFF", icon: GrokLogo },
] as const;

const _DISABLED = new Set(window.__ELLUL_CONFIG__?.disabledSessions ?? []);
const _DISABLED_PROVIDERS = new Set(
  [..._DISABLED].map((s) => providerForSession(s)).filter((p): p is ProviderKind => p !== null),
);
const SESSION_DISPLAY = _DISABLED.size > 0
  ? _ALL_SESSION_DISPLAY.filter((s) => !_DISABLED.has(s.id))
  : [..._ALL_SESSION_DISPLAY];

const THREAD_SESSIONS = SESSION_DISPLAY;

const SESSION_MAP = Object.fromEntries(_ALL_SESSION_DISPLAY.map((s) => [s.id, s]));

function AdapterPicker({
  value,
  onChange,
  size = "xs",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  size?: "xs" | "sm";
  className?: string;
}) {
  const handleChange = useCallback((v: string | null) => { if (v) onChange(v); }, [onChange]);
  const session = SESSION_MAP[value];
  const Icon = session?.icon;
  return (
    <Select value={value} onValueChange={handleChange}>
      <SelectTrigger size={size} variant="ghost" className={className}>
        {Icon && session ? (
          <span className="flex items-center gap-1.5 truncate">
            <Icon className={cn("shrink-0", size === "xs" ? "w-3 h-3" : "w-3.5 h-3.5")} style={{ color: session.color }} />
            <span className="truncate text-xs font-medium" style={{ color: session.color }}>{session.label}</span>
          </span>
        ) : (
          <SelectValue placeholder="Adapter" />
        )}
      </SelectTrigger>
      <SelectPopup>
        {THREAD_SESSIONS.map((s) => {
          const SIcon = s.icon;
          return (
            <SelectItem key={s.id} value={s.id}>
              <span className="flex items-center gap-2">
                <SIcon className="w-3.5 h-3.5 shrink-0" style={{ color: s.color }} />
                <span style={{ color: s.color }}>{s.label}</span>
              </span>
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
}


/** Format a timestamp as a relative time string ("5 minutes ago" /
 *  "5分前") for recent values, or as a locale-aware absolute date for
 *  older values. ICU plural forms in the message tree handle one/other
 *  branching correctly per locale; Intl.DateTimeFormat handles the
 *  absolute path so JP users see 2026/05/02 rather than 5/2/2026.
 */
function formatRelativeTime(
  timestamp: number,
  t: (key: string, values?: Record<string, string | number>) => string,
  locale: string,
): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return t("relativeTime.justNow");
  if (minutes < 60) return t("relativeTime.minutesAgo", { count: minutes });
  if (hours < 24) return t("relativeTime.hoursAgo", { count: hours });
  if (days < 7) return t("relativeTime.daysAgo", { count: days });
  try {
    return new Intl.DateTimeFormat(locale).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleDateString();
  }
}

// ---------- ThreadItem (matches console ThreadPicker) ----------

function ThreadItem({
  thread,
  isActive,
  onSelect,
  onDelete,
  onRename,
  showScope,
}: {
  thread: Thread;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  showScope?: boolean;
}) {
  const tChat = useTranslations("chat");
  const locale = useLocale();
  const [showMenu, setShowMenu] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(thread.title || "");

  const effectiveSessionId = _DISABLED.has(thread.lastSession ?? "") ? SESSION_DISPLAY[0]?.id ?? "opencode" : thread.lastSession;
  const session = SESSION_MAP[effectiveSessionId];
  const sColor = session?.color || "#94a3b8";
  const SIcon = session?.icon || ClaudeLogo;

  // Derive the thread's scope label: the portion of view_scope AFTER the
  const scopeLabel = (() => {
    if (!thread.viewScope) return null;
    const slash = thread.viewScope.indexOf("/");
    if (slash < 0) return null;
    const sub = thread.viewScope.slice(slash + 1).trim();
    return sub || null;
  })();

  const handleRename = useCallback(() => {
    if (editTitle.trim() && editTitle.trim() !== thread.title) {
      onRename(editTitle.trim());
    }
    setIsEditing(false);
  }, [editTitle, thread.title, onRename]);

  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 px-3 py-3 rounded-lg cursor-pointer transition-colors",
        isActive ? "bg-cream/10 text-cream" : "text-cream/75 hover:bg-cream/5"
      )}
      onClick={onSelect}
    >
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: `${sColor}20` }}
      >
        <SIcon className="w-4 h-4" style={{ color: sColor }} />
      </div>
      <div className="flex-1 min-w-0">
        {isEditing ? (
          <input
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRename();
              if (e.key === "Escape") setIsEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full bg-cream/10 border border-cream/20 rounded px-2 py-0.5 text-sm text-cream focus:outline-none focus:border-sodium"
            autoFocus
          />
        ) : (
          <>
            <div className="truncate text-sm font-medium">
              {thread.title || tChat("threads.newThreadFallback")}
            </div>
            <div className="flex items-center gap-2 text-xs text-cream/45">
              <span style={{ color: sColor }}>{session?.label || thread.lastSession}</span>
              <span>&middot;</span>
              <span>{formatRelativeTime(thread.updatedAt, tChat, locale)}</span>
            </div>
            {showScope && scopeLabel && (
              <div className="mt-0.5">
                <span
                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium bg-cream/5 text-cream/45 border border-cream/5"
                  title={thread.viewScope ?? undefined}
                >
                  {scopeLabel.split("/").length > 2 ? scopeLabel.split("/").slice(-2).join("/") : scopeLabel}
                </span>
              </div>
            )}
          </>
        )}
      </div>
      <div
        className={cn(
          "flex items-center transition-opacity",
          showMenu || isActive ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        )}
      >
        <button
          onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
          className="p-1.5 rounded hover:bg-cream/10"
        >
          <MoreVertical className="w-4 h-4 text-cream/60" />
        </button>
      </div>
      {showMenu && (
        <>
        <div className="fixed inset-0 z-[9] cursor-default" onClick={(e) => { e.stopPropagation(); setShowMenu(false); }} />
        <div
          className="absolute right-2 top-full mt-1 z-10 bg-card border border-cream/10 rounded-lg shadow-lg py-1 min-w-[120px]"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => { setIsEditing(true); setShowMenu(false); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-cream/75 hover:bg-cream/10"
          >
            <Pencil className="w-3 h-3" />
            {tChat("thread.rename")}
          </button>
          <button
            onClick={() => { onDelete(); setShowMenu(false); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-terra hover:bg-cream/10"
          >
            <Trash2 className="w-3 h-3" />
            {tChat("thread.delete")}
          </button>
        </div>
        </>
      )}
    </div>
  );
}

// ---------- Thread message type detection ----------

const THREAD_MSG_TYPES = new Set([
  "threads_list",
  "thread_created",
  "thread_data",
  "thread_deleted",
  "thread_set",
  "thread_renamed",
  "message_added",
  "message_updated",
  "sync_messages",
]);

function isThreadMessage(type: string): boolean {
  return THREAD_MSG_TYPES.has(type);
}

// ---------- Helpers ----------

// Determine if a hex colour is light (needs dark text) or dark (needs white text)
function isLightColor(hex: string): boolean {
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  // W3C relative luminance threshold
  return (r * 299 + g * 587 + b * 114) / 1000 > 180;
}

// Format bytes to human readable
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// Derive code domain from current host (replace -srv. with -code.)
function getCodeApiUrl(): string {
  const host = location.host.replace("-srv.", "-code.");
  return `https://${host}`;
}


function providerToLegacySession(provider: string | null | undefined): string {
  if (!provider) return "opencode";
  if (provider === "claudeAgent") return "claude";
  if (provider === "zeroclaw") return "claw";
  if (provider === "grokAgent") return "grok";
  return provider;
}

function summaryToLegacyThread(summary: SidebarThreadSummary): Thread {
  const updatedAtIso = summary.latestUserMessageAt ?? summary.updatedAt ?? summary.createdAt;
  return {
    id: summary.id,
    title: summary.title,
    project: null,
    viewScope: summary.viewScope,
    lastSession: providerToLegacySession(
      summary.modelSelection?.provider ?? summary.session?.provider,
    ),
    lastModel: null,
    createdAt: Date.parse(summary.createdAt) || 0,
    updatedAt: Date.parse(updatedAtIso) || 0,
  };
}

// ---------- Main Component ----------

export function App() {
  const tChat = useTranslations("chat");
  // Same-origin agent auth
  const { fetchToken } = useAgentAuth(tChat);
  const [authError, setAuthError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [systemHealthState, setSystemHealthState] = useState<"green" | "yellow" | "red">("green");
  const [queueByThread, setQueueByThread] = useState<Record<string, { position: number; etaMs: number }>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [currentSession, setCurrentSession] = useState<SessionId>("opencode");

  const restoreSessionFromThread = useCallback((thread: { lastSession?: string | null }) => {
    if (thread.lastSession) {
      let s = thread.lastSession === "main" ? "opencode" : thread.lastSession;
      if (_DISABLED.has(s)) s = preferredSessionRef.current;
      setCurrentSession(s as SessionId);
    }
  }, []);

  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isReverting, _setIsReverting] = useState(false);

  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [showThreadPicker, setShowThreadPicker] = useState(false);
  const [desktopViewMode, setDesktopViewMode] = useState<"focus" | "studio">(() => {
    const s = window.__SHIELD_SETTINGS__;
    return s?.desktopViewMode === 'focus' ? 'focus' : 'studio';
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedAdapter, setSelectedAdapter] = useState<string>(THREAD_SESSIONS.find((s) => s.id === "opencode")?.id ?? THREAD_SESSIONS[0]?.id ?? "opencode");
  const [threadScopeMode, setThreadScopeMode] = useState<"scoped" | "all">("all");
  const threadScopeModeRef = useRef<"scoped" | "all">("all");
  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThreadId;

  // Actions dropdown state — executing action id drives per-action spinners
  const [executingActionId, setExecutingActionId] = useState<string | null>(null);
  const [pendingGateActionId, setPendingGateActionId] = useState<string | null>(null);
  const forwardedGateRequestIds = useRef(new Set<string>());
  // Hook result exposed via a ref so the message handler can call refetch()
  const integrationsRef = useRef<ReturnType<typeof useIntegrations> | null>(null);

  // Cross-project access managed via Settings > Security (removed from Actions menu)

  // Project state (set by parent via postMessage)
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const activeProjectRef = useRef<string | null>(null);
  activeProjectRef.current = activeProject;
  // Authoritative orchestration id resolved by the console (file-api ensures
  // a row exists for every app/package via /api/internal/ensure-projects, so
  // this is non-null in the happy path). Null only during the brief window
  // before the apps list hydrates or when the bridge is transiently down.
  const [activeProjectId, setActiveProjectId] = useState<ProjectId | null>(null);
  // Project IDs of every workspace package in the active monorepo app, fed by
  // the console alongside set_project. Drives the "All" sidebar scope so we
  // don't have to reverse-resolve project paths client-side.
  const [monorepoLeafProjectIds, setMonorepoLeafProjectIds] = useState<
    readonly ProjectId[]
  >([]);

  const projectParts = activeProject?.split("/").filter(Boolean) || [];
  const isMonorepoScope = projectParts.length > 2;
  const threadScopeLabel = isMonorepoScope ? projectParts.slice(2).join("/") : null;

  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const clearComposerDraftContent = useComposerDraftStore((s) => s.clearComposerContent);
  const setComposerDraftPrompt = useComposerDraftStore((s) => s.setPrompt);

  // Fetch resolved integration state + available actions for the chat dropdown.
  const integrationsHook = useIntegrations(activeProject);
  integrationsRef.current = integrationsHook;

  // Preferred session from parent (for auto-created threads)
  const preferredSessionRef = useRef<SessionId>("opencode");

  const wsRpcRef = useRef<WsRpcClient | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const disconnectedAtRef = useRef<number | null>(null);
  const [wsEpoch, setWsEpoch] = useState(0);
  const connectingRef = useRef(false); // Guard against concurrent connect() calls
  const connectIdRef = useRef(0); // Monotonic ID to ignore stale onclose events
  const intentionalCloseRef = useRef(false);

  const RECONNECT_GRACE_MS = 10_000;
  const RECONNECT_MAX_DELAY_MS = 30_000;

  const {
    providers: _rawProviderStatuses,
    refresh: refreshProviderStatuses,
  } = useProviderStatuses(wsRpcRef, wsEpoch);
  const liveProviderStatuses = useMemo(
    () => _DISABLED_PROVIDERS.size > 0
      ? _rawProviderStatuses.filter((p) => !_DISABLED_PROVIDERS.has(p.provider))
      : _rawProviderStatuses,
    [_rawProviderStatuses],
  );
  const [isRefreshingProvider, setIsRefreshingProvider] = useState(false);
  const [authModalProvider, setAuthModalProvider] = useState<ProviderKind | null>(null);
  const [verifyingAuthProvider, setVerifyingAuthProvider] = useState<ProviderKind | null>(null);
  const verifyTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const handleRefreshProvider = useCallback(
    async (provider: ProviderKind) => {
      setIsRefreshingProvider(true);
      try {
        await refreshProviderStatuses(provider);
      } finally {
        setIsRefreshingProvider(false);
      }
    },
    [refreshProviderStatuses],
  );
  const handleStartAuth = useCallback((provider: ProviderKind) => {
    setAuthModalProvider(provider);
  }, []);
  const verifyAbortRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  const beginPostAuthVerification = useCallback(
    (provider: ProviderKind) => {
      verifyAbortRef.current.cancelled = true;
      verifyTimersRef.current.forEach((t) => clearTimeout(t));
      verifyTimersRef.current = [];
      const abort = { cancelled: false };
      verifyAbortRef.current = abort;
      setVerifyingAuthProvider(provider);
      const delays = [800, 2200, 5000, 12000];
      void (async () => {
        for (const delay of delays) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, delay);
            verifyTimersRef.current.push(t);
          });
          if (abort.cancelled) return;
          const providers = await refreshProviderStatuses(provider);
          if (abort.cancelled) return;
          const live = providers?.find((entry) => entry.provider === provider);
          if (live?.status === "ready") {
            verifyTimersRef.current.forEach((tt) => clearTimeout(tt));
            verifyTimersRef.current = [];
            setVerifyingAuthProvider((cur) => (cur === provider ? null : cur));
            return;
          }
        }
        if (!abort.cancelled) {
          setVerifyingAuthProvider((cur) => (cur === provider ? null : cur));
        }
      })();
    },
    [refreshProviderStatuses],
  );
  useEffect(() => {
    return () => {
      verifyAbortRef.current.cancelled = true;
      verifyTimersRef.current.forEach((t) => clearTimeout(t));
      verifyTimersRef.current = [];
    };
  }, []);
  const handleCloseAuthModal = useCallback(() => {
    const provider = authModalProvider;
    setAuthModalProvider(null);
    if (provider) beginPostAuthVerification(provider);
  }, [authModalProvider, beginPostAuthVerification]);
  const handleAuthSuccess = useCallback(
    async (provider: ProviderKind) => {
      setAuthModalProvider(null);
      beginPostAuthVerification(provider);
    },
    [beginPostAuthVerification],
  );

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ planMarkdown: string }>).detail;
      if (!detail?.planMarkdown) return;
      sendToParent({
        type: "implement_plan",
        planMarkdown: detail.planMarkdown,
        sourceThreadId: activeThreadIdRef.current,
      } as unknown as Parameters<typeof sendToParent>[0]);
    };
    window.addEventListener("ellul:implement-plan", handler as EventListener);
    return () => window.removeEventListener("ellul:implement-plan", handler as EventListener);
  }, []);

  const currentSessionInfo = SESSIONS.find((s) => s.id === currentSession) || SESSIONS[0];

  // Connect to the orchestration WebSocket (F.3b.a)
  const connect = useCallback(async () => {
    if (wsRpcRef.current) return;
    if (connectingRef.current) return;
    connectingRef.current = true;

    const thisConnectId = ++connectIdRef.current;

    if (!disconnectedAtRef.current) {
      setConnectionStatus("connecting");
    }

    intentionalCloseRef.current = false;
    const result = await fetchToken();

    if (thisConnectId !== connectIdRef.current) {
      connectingRef.current = false;
      return;
    }

    if ("error" in result) {
      connectingRef.current = false;
      const isAuthError = result.code === "auth_required" || result.code === "auth_failed";
      if (isAuthError) {
        setConnectionStatus("error");
        setAuthError(result.error);
        sendToParent({ type: "auth_needed" });
        if (graceTimerRef.current) {
          clearTimeout(graceTimerRef.current);
          graceTimerRef.current = null;
        }
        return;
      }
      if (!disconnectedAtRef.current) {
        disconnectedAtRef.current = Date.now();
      }
      reconnectAttemptsRef.current++;
      const delay = Math.min(1000 * Math.pow(2, Math.min(reconnectAttemptsRef.current - 1, 4)), RECONNECT_MAX_DELAY_MS);
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, delay);
      return;
    }
    setAuthError(null);

    const wsUrl = getBridgeWsUrl(result.token);

    try {
      const client = createWsRpcClient({ url: wsUrl });
      wsRpcRef.current = client;
      setActiveEnvironmentClient(client);
      connectingRef.current = false;

      client.onBroadcast((event) => {
        if (event.event === "system_health_update") {
          const snap = event.snap as { state?: "green" | "yellow" | "red" } | undefined;
          if (snap?.state) setSystemHealthState(snap.state);
        } else if (event.event === "bridge_shutting_down") {
          setConnectionStatus("connecting");
        } else if (event.event === "gate_request") {
          const e = event as Record<string, unknown>;
          const rid = typeof e.requestId === "string" ? e.requestId : null;
          if (rid) forwardedGateRequestIds.current.add(rid);
          try {
            window.parent.postMessage({
              type: "gate_request",
              requestId: rid,
              gate: e.gate ?? "",
              reason: e.reason ?? "",
              threadId: e.threadId ?? "",
              sandboxId: e.sandboxId ?? null,
            }, "*");
          } catch {}
        } else if (event.event === "inference_queue_update") {
          const queues = event.queues as Array<{ queued: Array<{ turnId: string; position: number; etaMs: number }> }> | undefined;
          if (Array.isArray(queues)) {
            const byTurn: Record<string, { position: number; etaMs: number }> = {};
            for (const q of queues) for (const item of q.queued) byTurn[item.turnId] = { position: item.position, etaMs: item.etaMs };
            setQueueByThread(byTurn);
          }
        }
      });
      client.onStateChange((state) => {
        if (state === "open") {
          if (graceTimerRef.current) {
            clearTimeout(graceTimerRef.current);
            graceTimerRef.current = null;
          }
          setConnectionStatus("connected");
          reconnectAttemptsRef.current = 0;
          disconnectedAtRef.current = null;
          setWsEpoch((e) => e + 1);
          useStore.getState().setActiveEnvironmentId(ELLUL_ENV_ID);

          void (async () => {
            const startedForClient = client;
            let attempts = 0;
            while (wsRpcRef.current === startedForClient) {
              try {
                for await (const item of client.subscribeShell()) {
                  attempts = 0;
                  if (item.kind === "snapshot") {
                    useStore.getState().syncServerShellSnapshot(item.snapshot, ELLUL_ENV_ID);
                  } else {
                    useStore.getState().applyShellEvent(item, ELLUL_ENV_ID);
                  }
                }
              } catch (err) {
                console.error("[ws-rpc] subscribeShell failed:", err);
              }
              if (wsRpcRef.current !== startedForClient) break;
              attempts++;
              const backoffMs = Math.min(500 * 2 ** Math.min(attempts - 1, 4), 8000);
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }
          })();
        } else if (state === "closed") {
          if (wsRpcRef.current === client) {
            wsRpcRef.current = null;
            setActiveEnvironmentClient(null);
          }
          if (thisConnectId !== connectIdRef.current) return;
          if (intentionalCloseRef.current) return;

          if (!disconnectedAtRef.current) {
            disconnectedAtRef.current = Date.now();
          }

          if (!graceTimerRef.current) {
            graceTimerRef.current = setTimeout(() => {
              graceTimerRef.current = null;
              setConnectionStatus("disconnected");
            }, RECONNECT_GRACE_MS);
          }
          reconnectAttemptsRef.current++;
          const delay = Math.min(1000 * Math.pow(2, Math.min(reconnectAttemptsRef.current - 1, 4)), RECONNECT_MAX_DELAY_MS);
          reconnectTimeoutRef.current = setTimeout(() => {
            connect();
          }, delay);
        }
      });
    } catch {
      connectingRef.current = false;
      reconnectAttemptsRef.current++;
      const delay = Math.min(1000 * Math.pow(2, Math.min(reconnectAttemptsRef.current - 1, 4)), RECONNECT_MAX_DELAY_MS);
      reconnectTimeoutRef.current = setTimeout(() => {
        connect();
      }, delay);
    }
  }, [fetchToken]);

  // Initialize connection on mount
  useEffect(() => {
    connect();

    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
      }
      wsRpcRef.current?.close();
      wsRpcRef.current = null;
      setActiveEnvironmentClient(null);
    };
  }, [connect]);

  useEffect(() => {
    if (!activeThreadId) return;
    if (connectionStatus !== "connected") return;
    const client = wsRpcRef.current;
    if (!client) return;
    const threadId = activeThreadId as ThreadIdBrand;

    let cancelled = false;
    let activeIterator: ReturnType<ReturnType<typeof client.subscribeThread>[typeof Symbol.asyncIterator]> | null = null;
    void (async () => {
      let attempts = 0;
      while (!cancelled) {
        if (wsRpcRef.current !== client) break;
        const iterator = client.subscribeThread({ threadId })[Symbol.asyncIterator]();
        activeIterator = iterator;
        try {
          while (!cancelled) {
            const { value, done } = await iterator.next();
            if (done || cancelled) break;
            attempts = 0;
            if (value.kind === "snapshot") {
              useStore.getState().syncServerThreadDetail(value.snapshot.thread, ELLUL_ENV_ID);
            } else {
              useStore.getState().applyOrchestrationEvent(value.event, ELLUL_ENV_ID);
            }
          }
        } catch (err) {
          if (!cancelled) {
            console.error("[ws-rpc] subscribeThread failed:", err);
          }
        }
        activeIterator = null;
        if (cancelled || wsRpcRef.current !== client) break;
        attempts++;
        const backoffMs = Math.min(500 * 2 ** Math.min(attempts - 1, 4), 8000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    })();

    return () => {
      cancelled = true;
      void activeIterator?.return?.(undefined);
    };
  }, [activeThreadId, connectionStatus, wsEpoch]);

  const dispatchCommand = useCallback((input: ClientOrchestrationCommand) => {
    const client = wsRpcRef.current;
    if (!client) return;
    void client.dispatchCommand(input).catch((err) => {
      console.error("[ws-rpc] dispatchCommand failed:", err);
    });
  }, []);

  const newCommandId = useCallback((): CommandId => randomUUID() as CommandId, []);
  const newThreadIdValue = useCallback((): ThreadIdBrand => randomUUID() as ThreadIdBrand, []);
  const newMessageIdValue = useCallback((): MessageId => randomUUID() as MessageId, []);

  const activeProjectScopedRef = useMemo<ScopedProjectRef | null>(
    () => (activeProjectId ? scopeProjectRef(ELLUL_ENV_ID, activeProjectId) : null),
    [activeProjectId],
  );

  // Pre-built ScopedProjectRef set for the "All" sidebar scope: the active
  // project plus every monorepo-leaf project that lives under it. Empty when
  // no leaves are advertised by the console (single-project app).
  const allScopeProjectRefs = useMemo<readonly ScopedProjectRef[]>(() => {
    if (monorepoLeafProjectIds.length === 0 && !activeProjectId) return [];
    const refs: ScopedProjectRef[] = [];
    if (activeProjectId) refs.push(scopeProjectRef(ELLUL_ENV_ID, activeProjectId));
    for (const leafId of monorepoLeafProjectIds) {
      if (leafId === activeProjectId) continue;
      refs.push(scopeProjectRef(ELLUL_ENV_ID, leafId));
    }
    return refs;
  }, [activeProjectId, monorepoLeafProjectIds]);

  const sidebarThreadSummaries = useStore(
    useShallow((state) =>
      threadScopeMode === "all" && allScopeProjectRefs.length > 0
        ? selectSidebarThreadsForProjectRefs(state, allScopeProjectRefs)
        : selectSidebarThreadsForProjectRef(state, activeProjectScopedRef),
    ),
  );

  const threads: Thread[] = useMemo(() => {
    const filtered =
      threadScopeMode === "scoped" && threadScopeLabel
        ? sidebarThreadSummaries.filter((t) => t.viewScope === threadScopeLabel)
        : sidebarThreadSummaries;
    return filtered.map(summaryToLegacyThread);
  }, [sidebarThreadSummaries, threadScopeMode, threadScopeLabel]);

  const handleThreadScopeModeChange = useCallback((mode: "scoped" | "all") => {
    setThreadScopeMode(mode);
    threadScopeModeRef.current = mode;
  }, []);

  // Listen for postMessage from parent dashboard
  useEffect(() => {
    const cleanup = listenForMessages((msg) => {
      switch (msg.type) {
        case "set_project": {
          setActiveProject(msg.project);
          setActiveProjectId(
            typeof msg.projectId === "string" && msg.projectId.length > 0
              ? (msg.projectId as ProjectId)
              : null,
          );
          // monorepoLeafProjectIds is the console's pre-resolved set of every
          // workspace package's projectId. Drives the "All" sidebar scope.
          const leafIds = (msg as { monorepoLeafProjectIds?: unknown }).monorepoLeafProjectIds;
          setMonorepoLeafProjectIds(
            Array.isArray(leafIds)
              ? leafIds.filter((v): v is string => typeof v === "string" && v.length > 0).map((v) => v as ProjectId)
              : [],
          );
          break;
        }
        case "set_session":
          if (msg.session) {
            preferredSessionRef.current = msg.session as SessionId;
            setSelectedAdapter(msg.session as string);
            if (!activeThreadIdRef.current) {
              setCurrentSession(msg.session as SessionId);
            }
          }
          break;
        case "set_theme":
          applyTheme(msg.mode);
          break;
        case "auth_complete":
          setAuthError(null);
          if (wsRpcRef.current) {
            intentionalCloseRef.current = true;
            wsRpcRef.current.close();
            wsRpcRef.current = null;
            setActiveEnvironmentClient(null);
            connectingRef.current = false;
          }
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = null;
          }
          reconnectAttemptsRef.current = 0;
          connect();
          break;
        case "set_view_mode":
          setDesktopViewMode(msg.mode);
          break;
        case "action_result":
          // Parent completed an action — clear busy state if it matches the
          setExecutingActionId((prev) => (prev === msg.action ? null : prev));
          setPendingGateActionId((prev) => (prev === msg.action ? null : prev));
          integrationsRef.current?.refetch();
          clearTimeout(actionTimeoutRef.current);
          break;
        case "code_context": {
          const file = msg.file as string || "";
          const snippet = msg.snippet as string || "";
          const line = msg.line as number | undefined;
          const endLine = msg.endLine as number | undefined;
          const lineRef = line && endLine && endLine > line
            ? `:${line}-${endLine}`
            : line ? `:${line}` : "";
          const prompt = snippet
            ? `\`${file}${lineRef}\`\n\`\`\`\n${snippet}\n\`\`\`\n`
            : `\`${file}${lineRef}\`\n`;
          composerRef.current?.resetCursorState({ prompt, cursor: prompt.length });
          composerRef.current?.focusAtEnd();
          break;
        }
        case "preview_fix_request": {
          const scope = msg.scope as string || "";
          const error = msg.error as string || "";
          const logTail = msg.logTail as string || "";
          const kind = msg.kind as string || "install_failed";
          const trimmedLog = logTail.length > 3500 ? `…\n${logTail.slice(-3500)}` : logTail;
          const preamble = kind === "install_failed"
            ? `The dependency install for \`${scope}\` failed and the preview can't start. Please diagnose the error below, fix the offending \`package.json\` (or lockfile) in the project, and confirm with a clean install.`
            : `The preview dev server for \`${scope}\` crashed. Please diagnose the error below and fix the underlying issue.`;
          const prompt = [
            preamble,
            "",
            `**Error:** ${error}`,
            trimmedLog ? "\n**Log tail:**\n```\n" + trimmedLog + "\n```" : "",
          ].filter(Boolean).join("\n");
          composerRef.current?.resetCursorState({ prompt, cursor: prompt.length });
          composerRef.current?.focusAtEnd();
          break;
        }
        case "gate_continue": {
          const tid = activeThreadIdRef.current;
          const resolvedRequestId = typeof msg.requestId === "string" ? msg.requestId : null;
          if (resolvedRequestId) forwardedGateRequestIds.current.add(resolvedRequestId);
          if (!tid) break;
          const gate = (msg.gate as string) || "unknown";
          const mid = randomUUID() as MessageId;
          const cid = randomUUID() as CommandId;
          const text = `Approved. ${gate} gate is now open — continue.`;
          setOptimisticUserMessages((prev) => [
            ...prev,
            { id: mid, role: "user", text, createdAt: new Date().toISOString(), streaming: false },
          ]);
          const dispatchGateContinue = (attempt: number) => {
            const rpc = wsRpcRef.current;
            if (!rpc || rpc.state() !== "open") {
              if (attempt < 20) setTimeout(() => dispatchGateContinue(attempt + 1), 500);
              return;
            }
            rpc.dispatchCommand({
              type: "thread.turn.start",
              commandId: cid,
              threadId: tid as ThreadIdBrand,
              message: { messageId: mid, role: "user", text, attachments: [] },
              modelSelection: activeThreadFromStore?.modelSelection ?? undefined,
              runtimeMode: activeThreadFromStore?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
              interactionMode: activeThreadFromStore?.interactionMode ?? DEFAULT_INTERACTION_MODE,
              createdAt: new Date().toISOString(),
            }).catch(() => {
              if (attempt < 20) setTimeout(() => dispatchGateContinue(attempt + 1), 1000);
            });
          };
          dispatchGateContinue(0);
          break;
        }
        case "select_thread": {
          const tid = (msg as { threadId?: string }).threadId;
          if (tid && tid !== activeThreadIdRef.current) {
            handleSelectThread(tid);
          }
          break;
        }
      }
    });
    sendToParent({ type: "ready" });
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const actionTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Single dispatcher — fired by ActionsDropdown after any per-action
  const handleAction = useCallback(
    (action: ResolvedAction) => {
      if (!activeProject || executingActionId) return;
      setExecutingActionId(action.id);
      sendToParent({
        type: "action",
        action: action.id,
        project: activeProject,
        gateType: action.gateType,
      });
      clearTimeout(actionTimeoutRef.current);
      // sooner than this, but we never want the spinner to hang forever.
      actionTimeoutRef.current = setTimeout(() => {
        setExecutingActionId((prev) => (prev === action.id ? null : prev));
      }, 15000);
    },
    [activeProject, executingActionId],
  );

  // Auth error — tell parent
  useEffect(() => {
    if (authError) {
      sendToParent({ type: "auth_needed" });
    }
  }, [authError]);

  const handleFileUpload = useCallback(
    async (file: File) => {
      const project = activeProject || "";
      setIsUploading(true);
      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("project", project);
        await fetch(`${getCodeApiUrl()}/api/fs/upload`, {
          method: "POST",
          body: formData,
          credentials: "include",
        });
      } catch (err) {
        console.error("Upload failed:", err);
      } finally {
        setIsUploading(false);
      }
    },
    [activeProject],
  );

  // Drag and drop handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set dragging to false if we're leaving the container
    if (e.currentTarget === e.target) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const files = Array.from(e.dataTransfer.files);
      const firstFile = files[0];
      if (firstFile) {
        handleFileUpload(firstFile);
      }
    },
    [handleFileUpload]
  );


  // --- Thread management helpers ---
  const activeThread = threads.find((t) => t.id === activeThreadId) || null;

  const handleSelectThread = useCallback((threadId: string) => {
    if (threadId === activeThreadIdRef.current) return;
    const thread = threads.find((t) => t.id === threadId);
    if (thread) restoreSessionFromThread(thread);
    setActiveThreadId(threadId);
    activeThreadIdRef.current = threadId;
    setShowThreadPicker(false);
  }, [threads, restoreSessionFromThread]);

  const handleRevertTurn = useCallback((userMessageId: string, turnCount?: number) => {
    const threadId = activeThreadIdRef.current;
    if (!threadId || !turnCount || turnCount < 1) return;
    _setIsReverting(true);
    dispatchCommand({
      type: "thread.checkpoint.revert",
      commandId: newCommandId(),
      threadId: threadId as ThreadIdBrand,
      turnCount,
      createdAt: new Date().toISOString(),
    });
  }, [dispatchCommand, newCommandId]);

  const handleCreateThread = useCallback(async (session: string) => {
    setCurrentSession(session as SessionId);
    setShowThreadPicker(false);

    if (!activeProject) return;
    const provider = providerForSession(session);
    if (!provider) return;
    const client = wsRpcRef.current;
    if (!client) return;

    // Auto-bootstrap project: createWorkspaceRootIfMissing for unscaffolded cwd; await both so thread.create's requireProject sees the row.
    let projectId = activeProjectId;
    if (!projectId) {
      projectId = randomUUID() as ProjectId;
      const titleFromCwd = activeProject.split("/").filter(Boolean).pop() || activeProject;
      try {
        await client.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title: titleFromCwd,
          workspaceRoot: activeProject,
          createWorkspaceRootIfMissing: true,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error("[chat] project.create failed:", err);
        return;
      }
    }

    const newId = newThreadIdValue();
    const pinnedModel = pinnedModelByProviderRef.current[provider];
    const seedModel = pinnedModel ?? getDefaultServerModel(liveProviderStatuses, provider);
    try {
      await client.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: newId,
        projectId,
        title: tChat("threads.newThread"),
        modelSelection: createModelSelection(provider, seedModel),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        viewScope: isMonorepoScope && threadScopeLabel ? threadScopeLabel : null,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[chat] thread.create failed:", err);
      return;
    }
    setActiveThreadId(newId);
    activeThreadIdRef.current = newId;
  }, [
    activeProject,
    activeProjectId,
    liveProviderStatuses,
    newCommandId,
    newThreadIdValue,
  ]);

  // Auto-create a first thread on empty project once bootstrap is complete. Ref-gated to fire once per projectId.
  const autoCreatedForProjectRef = useRef<ProjectId | null>(null);
  const creatingThreadRef = useRef(false);
  const bootstrapComplete = useStore(
    (state) => selectBootstrapCompleteForActiveEnvironment(state),
  );
  useEffect(() => {
    if (!bootstrapComplete) return;
    if (!activeProjectId) return;
    if (threads.length > 0) return;
    if (liveProviderStatuses.length === 0) return;
    if (autoCreatedForProjectRef.current === activeProjectId) return;
    if (creatingThreadRef.current) return;
    autoCreatedForProjectRef.current = activeProjectId;
    creatingThreadRef.current = true;
    void handleCreateThread(preferredSessionRef.current).finally(() => {
      creatingThreadRef.current = false;
    });
  }, [bootstrapComplete, activeProjectId, threads.length, liveProviderStatuses.length, handleCreateThread]);

  useEffect(() => {
    if (!bootstrapComplete) return;
    if (activeThreadId) return;
    if (threads.length === 0) return;
    handleSelectThread(threads[0]!.id);
  }, [bootstrapComplete, activeThreadId, threads, handleSelectThread]);

  useEffect(() => {
    sendToParent({ type: "thread_active", threadId: activeThreadId });
  }, [activeThreadId]);

  const handleDeleteThread = useCallback((threadId: string) => {
    dispatchCommand({
      type: "thread.delete",
      commandId: newCommandId(),
      threadId: threadId as ThreadIdBrand,
    });
    if (activeThreadId === threadId) {
      const remaining = threads.filter((t) => t.id !== threadId);
      if (remaining.length > 0) {
        handleSelectThread(remaining[0]!.id);
      } else {
        setActiveThreadId(null);
        activeThreadIdRef.current = null;
      }
    }
  }, [activeThreadId, dispatchCommand, handleSelectThread, newCommandId, threads]);

  const handleRenameThread = useCallback((threadId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId: threadId as ThreadIdBrand,
      title: trimmed,
    });
  }, [dispatchCommand, newCommandId]);

  const handleApprovalRespond = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      setRespondingRequestIds((prev) =>
        prev.includes(requestId) ? prev : [...prev, requestId],
      );
      try {
        await wsRpcRef.current?.dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: threadId as ThreadIdBrand,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error("[ws-rpc] approval respond failed:", err);
      } finally {
        setRespondingRequestIds((prev) => prev.filter((id) => id !== requestId));
      }
    },
    [newCommandId],
  );

  const handleUserInputRespond = useCallback(
    async (requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      try {
        await wsRpcRef.current?.dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: threadId as ThreadIdBrand,
          requestId,
          answers,
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error("[ws-rpc] user-input respond failed:", err);
      }
    },
    [newCommandId],
  );

  const handleInterrupt = useCallback(() => {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: threadId as ThreadIdBrand,
      createdAt: new Date().toISOString(),
    });
  }, [dispatchCommand, newCommandId]);

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      dispatchCommand({
        type: "thread.runtime-mode.set",
        commandId: newCommandId(),
        threadId: threadId as ThreadIdBrand,
        runtimeMode: mode,
        createdAt: new Date().toISOString(),
      });
    },
    [dispatchCommand, newCommandId],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      dispatchCommand({
        type: "thread.interaction-mode.set",
        commandId: newCommandId(),
        threadId: threadId as ThreadIdBrand,
        interactionMode: mode,
        createdAt: new Date().toISOString(),
      });
    },
    [dispatchCommand, newCommandId],
  );

  const handleProviderModelSelect = useCallback(
    (provider: ProviderKind, model: string) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: threadId as ThreadIdBrand,
        modelSelection: createModelSelection(provider, model),
      });
    },
    [dispatchCommand, newCommandId],
  );

  const handlePinModel = useCallback(
    async (provider: ProviderKind, model: string | null) => {
      const client = wsRpcRef.current;
      if (!client) return;
      const previous =
        useStore.getState().environmentStateById[ELLUL_ENV_ID]?.sandbox
          .pinnedModelByProvider[provider] ?? null;
      useStore.getState().applyOptimisticSandboxPin(ELLUL_ENV_ID, provider, model);
      try {
        if (model === null) {
          await client.dispatchCommand({
            type: "sandbox.model.unpin",
            commandId: newCommandId(),
            provider,
            createdAt: new Date().toISOString(),
          });
        } else {
          await client.dispatchCommand({
            type: "sandbox.model.pin",
            commandId: newCommandId(),
            provider,
            model,
            createdAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        useStore.getState().applyOptimisticSandboxPin(ELLUL_ENV_ID, provider, previous);
        console.error("[ws-rpc] sandbox pin dispatch failed:", error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: model === null ? tChat("modelPin.unpinFailed") : tChat("modelPin.pinFailed"),
            description: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    },
    [newCommandId],
  );

  // Thread state is managed internally — no sync to parent needed

  // Sheet: escape key + body scroll lock (matches console Sheet)
  useEffect(() => {
    if (!showThreadPicker) return;
    document.body.style.overflow = "hidden";
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowThreadPicker(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handleEscape);
    };
  }, [showThreadPicker]);

  // ---------- ChatComposer + MessagesTimeline derivations ----------
  const activeThreadRef = useMemo<ScopedThreadRef | null>(
    () => (activeThreadId ? scopeThreadRef(ELLUL_ENV_ID, activeThreadId as ThreadIdBrand) : null),
    [activeThreadId],
  );
  const activeThreadFromStore = useStore((state) => selectThreadByRef(state, activeThreadRef));
  const activeProjectFromStore = useStore((state) =>
    activeProjectScopedRef
      ? state.environmentStateById[activeProjectScopedRef.environmentId]?.projectById[
          activeProjectScopedRef.projectId
        ] ?? null
      : null,
  );
  const pinnedModelByProvider = useStore(
    (state) =>
      state.environmentStateById[ELLUL_ENV_ID]?.sandbox.pinnedModelByProvider ??
      EMPTY_PINNED_MODEL_BY_PROVIDER,
  );
  const pinnedModelByProviderRef = useRef(pinnedModelByProvider);
  pinnedModelByProviderRef.current = pinnedModelByProvider;

  const threadActivities = activeThreadFromStore?.activities ?? [];
  const activeLatestTurn = activeThreadFromStore?.latestTurn ?? null;
  const phaseOfActiveThread = derivePhase(activeThreadFromStore?.session ?? null);
  const latestTurnSettled = isLatestTurnSettled(
    activeLatestTurn,
    activeThreadFromStore?.session ?? null,
  );
  const pendingApprovalsList = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputsList = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  const activePendingApproval = pendingApprovalsList[0] ?? null;
  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [threadActivities, activeLatestTurn?.turnId],
  );
  const messagesForTimeline = useMemo(() => {
    const serverMessages = activeThreadFromStore?.messages ?? [];
    if (optimisticUserMessages.length === 0) return serverMessages;
    const knownIds = new Set(serverMessages.map((m) => m.id));
    const pending = optimisticUserMessages.filter((m) => !knownIds.has(m.id));
    return pending.length === 0 ? serverMessages : [...serverMessages, ...pending];
  }, [activeThreadFromStore?.messages, optimisticUserMessages]);
  useEffect(() => {
    const serverMessages = activeThreadFromStore?.messages;
    if (!serverMessages || optimisticUserMessages.length === 0) return;
    const knownIds = new Set(serverMessages.map((m) => m.id));
    const next = optimisticUserMessages.filter((m) => !knownIds.has(m.id));
    if (next.length !== optimisticUserMessages.length) setOptimisticUserMessages(next);
  }, [activeThreadFromStore?.messages, optimisticUserMessages]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        messagesForTimeline,
        activeThreadFromStore?.proposedPlans ?? [],
        workLogEntries,
      ),
    [messagesForTimeline, activeThreadFromStore?.proposedPlans, workLogEntries],
  );
  const completionDividerBeforeEntryId = useMemo(
    () => deriveCompletionDividerBeforeEntryId(timelineEntries, activeLatestTurn),
    [timelineEntries, activeLatestTurn],
  );
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const map = new Map<MessageId, StoreThread["turnDiffSummaries"][number]>();
    const summaries = activeThreadFromStore?.turnDiffSummaries;
    if (!summaries) return map;
    for (const summary of summaries) {
      if (summary.assistantMessageId) {
        map.set(summary.assistantMessageId, summary);
      }
    }
    return map;
  }, [activeThreadFromStore?.turnDiffSummaries]);
  const checkpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(activeThreadFromStore?.turnDiffSummaries ?? []),
    [activeThreadFromStore?.turnDiffSummaries],
  );
  const revertTurnCountByUserMessageId = useMemo(() => {
    const map = new Map<MessageId, number>();
    const messages = activeThreadFromStore?.messages ?? [];
    let userIdx = 0;
    for (const message of messages) {
      if (message.role !== "user") continue;
      userIdx += 1;
      const remaining = messages.slice(userIdx).reverse();
      for (const m of remaining) {
        if (m.role === "assistant" && m.turnId) {
          const count = checkpointTurnCountByTurnId[m.turnId];
          if (count !== undefined) {
            map.set(message.id, count);
            break;
          }
        }
      }
    }
    return map;
  }, [activeThreadFromStore?.messages, checkpointTurnCountByTurnId]);

  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [pendingUserInputDraftAnswers, setPendingUserInputDraftAnswers] = useState<
    Record<string, PendingUserInputDraftAnswer>
  >({});
  const [pendingUserInputQuestionIndex, setPendingUserInputQuestionIndex] = useState(0);

  const activePendingUserInput = pendingUserInputsList[0] ?? null;
  const activePendingQuestions = activePendingUserInput?.questions ?? [];

  useEffect(() => {
    setPendingUserInputDraftAnswers({});
    setPendingUserInputQuestionIndex(0);
  }, [activePendingUserInput?.requestId]);

  const activePendingProgressDerived = useMemo(
    () =>
      activePendingQuestions.length > 0
        ? derivePendingUserInputProgress(
            activePendingQuestions,
            pendingUserInputDraftAnswers,
            pendingUserInputQuestionIndex,
          )
        : null,
    [activePendingQuestions, pendingUserInputDraftAnswers, pendingUserInputQuestionIndex],
  );

  const activePendingResolvedAnswersDerived = useMemo(
    () =>
      activePendingQuestions.length > 0
        ? buildPendingUserInputAnswers(activePendingQuestions, pendingUserInputDraftAnswers)
        : null,
    [activePendingQuestions, pendingUserInputDraftAnswers],
  );

  const handleSelectActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      const question = activePendingQuestions.find((q) => q.id === questionId);
      if (!question) return;
      setPendingUserInputDraftAnswers((prev) => ({
        ...prev,
        [questionId]: togglePendingUserInputOptionSelection(question, prev[questionId], optionLabel),
      }));
      promptRef.current = "";
      composerRef.current?.resetCursorState({ cursor: 0, prompt: "", detectTrigger: false });
    },
    [activePendingQuestions],
  );

  const handleAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgressDerived) return;
    const { isLastQuestion, canAdvance } = activePendingProgressDerived;
    if (!canAdvance) return;
    if (!isLastQuestion) {
      setPendingUserInputQuestionIndex((prev) => prev + 1);
      return;
    }
    const resolvedAnswers = buildPendingUserInputAnswers(
      activePendingQuestions,
      pendingUserInputDraftAnswers,
    );
    if (!resolvedAnswers) return;
    setRespondingRequestIds((prev) =>
      prev.includes(activePendingUserInput.requestId)
        ? prev
        : [...prev, activePendingUserInput.requestId],
    );
    handleUserInputRespond(activePendingUserInput.requestId, resolvedAnswers).finally(() => {
      setRespondingRequestIds((prev) =>
        prev.filter((id) => id !== activePendingUserInput.requestId),
      );
    });
  }, [
    activePendingUserInput,
    activePendingProgressDerived,
    activePendingQuestions,
    pendingUserInputDraftAnswers,
    handleUserInputRespond,
  ]);

  const handlePreviousActivePendingUserInputQuestion = useCallback(() => {
    setPendingUserInputQuestionIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const handleChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      _expandedCursor: number,
      _cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) return;
      promptRef.current = value;
      setPendingUserInputDraftAnswers((prev) => ({
        ...prev,
        [questionId]: setPendingUserInputCustomAnswer(prev[questionId], value),
      }));
      const snapshot = composerRef.current?.readSnapshot?.();
      if (snapshot && (snapshot.value !== value || snapshot.cursor !== nextCursor)) {
        composerRef.current?.focusAt?.(nextCursor);
      }
    },
    [activePendingUserInput],
  );

  const [, setLocalDispatchStartedAt] = useState<string | null>(null);
  const isWorking = phaseOfActiveThread === "running" || isReverting;
  const activeWorkStartedAt = deriveActiveWorkStartedAt(
    activeLatestTurn,
    activeThreadFromStore?.session ?? null,
    null,
  );

  const composerRef = useRef<ChatComposerHandle | null>(null);
  const promptRef = useRef("");
  const composerImagesRef = useRef<unknown[]>([]);
  const composerTerminalContextsRef = useRef<unknown[]>([]);
  const isAtEndRef = useRef(true);
  const [isAtEnd, setIsAtEnd] = useState(true);
  const legendListRef = useRef<LegendListRef | null>(null);
  const [failedMessageIds, setFailedMessageIds] = useState<Set<string>>(() => new Set());
  const failedMessagePayloads = useRef<Map<string, { prompt: string; modelSelection: unknown }>>(new Map());
  const noopFn = useCallback(() => {}, []);
  const setActiveThreadError = useCallback(
    (threadId: ThreadIdBrand | null, error: string | null) => {
      if (!threadId) return;
      useStore.getState().setError(threadId, error);
    },
    [],
  );

  const onSendComposer = useCallback(
    async (e?: { preventDefault: () => void }) => {
      e?.preventDefault();
      if (activePendingUserInput) {
        handleAdvanceActivePendingUserInput();
        return;
      }
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      const client = wsRpcRef.current;
      if (!client) {
        setActiveThreadError(threadId as ThreadIdBrand, tChat("errors.notConnected"));
        return;
      }
      const sendCtx = composerRef.current?.getSendContext();
      if (!sendCtx) return;
      const trimmed = sendCtx.prompt.trim();
      if (!trimmed) return;

      const promptForRetry = sendCtx.prompt;
      const messageId = newMessageIdValue();
      const createdAt = new Date().toISOString();

      const optimisticMessage: ChatMessage = {
        id: messageId,
        role: "user",
        text: trimmed,
        createdAt,
        streaming: false,
      };
      setOptimisticUserMessages((prev) => [...prev, optimisticMessage]);
      promptRef.current = "";
      if (activeThreadRef) clearComposerDraftContent(activeThreadRef);
      composerRef.current?.resetCursorState({ cursor: 0, prompt: "", detectTrigger: false });
      if (isTouchDevice()) {
        navigator.vibrate?.(10);
        requestAnimationFrame(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        });
      } else {
        requestAnimationFrame(() => composerRef.current?.focusAtEnd());
      }
      setActiveThreadError(threadId as ThreadIdBrand, null);

      setLocalDispatchStartedAt(createdAt);
      try {
        await client.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadId as ThreadIdBrand,
          message: {
            messageId,
            role: "user",
            text: trimmed,
            attachments: [],
          },
          modelSelection: sendCtx.selectedModelSelection,
          runtimeMode: activeThreadFromStore?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: activeThreadFromStore?.interactionMode ?? DEFAULT_INTERACTION_MODE,
          createdAt,
        });
      } catch (err) {
        failedMessagePayloads.current.set(messageId, {
          prompt: trimmed,
          modelSelection: sendCtx.selectedModelSelection,
        });
        setFailedMessageIds((prev) => new Set(prev).add(messageId));
        setActiveThreadError(
          threadId as ThreadIdBrand,
          err instanceof Error ? err.message : tChat("errors.sendFailed"),
        );
      } finally {
        setLocalDispatchStartedAt(null);
      }
    },
    [
      activePendingUserInput,
      handleAdvanceActivePendingUserInput,
      activeThreadFromStore?.interactionMode,
      activeThreadFromStore?.runtimeMode,
      activeThreadRef,
      clearComposerDraftContent,
      newCommandId,
      newMessageIdValue,
      setActiveThreadError,
      setComposerDraftPrompt,
    ],
  );

  const toggleInteractionMode = useCallback(() => {
    const current = activeThreadFromStore?.interactionMode ?? DEFAULT_INTERACTION_MODE;
    handleInteractionModeChange(current === "plan" ? "default" : "plan");
  }, [activeThreadFromStore?.interactionMode, handleInteractionModeChange]);

  const focusComposer = useCallback(() => {
    composerRef.current?.focusAtEnd();
  }, []);

  const scrollToBottom = useCallback(() => {
    legendListRef.current?.scrollToEnd?.({ animated: true });
  }, []);

  const onRetryMessage = useCallback(
    (messageId: string) => {
      const payload = failedMessagePayloads.current.get(messageId);
      if (!payload) return;
      setFailedMessageIds((prev) => {
        const next = new Set(prev);
        next.delete(messageId);
        return next;
      });
      failedMessagePayloads.current.delete(messageId);
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      const client = wsRpcRef.current;
      if (!client) return;
      const createdAt = new Date().toISOString();
      setLocalDispatchStartedAt(createdAt);
      client
        .dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: threadId as ThreadIdBrand,
          message: {
            messageId: messageId as unknown as MessageId,
            role: "user",
            text: payload.prompt,
            attachments: [],
          },
          modelSelection: payload.modelSelection,
          runtimeMode: activeThreadFromStore?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          interactionMode: activeThreadFromStore?.interactionMode ?? DEFAULT_INTERACTION_MODE,
          createdAt,
        } as ClientOrchestrationCommand)
        .catch(() => {
          setFailedMessageIds((prev) => new Set(prev).add(messageId));
          failedMessagePayloads.current.set(messageId, payload);
        })
        .finally(() => setLocalDispatchStartedAt(null));
    },
    [activeThreadFromStore?.interactionMode, activeThreadFromStore?.runtimeMode, newCommandId],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AnchoredToastProvider>
    <div
      className="h-full flex flex-col min-h-0 relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drop Zone Overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-card/90 flex items-center justify-center border-2 border-dashed border-sodium/50 rounded-lg m-2">
          <div className="text-center">
            <FileUp className="h-12 w-12 text-sodium mx-auto mb-3" />
            <p className="text-sodium font-medium">{tChat("fileDrop.title")}</p>
            <p className="text-cream/60 text-sm mt-1">{tChat("fileDrop.hint")}</p>
          </div>
        </div>
      )}

      {/* Upload Progress Overlay */}
      {isUploading && (
        <div className="absolute inset-0 z-50 bg-card/80 flex items-center justify-center">
          <div className="text-center">
            <Loader2 className="h-8 w-8 text-sodium mx-auto mb-2 animate-spin" />
            <p className="text-cream/75 text-sm">{tChat("uploading")}</p>
          </div>
        </div>
      )}
      {/* Header removed — thread selector and actions are now floating pills inside the content area */}

      {/* Thread picker sheet — used for mobile (always) and desktop studio mode */}
      {showThreadPicker && createPortal(
        <div className="fixed inset-0 z-[200] flex items-end md:items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in-0 duration-200"
            onClick={() => setShowThreadPicker(false)}
          />
          <div
            className={cn(
              "relative w-full bg-card border border-border",
              "h-[70vh] max-h-[90vh] overflow-hidden flex flex-col",
              "rounded-t-xl border-b-0",
              "md:max-w-lg md:rounded-xl md:border-b md:mx-4 md:h-[60vh]",
              "animate-in slide-in-from-bottom-4 md:slide-in-from-bottom-0 md:zoom-in-95 duration-200"
            )}
            style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
          >
            {/* Sheet header */}
            <div className="flex flex-col gap-3 px-4 py-3 border-b border-cream/10 shrink-0">
              <div className="flex items-center gap-2 w-full">
                <h2 className="text-base font-semibold text-cream">{tChat("threads.heading")}</h2>
                <span className="text-xs text-cream/45">{threads.length}</span>
              </div>
              {/* Adapter picker + new thread */}
              <div className="flex items-center gap-2 w-full">
                <AdapterPicker value={selectedAdapter} onChange={setSelectedAdapter} size="sm" className="flex-1 min-w-0" />
                <button
                  onClick={() => handleCreateThread(selectedAdapter)}
                  className="shrink-0 p-2 rounded-lg border border-cream/10 hover:bg-cream/10 transition-colors text-cream/60 hover:text-cream"
                  title={tChat("threads.newThread")}
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Scope toggle (monorepo only) */}
            {isMonorepoScope && (
              <div className="flex items-center gap-1 px-4 py-2 border-b border-cream/10 shrink-0">
                <div className="flex items-center gap-0.5 rounded-lg border border-cream/10 overflow-hidden flex-1">
                  <button
                    onClick={() => handleThreadScopeModeChange("scoped")}
                    className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors truncate ${
                      threadScopeMode === "scoped" ? "bg-sodium/10 text-sodium" : "text-cream/45"
                    }`}
                  >
                    {threadScopeLabel || tChat("threads.scopedLabel")}
                  </button>
                  <button
                    onClick={() => handleThreadScopeModeChange("all")}
                    className={`flex-1 px-3 py-1.5 text-xs font-medium transition-colors ${
                      threadScopeMode === "all" ? "bg-sodium/10 text-sodium" : "text-cream/45"
                    }`}
                  >
                    {tChat("threads.allLabel")}
                  </button>
                </div>
              </div>
            )}

            {/* Thread list */}
            <div className="flex-1 overflow-y-auto p-2">
              {threads.length === 0 ? (
                connectionStatus === "connecting" ? (
                  <div className="text-center py-12 text-cream/45">
                    <ClaudeLogo className="w-10 h-10 mx-auto mb-3 opacity-50 animate-pulse" />
                    <p className="text-sm">{tChat("connection.reconnecting")}</p>
                    <p className="text-xs mt-1">{tChat("connection.reconnectingHint")}</p>
                  </div>
                ) : connectionStatus === "disconnected" ? (
                  <div className="text-center py-12 text-cream/45">
                    <ClaudeLogo className="w-10 h-10 mx-auto mb-3 opacity-50" />
                    <p className="text-sm">{tChat("connection.disconnected")}</p>
                    <p className="text-xs mt-1">{tChat("connection.disconnectedHint")}</p>
                  </div>
                ) : (
                  <div className="text-center py-12 text-cream/45">
                    <ClaudeLogo className="w-10 h-10 mx-auto mb-3 opacity-50" />
                    <p className="text-sm">{tChat("emptyStates.noThreads")}</p>
                    <p className="text-xs mt-1">{tChat("emptyStates.noThreadsHint")}</p>
                  </div>
                )
              ) : (
                <div className="space-y-1">
                  {threads.map((thread) => (
                    <ThreadItem
                      key={thread.id}
                      thread={thread}
                      isActive={thread.id === activeThreadId}
                      onSelect={() => handleSelectThread(thread.id)}
                      onDelete={() => handleDeleteThread(thread.id)}
                      onRename={(title) => handleRenameThread(thread.id, title)}
                      showScope={isMonorepoScope && threadScopeMode === "all"}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Focus (desktop): sidebar + content in a row; Studio / mobile: content fills the column */}
      <div className={cn("flex-1 flex min-h-0 flex-col", desktopViewMode === "focus" && "md:flex-row")}>
      {desktopViewMode === "focus" && (
        <aside className={cn(
          "hidden md:flex shrink-0 flex-col border-r border-border bg-card/50 min-h-0 transition-all",
          sidebarCollapsed ? "w-10" : "w-[280px]"
        )}>
          {sidebarCollapsed ? (
            <div className="flex flex-col items-center pt-2">
              <button
                onClick={() => setSidebarCollapsed(false)}
                className="p-1.5 rounded-lg hover:bg-cream/10 text-cream/60 hover:text-cream transition-colors"
                title={tChat("tooltips.expandThreads")}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <div className="mt-2 text-[10px] text-cream/45" style={{ writingMode: "vertical-rl" }}>
                {tChat("thread.threadsCountTotal", { count: threads.length })}
              </div>
            </div>
          ) : (
            <>
              {/* Sidebar header */}
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-cream">{tChat("threads.heading")}</span>
                  <span className="text-[10px] text-cream/45">{threads.length}</span>
                </div>
                <div className="flex items-center gap-1">
                  <AdapterPicker value={selectedAdapter} onChange={setSelectedAdapter} size="xs" />
                  <button
                    onClick={() => handleCreateThread(selectedAdapter)}
                    className="p-1.5 rounded-lg hover:bg-cream/10 text-cream/60 hover:text-cream transition-colors"
                    title={tChat("threads.newThread")}
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setSidebarCollapsed(true)}
                    className="p-1.5 rounded-lg hover:bg-cream/10 text-cream/60 hover:text-cream transition-colors"
                    title={tChat("tooltips.collapseSidebar")}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {/* Scope toggle (monorepo only) */}
              {isMonorepoScope && (
                <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-border shrink-0">
                  <div className="flex items-center gap-0.5 rounded-md border border-border overflow-hidden flex-1">
                    <button
                      onClick={() => handleThreadScopeModeChange("scoped")}
                      className={`flex-1 px-2 py-1 text-[10px] font-medium transition-colors truncate ${
                        threadScopeMode === "scoped" ? "bg-sodium/10 text-sodium" : "text-cream/45 hover:text-cream/75"
                      }`}
                      title={threadScopeLabel ? tChat("tooltips.showThreadsFrom", { scope: threadScopeLabel }) : tChat("tooltips.showScopedThreads")}
                    >
                      {threadScopeLabel || tChat("threads.scopedLabel")}
                    </button>
                    <button
                      onClick={() => handleThreadScopeModeChange("all")}
                      className={`flex-1 px-2 py-1 text-[10px] font-medium transition-colors ${
                        threadScopeMode === "all" ? "bg-sodium/10 text-sodium" : "text-cream/45 hover:text-cream/75"
                      }`}
                    >
                      {tChat("threads.allLabel")}
                    </button>
                  </div>
                </div>
              )}
              {/* Thread list */}
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {threads.length === 0 ? (
                  connectionStatus === "connecting" ? (
                    // Reconnecting after a bridge restart or transient
                    // network blip. Surface this as "reconnecting" rather
                    // than "no threads" — the data is intact server-side
                    // and the snapshot will arrive when the WS handshake
                    // completes.
                    <div className="text-center py-8 text-cream/45">
                      <p className="text-xs">{tChat("connection.reconnecting")}</p>
                      <p className="text-[10px] mt-1">{tChat("connection.reconnectingHint")}</p>
                    </div>
                  ) : connectionStatus === "disconnected" ? (
                    <div className="text-center py-8 text-cream/45">
                      <p className="text-xs">{tChat("connection.disconnected")}</p>
                      <p className="text-[10px] mt-1">{tChat("connection.disconnectedHint")}</p>
                    </div>
                  ) : (
                    <div className="text-center py-8 text-cream/45">
                      <p className="text-xs">{tChat("emptyStates.noThreads")}</p>
                      <p className="text-[10px] mt-1">{tChat("emptyStates.noThreadsHint")}</p>
                    </div>
                  )
                ) : (
                  threads.map((thread) => (
                    <ThreadItem
                      key={thread.id}
                      thread={thread}
                      isActive={thread.id === activeThreadId}
                      onSelect={() => handleSelectThread(thread.id)}
                      onDelete={() => handleDeleteThread(thread.id)}
                      onRename={(title) => handleRenameThread(thread.id, title)}
                      showScope={isMonorepoScope && threadScopeMode === "all"}
                    />
                  ))
                )}
              </div>
            </>
          )}
        </aside>
      )}

      {/* Main content column (messages + composer) */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0 relative">
      {/* Floating toolbar — thread pill (left) + actions (right), overlaid on content */}
      <div className={cn("absolute left-3 right-3 sm:left-4 sm:right-4 z-30 flex items-start justify-between pointer-events-none", !IS_ANDROID && "top-3")} style={IS_ANDROID ? { top: "calc(0.75rem + env(safe-area-inset-top, 0px))" } : undefined}>
        {/* Thread selector pill — hidden on desktop focus (sidebar handles it) */}
        <button
          onClick={() => setShowThreadPicker(true)}
          className={cn(
            "pointer-events-auto flex items-center gap-2 h-8 pl-2.5 pr-3 rounded-lg text-xs font-medium transition-colors backdrop-blur-md bg-card/70 border border-cream/[0.06] hover:bg-card/90 hover:border-cream/[0.08]",
            desktopViewMode === "focus" && "md:hidden"
          )}
        >
          <div
            className="px-1.5 py-0.5 rounded text-[11px] font-semibold shrink-0"
            style={{
              backgroundColor: `${currentSessionInfo.color}20`,
              color: currentSessionInfo.color,
            }}
          >
            {SESSION_MAP[currentSession]?.label || currentSessionInfo.label}
          </div>
          <span className="truncate text-xs text-cream max-w-[120px] sm:max-w-[180px]">
            {activeThread?.title || tChat("threads.activeThreadFallback")}
          </span>
          <ChevronDown className="w-3 h-3 text-cream/60 shrink-0" />
        </button>

        {/* Actions pill — ml-auto ensures far-right when thread pill is hidden */}
        <ActionsDropdown
          resolvedActions={integrationsHook.resolvedActions}
          loading={integrationsHook.loading}
          hasProject={!!activeProject}
          executingActionId={executingActionId}
          pendingGateActionId={pendingGateActionId}
          onExecute={handleAction}
        />
      </div>

      <ConnectionStatusBanner
        status={connectionStatus === "connected" ? "connected" : connectionStatus === "connecting" ? "reconnecting" : connectionStatus === "error" ? "error" : "disconnected"}
        attempt={reconnectAttemptsRef.current}
      />
      <DegradationModeBanner state={systemHealthState} />
      {activeProject && (
        <div className="hidden">
          <SandboxSwitcher
            active={{ id: activeProject, name: activeProject, warm: connectionStatus === "connected", proSlotsHere: 0 }}
            options={[{ id: activeProject, name: activeProject, warm: connectionStatus === "connected", proSlotsHere: 0 }]}
            onSelect={() => { /* parent dashboard owns project switching via postMessage */ }}
          />
          <ArchiveSection
            items={[]}
            onUnarchive={() => { /* server-driven via thread.unarchive command (route TBD) */ }}
            onSelect={() => { /* same handler as active sidebar selection */ }}
          />
        </div>
      )}

      {activeThreadRef && activeThreadFromStore ? (
        <ThreadIdContext.Provider value={activeThreadRef}>
          <ThreadErrorBanner
            error={activeThreadFromStore.error}
            onDismiss={() => setActiveThreadError(activeThreadRef.threadId, null)}
          />
          <div className={cn("relative flex min-h-0 flex-1 flex-col", !IS_ANDROID && "pt-12")} style={IS_ANDROID ? { paddingTop: "calc(3rem + env(safe-area-inset-top, 0px))" } : undefined}>
            <MessagesTimeline
              key={activeThreadRef.threadId}
              isWorking={isWorking}
              activeTurnInProgress={isWorking || !latestTurnSettled}
              activeTurnId={activeLatestTurn?.turnId ?? null}
              activeTurnStartedAt={activeWorkStartedAt}
              listRef={legendListRef}
              timelineEntries={timelineEntries}
              completionDividerBeforeEntryId={completionDividerBeforeEntryId}
              completionSummary={null}
              turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
              activeThreadEnvironmentId={activeThreadRef.environmentId}
              routeThreadKey={`${activeThreadRef.environmentId}:${activeThreadRef.threadId}`}
              onOpenTurnDiff={noopFn}
              revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
              onRevertUserMessage={(messageId) =>
                handleRevertTurn(messageId, revertTurnCountByUserMessageId.get(messageId))
              }
              isRevertingCheckpoint={isReverting}
              onImageExpand={noopFn}
              markdownCwd={activeProjectFromStore?.cwd ?? undefined}
              resolvedTheme="dark"
              timestampFormat="locale"
              workspaceRoot={activeProjectFromStore?.cwd ?? undefined}
              failedMessageIds={failedMessageIds}
              onRetryMessage={onRetryMessage}
              onIsAtEndChange={(val) => {
                isAtEndRef.current = val;
                setIsAtEnd(val);
              }}
            />
            {!isAtEnd && (
              <button
                type="button"
                onClick={scrollToBottom}
                className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card/95 shadow-lg backdrop-blur-sm transition-all duration-200 hover:bg-card hover:scale-105 active:scale-95 size-9"
                aria-label={tChat("scrollToBottom")}
              >
                <ChevronDown className="size-4 text-muted-foreground" />
              </button>
            )}
          </div>
          <div className="shrink-0 px-3 pt-1.5 pb-3 sm:px-5 sm:pt-2 sm:pb-4 pb-safe">
            {(() => {
              const providerForBanner =
                activeThreadFromStore?.modelSelection?.provider ??
                activeProjectFromStore?.defaultModelSelection?.provider ??
                null;
              const bannerStatus = providerForBanner
                ? (liveProviderStatuses.find(
                    (entry) => entry.provider === providerForBanner,
                  ) ?? null)
                : null;
              return (
                <ProviderAuthPrompt
                  status={bannerStatus}
                  onRefresh={handleRefreshProvider}
                  onStartAuth={handleStartAuth}
                  refreshing={isRefreshingProvider}
                  verifying={verifyingAuthProvider === bannerStatus?.provider}
                />
              );
            })()}
            {(() => {
              const turnId = activeThreadFromStore?.session?.activeTurnId ?? null;
              const queued = turnId ? queueByThread[turnId] : undefined;
              return queued ? (
                <div className="px-3 pb-1">
                  <QueuedSendPill position={queued.position} etaMs={queued.etaMs} />
                </div>
              ) : null;
            })()}
            <ChatComposer
              ref={composerRef}
              composerDraftTarget={activeThreadRef}
              environmentId={ELLUL_ENV_ID}
              routeKind="server"
              routeThreadRef={activeThreadRef}
              draftId={null}
              activeThreadId={activeThreadRef.threadId}
              activeThreadEnvironmentId={activeThreadRef.environmentId}
              activeThread={activeThreadFromStore}
              isServerThread={true}
              isLocalDraftThread={false}
              phase={phaseOfActiveThread}
              isConnecting={connectionStatus === "connecting"}
              isSendBusy={isSubmitting}
              isPreparingWorktree={false}
              activePendingApproval={activePendingApproval}
              pendingApprovals={pendingApprovalsList}
              pendingUserInputs={pendingUserInputsList}
              activePendingProgress={activePendingProgressDerived}
              activePendingResolvedAnswers={activePendingResolvedAnswersDerived}
              activePendingIsResponding={
                activePendingUserInput
                  ? respondingRequestIds.includes(activePendingUserInput.requestId)
                  : false
              }
              activePendingDraftAnswers={pendingUserInputDraftAnswers}
              activePendingQuestionIndex={pendingUserInputQuestionIndex}
              respondingRequestIds={respondingRequestIds}
              showPlanFollowUpPrompt={false}
              activeProposedPlan={null}
              activePlan={null}
              sidebarProposedPlan={null}
              planSidebarLabel={tChat("planSidebar.label")}
              planSidebarOpen={false}
              runtimeMode={activeThreadFromStore.runtimeMode}
              interactionMode={activeThreadFromStore.interactionMode}
              lockedProvider={null}
              providerStatuses={[...liveProviderStatuses]}
              activeProjectDefaultModelSelection={
                activeProjectFromStore?.defaultModelSelection ?? null
              }
              activeThreadModelSelection={activeThreadFromStore.modelSelection}
              activeThreadActivities={activeThreadFromStore.activities}
              resolvedTheme="dark"
              settings={DEFAULT_UNIFIED_SETTINGS}
              gitCwd={activeProjectFromStore?.cwd ?? null}
              promptRef={promptRef}
              composerImagesRef={composerImagesRef as React.MutableRefObject<never[]>}
              composerTerminalContextsRef={composerTerminalContextsRef as React.MutableRefObject<never[]>}
              shouldAutoScrollRef={isAtEndRef}
              scheduleStickToBottom={noopFn}
              onSend={onSendComposer}
              onInterrupt={handleInterrupt}
              onImplementPlanInNewThread={noopFn}
              onRespondToApproval={handleApprovalRespond}
              onSelectActivePendingUserInputOption={handleSelectActivePendingUserInputOption}
              onAdvanceActivePendingUserInput={handleAdvanceActivePendingUserInput}
              onPreviousActivePendingUserInputQuestion={handlePreviousActivePendingUserInputQuestion}
              onChangeActivePendingUserInputCustomAnswer={handleChangeActivePendingUserInputCustomAnswer}
              onProviderModelSelect={handleProviderModelSelect}
              pinnedModelByProvider={pinnedModelByProvider}
              onPinModel={handlePinModel}
              toggleInteractionMode={toggleInteractionMode}
              handleRuntimeModeChange={handleRuntimeModeChange}
              handleInteractionModeChange={handleInteractionModeChange}
              togglePlanSidebar={noopFn}
              focusComposer={focusComposer}
              scheduleComposerFocus={focusComposer}
              setThreadError={setActiveThreadError}
              onExpandImage={noopFn}
            />
          </div>
        </ThreadIdContext.Provider>
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground/60">
          {connectionStatus === "connecting" ? tChat("emptyStates.connecting") : tChat("emptyStates.selectOrCreate")}
        </div>
      )}
      </div>{/* end main content column */}
      </div>{/* end row/column wrapper */}
    </div>
    <AuthSetupModal
      open={authModalProvider !== null}
      status={
        authModalProvider
          ? (liveProviderStatuses.find((entry) => entry.provider === authModalProvider) ?? null)
          : null
      }
      onClose={handleCloseAuthModal}
      onSuccess={handleAuthSuccess}
    />
        </AnchoredToastProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
