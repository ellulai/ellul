// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import {
  RefreshCw,
  FileText,
  Save,
  Trash2,
  Plus,
  Brain,
  Globe,
  AlertCircle,
  Check,
  BookOpen,
  Pencil,
  Eye,
  ArrowLeft,
  ChevronRight,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { ClaudeLogo, OpenAILogo, CursorLogo } from "@/components/ui/ai-logos";
import { getCodeApiUrl } from "@/lib/domains";
import { useCodeToken, AuthenticationError } from "@/contexts/CodeTokenContext";
import { KeyRound } from "lucide-react";

interface ContextFile {
  name: string;
  path: string;
  type: "context" | "project" | "global" | "readme";
  project?: string;
  size: number;
  modified: string;
  preview: string;
}

type AppInfo = import("@/contexts/AppsListContext").ApiApp;

interface ServerContextProps {
  serverDomain: string;
  // Only show app-specific context (hide global)
  appOnly?: boolean;
  // Only show global context (hide app-specific)
  globalOnly?: boolean;
  // App info from backend (props-based data flow)
  app?: AppInfo | null;
}

type ViewMode = "list" | "detail";

export function ServerContext({ serverDomain, appOnly, globalOnly, app }: ServerContextProps) {
  const tServerContext = useTranslations("console.serverContext");
  // App info comes from props (backend-driven architecture)
  const selectedApp = app?.directory ?? null;
  const selectedAppName = app?.name ?? null;
  const prevAppRef = useRef(selectedApp);

  const [files, setFiles] = useState<ContextFile[]>([]);
  const [readmeContent, setReadmeContent] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [originalContent, setOriginalContent] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [isEditing, setIsEditing] = useState(false);

  const codeApiUrl = getCodeApiUrl(serverDomain);
  const { fetchWithCodeToken, reauthenticate } = useCodeToken();
  const [isReauthenticating, setIsReauthenticating] = useState(false);
  const initialLoadDone = useRef(false);

  const fetchFiles = useCallback(async () => {
    try {
      const res = await fetchWithCodeToken(`${codeApiUrl}/api/context`, { credentials: "include" });
      if (!res.ok) throw new Error(tServerContext("errorFetchFailed"));
      const data = await res.json();
      setFiles(data.files || []);
      setError(null);
    } catch (e) {
      if (e instanceof AuthenticationError) {
        // Sentinel "auth:" prefix lets the error-handling branch later in this
        // component recognise auth errors without substring-matching English.
        setError("auth:" + tServerContext("errorCannotConnect"));
      } else {
        setError(tServerContext("errorCannotConnect"));
      }
    } finally {
      setIsLoading(false);
    }
  }, [codeApiUrl, fetchWithCodeToken, tServerContext]);

  // Fetch README.md for selected app
  const fetchReadme = useCallback(async () => {
    if (!selectedApp) {
      setReadmeContent(null);
      return;
    }
    try {
      const res = await fetchWithCodeToken(
        `${codeApiUrl}/api/file?path=${encodeURIComponent(`${selectedApp}/README.md`)}`,
        { credentials: "include" }
      );
      if (res.ok) {
        const text = await res.text();
        setReadmeContent(text);
      } else {
        setReadmeContent(null);
      }
    } catch {
      setReadmeContent(null);
    }
  }, [codeApiUrl, selectedApp, fetchWithCodeToken]);

  const fetchFileContent = useCallback(
    async (fileName: string) => {
      try {
        const res = await fetchWithCodeToken(
          `${codeApiUrl}/api/context?file=${encodeURIComponent(fileName)}`,
          { credentials: "include" }
        );
        if (!res.ok) throw new Error(tServerContext("errorFetchFile"));
        const data = await res.json();
        setContent(data.content);
        setOriginalContent(data.content);
      } catch (e) {
        setContent("// Error loading file");
      }
    },
    [codeApiUrl, fetchWithCodeToken]
  );

  const saveFile = async () => {
    if (!selectedFile) return;

    setIsSaving(true);
    setSaveStatus("saving");

    try {
      const res = await fetchWithCodeToken(`${codeApiUrl}/api/context`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: selectedFile, content }),
      });

      if (!res.ok) throw new Error(tServerContext("errorSave"));

      setOriginalContent(content);
      setSaveStatus("saved");
      setIsEditing(false);
      setTimeout(() => setSaveStatus("idle"), 2000);
      fetchFiles();
    } catch (e) {
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
    } finally {
      setIsSaving(false);
    }
  };

  const deleteFile = async (fileName: string) => {
    if (!confirm(`Delete ${fileName}?`)) return;

    try {
      const res = await fetchWithCodeToken(
        `${codeApiUrl}/api/context?file=${encodeURIComponent(fileName)}`,
        { method: "DELETE", credentials: "include" }
      );
      if (!res.ok) throw new Error(tServerContext("errorDelete"));

      if (selectedFile === fileName) {
        setSelectedFile(null);
        setContent("");
        setViewMode("list");
      }
      fetchFiles();
    } catch (e) {
      alert(tServerContext("errorDeleteFile"));
    }
  };

  const createNewFile = async () => {
    if (!newFileName.trim()) return;

    const baseName = newFileName.endsWith(".md") ? newFileName : `${newFileName}.md`;
    // When an app is selected, create in the project directory; otherwise in custom context dir
    const fileName = selectedApp ? `${selectedApp}/${baseName}` : baseName;
    const displayName = baseName.replace(".md", "");

    try {
      const res = await fetchWithCodeToken(`${codeApiUrl}/api/context`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: fileName,
          content: `# ${displayName}\n\nAdd your context here...`,
        }),
      });

      if (!res.ok) throw new Error(tServerContext("errorCreateFile"));

      setNewFileName("");
      setShowNewFileInput(false);
      fetchFiles();
      // Open the new file
      setSelectedFile(fileName);
      setViewMode("detail");
    } catch (e) {
      alert(tServerContext("errorCreateFile"));
    }
  };

  // Handle selecting a file
  const handleSelectFile = (fileName: string | null, fileContent?: string) => {
    setSelectedFile(fileName);
    if (fileContent !== undefined) {
      setContent(fileContent);
      setOriginalContent(fileContent);
    }
    setViewMode("detail");
    setIsEditing(false);
  };

  // Handle back to list
  const handleBackToList = () => {
    setViewMode("list");
    setSelectedFile(null);
    setContent("");
    setOriginalContent("");
    setIsEditing(false);
  };

  // Initial load
  useEffect(() => {
    if (initialLoadDone.current) return;
    initialLoadDone.current = true;
    fetchFiles();
  }, [fetchFiles]);

  // Handle app changes - clear state when app switches
  useEffect(() => {
    if (prevAppRef.current !== selectedApp) {
      // Clear app-specific state when switching
      setReadmeContent(null);

      // If viewing app-specific content, go back to list
      if (selectedFile && viewMode === "detail") {
        const currentFile = files.find(f => f.name === selectedFile);
        if (currentFile?.type === "project" || currentFile?.type === "readme") {
          setViewMode("list");
          setSelectedFile(null);
          setContent("");
          setOriginalContent("");
        }
      }

      prevAppRef.current = selectedApp;
    }
  }, [selectedApp, selectedFile, viewMode, files]);

  // Fetch README when selectedApp changes
  useEffect(() => {
    if (selectedApp) {
      fetchReadme();
    }
  }, [fetchReadme, selectedApp]);

  // Fetch file content when selected
  useEffect(() => {
    if (selectedFile && viewMode === "detail") {
      fetchFileContent(selectedFile);
    }
  }, [selectedFile, viewMode, fetchFileContent]);

  const hasChanges = content !== originalContent;

  // Organize files — app settings shows only project files; platform settings shows global + custom
  const globalFile = appOnly ? null : (files.find((f) => f.type === "global") || null);
  // Context files live at sandbox root after reconciliation (sbx-xxx/CLAUDE.md)
  // but at app level before reconciliation (sbx-xxx/my-app/CLAUDE.md). Match both.
  const matchesApp = (f: ContextFile) =>
    f.type === "project" &&
    (f.project === selectedApp || (selectedApp?.startsWith(f.project + "/") ?? false));
  const appFiles = (appOnly || (!globalOnly && selectedApp))
    ? files.filter(matchesApp)
    : [];
  const customFiles = appOnly ? [] : files.filter((f) => f.type === "context" && f.name !== "global.md");

  if (error) {
    const isAuthError = error.startsWith("auth:") || error.includes("Authentication");
    const displayError = error.startsWith("auth:") ? error.slice(5) : error;
    void displayError;

    const handleReauthenticate = async () => {
      setIsReauthenticating(true);
      try {
        await reauthenticate();
        setError(null);
        fetchFiles();
      } catch (e) {
        // Error will be shown via error state
      } finally {
        setIsReauthenticating(false);
      }
    };

    return (
      <div className="h-full flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <div className={`w-16 h-16 rounded-2xl ${isAuthError ? "bg-sodium/10 border-sodium/20" : "bg-terra/10 border-terra/20"} border flex items-center justify-center mx-auto mb-4`}>
            <AlertCircle className={`h-8 w-8 ${isAuthError ? "text-sodium" : "text-terra"}`} />
          </div>
          <h3 className="text-sm font-medium text-cream/75 mb-2">
            {isAuthError ? tServerContext("authRequiredTitle") : tServerContext("sessionExpiredTitle")}
          </h3>
          <p className="text-xs text-cream/60 leading-relaxed mb-4">
            {isAuthError
              ? tServerContext("authRequiredBody")
              : tServerContext("sessionExpiredBody")}
          </p>
          <div className="flex flex-col gap-2">
            <Button
              onClick={handleReauthenticate}
              disabled={isReauthenticating}
              size="sm"
              className="bg-sodium hover:bg-sodium text-ink"
            >
              {isReauthenticating ? (
                <RefreshCw className="h-3.5 w-3.5 mr-2 animate-spin" />
              ) : (
                <KeyRound className="h-3.5 w-3.5 mr-2" />
              )}
              {isReauthenticating ? tServerContext("authenticating") : tServerContext("loginWithPasskey")}
            </Button>
            <Button onClick={() => isAuthError ? window.location.reload() : fetchFiles()} variant="outline" size="sm" className="border-border">
              <RefreshCw className="h-3.5 w-3.5 mr-2" />
              {isAuthError ? tServerContext("refreshPage") : tServerContext("retry")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Detail View
  if (viewMode === "detail") {
    const isReadme = !selectedFile && content;
    const currentFileName = selectedFile || "README.md";
    const currentFile = files.find(f => f.name === selectedFile);
    const isGlobal = currentFile?.type === "global";
    const isAppSpecific = currentFile?.type === "project";

    return (
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-cream/[0.04]">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={handleBackToList}
              className="p-1 rounded-lg hover:bg-cream/[0.06] text-cream/60 hover:text-cream transition-colors shrink-0"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-medium text-cream truncate">
              {currentFileName}
            </span>
            {isReadme && (
              <span className="text-[10px] text-cream/45">{tServerContext("readOnly")}</span>
            )}
            {hasChanges && selectedFile && (
              <span className="text-[10px] text-sodium">{tServerContext("unsaved")}</span>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {selectedFile && (
              <>
                {isEditing && hasChanges && (
                  <Button
                    onClick={saveFile}
                    disabled={isSaving}
                    size="sm"
                    className="h-7 text-xs bg-cream/[0.08] hover:bg-cream/[0.12] text-cream"
                  >
                    {saveStatus === "saving" ? (
                      <RefreshCw className="h-3 w-3 mr-1.5 animate-spin" />
                    ) : saveStatus === "saved" ? (
                      <Check className="h-3 w-3 mr-1.5" />
                    ) : (
                      <Save className="h-3 w-3 mr-1.5" />
                    )}
                    {saveStatus === "saved" ? tServerContext("saved") : tServerContext("save")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className={`h-7 px-2 text-xs ${isEditing ? "text-cream" : "text-cream/60 hover:text-cream"}`}
                  onClick={() => setIsEditing(!isEditing)}
                >
                  {isEditing ? (
                    <>
                      <Eye className="h-3 w-3 mr-1.5" />
                      {tServerContext("preview")}
                    </>
                  ) : (
                    <>
                      <Pencil className="h-3 w-3 mr-1.5" />
                      {tServerContext("edit")}
                    </>
                  )}
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {isEditing && selectedFile ? (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full h-full p-4 bg-transparent text-sm font-mono text-cream/75 resize-none focus:outline-none"
              placeholder={tServerContext("contextPlaceholder")}
              spellCheck={false}
              autoFocus
            />
          ) : (
            <div className="p-4 prose prose-invert prose-sm max-w-none prose-headings:text-cream/85 prose-headings:font-semibold prose-h1:text-lg prose-h2:text-base prose-h3:text-sm prose-p:text-cream/60 prose-p:text-sm prose-p:leading-relaxed prose-a:text-cream/65 prose-code:text-sodium prose-code:bg-secondary prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-pre:bg-card prose-pre:border prose-pre:border-border prose-strong:text-cream/75 prose-li:text-cream/60 prose-li:text-sm prose-ul:text-cream/60 prose-ol:text-cream/60 prose-blockquote:border-sodium/50 prose-blockquote:text-cream/60 prose-hr:border-border">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content || tServerContext("noContent")}
              </ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    );
  }

  // List View
  return (
    <div className="h-full flex flex-col">
      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <RefreshCw className="h-5 w-5 text-cream/45 animate-spin" />
          </div>
        ) : (
          <>
            {/* README Card - Only show when app selected and not in globalOnly mode */}
            {selectedApp && readmeContent && !globalOnly && (
              <button
                onClick={() => handleSelectFile(null, readmeContent)}
                className="w-full text-left p-3.5 rounded-xl border border-cream/[0.06] bg-cream/[0.02] hover:bg-cream/[0.04] transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <BookOpen className="h-4 w-4 text-cream/60 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-medium text-cream">README.md</h3>
                      <ChevronRight className="h-4 w-4 text-cream/45 group-hover:text-cream/75 transition-colors" />
                    </div>
                    <p className="text-[11px] text-cream/45 mt-0.5 line-clamp-1">
                      {readmeContent.slice(0, 120)}...
                    </p>
                  </div>
                </div>
              </button>
            )}

            {/* Global Context Card */}
            {globalFile && (
              <button
                onClick={() => handleSelectFile(globalFile.name)}
                className="w-full text-left p-3.5 rounded-xl border border-cream/[0.06] bg-cream/[0.02] hover:bg-cream/[0.04] transition-colors group"
              >
                <div className="flex items-center gap-3">
                  <Globe className="h-4 w-4 text-cream/60 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-medium text-cream">{tServerContext("globalContext")}</h3>
                      <ChevronRight className="h-4 w-4 text-cream/45 group-hover:text-cream/75 transition-colors" />
                    </div>
                    <p className="text-[11px] text-cream/45 mt-0.5 line-clamp-1">
                      {globalFile.preview || tServerContext("globalFallbackPreview")}
                    </p>
                  </div>
                </div>
              </button>
            )}

            {/* App Context Cards */}
            {appFiles.map((af) => {
              const baseName = af.name.split("/").pop() || af.name;
              const displayName = baseName.replace(".md", "");
              const knownIcons: Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
                "CLAUDE.md": ClaudeLogo,
                "AGENTS.md": OpenAILogo,
              };
              const knownSubtitles: Record<string, string> = {
                "CLAUDE.md": tServerContext("claudeSubtitle"),
                "AGENTS.md": tServerContext("agentsSubtitle"),
              };
              const Icon = knownIcons[baseName] || FileText;
              const subtitle = knownSubtitles[baseName] || tServerContext("customContextSubtitle");
              const isProtected = !!knownIcons[baseName];
              return (
                <button
                  key={af.name}
                  onClick={() => handleSelectFile(af.name)}
                  className="w-full text-left p-3.5 rounded-xl border border-cream/[0.06] bg-cream/[0.02] hover:bg-cream/[0.04] transition-colors group"
                >
                  <div className="flex items-center gap-3">
                    <Icon className="h-4 w-4 text-cream/60 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-medium text-cream">{displayName}</h3>
                        <div className="flex items-center gap-1 shrink-0">
                          {!isProtected && (
                            <span
                              role="button"
                              onClick={(e) => { e.stopPropagation(); deleteFile(af.name); }}
                              className="p-1.5 rounded-lg hover:bg-terra/20 text-cream/45 hover:text-terra transition-colors opacity-0 group-hover:opacity-100"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </span>
                          )}
                          <ChevronRight className="h-4 w-4 text-cream/45 group-hover:text-cream/75 transition-colors" />
                        </div>
                      </div>
                      <p className="text-[11px] text-cream/45 mt-0.5">{subtitle}</p>
                    </div>
                  </div>
                </button>
              );
            })}

            {/* Custom Context Files */}
            {customFiles.length > 0 && (
              <div>
                <h4 className="text-[11px] font-medium text-cream/60 uppercase tracking-wider mb-2 px-1">
                  {tServerContext("customContextFiles")}
                </h4>
                <div className="space-y-2">
                  {customFiles.map((file) => (
                    <button
                      key={file.name}
                      onClick={() => handleSelectFile(file.name)}
                      className="w-full text-left p-3.5 rounded-xl border border-cream/[0.06] bg-cream/[0.02] hover:bg-cream/[0.04] transition-colors group"
                    >
                      <div className="flex items-center gap-3">
                        <FileText className="h-4 w-4 text-cream/60 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <h3 className="text-sm font-medium text-cream truncate">{file.name}</h3>
                            <ChevronRight className="h-4 w-4 text-cream/45 group-hover:text-cream/75 transition-colors shrink-0" />
                          </div>
                          <p className="text-[11px] text-cream/45 truncate">{file.preview}</p>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteFile(file.name);
                          }}
                          className="p-1.5 rounded-lg hover:bg-terra/20 text-cream/45 hover:text-terra transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Add New File */}
            {!globalOnly && (
              <div>
                {showNewFileInput ? (
                  <div className="flex gap-2 p-3 rounded-xl border border-cream/[0.06] bg-cream/[0.02]">
                    <input
                      type="text"
                      value={newFileName}
                      onChange={(e) => setNewFileName(e.target.value)}
                      placeholder={tServerContext("filenamePlaceholder")}
                      className="flex-1 px-3 py-2 text-sm bg-cream/[0.02] border border-cream/[0.06] rounded-lg text-cream/85 placeholder:text-cream/45 focus:outline-none focus:border-cream/[0.12]"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") createNewFile();
                        if (e.key === "Escape") {
                          setShowNewFileInput(false);
                          setNewFileName("");
                        }
                      }}
                      autoFocus
                    />
                    <Button size="sm" className="px-3" onClick={createNewFile}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full h-10 border-dashed border-cream/[0.06] hover:border-cream/[0.12] hover:bg-cream/[0.04] text-cream/60"
                    onClick={() => setShowNewFileInput(true)}
                  >
                    <Plus className="h-4 w-4 mr-2" />
                    {tServerContext("newContextFile")}
                  </Button>
                )}
              </div>
            )}

            {/* Empty State */}
            {!globalFile && appFiles.length === 0 && customFiles.length === 0 && !readmeContent && (
              <div className="flex-1 flex items-center justify-center py-12">
                <div className="text-center max-w-sm">
                  <Brain className="h-8 w-8 text-cream/45 mx-auto mb-4" />
                  <h3 className="text-sm font-medium text-cream/75 mb-2">{tServerContext("noContextFiles")}</h3>
                  <p className="text-xs text-cream/60 leading-relaxed">
                    {tServerContext("noContextFilesHint")}
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
