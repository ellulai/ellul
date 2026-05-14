// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Code Browser SPA — pixel-perfect port of ServerCode.tsx.

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslations } from "use-intl";
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  GitBranch,
  RefreshCw,
  X,
  FileCode,
  AlertCircle,
  ChevronsUpDown,
  Search,
  Copy,
  MessageSquare,
  Wrench,
  Clock,
  MoreVertical,
} from "lucide-react";
import { Button } from "@shared/ui/button";
import { Badge } from "@shared/ui/badge";
import { useFileTree } from "./hooks/useFileTree";
import { useWebSocket } from "./hooks/useWebSocket";
import { listenForMessages, sendToParent } from "@shared/postMessage";
import { applyTheme } from "@shared/theme";
import { getFileConfig, getStatusLabel, relativeDate } from "./components/file-config";
import { CodeViewer } from "./components/CodeViewer";
import { DiffViewer } from "./components/DiffViewer";
import type { FileNode, GitChange, Tab, TabStatus, SearchResult, BlameLine, Commit } from "./types";

// File config, status labels, and relative dates imported from ./components/file-config

// ─── TreeNode (exact copy from ServerCode.tsx) ─────────────────────

interface TreeNodeProps {
  node: FileNode;
  depth: number;
  onSelect: (path: string) => void;
  selectedPath: string | null;
  modifiedFiles: Set<string>;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
}

