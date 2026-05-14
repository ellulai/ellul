// SPDX-License-Identifier: MIT
"use client";

// Permission Inbox Context — enterprise-grade HITL inbox.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useVpsBridge } from "@/lib/vps-bridge";
import type { GateType } from "./WorkbenchContext";

// ── Wire types (mirror shield/permission.service.ts) ─────────────────────

export type PermissionStatus =
  | "pending" | "granted" | "denied" | "revoked" | "expired" | "superseded";

export interface InboxRequestedBy {
  agentId?: string;
  cliKind?: string;
  toolName?: string;
  argsHash?: string;
}

export interface InboxResolution {
  action: "grant_timed" | "grant_session" | "grant_always" | "deny" | "deny_always";
  ttlMs?: number | null;
  expiresAt?: number | null;
  resolvedAt: number;
  sessionId?: string | null;
  credentialId?: string | null;
  popNonce?: string | null;
  popTimestamp?: string | null;
  device?: { ip?: string | null; userAgent?: string | null } | null;
}

export interface InboxRequest {
  id: string;
  gate: GateType | string;
  threadId: string;
  sandboxId: string | null;
  requestedBy: InboxRequestedBy;
  scope: Record<string, unknown> | null;
  reason: string | null;
  status: PermissionStatus;
  resolution: InboxResolution | null;
  createdAt: number;
  lastSeenAt: number | null;
  resolvedAt: number | null;
}

// ── Context shape ────────────────────────────────────────────────────────

export interface PermissionInboxContextValue {
  // All known requests keyed by id (both pending and recently resolved).
  byId: Map<string, InboxRequest>;
  // Pending requests scoped to a specific thread.
  byThread: (threadId: string) => InboxRequest[];
  // Total pending across all threads — drives the global unread badge.
  unreadCount: number;
  applyDelta: (request: InboxRequest) => void;
  // Mark a request as surfaced — bumps lastSeenAt to suppress toast spam.
  markSeen: (id: string) => Promise<void>;
  // Hydration and connection status (for debugging + diagnostics UI).
  status: { hydrated: boolean; lastError: string | null };
  // Force a full resync from the server (called on visibility change).
  refresh: () => Promise<void>;
}

const PermissionInboxContext =
  createContext<PermissionInboxContextValue | null>(null);

// Mount this at the dashboard root. Downstream components use
export function usePermissionInbox(): PermissionInboxContextValue {
  const ctx = useContext(PermissionInboxContext);
  if (!ctx) {
    throw new Error("usePermissionInbox must be used within PermissionInboxProvider");
  }
  return ctx;
}

export function usePermissionInboxOptional(): PermissionInboxContextValue | null {
  return useContext(PermissionInboxContext);
}

// ── Provider ─────────────────────────────────────────────────────────────

interface ProviderProps {
  // Shield base URL (e.g. `https://sbx-abc-srv.ellul.ai`). Null disables.
  serverDomain: string | null;
  children: ReactNode;
}

const RESOLVED_RETENTION_MS = 5 * 60 * 1000;
// Hard cap on in-memory request count. A buggy/hostile feed
// first, then oldest pending-seen rows, and finally log a warning if
const MAX_INBOX_SIZE = 500;

// Eviction score — lower is evicted first.
function scoreForEviction(r: InboxRequest, now: number): number {
  if (r.status !== 'pending') {
    if (r.resolvedAt && now - r.resolvedAt > RESOLVED_RETENTION_MS) return 0;
    return 1;
  }
  return r.lastSeenAt ? 2 : 3;
}

