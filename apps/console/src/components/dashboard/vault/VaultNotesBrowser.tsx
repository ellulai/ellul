// SPDX-License-Identifier: MIT
"use client";

import {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
} from "react";
import {
  FileText,
  Search,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Plus,
  Pencil,
  Eye,
  Trash2,
  ArrowRightLeft,
  Check,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { VaultNoteRenderer } from "./VaultNoteRenderer";
import { VaultBacklinksPane } from "./VaultBacklinksPane";
import { getVpsApiUrl } from "@/lib/domains";

// ── Types ──

interface VaultNote {
  id: string;
  path: string;
  title: string;
  tags: string[];
  wordCount: number;
  modifiedAt: number;
}

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: TreeNode[];
  note?: VaultNote;
}

interface VaultNotesBrowserProps {
  serverDomain: string;
  project: string;
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

// ── Main Component ──

export function VaultNotesBrowser({
  serverDomain,
  project,
}: VaultNotesBrowserProps) {
  const t = useTranslations("console.vault");
  // Core state
  const [notes, setNotes] = useState<VaultNote[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [noteContent, setNoteContent] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [backlinks, setBacklinks] = useState<any[]>([]);
  const [restrictedBacklinks, setRestrictedBacklinks] =
    useState<string>("none");
  const [error, setError] = useState<string | null>(null);

  // Editor state
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // Dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [newNotePath, setNewNotePath] = useState("");
  const [renamePath, setRenamePath] = useState("");
  const [dialogLoading, setDialogLoading] = useState(false);

  // Build file tree from flat note list
  const tree = useMemo(() => buildTree(notes), [notes]);

  const filteredNotes = useMemo(() => {
    if (!searchQuery.trim()) return notes;
    const q = searchQuery.toLowerCase();
    return notes.filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.path.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q)),
    );
  }, [notes, searchQuery]);

  const filteredTree = useMemo(
    () => (searchQuery.trim() ? buildTree(filteredNotes) : tree),
    [searchQuery, filteredNotes, tree],
  );

  const selectedNote = useMemo(
    () => notes.find((n) => n.id === selectedNoteId),
    [notes, selectedNoteId],
  );

  // ── API Helpers ──

  const vaultFetch = useCallback(
    async (path: string, options?: RequestInit) => {
      const res = await fetch(`${getVpsApiUrl(serverDomain)}${path}`, {
        ...options,
        credentials: "include",
      });
      return res;
    },
    [serverDomain],
  );

  const fetchNotes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await vaultFetch(
        `/_auth/vault/notes?project=${encodeURIComponent(project)}&limit=500`,
      );
      if (!res.ok) throw new Error("Failed to fetch notes");
      const data = await res.json();
      setNotes(data.notes || []);
      setInitialized(true);
    } catch (err) {
      console.error("[vault] Failed to fetch notes:", err);
    } finally {
      setLoading(false);
    }
  }, [vaultFetch, project]);

  const initVault = useCallback(async () => {
    setLoading(true);
    try {
      const res = await vaultFetch(`/_auth/vault/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project }),
      });
      if (!res.ok) throw new Error("Failed to initialize vault");
      await fetchNotes();
    } catch (err) {
      console.error("[vault] Failed to init vault:", err);
    } finally {
      setLoading(false);
    }
  }, [vaultFetch, project, fetchNotes]);

  // ── Note Selection ──

  const selectNote = useCallback(
    async (noteId: string) => {
      // Warn about unsaved changes
      if (hasUnsavedChanges && editMode) {
        // Auto-save before switching
        if (selectedNoteId && editContent !== noteContent) {
          await saveNote(selectedNoteId, editContent);
        }
      }

      setSelectedNoteId(noteId);
      setEditMode(false);
      setHasUnsavedChanges(false);
      setSaveStatus("idle");

      try {
        const res = await vaultFetch(
          `/_auth/vault/notes/${encodeURIComponent(noteId)}?project=${encodeURIComponent(project)}`,
        );
        if (!res.ok) throw new Error("Failed to fetch note");
        const data = await res.json();
        setNoteContent(data.content || "");
        setEditContent(data.content || "");
        setBacklinks(data.backlinks || []);
        setRestrictedBacklinks(data.restrictedBacklinks || "none");
      } catch (err) {
        console.error("[vault] Failed to fetch note:", err);
        setNoteContent("");
        setEditContent("");
      }
    },
    [serverDomain, project, hasUnsavedChanges, editMode, selectedNoteId, editContent, noteContent, vaultFetch],
  );

  // ── Save ──

  const saveNote = useCallback(
    async (noteId: string, content: string) => {
      setSaveStatus("saving");
      try {
        const res = await vaultFetch(
          `/_auth/vault/notes/${encodeURIComponent(noteId)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ project, content }),
          },
        );
        if (!res.ok) {
          setSaveStatus("error");
          return false;
        }
        setNoteContent(content);
        setHasUnsavedChanges(false);
        setSaveStatus("saved");
        // Reset status after 2s
        setTimeout(() => setSaveStatus((s) => (s === "saved" ? "idle" : s)), 2000);

        // Refresh note list to update word counts etc
        fetchNotes();
        return true;
      } catch {
        setSaveStatus("error");
        return false;
      }
    },
    [vaultFetch, project, fetchNotes],
  );

  // Debounced auto-save
  const scheduleAutoSave = useCallback(
    (noteId: string, content: string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveNote(noteId, content);
      }, 1500);
    },
    [saveNote],
  );

  const handleEditorChange = useCallback(
    (value: string) => {
      setEditContent(value);
      setHasUnsavedChanges(true);
      setSaveStatus("idle");
      if (selectedNoteId) {
        scheduleAutoSave(selectedNoteId, value);
      }
    },
    [selectedNoteId, scheduleAutoSave],
  );

  const handleManualSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (selectedNoteId && hasUnsavedChanges) {
      saveNote(selectedNoteId, editContent);
    }
  }, [selectedNoteId, hasUnsavedChanges, editContent, saveNote]);

  // ── Edit Toggle ──

  const toggleEditMode = useCallback(() => {
    if (editMode && hasUnsavedChanges && selectedNoteId) {
      // Save when leaving edit mode
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveNote(selectedNoteId, editContent);
    }
    if (!editMode) {
      // Entering edit mode — sync content
      setEditContent(noteContent);
    }
    setEditMode((m) => !m);
  }, [editMode, hasUnsavedChanges, selectedNoteId, noteContent, editContent, saveNote]);

  // ── Create Note ──

  const handleCreateNote = useCallback(async () => {
    if (!newNotePath.trim()) return;
    setDialogLoading(true);

    let notePath = newNotePath.trim();
    // Ensure .md extension
    if (!notePath.endsWith(".md")) notePath += ".md";

    try {
      const res = await vaultFetch(`/_auth/vault/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project,
          path: notePath,
          content: `# ${notePath.replace(/\.md$/, "").split("/").pop()}\n\n`,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || t("createNoteFailed"));
        return;
      }

      const data = await res.json();
      setCreateDialogOpen(false);
      setNewNotePath("");

      // Refresh notes and select the new one
      await fetchNotes();
      if (data.note?.id) {
        setSelectedNoteId(data.note.id);
        const content = `# ${notePath.replace(/\.md$/, "").split("/").pop()}\n\n`;
        setNoteContent(content);
        setEditContent(content);
        setEditMode(true);
        setBacklinks([]);
        setRestrictedBacklinks("none");

        // Expand parent folders
        const parts = notePath.split("/");
        if (parts.length > 1) {
          setExpandedFolders((prev) => {
            const next = new Set(prev);
            let current = "";
            for (let i = 0; i < parts.length - 1; i++) {
              current = current ? `${current}/${parts[i]}` : parts[i]!;
              next.add(current);
            }
            return next;
          });
        }
      }
    } catch (err) {
      console.error("[vault] Failed to create note:", err);
    } finally {
      setDialogLoading(false);
    }
  }, [newNotePath, vaultFetch, project, fetchNotes, t]);

  // ── Delete Note ──

  const handleDeleteNote = useCallback(async () => {
    if (!selectedNoteId) return;
    setDialogLoading(true);

    try {
      const res = await vaultFetch(
        `/_auth/vault/notes/${encodeURIComponent(selectedNoteId)}?project=${encodeURIComponent(project)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || t("deleteNoteFailed"));
        return;
      }

      setDeleteDialogOpen(false);
      setSelectedNoteId(null);
      setNoteContent("");
      setEditContent("");
      setEditMode(false);
      setHasUnsavedChanges(false);
      await fetchNotes();
    } catch (err) {
      console.error("[vault] Failed to delete note:", err);
    } finally {
      setDialogLoading(false);
    }
  }, [selectedNoteId, vaultFetch, project, fetchNotes, t]);

  // ── Rename Note ──

  const handleRenameNote = useCallback(async () => {
    if (!selectedNoteId || !renamePath.trim()) return;
    setDialogLoading(true);

    let newPath = renamePath.trim();
    if (!newPath.endsWith(".md")) newPath += ".md";

    try {
      const res = await vaultFetch(
        `/_auth/vault/notes/${encodeURIComponent(selectedNoteId)}/rename`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project, newPath }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || t("renameNoteFailed"));
        return;
      }

      const data = await res.json();
      setRenameDialogOpen(false);

      // Refresh and select the renamed note
      await fetchNotes();
      if (data.note?.id) {
        setSelectedNoteId(data.note.id);
        // Re-fetch the note content (may have alias injected)
        const noteRes = await vaultFetch(
          `/_auth/vault/notes/${encodeURIComponent(data.note.id)}?project=${encodeURIComponent(project)}`,
        );
        if (noteRes.ok) {
          const noteData = await noteRes.json();
          setNoteContent(noteData.content || "");
          setEditContent(noteData.content || "");
        }
      }
    } catch (err) {
      console.error("[vault] Failed to rename note:", err);
    } finally {
      setDialogLoading(false);
    }
  }, [selectedNoteId, renamePath, vaultFetch, project, fetchNotes, t]);

  // ── Keyboard Shortcuts ──

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // Cmd+N — new note
      if (mod && e.key === "n" && initialized) {
        e.preventDefault();
        setCreateDialogOpen(true);
      }

      // Cmd+E — toggle edit/preview
      if (mod && e.key === "e" && selectedNoteId) {
        e.preventDefault();
        toggleEditMode();
      }

      // Cmd+S — save
      if (mod && e.key === "s" && editMode) {
        e.preventDefault();
        handleManualSave();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [initialized, selectedNoteId, editMode, toggleEditMode, handleManualSave]);

  // ── Tab key in editor ──

  const handleEditorKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const textarea = e.currentTarget;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;
        const newValue = value.substring(0, start) + "\t" + value.substring(end);
        handleEditorChange(newValue);
        // Restore cursor position
        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 1;
        });
      }
    },
    [handleEditorChange],
  );

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Fetch on mount
  const fetchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (fetchedRef.current === project) return;
    fetchedRef.current = project;
    setNotes([]);
    setInitialized(false);
    setError(null);
    setSelectedNoteId(null);
    setNoteContent("");
    setEditContent("");
    setEditMode(false);

    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `${getVpsApiUrl(serverDomain)}/_auth/vault/notes?project=${encodeURIComponent(project)}&limit=500`,
          { credentials: "include" },
        );
        if (cancelled) return;
        if (res.status === 401) { setError("auth"); return; }
        if (res.status === 404 || res.status === 400) { setInitialized(false); return; }
        if (!res.ok) { setError("failed"); return; }
        const data = await res.json();
        setNotes(data.notes || []);
        setInitialized(true);
      } catch {
        if (!cancelled) setError("network");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [serverDomain, project]);

  // Cleanup auto-save timer
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // ── Render: Loading ──
  if (loading && !initialized) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <Spinner size="default" color="muted" />
          <p className="text-xs text-cream/45">{t("loadingIndex")}</p>
        </div>
      </div>
    );
  }

  // ── Render: Auth error ──
  if (error === "auth") {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <FileText className="h-8 w-8 mx-auto text-cream/35" />
          <p className="text-xs text-cream/60">{t("authRequired")}</p>
          <p className="text-[10px] text-cream/45">{t("authRefreshHint")}</p>
        </div>
      </div>
    );
  }

  // ── Render: Network error ──
  if (error === "failed" || error === "network") {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <FileText className="h-8 w-8 mx-auto text-cream/35" />
          <p className="text-xs text-cream/60">{t("loadFailed")}</p>
          <p className="text-[10px] text-cream/45">{t("loadFailedHint")}</p>
          <Button variant="outline" size="sm" onClick={() => { setError(null); fetchedRef.current = null; }}>
            {t("retry")}
          </Button>
        </div>
      </div>
    );
  }

  // ── Render: Not initialized ──
  if (!initialized && !loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3">
          <FileText className="h-8 w-8 mx-auto text-cream/35" />
          <p className="text-sm font-medium text-cream">{t("title")}</p>
          <p className="text-xs text-cream/60">{t("indexHint")}</p>
          <Button size="sm" onClick={initVault} loading={loading}>
            {t("initialize")}
          </Button>
        </div>
      </div>
    );
  }

  // ── Render: Main Layout ──
  return (
    <>
      <div className="flex h-full">
        {/* ── Left Pane: Sidebar ── */}
        <div className="w-72 border-r border-cream/[0.06] flex flex-col bg-cream/[0.01]">
          {/* Search */}
          <div className="p-2 border-b border-cream/[0.06]">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-cream/45" />
              <input
                type="text"
                placeholder={t("searchPlaceholder")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-md border border-cream/[0.08] bg-transparent pl-8 pr-3 py-1.5 text-xs text-cream/75 placeholder:text-cream/35 focus:outline-none focus:ring-1 focus:ring-sodium/50"
              />
            </div>
          </div>

          {/* Actions bar */}
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-cream/[0.06]">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setNewNotePath("");
                setCreateDialogOpen(true);
              }}
              className="h-6 w-6"
              title={t("newNoteTooltip")}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={initVault}
              disabled={loading}
              className="h-6 w-6"
              title={t("rebuildIndexTooltip")}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <span className="text-[10px] text-cream/45 ml-auto">
              {t("noteCount", { count: notes.length })}
            </span>
          </div>

          {/* Tree */}
          <div className="flex-1 overflow-y-auto p-1">
            {loading && notes.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <Spinner size="sm" color="muted" />
              </div>
            ) : (
              <>
                {filteredTree.map((node) => (
                  <TreeItem
                    key={node.path}
                    node={node}
                    depth={0}
                    selectedId={selectedNoteId}
                    expandedFolders={expandedFolders}
                    onSelect={selectNote}
                    onToggleFolder={toggleFolder}
                  />
                ))}
                {notes.length === 0 && !loading && (
                  <div className="text-center py-8 px-3 space-y-3">
                    <FileText className="h-8 w-8 mx-auto text-cream/35" />
                    <p className="text-xs text-cream/45">{t("noNotesYet")}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setNewNotePath("");
                        setCreateDialogOpen(true);
                      }}
                      className="text-xs"
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      {t("createFirstNote")}
                    </Button>
                  </div>
                )}
                {filteredNotes.length === 0 &&
                  notes.length > 0 &&
                  searchQuery.trim() && (
                    <div className="text-xs text-cream/45 p-3 text-center">
                      {t("noResultsFor", { query: searchQuery })}
                    </div>
                  )}
              </>
            )}
          </div>
        </div>

        {/* ── Right Pane: Content ── */}
        <div className="flex-1 flex flex-col overflow-hidden panel-ascente">
          {selectedNoteId && (noteContent || editMode) ? (
            <>
              {/* Note header */}
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-cream/[0.04] min-h-[44px]">
                <FileText className="h-4 w-4 text-cream/60 shrink-0" />
                <span className="text-sm font-medium text-cream truncate">
                  {selectedNote?.title || selectedNoteId}
                </span>

                {/* Save status indicator */}
                {editMode && (
                  <span className="flex items-center gap-1 text-[10px] shrink-0">
                    {saveStatus === "saving" && (
                      <>
                        <Spinner size="xs" color="muted" delay={300} />
                        <span className="text-cream/45">{t("saving")}</span>
                      </>
                    )}
                    {saveStatus === "saved" && (
                      <>
                        <Check className="h-3 w-3 text-sodium" />
                        <span className="text-sodium">{t("saved")}</span>
                      </>
                    )}
                    {saveStatus === "error" && (
                      <span className="text-terra">{t("saveFailed")}</span>
                    )}
                    {saveStatus === "idle" && hasUnsavedChanges && (
                      <span className="text-sodium/70">{t("unsaved")}</span>
                    )}
                  </span>
                )}

                <div className="flex items-center gap-1 ml-auto shrink-0">
                  {/* Tags (preview mode only) */}
                  {!editMode &&
                    selectedNote?.tags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-[10px]">
                        {tag}
                      </Badge>
                    ))}

                  {!editMode && selectedNote && (
                    <span className="text-[10px] text-cream/45 mr-1">
                      {t("wordCount", { count: selectedNote.wordCount })}
                    </span>
                  )}

                  {/* Edit / Preview toggle */}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={toggleEditMode}
                    className="h-7 w-7"
                    title={editMode ? t("previewTooltip") : t("editTooltip")}
                  >
                    {editMode ? (
                      <Eye className="h-3.5 w-3.5" />
                    ) : (
                      <Pencil className="h-3.5 w-3.5" />
                    )}
                  </Button>

                  {/* Rename */}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      if (selectedNote) {
                        setRenamePath(selectedNote.path.replace(/\.md$/, ""));
                        setRenameDialogOpen(true);
                      }
                    }}
                    className="h-7 w-7"
                    title={t("renameTooltip")}
                  >
                    <ArrowRightLeft className="h-3.5 w-3.5" />
                  </Button>

                  {/* Delete */}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeleteDialogOpen(true)}
                    className="h-7 w-7 hover:text-terra"
                    title={t("deleteNoteTooltip")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {/* Content area */}
              {editMode ? (
                // ── Editor ──
                <div className="flex-1 overflow-hidden flex flex-col">
                  {/* Path breadcrumb */}
                  {selectedNote && (
                    <div className="px-4 pt-2 pb-1">
                      <span className="text-[10px] text-cream/35 font-mono">
                        {selectedNote.path}
                      </span>
                    </div>
                  )}
                  <div className="flex-1 overflow-hidden px-4 pb-4 pt-1">
                    <textarea
                      ref={editorRef}
                      value={editContent}
                      onChange={(e) => handleEditorChange(e.target.value)}
                      onKeyDown={handleEditorKeyDown}
                      spellCheck={false}
                      className="w-full h-full resize-none rounded-md border border-cream/[0.08] bg-transparent p-4 text-[13px] leading-relaxed font-mono text-cream/75 placeholder:text-cream/35 focus:outline-none focus:ring-1 focus:ring-sodium/50 selection:bg-sodium/20"
                      placeholder={t("writingPlaceholder")}
                    />
                  </div>
                </div>
              ) : (
                // ── Preview ──
                <>
                  <div className="flex-1 overflow-y-auto">
                    <VaultNoteRenderer
                      content={noteContent}
                      serverDomain={serverDomain}
                      project={project}
                      onNoteClick={selectNote}
                    />
                  </div>

                  <VaultBacklinksPane
                    backlinks={backlinks}
                    restrictedCount={restrictedBacklinks}
                    onNoteClick={selectNote}
                  />
                </>
              )}
            </>
          ) : (
            // ── Empty state ──
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-3">
                <FileText className="h-8 w-8 mx-auto text-cream/35" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-cream">
                    {notes.length > 0
                      ? t("selectNoteToStart")
                      : t("vaultEmpty")}
                  </p>
                  <p className="text-xs text-cream/60 max-w-[240px]">
                    {notes.length > 0
                      ? t("browseHint")
                      : t("createFirstHint")}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setNewNotePath("");
                    setCreateDialogOpen(true);
                  }}
                  className="text-xs"
                >
                  <Plus className="h-3 w-3 mr-1.5" />
                  {t("newNote")}
                </Button>
                <div className="flex items-center justify-center gap-3 pt-1">
                  <span className="text-[10px] text-cream/35">
                    <kbd className="px-1 py-0.5 rounded border border-cream/[0.08] bg-cream/[0.03] font-mono text-[9px]">Cmd+N</kbd> {t("kbdNew")}
                  </span>
                  <span className="text-[10px] text-cream/35">
                    <kbd className="px-1 py-0.5 rounded border border-cream/[0.08] bg-cream/[0.03] font-mono text-[9px]">Cmd+E</kbd> {t("kbdEdit")}
                  </span>
                  <span className="text-[10px] text-cream/35">
                    <kbd className="px-1 py-0.5 rounded border border-cream/[0.08] bg-cream/[0.03] font-mono text-[9px]">Cmd+S</kbd> {t("kbdSave")}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Create Note Dialog ── */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("newNoteTitle")}</DialogTitle>
            <DialogDescription className="text-cream/60">
              {t("newNoteDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">
                {t("notePath")}
              </label>
              <input
                type="text"
                value={newNotePath}
                onChange={(e) => setNewNotePath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateNote();
                }}
                placeholder={t("notePathPlaceholder")}
                autoFocus
                className="w-full rounded-md border border-cream/[0.08] bg-transparent px-2.5 py-1.5 text-xs text-cream/75 placeholder:text-cream/35 focus:outline-none focus:ring-1 focus:ring-sodium/50 font-mono"
              />
              <p className="text-[10px] text-cream/45">
                {t("notePathHintPrefix")} <code className="px-1 py-0.5 rounded bg-cream/[0.06] text-[9px] font-mono text-cream/75">folder/name</code> {t("notePathHintSuffix")}
              </p>
            </div>

            {/* Quick suggestions */}
            {newNotePath === "" && (
              <div className="flex flex-wrap gap-1.5">
                {[t("untitled"), "journal/" + new Date().toISOString().split("T")[0], t("inboxQuick")].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => setNewNotePath(suggestion)}
                    className="px-2.5 py-1 text-[10px] rounded-md border border-cream/[0.06] bg-cream/[0.02] text-cream/45 hover:text-cream/75 hover:bg-cream/[0.04] hover:border-cream/[0.12] transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCreateDialogOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              onClick={handleCreateNote}
              disabled={!newNotePath.trim() || dialogLoading}
              loading={dialogLoading}
            >
              <Plus className="h-3 w-3 mr-1" />
              {t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete Confirmation Dialog ── */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-terra">{t("deleteNoteTitle")}</DialogTitle>
            <DialogDescription className="text-cream/60">
              {t("deleteNoteConfirmPrefix")}{" "}
              <span className="text-cream/85 font-medium">
                {selectedNote?.title || t("thisNote")}
              </span>
              {t("deleteNoteConfirmSuffix")}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-terra/20 bg-terra/5 p-3">
            <p className="text-xs text-terra">{t("deleteNoteWarning")}</p>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleteDialogOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteNote}
              disabled={dialogLoading}
              loading={dialogLoading}
            >
              <Trash2 className="h-3 w-3 mr-1" />
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Rename Dialog ── */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("renameNoteTitle")}</DialogTitle>
            <DialogDescription className="text-cream/60">
              {t("renameNoteDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">
              {t("newPath")}
            </label>
            <input
              type="text"
              value={renamePath}
              onChange={(e) => setRenamePath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRenameNote();
              }}
              autoFocus
              className="w-full rounded-md border border-cream/[0.08] bg-transparent px-2.5 py-1.5 text-xs text-cream/75 placeholder:text-cream/35 focus:outline-none focus:ring-1 focus:ring-sodium/50 font-mono"
            />
            <p className="text-[10px] text-cream/45">
              {t("renameHint")}
            </p>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRenameDialogOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              size="sm"
              onClick={handleRenameNote}
              disabled={!renamePath.trim() || dialogLoading}
              loading={dialogLoading}
            >
              <ArrowRightLeft className="h-3 w-3 mr-1" />
              {t("rename")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Tree Item Component ──

interface TreeItemProps {
  node: TreeNode;
  depth: number;
  selectedId: string | null;
  expandedFolders: Set<string>;
  onSelect: (noteId: string) => void;
  onToggleFolder: (path: string) => void;
}

function TreeItem({
  node,
  depth,
  selectedId,
  expandedFolders,
  onSelect,
  onToggleFolder,
}: TreeItemProps) {
  const isExpanded = expandedFolders.has(node.path);
  const isSelected = node.note?.id === selectedId;
  const paddingLeft = 8 + depth * 14;

  if (node.type === "folder") {
    return (
      <div>
        <button
          onClick={() => onToggleFolder(node.path)}
          className="w-full flex items-center gap-1.5 py-1 px-1 text-xs text-cream/60 hover:text-cream/75 hover:bg-cream/[0.04] rounded transition-colors"
          style={{ paddingLeft }}
        >
          {isExpanded ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-cream/45" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-cream/45" />
          )}
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-cream/60" />
          <span className="truncate">{node.name}</span>
        </button>
        {isExpanded &&
          node.children?.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              expandedFolders={expandedFolders}
              onSelect={onSelect}
              onToggleFolder={onToggleFolder}
            />
          ))}
      </div>
    );
  }

  return (
    <button
      onClick={() => node.note && onSelect(node.note.id)}
      className={`w-full flex items-center gap-1.5 py-1 px-1 text-xs rounded transition-colors ${
        isSelected
          ? "bg-sodium/10 text-sodium"
          : "text-cream/75 hover:bg-cream/[0.04]"
      }`}
      style={{ paddingLeft }}
    >
      <FileText
        className={`h-3.5 w-3.5 shrink-0 ${isSelected ? "text-sodium" : "text-cream/45"}`}
      />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

// ── Build tree from flat note list ──

function buildTree(notes: VaultNote[]): TreeNode[] {
  const root: TreeNode[] = [];
  const folderMap = new Map<string, TreeNode>();

  const sorted = [...notes].sort((a, b) => a.path.localeCompare(b.path));

  for (const note of sorted) {
    const parts = note.path.split("/");
    const fileName = parts.pop()!;
    let currentChildren = root;
    let currentPath = "";

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let folder = folderMap.get(currentPath);
      if (!folder) {
        folder = {
          name: part,
          path: currentPath,
          type: "folder",
          children: [],
        };
        folderMap.set(currentPath, folder);
        currentChildren.push(folder);
      }
      currentChildren = folder.children!;
    }

    const displayName = fileName.replace(/\.md$/i, "");
    currentChildren.push({
      name: displayName,
      path: note.path,
      type: "file",
      note,
    });
  }

  return root;
}
