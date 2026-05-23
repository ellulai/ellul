// SPDX-License-Identifier: MIT
"use client";

import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useNativeNotifications } from "@/hooks/useNativeNotifications";
import { removeCachedThread } from "@/hooks/useOfflineCache";
import { usePermissionInboxOptional, type InboxRequest } from "@/contexts/PermissionInboxContext";
import { useOperatorKeyOptional } from "@/contexts/OperatorKeyContext";
import { OperatorKeyUnrecoverableError } from "@/lib/operator-key";

import { useAppsListOptional } from "@/contexts/AppsListContext";
import { useVpsBridge } from "@/lib/vps-bridge";
import type { GateClient } from "@/lib/gate-client";
import type { ContextModeClient } from "@/lib/context-mode-client";
import type { ToolPermissionClient } from "@/lib/tool-permission-client";

function isAuthRequiredError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as { status?: unknown }).status;
    if (status === 401) return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "Authentication required") return true;
  if (msg.includes("HTTP 401")) return true;
  return false;
}

// Types matching VPS thread service
export interface Thread {
  id: string;
  title: string | null;
  project: string | null;
  lastSession: string;
  lastModel: string | null;
  createdAt: number;
  updatedAt: number;
}

import type { MessagePart } from "@ellul.ai/types";

export interface ThreadMessage {
  id: string;
  threadId: string;
  type: "user" | "assistant" | "error" | "system" | "cli_prompt" | "cli_input";
  content: string;
  session: string | null;
  model: string | null;
  // Canonical structured content for assistant messages: ordered
  parts: MessagePart[] | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
  seq: number;
}

export interface ProcessingState {
  isProcessing: boolean;
  // In-flight parts for the assistant message currently being streamed.
  parts: MessagePart[];
  session: string;
  startedAt?: number;
}

export type GateType = "logs" | "env" | "db" | "db_read" | "db_write" | "db_migrate" | "db_full" | "git" | "deploy";
export type GatePermission = "ask" | "allow_session" | "allow_always" | "never";

export interface GateGrantInfo {
  active: boolean;
  expiresAt: number | null;
}

export interface GateStatus {
  logs: GateGrantInfo;
  env: GateGrantInfo;
  db: GateGrantInfo;
  db_read: GateGrantInfo;
  db_write: GateGrantInfo;
  db_migrate: GateGrantInfo;
  db_full: GateGrantInfo;
  git: GateGrantInfo;
  deploy: GateGrantInfo;
}

export interface WorkbenchState {
  threads: Thread[];
  activeThreadId: string | null;
  activeThread: Thread | null;
  messages: ThreadMessage[];
  isLoadingThreads: boolean;
  isLoadingMessages: boolean;
  sidebarOpen: boolean;
  isConnected: boolean;
  processingState: ProcessingState | null;
  // Increments each time thread_data is received from server (DB reload).
  threadDataVersion: number;
  // Last known sequence number for the active thread (for gap detection).
  lastSeq: number;
  // Current gate status for the active thread.
  gateStatus: GateStatus;
  // Last error from a proactive gate grant attempt.
  gateGrantError: string | null;
}