export function PermissionInboxProvider({ serverDomain, children }: ProviderProps) {
  const [byId, setById] = useState<Map<string, InboxRequest>>(() => new Map());
  const [hydrated, setHydrated] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const { send: bridgeSend, waitForReady: bridgeWaitForReady } = useVpsBridge();

  const mountedRef = useRef(true);

  // ── Mutation helpers ───────────────────────────────────────────────

  const enforceCap = useCallback((map: Map<string, InboxRequest>): Map<string, InboxRequest> => {
    if (map.size <= MAX_INBOX_SIZE) return map;
    const now = Date.now();
    const rows = Array.from(map.values());
    rows.sort((a, b) => {
      const aScore = scoreForEviction(a, now);
      const bScore = scoreForEviction(b, now);
      if (aScore !== bScore) return aScore - bScore;
      // same tier → oldest createdAt evicted first
      return a.createdAt - b.createdAt;
    });
    const toEvict = rows.slice(0, map.size - MAX_INBOX_SIZE);
    if (toEvict.some((r) => r.status === 'pending' && r.lastSeenAt === null)) {
      console.warn(`[PermissionInbox] evicting unseen pending rows — inbox over cap (${map.size})`);
    }
    const next = new Map(map);
    for (const r of toEvict) next.delete(r.id);
    return next;
  }, []);

  const mergeOne = useCallback((request: InboxRequest) => {
    setById((prev) => {
      const next = new Map(prev);
      const existing = next.get(request.id);
      // Only advance: never overwrite a newer (by resolvedAt) row with an older one.
      if (existing && existing.resolvedAt && request.resolvedAt
          && existing.resolvedAt > request.resolvedAt) {
        return prev;
      }
      next.set(request.id, request);
      return enforceCap(next);
    });
  }, [enforceCap]);

  // ── Hydration ──────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    if (!serverDomain) return;
    try {
      await bridgeWaitForReady();
      const data = await bridgeSend<{ requests?: InboxRequest[] }>(
        "permission_list_pending",
        {},
      );
      if (!mountedRef.current) return;
      const requests = Array.isArray(data.requests) ? data.requests : [];
      // Replace rather than merge on a full resync — the server's view is
      setById((prev) => {
        const next = new Map<string, InboxRequest>();
        const now = Date.now();
        for (const [id, r] of prev) {
          if (r.resolvedAt && now - r.resolvedAt < RESOLVED_RETENTION_MS) {
            next.set(id, r);
          }
        }
        for (const r of requests) next.set(r.id, r);
        return enforceCap(next);
      });
      setHydrated(true);
      setLastError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setLastError(`inbox hydration failed: ${(e as Error).message}`);
    }
  }, [serverDomain, enforceCap, bridgeSend, bridgeWaitForReady]);

  // Initial hydration + on-focus resync
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!serverDomain) return;
    void refresh();
  }, [serverDomain, refresh]);

  useEffect(() => {
    if (!serverDomain) return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onFocus = () => { void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [serverDomain, refresh]);

  // ── Periodic pruning of stale resolved rows ────────────────────────
  useEffect(() => {
    const iv = setInterval(() => {
      setById((prev) => {
        const now = Date.now();
        let changed = false;
        const next = new Map<string, InboxRequest>();
        for (const [id, r] of prev) {
          if (r.resolvedAt && now - r.resolvedAt > RESOLVED_RETENTION_MS) {
            changed = true;
            continue;
          }
          next.set(id, r);
        }
        return changed ? next : prev;
      });
    }, 60_000);
    return () => clearInterval(iv);
  }, []);

  // ── Selectors ──────────────────────────────────────────────────────
  const byThread = useCallback((threadId: string): InboxRequest[] => {
    const out: InboxRequest[] = [];
    for (const r of byId.values()) {
      if (r.threadId === threadId && r.status === "pending") out.push(r);
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  }, [byId]);

  const unreadCount = useMemo(() => {
    let n = 0;
    for (const r of byId.values()) {
      if (r.status === "pending" && r.lastSeenAt === null) n++;
    }
    return n;
  }, [byId]);

  const applyDelta = useCallback((request: InboxRequest) => {
    mergeOne(request);
  }, [mergeOne]);

  const markSeen = useCallback(async (id: string) => {
    if (!serverDomain) return;
    setById((prev) => {
      const existing = prev.get(id);
      if (!existing || existing.lastSeenAt !== null) return prev;
      const next = new Map(prev);
      next.set(id, { ...existing, lastSeenAt: Date.now() });
      return next;
    });
    try {
      await bridgeWaitForReady();
      await bridgeSend("permission_mark_seen", { id });
    } catch {
      // Non-fatal: the UI already shows the row as seen.
    }
  }, [serverDomain, bridgeSend, bridgeWaitForReady]);

  const value: PermissionInboxContextValue = useMemo(() => ({
    byId,
    byThread,
    unreadCount,
    applyDelta,
    markSeen,
    refresh,
    status: { hydrated, lastError },
  }), [byId, byThread, unreadCount, applyDelta, markSeen, refresh, hydrated, lastError]);

  return (
    <PermissionInboxContext.Provider value={value}>
      {children}
    </PermissionInboxContext.Provider>
  );
}
