// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  Plus,
  MoreVertical,
  Pencil,
  Trash2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePermissionInboxOptional } from "@/contexts/PermissionInboxContext";

export interface ThreadInfo {
  id: string;
  title: string | null;
  lastSession: string;
  updatedAt: number;
  viewScope?: string | null;
}

// Session metadata for display
const SESSION_META: Record<string, { label: string; color: string }> = {
  claw: { label: "ZeroClaw", color: "#2563EB" },
  opencode: { label: "OpenCode", color: "#B7B1B1" },
  claude: { label: "Claude", color: "#DE7356" },
  codex: { label: "Codex", color: "#38bdf8" },
  cursor: { label: "Cursor", color: "#E5E5E5" },
  main: { label: "Main", color: "rgba(245,239,230,0.6)" },
};

const THREAD_SESSIONS = [
  { id: "claw", label: "ZeroClaw", color: "#2563EB" },
  { id: "opencode", label: "OpenCode", color: "#B7B1B1" },
  { id: "claude", label: "Claude", color: "#DE7356" },
  { id: "codex", label: "Codex", color: "#38bdf8" },
  // { id: "cursor", label: "Cursor", color: "#E5E5E5" },
];

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString();
}

export type ThreadScopeMode = "scoped" | "all";

interface ThreadSidebarProps {
  threads: ThreadInfo[];
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onCreateThread: (session: string) => void;
  onDeleteThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
  // Whether the current view is inside a monorepo (enables scope toggle).
  isMonorepo?: boolean;
  // Current scope filter mode.
  scopeMode?: ThreadScopeMode;
  // Called when the user toggles between scoped and all.
  onScopeModeChange?: (mode: ThreadScopeMode) => void;
  // Short label for the current scope (e.g. "apps/web").
  scopeLabel?: string | null;
}