function TreeNode({
  node,
  depth,
  onSelect,
  selectedPath,
  modifiedFiles,
  expandedPaths,
  onToggle,
}: TreeNodeProps) {
  const isModified = modifiedFiles.has(node.path);
  const isSelected = selectedPath === node.path;
  const isExpanded = expandedPaths.has(node.path);
  const fileConfig = getFileConfig(node.name);
  const FileIcon = fileConfig.icon;

  // it ever leaks through the server-side dotfile filter — platform state
  // should never appear in the user's code view.
  const sortedChildren = useMemo(() => {
    if (!node.children) return [];
    return [...node.children]
      .filter((c) => c.name !== ".zeroclaw")
      .sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === "dir" ? -1 : 1;
      });
  }, [node.children]);

  if (node.type === "file") {
    return (
      <button
        onClick={() => onSelect(node.path)}
        className={`w-full flex items-center gap-2 px-2 py-1 text-left text-[13px] hover:bg-cream/[0.06] transition-colors ${
          isSelected ? "bg-cream/[0.08] text-cream" : "text-cream/60"
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <FileIcon className={`h-4 w-4 shrink-0 ${fileConfig.color}`} />
        <span className="truncate flex-1">{node.name}</span>
        {isModified && (
          <span className="w-2 h-2 rounded-full bg-sodium shrink-0" />
        )}
      </button>
    );
  }

  return (
    <div>
      <button
        onClick={() => onToggle(node.path)}
        className="w-full flex items-center gap-1 px-2 py-1 text-left text-[13px] text-cream/75 hover:bg-cream/[0.06] transition-colors"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-cream/60" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-cream/60" />
        )}
        {isExpanded ? (
          <FolderOpen className="h-4 w-4 shrink-0 text-sodium" />
        ) : (
          <Folder className="h-4 w-4 shrink-0 text-cream/60" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {isExpanded && sortedChildren.length > 0 && (
        <div>
          {sortedChildren.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              onSelect={onSelect}
              selectedPath={selectedPath}
              modifiedFiles={modifiedFiles}
              expandedPaths={expandedPaths}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// CodeViewer and DiffViewer imported from ./components/

// ─── Main App (adapted from ServerCode component) ──────────────────

// Check if a file path exists in a tree
function findFileInTree(node: FileNode, filePath: string): boolean {
  if (node.type === "file" && node.path === filePath) return true;
  if (node.children) {
    for (const child of node.children) {
      if (findFileInTree(child, filePath)) return true;
    }
  }
  return false;
}

function getInitialApp(): string | null {
  const params = new URLSearchParams(location.search);
  return params.get("app") || null;
}

function isEmbedded(): boolean {
  const params = new URLSearchParams(location.search);
  return params.get("embedded") === "true";
}

function getInitialStudio(): boolean {
  const settings = (window as any).__SHIELD_SETTINGS__;
  return settings?.desktopViewMode === 'studio';
}

// Strip the sandbox prefix from a nested app directory for display. The
function displayAppLabel(dir: string | null): string {
  if (!dir) return "";
  const parts = dir.split("/").filter(Boolean);
  if (parts.length <= 1) return dir;
  // Drop the sandbox slug (first segment), keep everything under it.
  return parts.slice(1).join(" / ");
}

export function App() {
  const tCB = useTranslations("codeBrowser");
  const [selectedApp, setSelectedApp] = useState<string | null>(getInitialApp);
  const selectedAppName = displayAppLabel(selectedApp);
  const embedded = useMemo(() => isEmbedded(), []);
  const [studio, setStudio] = useState(getInitialStudio);
  const [mobile, setMobile] = useState(false);
  // Chrome mode: "standalone" (iframe owns its header — focus mode, mobile,
  const [chromeMode, setChromeMode] = useState<"standalone" | "embedded">("standalone");

  // ── App list ──
  const [projectList, setProjectList] = useState<string[]>([]);
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);

  // Fetch detected apps and optionally auto-select the newest one
  const refreshProjects = useCallback((autoSelectNew = false) => {
    fetch('/api/apps', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data?.apps || !Array.isArray(data.apps)) return;

        // Keep only app-level entries — sandboxes and monorepo packages are
        type ApiAppInfo = { kind?: string; directory: string };
        const apps: string[] = (data.apps as ApiAppInfo[])
          .filter(a => a.kind === 'app')
          .map(a => a.directory);
        const prev = projectList;
        setProjectList(apps);

        // it matches an app entry; otherwise pick the first app.
        if (!selectedApp && apps.length > 0) {
          const activeHint = typeof data.active === 'string' ? data.active : null;
          // app inside it; otherwise fall back to the first app.
          const fromSandbox = activeHint && !activeHint.includes('/')
            ? apps.find(d => d.startsWith(activeHint + '/'))
            : null;
          const exactMatch = activeHint ? apps.find(d => d === activeHint) : null;
          const target = exactMatch || fromSandbox || apps[0];
          setSelectedApp(target!);
          sendToParent({ type: 'project_changed', project: target! });
          return;
        }

        // Auto-switch to a newly added app (e.g. user just scaffolded or cloned)
        if (autoSelectNew && prev.length > 0) {
          const added = apps.filter(p => !prev.includes(p));
          if (added.length === 1) {
            const target = added[0]!;
            setSelectedApp(target);
            sendToParent({ type: 'project_changed', project: target });
            fetch('/api/active-project', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ project: target }),
            }).catch(() => {});
          }
        }
      })
      .catch(() => {});
  }, [selectedApp, projectList]);

  // Fetch on mount and app change
  useEffect(() => { refreshProjects(); }, [selectedApp]);

  // Close project dropdown on outside click / escape
  useEffect(() => {
    if (!showProjectDropdown) return;
    const handleClick = () => setShowProjectDropdown(false);
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowProjectDropdown(false); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [showProjectDropdown]);

  const switchProject = useCallback((slug: string) => {
    setSelectedApp(slug);
    setShowProjectDropdown(false);
    // Notify parent console
    sendToParent({ type: 'project_changed', project: slug });
    // Persist session selection
    fetch('/api/active-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ project: slug }),
    }).catch(() => {});
  }, []);

  const [view, setView] = useState<"tree" | "changes" | "search">("tree");
  const [tree, setTree] = useState<FileNode | null>(null);
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // Expanded folder paths. Default: only the virtual root (""). Real folders
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    return new Set([""]);
  });
  const [isRefreshing, setIsRefreshing] = useState(false);

  // ── Search state ──
  const [searchQuery, setSearchQuery] = useState("");
  const [searchGlob, setSearchGlob] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [scrollToLine, setScrollToLine] = useState<number | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // ── Blame state ──
  const [blameData, setBlameData] = useState<BlameLine[] | null>(null);
  const [showBlame, setShowBlame] = useState(false);
  const [historyCommits, setHistoryCommits] = useState<Commit[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  // Blame cache: keyed by tab path to avoid re-fetching on toggle
  const blameCacheRef = useRef<Map<string, BlameLine[]>>(new Map());

  // Close history dropdown on outside click / escape
  useEffect(() => {
    if (!showHistory) return;
    const handleClick = () => setShowHistory(false);
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowHistory(false); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [showHistory]);

  // ── Tab state (replaces single selectedFile/fileContent) ──
  const MAX_TABS = 10;
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const codeScrollRef = useRef<HTMLDivElement>(null);

  const activeTab = useMemo(
    () => tabs.find((t) => t.path === activeTabPath) ?? null,
    [tabs, activeTabPath],
  );
  const showFileViewer = activeTabPath !== null;

  // ── Tab helpers ──
  const openTab = useCallback(
    (filePath: string, content: string, opts?: { isDiff?: boolean; status?: TabStatus }) => {
      setTabs((prev) => {
        const existing = prev.find((t) => t.path === filePath);
        if (existing) {
          // Focus existing tab, update content and access time
          return prev.map((t) =>
            t.path === filePath
              ? { ...t, content, lastAccessed: Date.now(), status: opts?.status ?? t.status, isDiff: opts?.isDiff ?? t.isDiff }
              : t,
          );
        }
        // New tab — evict LRU if at capacity
        const language = getFileConfig(filePath.split("/").pop() || "").language;
        const newTab: Tab = {
          path: filePath,
          content,
          language,
          isDiff: opts?.isDiff ?? false,
          status: opts?.status ?? "normal",
          lastAccessed: Date.now(),
        };
        let next = [...prev, newTab];
        if (next.length > MAX_TABS) {
          // Evict least-recently-used (but not the new one)
          const sorted = [...next].sort((a, b) => a.lastAccessed - b.lastAccessed);
          const evict = sorted[0]!;
          next = next.filter((t) => t.path !== evict.path);
        }
        return next;
      });
      setActiveTabPath(filePath);
    },
    [],
  );

  const closeTab = useCallback(
    (filePath: string) => {
      setTabs((prev) => {
        const next = prev.filter((t) => t.path !== filePath);
        // If closing the active tab, switch to most recently accessed
        if (activeTabPath === filePath) {
          if (next.length > 0) {
            const sorted = [...next].sort((a, b) => b.lastAccessed - a.lastAccessed);
            setActiveTabPath(sorted[0]!.path);
          } else {
            setActiveTabPath(null);
          }
        }
        return next;
      });
    },
    [activeTabPath],
  );

  // Disambiguated tab label: basename, or parent/basename when duplicates exist
  const getTabLabel = useCallback(
    (tabPath: string) => {
      const basename = tabPath.split("/").pop() || tabPath;
      const duplicates = tabs.filter((t) => (t.path.split("/").pop() || t.path) === basename);
      if (duplicates.length > 1) {
        const parts = tabPath.split("/");
        return parts.length > 1 ? `${parts[parts.length - 2]}/${basename}` : basename;
      }
      return basename;
    },
    [tabs],
  );

  // Hooks for data fetching
  const {
    tree: fetchedTree,
    changes: fetchedChanges,
    loading,
    error: fetchError,
    fetchTree,
    fetchFile,
    fetchDiff,
    fetchSearch,
    fetchBlame,
    fetchLog,
    isRepo,
  } = useFileTree(selectedApp);

  const ws = useWebSocket(selectedApp);

  // Track tree version to trigger file content refresh
  const [treeVersion, setTreeVersion] = useState(0);

  // Track app changes to clear state
  const prevAppRef = useRef(selectedApp);

  // Clear all viewer state when project changes (tabs are project-scoped)
  useEffect(() => {
    if (prevAppRef.current !== selectedApp) {
      prevAppRef.current = selectedApp;
      setTabs([]);
      setActiveTabPath(null);
      setView("tree");
      setTree(null);
      setChanges([]);
      setError(null);
      // Clear search state on project switch
      setSearchQuery("");
      setSearchGlob("");
      setSearchResults([]);
      setSearchTruncated(false);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      // Clear blame/history
      setBlameData(null);
      setShowBlame(false);
      setHistoryCommits(null);
      setShowHistory(false);
    }
  }, [selectedApp]);

  // Update local state from fetch results. We do NOT reset `expandedPaths`
  // must keep whatever shape the user currently has open. Reset happens
  useEffect(() => {
    if (fetchedTree) {
      setTree(fetchedTree);
      setLastUpdated(new Date());
    }
  }, [fetchedTree]);

  // ── Persist expanded tree state across refreshes ─────────────────────
  // the same sandbox don't pollute each other's tree state. Restored on
  const treeStorageKey = useMemo(
    () => (selectedApp ? `code-browser:tree-expand:${selectedApp}` : null),
    [selectedApp],
  );

  // Restore on app switch — runs whenever the selected app changes OR on
  useEffect(() => {
    if (!treeStorageKey) return;
    try {
      const raw = window.localStorage.getItem(treeStorageKey);
      if (!raw) {
        setExpandedPaths(new Set([""]));
        return;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setExpandedPaths(new Set([...parsed, ""]));
      } else {
        setExpandedPaths(new Set([""]));
      }
    } catch {
      setExpandedPaths(new Set([""]));
    }
  }, [treeStorageKey]);

  // Persist on every change (debounced via microtask to avoid thrashing
  useEffect(() => {
    if (!treeStorageKey) return;
    const handle = setTimeout(() => {
      try {
        const toStore = Array.from(expandedPaths).filter((p) => p !== "");
        window.localStorage.setItem(treeStorageKey, JSON.stringify(toStore));
      } catch { /* quota / private mode — ignore */ }
    }, 100);
    return () => clearTimeout(handle);
  }, [expandedPaths, treeStorageKey]);

  useEffect(() => {
    if (fetchedChanges) {
      setChanges(fetchedChanges);
    }
  }, [fetchedChanges]);

  useEffect(() => {
    if (fetchError) {
      if (fetchError === "auth_needed") {
        setError(tCB("errors.authPrompt"));
        sendToParent({ type: "auth_needed" });
      } else {
        setError(tCB("errors.connectionFallback"));
      }
    } else {
      setError(null);
    }
  }, [fetchError, tCB]);

  // Apply WebSocket tree updates + stale detection for tabs
  useEffect(() => {
    if (ws.tree && selectedApp) {
      setTree(ws.tree);
      setLastUpdated(new Date());
      setError(null);
      setTreeVersion((v) => v + 1);

      // Mark tabs as stale when underlying files change
      setTabs((prev) => {
        if (prev.length === 0) return prev;
        return prev.map((tab) => {
          if (tab.status === "deleted") return tab; // deleted tabs never refetch
          // Check if the file still exists in the new tree
          const fileExists = findFileInTree(ws.tree!, tab.path);
          if (!fileExists) return { ...tab, status: "deleted" as TabStatus };
          // Active tab auto-refreshes; inactive tabs marked stale
          if (tab.path === activeTabPath) return tab; // will be refreshed below
          return { ...tab, status: "stale" as TabStatus };
        });
      });
    }
  }, [ws.tree, selectedApp, activeTabPath]);

  // Apply WebSocket status updates
  useEffect(() => {
    if (ws.changes.length > 0 || ws.treeVersion > 0) {
      setChanges(ws.changes);
      setLastUpdated(new Date());
    }
  }, [ws.changes, ws.treeVersion]);

  // Refetch on WebSocket reconnection
  const wasConnectedRef = useRef(false);
  useEffect(() => {
    if (ws.connected && !wasConnectedRef.current && selectedApp) {
      fetchTree();
    }
    wasConnectedRef.current = ws.connected;
  }, [ws.connected, selectedApp, fetchTree]);

  // Re-fetch project list when WebSocket detects folder changes (clone, mkdir, rm)
  useEffect(() => {
    if (ws.projectsChanged > 0) {
      refreshProjects(true);
    }
  }, [ws.projectsChanged]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load active tab content when it changes or when files change (AI edits)
  useEffect(() => {
    if (!activeTabPath || !selectedApp) return;
    const tab = tabs.find((t) => t.path === activeTabPath);
    if (!tab || tab.status === "deleted") return;
    // Auto-refresh active tab on tree version bump (preserves scroll via ref)
    const scrollTop = codeScrollRef.current?.scrollTop ?? 0;
    if (tab.isDiff) return; // diff tabs handled separately
    fetchFile(activeTabPath).then((content) => {
      if (content !== null) {
        setTabs((prev) =>
          prev.map((t) =>
            t.path === activeTabPath ? { ...t, content, status: "normal" as TabStatus } : t,
          ),
        );
        // Restore scroll position after content update
        requestAnimationFrame(() => {
          if (codeScrollRef.current) codeScrollRef.current.scrollTop = scrollTop;
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabPath, selectedApp, fetchFile, treeVersion]);

  // Refresh stale tabs when they become active
  const handleTabFocus = useCallback(
    (tabPath: string) => {
      setActiveTabPath(tabPath);
      setTabs((prev) =>
        prev.map((t) => (t.path === tabPath ? { ...t, lastAccessed: Date.now() } : t)),
      );
      const tab = tabs.find((t) => t.path === tabPath);
      if (!tab || tab.status !== "stale" || !selectedApp) return;
      if (tab.isDiff) {
        // Diff tabs: will be refetched when fetchDiff is wired (Phase 4)
        return;
      }
      fetchFile(tabPath).then((content) => {
        if (content !== null) {
          setTabs((prev) =>
            prev.map((t) =>
              t.path === tabPath ? { ...t, content, status: "normal" as TabStatus } : t,
            ),
          );
        }
      });
    },
    [tabs, selectedApp, fetchFile],
  );

  // Open a file from the tree (non-diff)
  const openFileTab = useCallback(
    async (filePath: string) => {
      // If tab already exists, just focus it
      const existing = tabs.find((t) => t.path === filePath);
      if (existing) {
        handleTabFocus(filePath);
        return;
      }
      // Fetch content and open new tab
      if (!selectedApp) return;
      const content = await fetchFile(filePath);
      openTab(filePath, content ?? "// Error loading file");
    },
    [tabs, selectedApp, fetchFile, openTab, handleTabFocus],
  );

  // Open a changed file — uses diff for tracked files, full content for untracked
  const openChangeTab = useCallback(
    async (change: GitChange) => {
      // If already open, focus it
      const existing = tabs.find((t) => t.path === change.file);
      if (existing) {
        handleTabFocus(change.file);
        return;
      }
      if (!selectedApp) return;

      if (change.status === "??") {
        // Untracked: show full content
        const content = await fetchFile(change.file);
        openTab(change.file, content ?? "// Error loading file");
        return;
      }

      // Tracked changes: fetch diff
      const diff = await fetchDiff(change.file, change.status);
      const tabStatus: TabStatus = change.status === "D" ? "deleted" : "diff";
      if (diff !== null) {
        openTab(change.file, diff, { isDiff: true, status: tabStatus });
      } else {
        // Fallback to full content if diff fails
        const content = await fetchFile(change.file);
        openTab(change.file, content ?? "// Error loading file");
      }
    },
    [tabs, selectedApp, fetchFile, fetchDiff, openTab, handleTabFocus],
  );

  // Ref for glob to avoid stale closure in debounced search
  const searchGlobRef = useRef(searchGlob);
  searchGlobRef.current = searchGlob;

  // Debounced search handler
  const handleSearchInput = useCallback(
    (value: string) => {
      setSearchQuery(value);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      if (!value.trim()) {
        setSearchResults([]);
        setSearchTruncated(false);
        return;
      }
      searchTimerRef.current = setTimeout(async () => {
        setIsSearching(true);
        const result = await fetchSearch(value, searchGlobRef.current || undefined);
        if (result) {
          setSearchResults(result.results);
          setSearchTruncated(result.truncated);
        } else {
          setSearchResults([]);
        }
        setIsSearching(false);
      }, 300);
    },
    [fetchSearch],
  );

  // Open search result — opens file and scrolls to line
  const openSearchResult = useCallback(
    async (result: SearchResult) => {
      await openFileTab(result.file);
      setScrollToLine(result.line);
    },
    [openFileTab],
  );

  // Scroll-to-line effect (approximate for Prism-rendered code)
  useEffect(() => {
    if (scrollToLine === null || !codeScrollRef.current) return;
    const lineHeight = 20; // leading-5 = 1.25rem = 20px
    codeScrollRef.current.scrollTop = (scrollToLine - 1) * lineHeight;
    setScrollToLine(null);
  }, [scrollToLine, activeTabPath]);

  // ── Toast state for transient feedback ──
  const [toast, setToast] = useState<string | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Toggle blame annotations (cached per tab path)
  const toggleBlame = useCallback(async () => {
    if (showBlame) {
      setShowBlame(false);
      return;
    }
    if (!activeTabPath || !selectedApp) return;
    // Check cache first
    const cached = blameCacheRef.current.get(activeTabPath);
    if (cached) {
      setBlameData(cached);
      setShowBlame(true);
      return;
    }
    const data = await fetchBlame(activeTabPath);
    if (data && data.length > 0) {
      blameCacheRef.current.set(activeTabPath, data);
      setBlameData(data);
      setShowBlame(true);
    } else {
      showToast(tCB("toasts.blameFailed"));
    }
  }, [showBlame, activeTabPath, selectedApp, fetchBlame, showToast, tCB]);

  // Fetch and show history dropdown
  const toggleHistory = useCallback(async () => {
    if (showHistory) {
      setShowHistory(false);
      return;
    }
    if (!activeTabPath || !selectedApp) return;
    const commits = await fetchLog(activeTabPath);
    if (commits) {
      setHistoryCommits(commits);
      setShowHistory(true);
    } else {
      showToast(tCB("toasts.historyFailed"));
    }
  }, [showHistory, activeTabPath, selectedApp, fetchLog, showToast, tCB]);

  // Open a commit diff from history
  const openCommitDiff = useCallback(
    async (commit: Commit) => {
      if (!activeTabPath || !selectedApp) return;
      setShowHistory(false);
      try {
        const params = new URLSearchParams({
          path: activeTabPath,
          project: selectedApp,
          status: 'M',
          sha: commit.sha,
        });
        const res = await fetch(`/api/diff?${params}`, { credentials: 'include' });
        if (res.ok) {
          const content = await res.text();
          openTab(
            `${activeTabPath}@${commit.sha.slice(0, 7)}`,
            content || 'Path not present in selected commit',
            { isDiff: true, status: 'diff' },
          );
        }
      } catch {}
    },
    [activeTabPath, selectedApp, openTab],
  );

  // Copy text to clipboard with toast fallback
  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      showToast(tCB("toasts.copyFailed"));
    }
  }, [showToast, tCB]);

  // ── Selection action bar state ──
  const [selectionBar, setSelectionBar] = useState<{ top: number; left: number; text: string; startLine?: number; endLine?: number } | null>(null);

  // Detect text selection in code viewer
  useEffect(() => {
    const handleSelectionChange = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        setSelectionBar(null);
        return;
      }
      // Check if selection is within the code scroll area
      const range = sel.getRangeAt(0);
      const container = codeScrollRef.current;
      if (!container || !container.contains(range.commonAncestorContainer)) {
        setSelectionBar(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) { setSelectionBar(null); return; }

      // Get line range from data-line attributes (robust — not dependent on CSS classes)
      let startLine: number | undefined;
      let endLine: number | undefined;
      try {
        const findLineRow = (node: Node | null): Element | null => {
          if (!node) return null;
          const el = node instanceof Element ? node : node.parentElement;
          return el?.closest('[data-line]') ?? null;
        };
        const anchorRow = findLineRow(sel.anchorNode);
        const focusRow = findLineRow(sel.focusNode);
        if (anchorRow) startLine = parseInt(anchorRow.getAttribute('data-line') || '', 10) || undefined;
        if (focusRow) endLine = parseInt(focusRow.getAttribute('data-line') || '', 10) || undefined;
        // Normalize direction
        if (startLine && endLine && startLine > endLine) [startLine, endLine] = [endLine, startLine];
      } catch {}

      const rect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setSelectionBar({
        top: rect.top - containerRect.top - 32,
        left: Math.min(rect.left - containerRect.left + rect.width / 2, containerRect.width - 100),
        text,
        startLine,
        endLine,
      });
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, []);

  // Send context to chat via postMessage
  const askAi = useCallback(
    (opts: { file: string; line?: number; endLine?: number; snippet?: string; commit?: string; context: "full_file" | "selection" | "search_result" | "blame" | "diff" }) => {
      sendToParent({ type: "ask_ai", ...opts });
    },
    [],
  );

  const fixRequest = useCallback(
    (opts: { file: string; line?: number; snippet?: string; diff?: string; context: "diff" | "search_result" | "selection" | "full_file" }) => {
      sendToParent({ type: "fix_request", ...opts });
    },
    [],
  );

  // hasGit derived from /api/status response (tree filters dotfiles, can't check there)
  const hasGit = isRepo;

  // Clear blame/history when switching tabs
  useEffect(() => {
    setShowBlame(false);
    setBlameData(null);
    setShowHistory(false);
    setHistoryCommits(null);
  }, [activeTabPath]);

  // Invalidate blame cache when tree changes (file was modified externally)
  useEffect(() => {
    blameCacheRef.current.clear();
  }, [treeVersion]);

  // Navigate to a folder path — scopes into it from the file viewer breadcrumbs
  const expandToPath = useCallback(
    (folderPath: string) => {
      const parts = folderPath.split("/");
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        next.add(""); // root
        let current = "";
        for (const part of parts) {
          current = current ? `${current}/${part}` : part;
          next.add(current);
        }
        return next;
      });
      if ((embedded && studio) || mobile) {
        setView("tree");
      }
    },
    [embedded, studio, mobile],
  );

  // Listen for postMessage from parent dashboard
  useEffect(() => {
    const cleanup = listenForMessages((msg) => {
      switch (msg.type) {
        case "set_app":
          setSelectedApp(msg.app);
          break;
        case "set_theme":
          applyTheme(msg.mode);
          break;
        case "auth_complete":
          setError(null);
          fetchTree();
          break;
        case "set_view":
          setView(msg.view);
          break;
        case "refresh":
          handleRefresh();
          break;
        case "set_view_mode":
          setStudio(msg.mode === 'studio');
          setMobile(!!msg.mobile);
          break;
        case "set_chrome_mode":
          setChromeMode(msg.mode);
          break;
      }
    });
    sendToParent({ type: "ready" });
    if (embedded) {
      sendToParent({
        type: "state_update",
        view,
        changesCount: changes.length,
        loading,
      });
    }
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Emit state_update to parent when view, changes count, or loading changes
  useEffect(() => {
    if (embedded) {
      sendToParent({
        type: "state_update",
        view,
        changesCount: changes.length,
        loading,
      });
    }
  }, [embedded, view, changes.length, loading]);

  // Emit project list to parent so the console's column toolbar can render
  useEffect(() => {
    if (embedded) {
      sendToParent({
        type: "project_list",
        apps: projectList,
        active: selectedApp,
      });
    }
  }, [embedded, projectList, selectedApp]);

  // Toggle folder expansion
  const handleToggle = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const currentLanguage = useMemo(() => {
    if (!activeTab) return "text";
    return activeTab.language;
  }, [activeTab]);

  const modifiedFiles = new Set(changes.map((c) => c.file));

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await fetchTree();
      setLastUpdated(new Date());
    } finally {
      setIsRefreshing(false);
    }
  };

  // Determine loading state
  const isLoading = loading;

  // In studio embedded mode, always use compact layout (full-width swap between
  const forceCompact = embedded && studio;
  const isAuthError =
    error?.includes("Authentication") || error?.includes("re-authenticate");

  return (
    <div
      className={`h-full flex flex-col min-h-0 relative ${!embedded ? "panel-ascente" : ""}`}
    >
      {/* Toast notification */}
      {toast && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 px-3 py-1.5 rounded-lg bg-card border border-cream/[0.1] text-xs text-cream/75 shadow-xl animate-in fade-in slide-in-from-bottom-2">
          {toast}
        </div>
      )}

      {/* Connection error (non-auth) */}
      {error && !isAuthError && (
        <div className="absolute inset-0 bg-card/95 flex items-center justify-center z-20">
          <div className="text-center max-w-sm p-6">
            <div className="w-16 h-16 rounded-2xl bg-terra/10 border border-terra/20 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="h-8 w-8 text-terra" />
            </div>
            <h3 className="text-base font-medium text-cream/85 mb-2">
              {tCB("errors.connectionTitle")}
            </h3>
            <p className="text-sm text-cream/60 leading-relaxed mb-6">
              {error}
            </p>
            <Button
              onClick={handleRefresh}
              variant="outline"
              className="border-border hover:bg-secondary/50"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              {tCB("errors.retry")}
            </Button>
          </div>
        </div>
      )}

      {/* Auth error overlay */}
      {error && isAuthError && (
        <div className="absolute inset-0 bg-card/95 flex items-center justify-center z-20">
          <div className="text-center max-w-sm p-6">
            <div className="w-16 h-16 rounded-2xl bg-sodium/10 border border-sodium/20 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="h-8 w-8 text-sodium" />
            </div>
            <h3 className="text-base font-medium text-cream/85 mb-2">
              {tCB("errors.authTitle")}
            </h3>
            <p className="text-sm text-cream/60 leading-relaxed mb-6">
              {tCB("errors.authBody")}
            </p>
          </div>
        </div>
      )}

      {/* Main content */}
      <div
        className={`flex-1 flex flex-col min-h-0 ${error ? "opacity-50 pointer-events-none" : ""}`}
      >
        {/* Header — hidden when embedded (console owns the header) */}
        {!embedded && (
          <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border bg-card/50">
            <div className="flex items-center gap-2 min-w-0">
              <FileCode className="h-4 w-4 text-sodium shrink-0" />
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {/* View Toggle — icon-only */}
              <div className="flex rounded-md border border-border overflow-hidden">
                <button
                  onClick={() => setView("tree")}
                  className={`px-2 py-1 text-xs font-medium transition-colors flex items-center gap-1.5 ${
                    view === "tree"
                      ? "bg-cream/[0.08] text-cream"
                      : "text-cream/60 hover:text-cream/75"
                  }`}
                >
                  <Folder className="h-3 w-3" />
                </button>
                <button
                  onClick={() => setView("changes")}
                  className={`px-2 py-1 text-xs font-medium transition-colors flex items-center gap-1.5 ${
                    view === "changes"
                      ? "bg-cream/[0.08] text-cream"
                      : "text-cream/60 hover:text-cream/75"
                  }`}
                >
                  <GitBranch className="h-3 w-3" />
                  {changes.length > 0 && (
                    <Badge
                      variant="outline"
                      className="h-4 px-1 text-[10px] border-sodium/30 bg-sodium/10 text-sodium"
                    >
                      {changes.length}
                    </Badge>
                  )}
                </button>
              </div>

              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-cream/60 hover:text-cream"
                onClick={handleRefresh}
                disabled={!selectedApp || isRefreshing}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${isLoading || isRefreshing ? "animate-spin" : ""}`}
                />
              </Button>
            </div>
          </div>
        )}

        {/* Main Content */}
        <div className="flex-1 flex min-h-0 relative">
          {/* File Tree / Changes List */}
          <div
            className={`${
              forceCompact
                ? (showFileViewer ? "hidden" : "flex")
                : (showFileViewer ? "hidden md:flex" : "flex")
            } flex-col ${forceCompact ? "w-full" : "w-full md:w-64 lg:w-72 md:shrink-0"} border-r border-border bg-card/30 min-h-0`}
          >
            {/* Header bar — project switcher + view toggle + refresh. Hidden
                when the parent owns chrome (studio mode): the console renders
                these controls in its column toolbar and drives the iframe via
                set_app / set_view / refresh postMessages. */}
            {embedded && selectedApp && chromeMode === "standalone" && (
              <div className="shrink-0 flex items-center justify-between gap-1.5 px-3 py-2 bg-card border-b border-border">
                {/* Left: project switcher */}
                <div className="flex items-center min-w-0 relative">
                  <button
                    onClick={() => projectList.length > 1 && setShowProjectDropdown((v) => !v)}
                    className={`flex items-center gap-1.5 text-[13px] font-medium text-cream/85 hover:text-cream truncate max-w-[180px] transition-colors ${
                      projectList.length > 1 ? "cursor-pointer" : "cursor-default"
                    }`}
                    title={selectedApp || ''}
                  >
                    <Folder className="h-3.5 w-3.5 text-sodium shrink-0" />
                    <span className="truncate">{selectedAppName}</span>
                    {projectList.length > 1 && (
                      <ChevronsUpDown className="h-3 w-3 text-cream/45 shrink-0" />
                    )}
                  </button>

                  {/* Project switcher dropdown */}
                  {showProjectDropdown && projectList.length > 1 && (
                    <div className="absolute left-0 top-full mt-1 min-w-[180px] bg-card border border-cream/[0.08] rounded-lg shadow-2xl z-50 py-1 backdrop-blur-xl">
                      {projectList.map((slug) => (
                        <button
                          key={slug}
                          onClick={() => switchProject(slug)}
                          className={`w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left hover:bg-cream/[0.06] transition-colors ${
                            slug === selectedApp ? "text-cream font-medium" : "text-cream/60"
                          }`}
                          title={slug}
                        >
                          <Folder className={`h-3.5 w-3.5 shrink-0 ${slug === selectedApp ? "text-sodium" : ""}`} />
                          <span className="truncate">{displayAppLabel(slug)}</span>
                          {slug === selectedApp && (
                            <span className="w-1.5 h-1.5 rounded-full bg-sodium ml-auto shrink-0" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Right: view toggle + refresh */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <div className="flex rounded-lg overflow-hidden border border-cream/[0.06]">
                    <button
                      onClick={() => setView("tree")}
                      className={`px-2.5 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5 ${
                        view === "tree" ? "bg-cream/[0.08] text-cream" : "text-cream/60 hover:text-cream/75"
                      }`}
                    >
                      <Folder className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => setView("changes")}
                      className={`px-2.5 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5 ${
                        view === "changes" ? "bg-cream/[0.08] text-cream" : "text-cream/60 hover:text-cream/75"
                      }`}
                    >
                      <GitBranch className="h-3 w-3" />
                      {changes.length > 0 && (
                        <span className="h-4 px-1 text-[10px] rounded border border-sodium/30 bg-sodium/10 text-sodium font-medium leading-4">
                          {changes.length}
                        </span>
                      )}
                    </button>
                    <button
                      onClick={() => setView("search")}
                      className={`px-2.5 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5 ${
                        view === "search" ? "bg-cream/[0.08] text-cream" : "text-cream/60 hover:text-cream/75"
                      }`}
                    >
                      <Search className="h-3 w-3" />
                    </button>
                  </div>
                  <button
                    className="h-7 w-7 flex items-center justify-center rounded-lg border border-cream/[0.06] text-cream/60 hover:text-cream hover:bg-cream/[0.06] transition-colors disabled:opacity-40"
                    onClick={handleRefresh}
                    disabled={!selectedApp || isRefreshing}
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${isLoading || isRefreshing ? "animate-spin" : ""}`} />
                  </button>
                </div>
              </div>
            )}
            {/* Empty state — no folders yet */}
            {!selectedApp && !isLoading ? (
              <div className="flex-1 flex items-center justify-center p-6">
                <div className="text-center">
                  <div className="w-12 h-12 rounded-xl bg-cream/[0.04] border border-cream/[0.06] flex items-center justify-center mx-auto mb-3">
                    <Folder className="h-6 w-6 text-cream/35" />
                  </div>
                  <p className="text-sm text-cream/60 mb-1">{tCB("emptyStates.noFolders")}</p>
                  <p className="text-xs text-cream/35">{tCB("emptyStates.noFoldersHint")}</p>
                </div>
              </div>
            ) : isLoading ? (
              <div className="flex items-center justify-center h-32">
                <RefreshCw className="h-5 w-5 text-cream/45 animate-spin" />
              </div>
            ) : view === "tree" && tree ? (
              <div className={`flex-1 overflow-y-auto min-h-0 ${embedded ? "pb-1" : "py-1"}`}>
                {tree.children
                  ?.slice()
                  .sort((a, b) => {
                    if (a.type === b.type) return a.name.localeCompare(b.name);
                    return a.type === "dir" ? -1 : 1;
                  })
                  .map((node) => (
                    <TreeNode
                      key={node.path}
                      node={node}
                      depth={0}
                      onSelect={openFileTab}
                      selectedPath={activeTabPath}
                      modifiedFiles={modifiedFiles}
                      expandedPaths={expandedPaths}
                      onToggle={handleToggle}
                    />
                  ))}
              </div>
            ) : view === "changes" ? (
              <div className={`flex-1 overflow-y-auto min-h-0 ${embedded ? "pb-1" : "py-1"}`}>
                {changes.length === 0 ? (
                  <div className="text-center py-8 text-cream/45 text-sm">
                    {tCB("changes.noUncommitted")}
                  </div>
                ) : (
                  changes.map((change) => {
                    const statusInfo = getStatusLabel(change.status);
                    const fileConfig = getFileConfig(
                      change.file.split("/").pop() || "",
                    );
                    const FileIcon = fileConfig.icon;
                    return (
                      <button
                        key={change.file}
                        onClick={() => openChangeTab(change)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-cream/[0.06] ${
                          activeTabPath === change.file ? "bg-cream/[0.08]" : ""
                        }`}
                      >
                        <span
                          className={`text-[10px] font-mono font-bold ${statusInfo.color}`}
                        >
                          {change.status.padEnd(2)}
                        </span>
                        <FileIcon
                          className={`h-4 w-4 shrink-0 ${fileConfig.color}`}
                        />
                        <span className="truncate text-cream/60">
                          {change.file}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            ) : view === "search" ? (
              <div className="flex-1 flex flex-col min-h-0">
                {/* Search input */}
                <div className="shrink-0 px-3 py-2 border-b border-border">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => handleSearchInput(e.target.value)}
                    placeholder={tCB("search.placeholder")}
                    className="w-full bg-transparent text-sm text-cream placeholder-cream/40 focus:outline-none"
                    autoFocus
                  />
                  <input
                    type="text"
                    value={searchGlob}
                    onChange={(e) => { setSearchGlob(e.target.value); if (searchQuery) handleSearchInput(searchQuery); }}
                    placeholder={tCB("search.globPlaceholder")}
                    className="w-full bg-transparent text-[11px] text-cream/60 placeholder-cream/40 focus:outline-none mt-1"
                  />
                </div>
                {/* Search results */}
                <div className="flex-1 overflow-y-auto">
                  {isSearching ? (
                    <div className="flex items-center justify-center h-20">
                      <RefreshCw className="h-4 w-4 text-cream/45 animate-spin" />
                    </div>
                  ) : searchResults.length === 0 && searchQuery.trim() ? (
                    <div className="text-center py-8 text-cream/45 text-sm">
                      {tCB("search.noResults")}
                    </div>
                  ) : (
                    (() => {
                      // Group results by file
                      const grouped = new Map<string, SearchResult[]>();
                      for (const r of searchResults) {
                        const arr = grouped.get(r.file) || [];
                        arr.push(r);
                        grouped.set(r.file, arr);
                      }
                      return Array.from(grouped.entries()).map(([file, results]) => (
                        <div key={file}>
                          <div className="px-3 py-1 text-[11px] text-cream/75 bg-cream/[0.02] border-b border-cream/[0.04] flex items-center gap-1.5">
                            <FileCode className="h-3 w-3 shrink-0" />
                            <span className="truncate">{file}</span>
                            <span className="text-cream/45 shrink-0">({results.length})</span>
                          </div>
                          {results.map((r, i) => {
                            // Highlight the match
                            const lowerContent = r.content.toLowerCase();
                            const lowerQuery = searchQuery.toLowerCase();
                            const matchIdx = lowerContent.indexOf(lowerQuery);
                            return (
                              <button
                                key={`${r.line}-${i}`}
                                onClick={() => openSearchResult(r)}
                                className="w-full flex items-start gap-2 px-3 py-1 text-left text-[12px] hover:bg-cream/[0.06] transition-colors"
                              >
                                <span className="text-cream/45 text-[11px] font-mono shrink-0 w-8 text-right">{r.line}</span>
                                <span className="truncate text-cream/60">
                                  {matchIdx >= 0 ? (
                                    <>
                                      {r.content.slice(0, matchIdx)}
                                      <mark className="bg-sodium/30 text-sodium">{r.content.slice(matchIdx, matchIdx + searchQuery.length)}</mark>
                                      {r.content.slice(matchIdx + searchQuery.length)}
                                    </>
                                  ) : r.content}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      ));
                    })()
                  )}
                  {searchTruncated && (
                    <div className="px-3 py-2 text-[11px] text-cream/45 text-center">
                      {tCB("search.truncated")}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          {/* File Viewer — tab-based */}
          <div
            className={`${
              forceCompact
                ? (showFileViewer ? "flex" : "hidden")
                : (showFileViewer ? "flex" : "hidden md:flex")
            } flex-1 flex-col min-w-0 bg-card`}
          >
            {tabs.length > 0 ? (
              <div className="relative flex-1 flex flex-col min-h-0">
                {/* Tab bar */}
                <div className="shrink-0 flex items-center bg-card border-b border-border py-1 px-1">
                  {/* Back to tree (compact/mobile) */}
                  {(forceCompact || mobile) && (
                    <button
                      className="h-6 w-6 flex items-center justify-center rounded text-cream/60 hover:text-cream shrink-0 mr-1"
                      onClick={() => setActiveTabPath(null)}
                    >
                      <ChevronRight className="h-3.5 w-3.5 rotate-180" />
                    </button>
                  )}

                  {/* Scrollable tab strip */}
                  <div className="flex-1 flex items-center gap-0.5 overflow-x-auto scrollbar-none min-w-0">
                    {tabs.map((tab) => {
                      const isActive = tab.path === activeTabPath;
                      const config = getFileConfig(tab.path.split("/").pop() || "");
                      const TabIcon = config.icon;
                      const label = getTabLabel(tab.path);
                      return (
                        <button
                          key={tab.path}
                          onClick={() => handleTabFocus(tab.path)}
                          className={`group flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] whitespace-nowrap transition-colors shrink-0 ${
                            isActive
                              ? "bg-cream/[0.08] text-cream"
                              : "text-cream/60 hover:text-cream/75 hover:bg-cream/[0.04]"
                          } ${tab.status === "deleted" ? "line-through opacity-60" : ""}`}
                          title={tab.path}
                        >
                          <TabIcon className={`h-3 w-3 shrink-0 ${config.color}`} />
                          <span className={`truncate ${mobile ? "max-w-[80px]" : "max-w-[120px]"}`}>
                            {label}
                          </span>
                          {/* Status badge */}
                          {tab.status === "stale" && (
                            <span className="w-1.5 h-1.5 rounded-full bg-sodium shrink-0" />
                          )}
                          {tab.status === "diff" && (
                            <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                          )}
                          {tab.status === "deleted" && (
                            <span className="w-1.5 h-1.5 rounded-full bg-terra shrink-0" />
                          )}
                          {/* Close button */}
                          <span
                            role="button"
                            onClick={(e) => { e.stopPropagation(); closeTab(tab.path); }}
                            className="h-4 w-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-cream/[0.1] transition-opacity shrink-0"
                          >
                            <X className="h-2.5 w-2.5" />
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Overflow indicator on mobile */}
                  {mobile && tabs.length > 4 && (
                    <div className="absolute right-0 top-0 bottom-0 w-6 bg-gradient-to-l from-card to-transparent pointer-events-none" />
                  )}
                </div>

                {/* Breadcrumbs + actions — hidden on mobile/compact */}
                {activeTab && !forceCompact && !mobile && (
                  <div className="shrink-0 flex items-center justify-between px-3 py-1 border-b border-border text-[11px]">
                    {/* Left: breadcrumbs */}
                    <div className="flex items-center gap-0.5 overflow-x-auto scrollbar-none min-w-0">
                      {activeTab.path.split("/").map((segment, i, arr) => {
                        const isLast = i === arr.length - 1;
                        const folderPath = arr.slice(0, i + 1).join("/");
                        return (
                          <span key={folderPath} className="flex items-center gap-0.5 shrink-0">
                            {i > 0 && <ChevronRight className="h-2.5 w-2.5 text-cream/35 shrink-0" />}
                            {isLast ? (
                              <span className="text-cream truncate max-w-[120px]">{segment}</span>
                            ) : (
                              <button
                                onClick={() => expandToPath(folderPath)}
                                className="text-cream/60 hover:text-cream/85 hover:bg-cream/[0.06] px-1 py-0.5 rounded transition-colors truncate max-w-[120px]"
                              >
                                {segment}
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </div>

                    {/* Right: copy path + blame + history */}
                    <div className="flex items-center gap-1 shrink-0 ml-2 relative">
                      {/* Copy path */}
                      <button
                        onClick={() => copyToClipboard(activeTab.path)}
                        className="h-5 w-5 flex items-center justify-center rounded text-cream/45 hover:text-cream/75 hover:bg-cream/[0.06] transition-colors"
                        title={tCB("tooltips.copyPath")}
                      >
                        <Copy className="h-3 w-3" />
                      </button>

                      {/* Blame toggle — only for normal file tabs in git repos */}
                      {hasGit && !activeTab.isDiff && (
                        <button
                          onClick={toggleBlame}
                          className={`h-5 w-5 flex items-center justify-center rounded transition-colors ${
                            showBlame ? "text-sodium bg-sodium/10" : "text-cream/45 hover:text-cream/75 hover:bg-cream/[0.06]"
                          }`}
                          title={showBlame ? tCB("tooltips.hideBlame") : tCB("tooltips.showBlame")}
                        >
                          <MoreVertical className="h-3 w-3" />
                        </button>
                      )}

                      {/* History — only for normal file tabs in git repos */}
                      {hasGit && !activeTab.isDiff && (
                        <button
                          onClick={toggleHistory}
                          className={`h-5 w-5 flex items-center justify-center rounded transition-colors ${
                            showHistory ? "text-sodium bg-sodium/10" : "text-cream/45 hover:text-cream/75 hover:bg-cream/[0.06]"
                          }`}
                          title={tCB("tooltips.fileHistory")}
                        >
                          <Clock className="h-3 w-3" />
                        </button>
                      )}

                      {/* History dropdown */}
                      {showHistory && historyCommits && (
                        <div className="absolute right-0 top-full mt-1 min-w-[280px] max-h-[300px] overflow-y-auto bg-card border border-cream/[0.08] rounded-lg shadow-2xl z-50 py-1 backdrop-blur-xl">
                          {historyCommits.length === 0 ? (
                            <div className="px-3 py-2 text-[11px] text-cream/45">{tCB("emptyStates.noCommits")}</div>
                          ) : (
                            historyCommits.map((commit) => (
                              <button
                                key={commit.sha}
                                onClick={() => openCommitDiff(commit)}
                                className="w-full flex items-start gap-2 px-3 py-1.5 text-left hover:bg-cream/[0.06] transition-colors"
                              >
                                <span className="text-[10px] font-mono text-sodium shrink-0">{commit.sha.slice(0, 7)}</span>
                                <div className="min-w-0">
                                  <div className="text-[11px] text-cream/75 truncate">{commit.message}</div>
                                  <div className="text-[10px] text-cream/45">{commit.author} · {relativeDate(commit.date)}</div>
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Active tab content */}
                {activeTab ? (
                  <>
                    {/* Deleted file banner */}
                    {activeTab.status === "deleted" && (
                      <div className="shrink-0 px-3 py-1.5 bg-terra/10 border-b border-terra/20 text-terra text-xs flex items-center gap-2">
                        <AlertCircle className="h-3 w-3" />
                        {tCB("file.deletedBanner")}
                      </div>
                    )}

                    {/* Diff tab actions: "Fix this" */}
                    {activeTab.isDiff && (
                      <div className="shrink-0 flex items-center gap-2 px-3 py-1 border-b border-border">
                        <button
                          onClick={() => fixRequest({ file: activeTab.path, diff: activeTab.content, context: "diff" })}
                          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-sodium hover:bg-sodium/10 border border-sodium/20 transition-colors"
                        >
                          <Wrench className="h-3 w-3" />
                          {tCB("file.fixThis")}
                        </button>
                        <button
                          onClick={() => askAi({ file: activeTab.path, context: "diff", snippet: activeTab.content.slice(0, 2000) })}
                          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] text-cream/60 hover:text-cream/75 hover:bg-cream/[0.06] transition-colors"
                        >
                          <MessageSquare className="h-3 w-3" />
                          {tCB("file.askAi")}
                        </button>
                      </div>
                    )}

                    <div ref={codeScrollRef} className="flex-1 overflow-auto bg-[#011627] relative">
                      {activeTab.content ? (
                        activeTab.isDiff ? (
                          <DiffViewer diff={activeTab.content} />
                        ) : (
                          <CodeViewer code={activeTab.content} language={currentLanguage} blameData={showBlame ? blameData : null} />
                        )
                      ) : (
                        <div className="flex items-center justify-center h-32">
                          <RefreshCw className="h-5 w-5 text-cream/45 animate-spin" />
                        </div>
                      )}

                      {/* Selection action bar — floats over code */}
                      {selectionBar && activeTabPath && (
                        <div
                          className="absolute z-50 flex items-center gap-0.5 rounded-lg bg-card border border-cream/[0.1] shadow-xl px-1 py-0.5"
                          style={{ top: Math.max(0, selectionBar.top), left: Math.max(8, selectionBar.left) }}
                        >
                          <button
                            onClick={() => { copyToClipboard(selectionBar.text); setSelectionBar(null); }}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-cream/75 hover:bg-cream/[0.06] transition-colors"
                            title={tCB("tooltips.copySelection")}
                          >
                            <Copy className="h-3 w-3" />
                            {tCB("file.copy")}
                          </button>
                          <button
                            onClick={() => {
                              askAi({
                                file: activeTabPath,
                                line: selectionBar.startLine,
                                endLine: selectionBar.endLine,
                                snippet: selectionBar.text.slice(0, 2000),
                                context: "selection",
                              });
                              setSelectionBar(null);
                            }}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-sodium hover:bg-sodium/10 transition-colors"
                            title={tCB("tooltips.askAiSelection")}
                          >
                            <MessageSquare className="h-3 w-3" />
                            {tCB("file.askAi")}
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex-1 flex items-center justify-center text-cream/45 text-sm bg-card/20">
                    <p>{tCB("emptyStates.selectTab")}</p>
                  </div>
                )}
              </div>
            ) : (
              <div className={`${forceCompact ? "hidden" : "hidden md:flex"} flex-1 items-center justify-center text-cream/45 text-sm bg-card/20`}>
                <div className="text-center">
                  <FileCode className="h-12 w-12 mx-auto mb-3 text-cream/35" />
                  <p>{selectedApp ? tCB("emptyStates.selectFile") : tCB("emptyStates.noFolders")}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