export interface WorkbenchContextValue extends WorkbenchState {
  // Thread operations
  createThread: (session: string, title?: string) => void;
  selectThread: (threadId: string | null) => void;
  deleteThread: (threadId: string) => void;
  renameThread: (threadId: string, title: string) => void;
  // Message operations
  addLocalMessage: (message: Omit<ThreadMessage, "id" | "threadId" | "createdAt">) => void;
  saveMessage: (message: Omit<ThreadMessage, "id" | "threadId" | "createdAt">) => void;
  clearMessages: () => void;
  // UI
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  // WebSocket integration
  setWsSend: (send: ((msg: Record<string, unknown>) => void) | null) => void;
  setConnected: (connected: boolean) => void;
  // Handle incoming WebSocket messages
  handleWsMessage: (msg: Record<string, unknown>) => void;
  // Refresh threads list
  refreshThreads: (project?: string | null) => void;
  // Context mode — controls which prompt layers are active per project
  sendContextMode: (mode: "base" | "preview" | "deploy", project?: string | null) => void;
  queryContextMode: (project?: string | null) => void;
  // Per-project context mode state (updated from bridge responses)
  projectContextModes: Record<string, "base" | "preview" | "deploy">;
  // Sovereign Gates
  respondToGateRequest: (requestId: string, action: "grant_timed" | "grant_session" | "grant_always" | "deny" | "deny_always") => Promise<boolean>;
  revokeGate: (gate: GateType) => void;
  // Proactively grant a gate from settings (no pending agent request needed).
  grantGate: (gate: GateType, action: "grant_timed" | "grant_session") => boolean;
  // Last error from a proactive gate grant attempt.
  gateGrantError: string | null;
  // Per-app gate permissions.
  setGatePermission: (gate: GateType, sandboxId: string, permission: GatePermission) => void;
  fetchGatePermissions: (sandboxId?: string) => void;
  appGatePermissions: Record<string, Record<GateType, GatePermission>>;
  // Per-tool permission overrides — sent to VPS via WebSocket.
  sendToolPermissionSet?: (connectionId: string, toolName: string, permission: GatePermission) => void;
  sendToolPermissionReset?: (connectionId: string, toolName: string) => void;
  chatIframeSendRef: React.MutableRefObject<((msg: Record<string, unknown>) => void) | null>;
  setActiveThreadIdFromIframe: (threadId: string | null) => void;
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

export function useWorkbench() {
  const context = useContext(WorkbenchContext);
  if (!context) {
    throw new Error("useWorkbench must be used within WorkbenchProvider");
  }
  return context;
}

// Optional version that returns null when not inside provider.
export function useWorkbenchOptional(): WorkbenchContextValue | null {
  return useContext(WorkbenchContext);
}

interface WorkbenchProviderProps {
  children: ReactNode;
  initialSidebarOpen?: boolean;
}

const DEFAULT_PERMS: Readonly<Record<GateType, GatePermission>> = Object.freeze({
  logs: "ask", env: "ask", db: "ask", db_read: "ask", db_write: "ask",
  db_migrate: "ask", db_full: "ask", git: "ask", deploy: "ask",
});

// WorkbenchProvider manages chat state for a single app/project.
function inboxRequestFromWire(msg: Record<string, unknown>): InboxRequest | null {
  const id = typeof msg.requestId === 'string' ? msg.requestId : null;
  const threadId = typeof msg.threadId === 'string' ? msg.threadId : null;
  const gate = typeof msg.gate === 'string' ? msg.gate : null;
  if (!id || !threadId || !gate) return null;
  return {
    id,
    gate: gate as GateType,
    threadId,
    sandboxId: (msg.sandboxId as string) || null,
    requestedBy: {},
    scope: null,
    reason: (msg.reason as string) || null,
    status: 'pending',
    resolution: null,
    createdAt: (msg.timestamp as number) || Date.now(),
    lastSeenAt: null,
    resolvedAt: null,
  };
}

export function WorkbenchProvider({ children, initialSidebarOpen = false }: WorkbenchProviderProps) {
  const t = useTranslations("console.contexts.workbench");
  // State - resets naturally when provider remounts on route change
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [isLoadingThreads, setIsLoadingThreads] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const [isConnected, setIsConnected] = useState(false);
  const [processingState, setProcessingState] = useState<ProcessingState | null>(null);
  const [threadDataVersion, setThreadDataVersion] = useState(0);
  const [lastSeq, setLastSeq] = useState(0);
  const [projectContextModes, setProjectContextModes] = useState<Record<string, "base" | "preview" | "deploy">>({});
  const resolvedGateRequestIds = useRef(new Set<string>());
  const closedGate: GateGrantInfo = { active: false, expiresAt: null };
  const [gateStatus, setGateStatus] = useState<GateStatus>({ logs: closedGate, env: closedGate, db: closedGate, db_read: closedGate, db_write: closedGate, db_migrate: closedGate, db_full: closedGate, git: closedGate, deploy: closedGate });

  const chatIframeSendRef = useRef<((msg: Record<string, unknown>) => void) | null>(null);

  // Native push notifications
  const { sendNotification } = useNativeNotifications();
  const nativeNotifyRef = useRef(sendNotification);
  useEffect(() => { nativeNotifyRef.current = sendNotification; }, [sendNotification]);

  const { signalAuthNeeded, needsVpsAuth } = useVpsBridge();
  const signalAuthIfNeeded = useCallback((err: unknown): boolean => {
    if (isAuthRequiredError(err)) {
      signalAuthNeeded();
      return true;
    }
    return false;
  }, [signalAuthNeeded]);

  // Cross-thread permission inbox (optional — null outside dashboard context).
  const inbox = usePermissionInboxOptional();
  const inboxRef = useRef(inbox);
  useEffect(() => { inboxRef.current = inbox; }, [inbox]);

  // Gate + context-mode control surface (REST via operator signature).
  const operatorKey = useOperatorKeyOptional();
  const appsList = useAppsListOptional();
  const gateClient: GateClient | null = operatorKey?.gateClient ?? null;
  const gateClientRef = useRef<GateClient | null>(gateClient);
  useEffect(() => { gateClientRef.current = gateClient; }, [gateClient]);
  const contextModeClient: ContextModeClient | null =
    operatorKey?.contextModeClient ?? null;
  const contextModeClientRef = useRef<ContextModeClient | null>(contextModeClient);
  useEffect(() => { contextModeClientRef.current = contextModeClient; }, [contextModeClient]);
  const toolPermissionClient: ToolPermissionClient | null =
    operatorKey?.toolPermissionClient ?? null;
  const toolPermissionClientRef = useRef<ToolPermissionClient | null>(toolPermissionClient);
  useEffect(() => { toolPermissionClientRef.current = toolPermissionClient; }, [toolPermissionClient]);
  const activeSandbox = appsList?.active.sandbox ?? null;
  const activeSandboxRef = useRef<string | null>(activeSandbox);
  useEffect(() => {
    activeSandboxRef.current = activeSandbox;
  }, [activeSandbox]);

  // Hydrate context mode for the newly-active sandbox so UI consumers
  // (projectContextModes[sandboxId]) reflect the server's authoritative state
  // on mount + every sandbox switch. Requires the operator key to be bound.
  useEffect(() => {
    if (!activeSandbox) return;
    if (needsVpsAuth) return;
    const client = contextModeClientRef.current;
    if (!client) return;
    client.getContextMode(activeSandbox)
      .then(({ mode }) =>
        setProjectContextModes((prev) =>
          prev[activeSandbox] === mode ? prev : { ...prev, [activeSandbox]: mode },
        ),
      )
      .catch((err) => {
        if (signalAuthIfNeeded(err)) return;
        console.error("[Workbench] hydrate context mode failed", err);
      });
  }, [activeSandbox, contextModeClient, needsVpsAuth, signalAuthIfNeeded]);

  // WebSocket send function ref
  const wsSendRef = useRef<((msg: Record<string, unknown>) => void) | null>(null);

  // Ref for activeThreadId — avoids stale closures in handleWsMessage
  const activeThreadIdRef = useRef<string | null>(null);

  // Tracks thread ID for which thread_data has been loaded — prevents redundant
  const threadDataLoadedForRef = useRef<string | null>(null);

  // Ref for isConnected — avoids stale closures in refreshThreads
  const isConnectedRef = useRef(false);

  // Auto-retry timer for stalled message loads
  const loadRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Local message ID counter for optimistic updates
  const localIdCounter = useRef(0);

  // Keep refs in sync with state (render-time sync)
  activeThreadIdRef.current = activeThreadId;
  isConnectedRef.current = isConnected;

  // Get active thread from list
  const activeThread = threads.find((t) => t.id === activeThreadId) || null;

  // Set WebSocket send function
  const setWsSend = useCallback((send: ((msg: Record<string, unknown>) => void) | null) => {
    wsSendRef.current = send;
  }, []);

  // Set connected state (caller is responsible for calling refreshThreads with project)
  const setConnected = useCallback((connected: boolean) => {
    setIsConnected(connected);
    // On disconnect, reset threadDataLoadedForRef so the next reconnect
    if (!connected) {
      threadDataLoadedForRef.current = null;
    }
  }, []);

  // Refresh threads list (project required for proper scoping)
  const refreshThreads = useCallback((project?: string | null) => {
    if (wsSendRef.current) {
      setIsLoadingThreads(true);
      wsSendRef.current({ type: "list_threads", project: project ?? null });
    }
  }, []);

  // Per-write monotonic counters keyed so latest-wins logic can tell a stale
  // failure (whose result no longer matters because a newer write started or
  // completed) from a "current" failure (whose optimistic state really should
  // roll back). Plain refs — no promise queue.
  const contextModeWriteIdRef = useRef<Record<string, number>>({});
  const toolPermissionWriteIdRef = useRef<Record<string, number>>({});

  // Per-project context-mode control — flips prompt layers (base / preview /
  // deploy) for the active sandbox. Goes over /_auth/context-mode (operator-
  // signed on writes, session-authed on reads) — same posture as gates.
  const sendContextMode = useCallback(
    (mode: "base" | "preview" | "deploy", project?: string | null) => {
      const client = contextModeClientRef.current;
      if (!client || !project) return;
      const sandboxId = project.includes("/") ? project.split("/")[0] : project;
      const writeId = (contextModeWriteIdRef.current[sandboxId] ?? 0) + 1;
      contextModeWriteIdRef.current[sandboxId] = writeId;
      setProjectContextModes((prev) => ({ ...prev, [sandboxId]: mode }));
      client.setContextMode(sandboxId, mode).catch((err) => {
        // Latest-wins: a later write started or completed; its outcome —
        // not ours — represents the user's current intent.
        if (contextModeWriteIdRef.current[sandboxId] !== writeId) return;
        if (signalAuthIfNeeded(err)) return;
        console.error("[Workbench] setContextMode failed", err);
        client.getContextMode(sandboxId)
          .then(({ mode: actual }) => {
            if (contextModeWriteIdRef.current[sandboxId] !== writeId) return;
            setProjectContextModes((prev) => ({ ...prev, [sandboxId]: actual }));
          })
          .catch((readErr) => {
            signalAuthIfNeeded(readErr);
          });
      });
    },
    [signalAuthIfNeeded],
  );

  const queryContextMode = useCallback((project?: string | null) => {
    const client = contextModeClientRef.current;
    if (!client || !project) return;
    const sandboxId = project.includes("/") ? project.split("/")[0] : project;
    client.getContextMode(sandboxId)
      .then(({ mode }) =>
        setProjectContextModes((prev) => ({ ...prev, [sandboxId]: mode })),
      )
      .catch((err) => {
        if (signalAuthIfNeeded(err)) return;
        console.error("[Workbench] getContextMode failed", err);
      });
  }, [signalAuthIfNeeded]);

  // Create thread with specific session/model
  const createThread = useCallback((session: string, title?: string) => {
    if (wsSendRef.current) {
      wsSendRef.current({ type: "create_thread", session, title });
    }
  }, []);

  const setActiveThreadIdFromIframe = useCallback((threadId: string | null) => {
    setActiveThreadId(threadId);
    activeThreadIdRef.current = threadId;
  }, []);

  // Select thread
  const selectThread = useCallback((threadId: string | null) => {
    if (wsSendRef.current) {
      setActiveThreadId(threadId);
      activeThreadIdRef.current = threadId; // Immediate sync for thread_data validation
      threadDataLoadedForRef.current = null; // Reset — new thread needs fresh data
      setMessages([]);
      setProcessingState(null);
      setGateStatus({ logs: { active: false, expiresAt: null }, env: { active: false, expiresAt: null }, db: { active: false, expiresAt: null }, db_read: { active: false, expiresAt: null }, db_write: { active: false, expiresAt: null }, db_migrate: { active: false, expiresAt: null }, db_full: { active: false, expiresAt: null }, git: { active: false, expiresAt: null }, deploy: { active: false, expiresAt: null } });
      if (threadId) {
        setIsLoadingMessages(true);
        // set_thread FIRST (starts auth/subscription), then get_thread (loads DB snapshot)
        wsSendRef.current({ type: "set_thread", threadId });
        wsSendRef.current({ type: "get_thread", threadId });
      } else {
        wsSendRef.current({ type: "set_thread", threadId: null });
      }
    }
  }, []);

  // Delete thread
  const deleteThread = useCallback((threadId: string) => {
    if (wsSendRef.current) {
      wsSendRef.current({ type: "delete_thread", threadId });
    }
  }, []);

  // Rename thread
  const renameThread = useCallback((threadId: string, title: string) => {
    if (wsSendRef.current) {
      wsSendRef.current({ type: "rename_thread", threadId, title });
    }
  }, []);

  // Add message locally (optimistic update)
  const addLocalMessage = useCallback((message: Omit<ThreadMessage, "id" | "threadId" | "createdAt">) => {
    if (!activeThreadId) return;

    const localMessage: ThreadMessage = {
      ...message,
      id: `local-${++localIdCounter.current}`,
      threadId: activeThreadId,
      createdAt: Date.now(),
    };

    setMessages((prev) => [...prev, localMessage]);
  }, [activeThreadId]);

  // Save message to VPS
  const saveMessage = useCallback((message: Omit<ThreadMessage, "id" | "threadId" | "createdAt">) => {
    if (wsSendRef.current && activeThreadId) {
      wsSendRef.current({ type: "add_message", threadId: activeThreadId, message });
    }
  }, [activeThreadId]);

  // Clear messages
  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  // Proactive gate grant error state. Declared ahead of the handlers that
  const [gateGrantError, setGateGrantError] = useState<string | null>(null);

  // Operator signature is required by sovereign-shield (SLH-DSA-SHA2-128s);
  // every approval/denial drives /_auth/gates/respond directly.
  const respondToGateRequest = useCallback(async (requestId: string, action: "grant_timed" | "grant_session" | "grant_always" | "deny" | "deny_always"): Promise<boolean> => {
    const client = gateClientRef.current;
    if (!client) return false;
    const inbox = inboxRef.current;
    const request = inbox?.byId.get(requestId);
    if (!request) {
      setGateGrantError(t("missingRequestId"));
      return false;
    }
    try {
      const serverAction = action === "deny_always" ? "deny" : action;
      const resp = await client.respondToGate({
        requestId,
        gate: request.gate,
        project: request.sandboxId ?? null,
        action: serverAction,
      }) as { status?: string; expiresAt?: number | null } | undefined;
      if (action === "deny_always" && request.sandboxId) {
        await client.setGatePermission({ gate: request.gate as GateType, project: request.sandboxId, permission: "never" });
      }
      resolvedGateRequestIds.current.add(requestId);
      if (action.startsWith("grant") && resp?.status === "granted") {
        const gate = request.gate as GateType;
        const expiresAt = resp.expiresAt ?? null;
        setGateStatus((prev) => ({ ...prev, [gate]: { active: true, expiresAt } }));
        chatIframeSendRef.current?.({ type: "gate_continue", gate, requestId });
      }
      if (inbox) {
        const resolvedStatus = action.startsWith("grant") ? "granted" : "denied";
        inbox.applyDelta({
          ...request,
          status: resolvedStatus as "granted" | "denied",
          resolution: {
            action: serverAction as "grant_timed" | "grant_session" | "grant_always" | "deny",
            resolvedAt: Date.now(),
          },
          lastSeenAt: Date.now(),
          resolvedAt: Date.now(),
        });
      }
      setGateGrantError(null);
      return true;
    } catch (e) {
      if (e instanceof OperatorKeyUnrecoverableError || signalAuthIfNeeded(e)) {
        signalAuthNeeded();
        return false;
      }
      const errMsg = e instanceof Error ? e.message : String(e);
      if (errMsg.includes("not found") || errMsg.includes("expired")) {
        resolvedGateRequestIds.current.add(requestId);
        if (inbox) {
          inbox.applyDelta({ ...request, status: "expired" as "expired", resolvedAt: Date.now() });
        }
        setGateGrantError(null);
        return true;
      }
      setGateGrantError(errMsg);
      return false;
    }
  }, [signalAuthIfNeeded, t]);

  // Revoke an active gate (from status bar)
  const revokeGate = useCallback(async (gate: GateType) => {
    const client = gateClientRef.current;
    const sandboxId = activeSandboxRef.current;
    if (!client || !sandboxId) {
      setGateGrantError(client ? t("noActiveSandbox") : t("operatorKeyUnavailable"));
      return;
    }
    // Optimistic: close locally immediately
    setGateStatus((prev) => ({ ...prev, [gate]: { active: false, expiresAt: null } }));
    try {
      await client.revokeGate({ gate, project: sandboxId });
    } catch (e) {
      if (signalAuthIfNeeded(e)) return;
      setGateGrantError(e instanceof Error ? e.message : String(e));
    }
  }, [signalAuthIfNeeded, t]);

  // Proactive grants synthesize a self-originated /_auth/gates/request and
  // immediately sign the grant response, since no direct /grant endpoint
  // exists on the browser surface. See gate-client.grantGate.
  const grantGate = useCallback((gate: GateType, action: "grant_timed" | "grant_session"): boolean => {
    setGateGrantError(null);
    const client = gateClientRef.current;
    if (!client) {
      setGateGrantError(t("operatorKeyUnavailable"));
      return false;
    }
    const sandboxId = activeSandboxRef.current;
    if (!sandboxId) {
      setGateGrantError(t("noActiveSandbox"));
      return false;
    }
    client.grantGate({ gate, project: sandboxId, action })
      .catch((e) => {
        if (signalAuthIfNeeded(e)) return;
        setGateGrantError(e instanceof Error ? e.message : String(e));
      });
    return true;
  }, [signalAuthIfNeeded, t]);

  // ── Gate Permissions ──
  const [appGatePermissions, setAppGatePermissions] = useState<Record<string, Record<GateType, GatePermission>>>({});

  const setGatePermission = useCallback(async (gate: GateType, sandboxId: string, permission: GatePermission) => {
    const client = gateClientRef.current;
    if (!client) {
      setGateGrantError(t("operatorKeyUnavailable"));
      return;
    }
    // Capture the pre-optimistic value inside the functional updater so the
    // rollback snapshot is accurate even under rapid successive calls — no
    // dependence on the rendered-state closure.
    let prevPerm: GatePermission = "ask";
    setAppGatePermissions((prev) => {
      prevPerm = prev[sandboxId]?.[gate] ?? "ask";
      return {
        ...prev,
        [sandboxId]: { ...(prev[sandboxId] || DEFAULT_PERMS), [gate]: permission },
      };
    });
    try {
      await client.setGatePermission({ gate, project: sandboxId, permission });
    } catch (e) {
      setAppGatePermissions((prev) => ({
        ...prev,
        [sandboxId]: { ...(prev[sandboxId] || DEFAULT_PERMS), [gate]: prevPerm },
      }));
      if (signalAuthIfNeeded(e)) return;
      setGateGrantError(e instanceof Error ? e.message : String(e));
    }
  }, [signalAuthIfNeeded, t]);

  const fetchGatePermissions = useCallback(async (sandboxId?: string) => {
    const client = gateClientRef.current;
    const id = sandboxId ?? activeSandboxRef.current;
    if (!client || !id) return;
    try {
      const { gates } = await client.fetchGates(id);
      const perms: Record<GateType, GatePermission> = { ...DEFAULT_PERMS };
      for (const g of gates) {
        perms[g.gate] = g.policy;
      }
      setAppGatePermissions((prev) => ({ ...prev, [id]: perms }));
    } catch (e) {
      if (signalAuthIfNeeded(e)) return;
      console.error("[Workbench] fetchGatePermissions failed", e);
    }
  }, [signalAuthIfNeeded]);

  // Per-tool permission overrides — operator-signed REST. Hits sovereign-shield's
  // /_auth/tool-permissions{,/reset}, which proxies to agent-bridge's mcpGateway.
  // Latest-wins error suppression: rapid set/reset cycles on the same tool
  // shouldn't spam the console with errors that a later in-flight call has
  // already corrected. (Optimistic UI state lives in TabSecurity's
  // react-query cache, not here.)
  const sendToolPermissionSet = useCallback((connectionId: string, toolName: string, permission: GatePermission) => {
    const client = toolPermissionClientRef.current;
    if (!client) return;
    const key = `${connectionId}:${toolName}`;
    const writeId = (toolPermissionWriteIdRef.current[key] ?? 0) + 1;
    toolPermissionWriteIdRef.current[key] = writeId;
    client.setToolPermission(connectionId, toolName, permission).catch((err) => {
      if (toolPermissionWriteIdRef.current[key] !== writeId) return;
      if (signalAuthIfNeeded(err)) return;
      console.error("[Workbench] setToolPermission failed", err);
    });
  }, [signalAuthIfNeeded]);

  const sendToolPermissionReset = useCallback((connectionId: string, toolName: string) => {
    const client = toolPermissionClientRef.current;
    if (!client) return;
    const key = `${connectionId}:${toolName}`;
    const writeId = (toolPermissionWriteIdRef.current[key] ?? 0) + 1;
    toolPermissionWriteIdRef.current[key] = writeId;
    client.resetToolPermission(connectionId, toolName).catch((err) => {
      if (toolPermissionWriteIdRef.current[key] !== writeId) return;
      if (signalAuthIfNeeded(err)) return;
      console.error("[Workbench] resetToolPermission failed", err);
    });
  }, [signalAuthIfNeeded]);

  // Toggle sidebar
  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  // Uses refs for activeThreadId to avoid stale closures — no dependency array needed.
  const handleWsMessage = useCallback((msg: Record<string, unknown>) => {
    const msgType = msg.type as string;
    // Read latest activeThreadId from ref (not stale closure)
    const currentActiveThreadId = activeThreadIdRef.current;

    // Fire native notification for key events (background only)
    if (nativeNotifyRef.current) {
      nativeNotifyRef.current(msgType, msg);
    }

    switch (msgType) {
      case "threads_list": {
        const threads = (msg.threads as Thread[]) || [];
        const serverActiveThreadId = msg.activeThreadId as string | null;
        setThreads(threads);
        setIsLoadingThreads(false);

        // Auto-create a thread if none exist for this project
        if (threads.length === 0 && wsSendRef.current) {
          wsSendRef.current({ type: "create_thread", session: "opencode" });
          break;
        }

        // Check if current thread is still in the list (handles reconnects)
        const currentThreadInList = currentActiveThreadId && threads.some(t => t.id === currentActiveThreadId);

        if (currentThreadInList) {
          // Thread still in list — re-register on bridge.
          if (wsSendRef.current) {
            wsSendRef.current({ type: "set_thread", threadId: currentActiveThreadId });
            // Skipping prevents thread_data from wiping transient auth prompts
            if (threadDataLoadedForRef.current !== currentActiveThreadId) {
              wsSendRef.current({ type: "get_thread", threadId: currentActiveThreadId });
            }
          }
        } else if (serverActiveThreadId) {
          // Current thread not in list (project changed) - use server's active thread
          const activeThread = threads.find(t => t.id === serverActiveThreadId);
          if (activeThread) {
            setActiveThreadId(serverActiveThreadId);
            activeThreadIdRef.current = serverActiveThreadId; // Immediate sync for thread_data validation
            threadDataLoadedForRef.current = null; // New thread context
            setMessages([]);
            if (wsSendRef.current) {
              setIsLoadingMessages(true);
              wsSendRef.current({ type: "set_thread", threadId: serverActiveThreadId });
              wsSendRef.current({ type: "get_thread", threadId: serverActiveThreadId });
            }
          } else {
            setActiveThreadId(null);
            activeThreadIdRef.current = null;
            threadDataLoadedForRef.current = null;
            setMessages([]);
          }
        } else {
          // No active thread - select the first one if available
          const firstThread = threads[0];
          if (firstThread) {
            setActiveThreadId(firstThread.id);
            activeThreadIdRef.current = firstThread.id; // Immediate sync
            threadDataLoadedForRef.current = null; // New thread context
            setMessages([]);
            if (wsSendRef.current) {
              setIsLoadingMessages(true);
              wsSendRef.current({ type: "set_thread", threadId: firstThread.id });
              wsSendRef.current({ type: "get_thread", threadId: firstThread.id });
            }
          } else {
            setActiveThreadId(null);
            activeThreadIdRef.current = null;
            threadDataLoadedForRef.current = null;
            setMessages([]);
          }
        }
        break;
      }

      case "thread_created": {
        const thread = msg.thread as Thread;
        setThreads((prev) => [thread, ...prev]);
        setActiveThreadId(thread.id);
        activeThreadIdRef.current = thread.id; // Immediate sync
        threadDataLoadedForRef.current = null; // New thread needs fresh data
        setMessages([]);
        // set_thread FIRST (starts auth/subscription), then get_thread (loads DB snapshot
        if (wsSendRef.current) {
          setIsLoadingMessages(true);
          wsSendRef.current({ type: "set_thread", threadId: thread.id });
          wsSendRef.current({ type: "get_thread", threadId: thread.id });
        }
        break;
      }

      case "thread_data": {
        const thread = msg.thread as Thread;
        const expectedThreadId = activeThreadIdRef.current;
        // Reject stale thread_data from a previous request (prevents wrong messages showing)
        if (expectedThreadId && thread.id !== expectedThreadId) {
          break;
        }
        const threadMessages = msg.messages as ThreadMessage[];
        const serverProcessingState = msg.processingState as ProcessingState | null | undefined;
        const serverLastSeq = msg.lastSeq as number | undefined;
        // Update thread in list
        setThreads((prev) =>
          prev.map((t) => (t.id === thread.id ? thread : t))
        );
        setMessages(threadMessages || []);
        setProcessingState(serverProcessingState || null);
        if (serverLastSeq !== undefined) setLastSeq(serverLastSeq);
        setIsLoadingMessages(false);
        threadDataLoadedForRef.current = thread.id;
        // Bump version so NativeChat re-syncs (critical for reconnect scenarios)
        setThreadDataVersion(prev => prev + 1);
        break;
      }

      case "thread_deleted": {
        const deletedId = msg.threadId as string;
        setThreads((prev) => prev.filter((t) => t.id !== deletedId));
        removeCachedThread(deletedId);
        if (currentActiveThreadId === deletedId) {
          setActiveThreadId(null);
          setMessages([]);
        }
        break;
      }

      case "thread_set":
        // Thread set confirmation - session may have been restored
        break;

      case "thread_renamed": {
        const renamedId = msg.threadId as string;
        const newTitle = msg.title as string;
        setThreads((prev) =>
          prev.map((t) => (t.id === renamedId ? { ...t, title: newTitle } : t))
        );
        break;
      }

      case "sync_messages": {
        // Reject sync for a different thread (defense-in-depth)
        if (msg.threadId && msg.threadId !== activeThreadIdRef.current) break;
        const syncMessages = (msg.messages as ThreadMessage[]) || [];
        const syncLastSeq = msg.lastSeq as number | undefined;
        if (syncMessages.length > 0) {
          setMessages((prev) => {
            // Deduplicate by id — append only messages not already present
            const existingIds = new Set(prev.map(m => m.id));
            const newMsgs = syncMessages.filter(m => !existingIds.has(m.id));
            return newMsgs.length > 0 ? [...prev, ...newMsgs] : prev;
          });
        }
        if (syncLastSeq !== undefined) setLastSeq(syncLastSeq);
        break;
      }

      case "message_added": {
        const addedMessage = msg.message as ThreadMessage;
        // Reject message for a different thread (defense-in-depth)
        if (addedMessage.threadId && addedMessage.threadId !== activeThreadIdRef.current) break;
        // Replace optimistic local message with server message
        setMessages((prev) => {
          // Check if we have a local version to replace
          const hasLocal = prev.some(
            (m) => m.id.startsWith("local-") && m.type === addedMessage.type && m.content === addedMessage.content
          );
          if (hasLocal) {
            return prev.map((m) =>
              m.id.startsWith("local-") && m.type === addedMessage.type && m.content === addedMessage.content
                ? addedMessage
                : m
            );
          }
          return [...prev, addedMessage];
        });
        break;
      }

      // ── Sovereign Gates ──
      case "gate_status": {
        const gates = (msg.gates as Array<{ gate: string; expiresAt?: number | null; scope?: string }>) || [];
        const open = new Map<string, number | null>(
          gates.map((g) => [g.gate, g.expiresAt ?? null]),
        );
        setGateStatus((prev) => {
          const next = { ...prev };
          for (const key of Object.keys(next) as GateType[]) {
            const exp = open.get(key);
            next[key] = exp !== undefined
              ? { active: true, expiresAt: exp }
              : { active: false, expiresAt: null };
          }
          return next;
        });
        break;
      }

      case "gate_request": {
        const threadId = msg.threadId as string;
        const requestId = typeof msg.requestId === 'string' ? msg.requestId : null;
        const currentThread = activeThreadIdRef.current;

        const mirror = inboxRequestFromWire({ ...msg });
        if (mirror && inboxRef.current) {
          inboxRef.current.applyDelta(mirror);
        }

        if (currentThread && threadId && currentThread !== threadId) break;
        if (requestId && resolvedGateRequestIds.current.has(requestId)) break;
        break;
      }

      case "gate_granted": {
        if (Array.isArray(msg.gates)) {
          const gates = msg.gates as Array<{ gate: string; expiresAt?: number | null }>;
          const open = new Map<string, number | null>(
            gates.map((g) => [g.gate, g.expiresAt ?? null]),
          );
          setGateStatus((prev) => {
            const next = { ...prev };
            for (const key of Object.keys(next) as GateType[]) {
              const exp = open.get(key);
              next[key] = exp !== undefined
                ? { active: true, expiresAt: exp }
                : { active: false, expiresAt: null };
            }
            return next;
          });
        } else {
          const gate = msg.gate as GateType;
          const expiresAt = (msg.expiresAt as number | null | undefined) ?? null;
          setGateStatus((prev) => ({ ...prev, [gate]: { active: true, expiresAt } }));
        }
        break;
      }

      case "gate_denied": {
        const deniedId = typeof msg.requestId === 'string' ? msg.requestId : null;
        if (deniedId) resolvedGateRequestIds.current.add(deniedId);
        break;
      }

      case "gate_revoked": {
        const revokedGate = msg.gate as GateType;
        setGateStatus((prev) => ({ ...prev, [revokedGate]: { active: false, expiresAt: null } }));
        break;
      }

    }
  }, []);

  // Auto-retry: if message loading stalls for 3s, re-request thread data.
  useEffect(() => {
    if (isLoadingMessages) {
      loadRetryTimerRef.current = setTimeout(() => {
        const threadId = activeThreadIdRef.current;
        if (threadId && wsSendRef.current) {
          wsSendRef.current({ type: "get_thread", threadId });
        }
      }, 3000);
    } else {
      if (loadRetryTimerRef.current) {
        clearTimeout(loadRetryTimerRef.current);
        loadRetryTimerRef.current = null;
      }
    }
    return () => {
      if (loadRetryTimerRef.current) {
        clearTimeout(loadRetryTimerRef.current);
        loadRetryTimerRef.current = null;
      }
    };
  }, [isLoadingMessages]);

  const value: WorkbenchContextValue = {
    // State
    threads,
    activeThreadId,
    activeThread,
    messages,
    isLoadingThreads,
    isLoadingMessages,
    sidebarOpen,
    isConnected,
    processingState,
    threadDataVersion,
    lastSeq,
    gateStatus,
    // Thread operations
    createThread,
    selectThread,
    deleteThread,
    renameThread,
    // Message operations
    addLocalMessage,
    saveMessage,
    clearMessages,
    // UI
    toggleSidebar,
    setSidebarOpen,
    // WebSocket integration
    setWsSend,
    setConnected,
    handleWsMessage,
    refreshThreads,
    sendContextMode,
    queryContextMode,
    projectContextModes,
    // Sovereign Gates
    respondToGateRequest,
    revokeGate,
    grantGate,
    gateGrantError,
    setGatePermission,
    fetchGatePermissions,
    appGatePermissions,
    sendToolPermissionSet,
    sendToolPermissionReset,
    chatIframeSendRef,
    setActiveThreadIdFromIframe,
  };

  return (
    <WorkbenchContext.Provider value={value}>
      {children}
    </WorkbenchContext.Provider>
  );
}