function ThreadItem({
  thread,
  isActive,
  onSelect,
  onDelete,
  onRename,
  showScope,
}: {
  thread: ThreadInfo;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (title: string) => void;
  showScope?: boolean;
}) {
  const tSidebar = useTranslations("console.sidebar");
  const [showMenu, setShowMenu] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(thread.title || "");

  const session = SESSION_META[thread.lastSession] || { label: thread.lastSession, color: "rgba(245,239,230,0.6)" };

  // Permission inbox: show a dot + count when this thread has pending HITL
  const inbox = usePermissionInboxOptional();
  const pendingCount = inbox ? inbox.byThread(thread.id).length : 0;
  const pendingLabel =
    pendingCount > 0
      ? tSidebar("pendingPermissionsBadge", { count: pendingCount })
      : undefined;

  const handleRename = useCallback(() => {
    if (editTitle.trim() && editTitle.trim() !== thread.title) {
      onRename(editTitle.trim());
    }
    setIsEditing(false);
  }, [editTitle, thread.title, onRename]);

  return (
    <div
      className={cn(
        "group relative flex items-center gap-2.5 px-2.5 py-2 rounded-lg cursor-pointer transition-colors",
        isActive ? "bg-cream/10 text-cream" : "text-cream/75 hover:bg-cream/5"
      )}
      onClick={onSelect}
    >
      <div
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: session.color }}
      />
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
            className="w-full bg-cream/10 border border-cream/20 rounded px-1.5 py-0.5 text-xs text-cream focus:outline-none focus:border-sodium"
            autoFocus
          />
        ) : (
          <>
            <div className="truncate text-xs font-medium">
              {thread.title || tSidebar("untitledThread")}
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-cream/45">
              <span style={{ color: session.color }}>{session.label}</span>
              <span>&middot;</span>
              <span>{formatRelativeTime(thread.updatedAt)}</span>
            </div>
            {showScope && thread.viewScope && (() => {
              const slash = thread.viewScope.indexOf("/");
              if (slash < 0) return null;
              const sub = thread.viewScope.slice(slash + 1).trim();
              if (!sub) return null;
              const parts = sub.split("/");
              const short = parts.length > 2 ? parts.slice(-2).join("/") : sub;
              return (
                <div className="mt-0.5">
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium bg-cream/5 text-cream/45 border border-cream/5">
                    {short}
                  </span>
                </div>
              );
            })()}
          </>
        )}
      </div>
      {pendingCount > 0 && (
        <span
          role="status"
          aria-label={pendingLabel}
          className="inline-flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-full text-[9px] font-semibold text-cream bg-sodium shrink-0"
          title={pendingLabel}
        >
          {pendingCount > 9 ? '9+' : pendingCount}
        </span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
        className={cn(
          "p-1 rounded hover:bg-cream/10 transition-opacity",
          showMenu || isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        )}
      >
        <MoreVertical className="w-3.5 h-3.5 text-cream/60" />
      </button>
      {showMenu && (
        <div
          className="absolute right-1 top-full mt-1 z-10 bg-card border border-cream/10 rounded-lg shadow-lg py-1 min-w-max whitespace-nowrap"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => { setIsEditing(true); setShowMenu(false); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-cream/75 hover:bg-cream/10"
          >
            <Pencil className="w-3 h-3" />
            {tSidebar("rename")}
          </button>
          <button
            onClick={() => { onDelete(); setShowMenu(false); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-terra hover:bg-cream/10"
          >
            <Trash2 className="w-3 h-3" />
            {tSidebar("delete")}
          </button>
        </div>
      )}
    </div>
  );
}

export function ThreadSidebar({
  threads,
  activeThreadId,
  onSelectThread,
  onCreateThread,
  onDeleteThread,
  onRenameThread,
  isMonorepo,
  scopeMode = "all",
  onScopeModeChange,
  scopeLabel,
}: ThreadSidebarProps) {
  const tSidebar = useTranslations("console.sidebar");
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("ellul-thread-sidebar-collapsed") === "true";
  });
  const [showNewMenu, setShowNewMenu] = useState(false);

  const handleToggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("ellul-thread-sidebar-collapsed", String(next));
  };

  if (collapsed) {
    return (
      <div className="w-10 shrink-0 flex flex-col items-center pt-2 border-r border-border bg-card/50">
        <button
          onClick={handleToggle}
          className="p-1.5 rounded-lg hover:bg-cream/10 text-cream/60 hover:text-cream transition-colors"
          title={tSidebar("expandThreadsTooltip")}
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <div className="mt-2 text-[10px] text-cream/45 writing-mode-vertical" style={{ writingMode: "vertical-rl" }}>
          {tSidebar("threadCountVertical", { count: threads.length })}
        </div>
      </div>
    );
  }

  return (
    <div className="w-[260px] shrink-0 flex flex-col border-r border-border bg-card/50 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-cream">{tSidebar("threadsHeader")}</span>
          <span className="text-[10px] text-cream/45">{threads.length}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <div className="relative">
            <button
              onClick={() => setShowNewMenu(!showNewMenu)}
              className="p-1.5 rounded-lg hover:bg-cream/10 text-cream/60 hover:text-cream transition-colors"
              title={tSidebar("newThreadTooltip")}
            >
              <Plus className="w-4 h-4" />
            </button>
            {showNewMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowNewMenu(false)} />
                <div className="absolute left-0 top-full mt-1 z-20 bg-card border border-cream/10 rounded-lg shadow-lg py-1 min-w-max whitespace-nowrap">
                  {THREAD_SESSIONS.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => { onCreateThread(s.id); setShowNewMenu(false); }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-cream/10 transition-colors"
                    >
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} />
                      <span className="text-cream/75">{s.label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            onClick={handleToggle}
            className="p-1.5 rounded-lg hover:bg-cream/10 text-cream/60 hover:text-cream transition-colors"
            title={tSidebar("collapseTooltip")}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Scope toggle — only for monorepos */}
      {isMonorepo && onScopeModeChange && (
        <div className="flex items-center gap-1 px-2.5 py-1.5 border-b border-border shrink-0">
          <div className="flex items-center gap-0.5 rounded-md border border-border overflow-hidden flex-1">
            <button
              onClick={() => onScopeModeChange("scoped")}
              className={cn(
                "flex-1 px-2 py-1 text-[10px] font-medium transition-colors truncate",
                scopeMode === "scoped"
                  ? "bg-sodium/10 text-sodium"
                  : "text-cream/45 hover:text-cream/75"
              )}
              title={
                scopeLabel
                  ? tSidebar("showThreadsFromTooltip", { scope: scopeLabel })
                  : tSidebar("showScopedThreadsTooltip")
              }
            >
              {scopeLabel || tSidebar("scopedTabDefault")}
            </button>
            <button
              onClick={() => onScopeModeChange("all")}
              className={cn(
                "flex-1 px-2 py-1 text-[10px] font-medium transition-colors",
                scopeMode === "all"
                  ? "bg-sodium/10 text-sodium"
                  : "text-cream/45 hover:text-cream/75"
              )}
            >
              {tSidebar("allTabLabel")}
            </button>
          </div>
        </div>
      )}

      {/* Thread List */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
        {threads.length === 0 ? (
          <div className="text-center py-8 text-cream/45">
            <p className="text-xs">{tSidebar("noThreadsYet")}</p>
            <p className="text-[10px] mt-1">{tSidebar("noThreadsHint")}</p>
          </div>
        ) : (
          threads.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              isActive={thread.id === activeThreadId}
              onSelect={() => onSelectThread(thread.id)}
              onDelete={() => onDeleteThread(thread.id)}
              onRename={(title) => onRenameThread(thread.id, title)}
              showScope={isMonorepo && scopeMode === "all"}
            />
          ))
        )}
      </div>
    </div>
  );
}
