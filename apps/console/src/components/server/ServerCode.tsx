// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  Folder,
  FolderOpen,
  File,
  ChevronRight,
  ChevronDown,
  GitBranch,
  RefreshCw,
  X,
  FileCode,
  AlertCircle,
  FileJson,
  FileText,
  Hash,
  Code2,
  Braces,
  Terminal,
  Image,
  Settings,
  Database,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Highlight, themes } from "prism-react-renderer";
import {
  useRealtime,
  type TreeData,
  type StatusData,
} from "@/providers/realtime-provider";
import { getCodeApiUrl } from "@/lib/domains";
import { useCodeToken, AuthenticationError } from "@/contexts/CodeTokenContext";
import { useQuery } from "@tanstack/react-query";

interface FileNode {
  name: string;
  type: "file" | "dir";
  path: string;
  children?: FileNode[];
}

interface GitChange {
  status: string;
  file: string;
}

type AppInfo = import("@/contexts/AppsListContext").ApiApp;

interface ServerCodeProps {
  serverDomain: string;
  // App info from backend (props-based data flow)
  app?: AppInfo | null;
  // Optional ReactNode rendered at the start of the header bar (e.g. panel toggle)
  headerPrefix?: React.ReactNode;
}

// File extension to icon and language mapping
const FILE_CONFIG: Record<
  string,
  { icon: typeof File; color: string; language: string }
> = {
  // TypeScript/JavaScript
  ".ts": { icon: Code2, color: "text-blue-400", language: "typescript" },
  ".tsx": { icon: Code2, color: "text-blue-400", language: "tsx" },
  ".js": { icon: Braces, color: "text-sodium", language: "javascript" },
  ".jsx": { icon: Braces, color: "text-sodium", language: "jsx" },
  ".mjs": { icon: Braces, color: "text-sodium", language: "javascript" },
  ".cjs": { icon: Braces, color: "text-sodium", language: "javascript" },

  // Web
  ".html": { icon: Code2, color: "text-sodium", language: "html" },
  ".htm": { icon: Code2, color: "text-sodium", language: "html" },
  ".css": { icon: Hash, color: "text-pink-400", language: "css" },
  ".scss": { icon: Hash, color: "text-pink-500", language: "scss" },
  ".sass": { icon: Hash, color: "text-pink-500", language: "sass" },
  ".less": { icon: Hash, color: "text-indigo-400", language: "less" },

  // Data
  ".json": { icon: FileJson, color: "text-sodium", language: "json" },
  ".yaml": { icon: FileJson, color: "text-cream/65", language: "yaml" },
  ".yml": { icon: FileJson, color: "text-cream/65", language: "yaml" },
  ".toml": { icon: FileJson, color: "text-sodium", language: "toml" },
  ".xml": { icon: FileJson, color: "text-green-400", language: "xml" },

  // Python
  ".py": { icon: Code2, color: "text-green-400", language: "python" },
  ".pyw": { icon: Code2, color: "text-green-400", language: "python" },
  ".pyx": { icon: Code2, color: "text-green-400", language: "python" },

  // Rust
  ".rs": { icon: Code2, color: "text-sodium", language: "rust" },

  // Go
  ".go": { icon: Code2, color: "text-cyan-400", language: "go" },

  // C/C++
  ".c": { icon: Code2, color: "text-blue-500", language: "c" },
  ".h": { icon: Code2, color: "text-blue-500", language: "c" },
  ".cpp": { icon: Code2, color: "text-blue-600", language: "cpp" },
  ".hpp": { icon: Code2, color: "text-blue-600", language: "cpp" },
  ".cc": { icon: Code2, color: "text-blue-600", language: "cpp" },

  // Java/Kotlin
  ".java": { icon: Code2, color: "text-terra", language: "java" },
  ".kt": { icon: Code2, color: "text-cream/65", language: "kotlin" },
  ".kts": { icon: Code2, color: "text-cream/65", language: "kotlin" },

  // Ruby
  ".rb": { icon: Code2, color: "text-terra", language: "ruby" },
  ".erb": { icon: Code2, color: "text-terra", language: "erb" },

  // PHP
  ".php": { icon: Code2, color: "text-indigo-400", language: "php" },

  // Shell
  ".sh": { icon: Terminal, color: "text-green-500", language: "bash" },
  ".bash": { icon: Terminal, color: "text-green-500", language: "bash" },
  ".zsh": { icon: Terminal, color: "text-green-500", language: "bash" },
  ".fish": { icon: Terminal, color: "text-green-500", language: "bash" },

  // SQL
  ".sql": { icon: Database, color: "text-blue-300", language: "sql" },

  // Markdown
  ".md": { icon: FileText, color: "text-cream/60", language: "markdown" },
  ".mdx": { icon: FileText, color: "text-cream/60", language: "mdx" },

  // Config
  ".env": { icon: Settings, color: "text-sodium", language: "bash" },
  ".gitignore": { icon: Settings, color: "text-cream/60", language: "git" },
  ".dockerignore": { icon: Settings, color: "text-cream/60", language: "git" },
  ".editorconfig": { icon: Settings, color: "text-cream/60", language: "ini" },
  ".prettierrc": { icon: Settings, color: "text-cream/60", language: "json" },
  ".eslintrc": { icon: Settings, color: "text-cream/60", language: "json" },

  // Images (won't highlight but good to identify)
  ".png": { icon: Image, color: "text-cream/65", language: "text" },
  ".jpg": { icon: Image, color: "text-cream/65", language: "text" },
  ".jpeg": { icon: Image, color: "text-cream/65", language: "text" },
  ".gif": { icon: Image, color: "text-cream/65", language: "text" },
  ".svg": { icon: Image, color: "text-sodium", language: "xml" },
  ".ico": { icon: Image, color: "text-cream/65", language: "text" },

  // Swift
  ".swift": { icon: Code2, color: "text-sodium", language: "swift" },

  // Dart
  ".dart": { icon: Code2, color: "text-cyan-500", language: "dart" },

  // Lua
  ".lua": { icon: Code2, color: "text-blue-400", language: "lua" },

  // Perl
  ".pl": { icon: Code2, color: "text-blue-400", language: "perl" },
  ".pm": { icon: Code2, color: "text-blue-400", language: "perl" },

  // GraphQL
  ".graphql": { icon: Code2, color: "text-pink-500", language: "graphql" },
  ".gql": { icon: Code2, color: "text-pink-500", language: "graphql" },

  // Prisma
  ".prisma": { icon: Database, color: "text-sodium", language: "prisma" },

  // Docker
  Dockerfile: { icon: Settings, color: "text-blue-400", language: "docker" },
};

function getFileConfig(name: string) {
  // Check for exact filename match first (e.g., Dockerfile)
  if (FILE_CONFIG[name]) {
    return FILE_CONFIG[name];
  }

  // Then check extension
  const ext = name.includes(".")
    ? "." + name.split(".").pop()?.toLowerCase()
    : "";
  return (
    FILE_CONFIG[ext] || {
      icon: File,
      color: "text-cream/60",
      language: "text",
    }
  );
}

// Git status code to colour. (The label was previously included here but
// the only caller reads .color; user-visible status labels are not
// rendered through this function.)
function getStatusColor(status: string): { color: string } {
  switch (status) {
    case "M":
      return { color: "text-sodium" };
    case "A":
      return { color: "text-green-400" };
    case "D":
      return { color: "text-terra" };
    case "R":
      return { color: "text-cream/65" };
    case "??":
      return { color: "text-cream/60" };
    default:
      return { color: "text-sodium" };
  }
}

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

  // Sort children: folders first, then files, both alphabetically
  const sortedChildren = useMemo(() => {
    if (!node.children) return [];
    return [...node.children].sort((a, b) => {
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

// Code viewer with syntax highlighting
function CodeViewer({ code, language }: { code: string; language: string }) {
  // Map some languages that prism-react-renderer might not have
  const languageMap: Record<string, string> = {
    text: "text",
    git: "bash",
    docker: "docker",
    dockerfile: "docker",
    ini: "ini",
    toml: "toml",
    prisma: "graphql",
    erb: "markup",
    mdx: "markdown",
  };

  const mappedLanguage = languageMap[language] || language;

  return (
    <Highlight theme={themes.nightOwl} code={code} language={mappedLanguage}>
      {({ className, style, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={`${className} text-[13px] leading-5 overflow-auto h-full`}
          style={{ ...style, background: "transparent", margin: 0, padding: 0 }}
        >
          <code className="block min-w-full">
            {tokens.map((line, i) => {
              const lineProps = getLineProps({ line });
              return (
                <div
                  key={i}
                  {...lineProps}
                  className="table-row hover:bg-secondary/30"
                >
                  <span className="table-cell text-right pr-4 pl-4 select-none text-cream/45 text-xs w-12">
                    {i + 1}
                  </span>
                  <span className="table-cell pr-4">
                    {line.map((token, key) => (
                      <span key={key} {...getTokenProps({ token })} />
                    ))}
                    {line.length === 0 && " "}
                  </span>
                </div>
              );
            })}
          </code>
        </pre>
      )}
    </Highlight>
  );
}

export function ServerCode({
  serverDomain,
  app,
  headerPrefix,
}: ServerCodeProps) {
  // App info comes from props (backend-driven architecture)
  const selectedApp = app?.directory ?? null;
  const selectedAppName = app?.name ?? null;
  const codeApiUrl = getCodeApiUrl(serverDomain);
  const { fetchWithCodeToken } = useCodeToken();

  const [view, setView] = useState<"tree" | "changes">("tree");
  const [tree, setTree] = useState<FileNode | null>(null);
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    new Set([""]),
  );
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Track app changes to clear state
  const prevAppRef = useRef(selectedApp);

  // Clear selection and content when app changes
  useEffect(() => {
    if (prevAppRef.current !== selectedApp) {
      prevAppRef.current = selectedApp;
      setSelectedFile(null);
      setFileContent("");
      setTree(null);
      setChanges([]);
      setError(null);
    }
  }, [selectedApp]);

  // Fetch tree using React Query
  const {
    data: treeData,
    isLoading: isTreeLoading,
    error: treeError,
    refetch: refetchTree,
  } = useQuery<{ tree: FileNode; project: string }>({
    queryKey: ["file-tree", selectedApp, codeApiUrl],
    queryFn: async ({ signal }) => {
      if (!selectedApp) throw new Error("No app selected");
      const url = `${codeApiUrl}/api/tree?project=${encodeURIComponent(selectedApp)}`;
      const res = await fetchWithCodeToken(url, {
        credentials: "include",
        signal,
      });
      if (!res.ok) throw new Error("Failed to fetch tree");
      return res.json();
    },
    enabled: !!selectedApp && !!codeApiUrl,
    staleTime: 30_000,
  });

  // Fetch git status using React Query
  const { data: statusData, refetch: refetchStatus } = useQuery<{
    modified: GitChange[];
  }>({
    queryKey: ["git-status", selectedApp, codeApiUrl],
    queryFn: async ({ signal }) => {
      if (!selectedApp) throw new Error("No app selected");
      const url = `${codeApiUrl}/api/status?project=${encodeURIComponent(selectedApp)}`;
      const res = await fetchWithCodeToken(url, {
        credentials: "include",
        signal,
      });
      if (!res.ok) throw new Error("Failed to fetch status");
      return res.json();
    },
    enabled: !!selectedApp && !!codeApiUrl,
    staleTime: 30_000,
  });

  // Update local state from query results
  useEffect(() => {
    if (treeData?.tree) {
      setTree(treeData.tree);
      setLastUpdated(new Date());

      // Auto-expand first level for specific app
      if (treeData.tree.children && selectedApp) {
        const initialExpanded = new Set([""]);
        treeData.tree.children.forEach((child: FileNode) => {
          if (child.type === "dir") {
            initialExpanded.add(child.path);
          }
        });
        setExpandedPaths(initialExpanded);
      }
    }
  }, [treeData, selectedApp]);

  useEffect(() => {
    if (statusData?.modified) {
      setChanges(statusData.modified);
    }
  }, [statusData]);

  useEffect(() => {
    if (treeError) {
      if (treeError instanceof AuthenticationError) {
        setError("Authentication required. Please re-authenticate.");
      } else if (treeError.message !== "STALE_GENERATION") {
        setError("Cannot connect to file API");
      }
    } else {
      setError(null);
    }
  }, [treeError]);

  // Real-time updates via WebSocket
  const handleTreeUpdate = useCallback(
    (data: TreeData) => {
      // Validate incoming data matches current app
      if (data.project !== selectedApp) return;
      setTree(data.tree);
      setLastUpdated(new Date());
      setError(null);
    },
    [selectedApp],
  );

  const handleStatusUpdate = useCallback(
    (data: StatusData) => {
      // Validate incoming data matches current app
      if (data.project !== selectedApp) return;
      setChanges(data.modified || []);
      setLastUpdated(new Date());
    },
    [selectedApp],
  );

  // Shared WebSocket via RealtimeProvider
  const {
    isConnected,
    tree: realtimeTree,
    gitStatus: realtimeGitStatus,
  } = useRealtime();

  // Track tree version to trigger file content refresh
  const [treeVersion, setTreeVersion] = useState(0);

  // Apply realtime updates when they match the selected app
  useEffect(() => {
    if (realtimeTree && selectedApp) {
      handleTreeUpdate(realtimeTree);
      setTreeVersion((v) => v + 1);
    }
  }, [realtimeTree, selectedApp, handleTreeUpdate]);

  useEffect(() => {
    if (realtimeGitStatus && selectedApp) {
      handleStatusUpdate(realtimeGitStatus);
    }
  }, [realtimeGitStatus, selectedApp, handleStatusUpdate]);

  // Refetch on WebSocket reconnection
  const wasConnectedRef = useRef(false);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current && selectedApp) {
      refetchTree();
      refetchStatus();
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected, selectedApp, refetchTree, refetchStatus]);

  // Fetch file content
  const fetchFile = useCallback(
    async (filePath: string) => {
      if (!selectedApp) return;
      try {
        const fullPath = `${selectedApp}/${filePath}`;
        const res = await fetchWithCodeToken(
          `${codeApiUrl}/api/file?path=${encodeURIComponent(fullPath)}`,
          {
            credentials: "include",
          },
        );
        if (!res.ok) throw new Error("Failed to fetch file");
        const content = await res.text();
        setFileContent(content);
      } catch {
        setFileContent("// Error loading file");
      }
    },
    [codeApiUrl, selectedApp, fetchWithCodeToken],
  );

  // Load file content when selected or when files change (AI edits)
  useEffect(() => {
    if (selectedFile && selectedApp) {
      fetchFile(selectedFile);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile, selectedApp, fetchFile, treeVersion]);

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
    if (!selectedFile) return "text";
    return getFileConfig(selectedFile.split("/").pop() || "").language;
  }, [selectedFile]);

  const modifiedFiles = new Set(changes.map((c) => c.file));

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([refetchTree(), refetchStatus()]);
      setLastUpdated(new Date());
    } finally {
      setIsRefreshing(false);
    }
  };

  // Determine loading state
  const isLoading = isTreeLoading;
  const showFileViewer = selectedFile !== null;
  const isAuthError =
    error?.includes("Authentication") || error?.includes("re-authenticate");

  return (
    <div className="flex-1 flex flex-col min-h-0 panel-ascente relative">
      {/* Connection error (non-auth) */}
      {error && !isAuthError && (
        <div className="absolute inset-0 bg-card/95 flex items-center justify-center z-20">
          <div className="text-center max-w-sm p-6">
            <div className="w-16 h-16 rounded-2xl bg-terra/10 border border-terra/20 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="h-8 w-8 text-terra" />
            </div>
            <h3 className="text-base font-medium text-cream/85 mb-2">
              Connection Error
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
              Retry
            </Button>
          </div>
        </div>
      )}

      {/* Main content */}
      <div
        className={`flex-1 flex flex-col min-h-0 ${error ? "opacity-50 pointer-events-none" : ""}`}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border bg-card/50">
          <div className="flex items-center gap-2">
            {headerPrefix}
            <FileCode className="h-4 w-4 text-sodium" />

            {lastUpdated && selectedApp && (
              <span className="text-[10px] text-cream/45">
                {lastUpdated.toLocaleTimeString()}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* View Toggle */}
            <div className="flex rounded-md border border-border overflow-hidden">
              <button
                onClick={() => setView("tree")}
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  view === "tree"
                    ? "bg-cream/[0.08] text-cream"
                    : "text-cream/60 hover:text-cream/75"
                }`}
              >
                Files
              </button>
              <button
                onClick={() => setView("changes")}
                className={`px-3 py-1 text-xs font-medium transition-colors flex items-center gap-1.5 ${
                  view === "changes"
                    ? "bg-cream/[0.08] text-cream"
                    : "text-cream/60 hover:text-cream/75"
                }`}
              >
                <GitBranch className="h-3 w-3" />
                Changes
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

        {/* Main Content */}
        <div className="flex-1 flex min-h-0">
          {/* File Tree / Changes List */}
          <div
            className={`${
              showFileViewer ? "hidden md:flex" : "flex"
            } flex-col w-full md:w-64 lg:w-72 md:shrink-0 border-r border-border overflow-y-auto bg-card/30`}
          >
            {isLoading ? (
              <div className="flex items-center justify-center h-32">
                <RefreshCw className="h-5 w-5 text-cream/45 animate-spin" />
              </div>
            ) : view === "tree" && tree ? (
              <div className="py-1">
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
                      onSelect={setSelectedFile}
                      selectedPath={selectedFile}
                      modifiedFiles={modifiedFiles}
                      expandedPaths={expandedPaths}
                      onToggle={handleToggle}
                    />
                  ))}
              </div>
            ) : view === "changes" ? (
              <div className="py-1">
                {changes.length === 0 ? (
                  <div className="text-center py-8 text-cream/45 text-sm">
                    No uncommitted changes
                  </div>
                ) : (
                  changes.map((change) => {
                    const statusInfo = getStatusColor(change.status);
                    const fileConfig = getFileConfig(
                      change.file.split("/").pop() || "",
                    );
                    const FileIcon = fileConfig.icon;
                    return (
                      <button
                        key={change.file}
                        onClick={() => setSelectedFile(change.file)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-cream/[0.06] ${
                          selectedFile === change.file ? "bg-cream/[0.08]" : ""
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
            ) : null}
          </div>

          {/* File Viewer */}
          <div
            className={`${
              showFileViewer ? "flex" : "hidden md:flex"
            } flex-1 flex-col min-w-0 bg-card`}
          >
            {selectedFile ? (
              <>
                {/* File Header */}
                <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-border bg-card/50">
                  <div className="flex items-center gap-2 min-w-0">
                    {/* Back button - visible on mobile */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 text-cream/60 hover:text-cream md:hidden"
                      onClick={() => setSelectedFile(null)}
                    >
                      <ChevronRight className="h-4 w-4 rotate-180" />
                    </Button>
                    {(() => {
                      const config = getFileConfig(
                        selectedFile.split("/").pop() || "",
                      );
                      const FileIcon = config.icon;
                      return (
                        <FileIcon
                          className={`h-4 w-4 shrink-0 ${config.color}`}
                        />
                      );
                    })()}
                    <span className="text-sm text-cream/75 truncate">
                      {selectedFile}
                    </span>
                    {modifiedFiles.has(selectedFile) && (
                      <Badge
                        variant="outline"
                        className="text-[10px] border-sodium/30 bg-sodium/10 text-sodium hidden sm:inline-flex"
                      >
                        Modified
                      </Badge>
                    )}
                    <Badge
                      variant="outline"
                      className="text-[10px] border-border text-cream/60 hidden sm:inline-flex"
                    >
                      {currentLanguage}
                    </Badge>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-cream/60 hover:text-cream md:hidden"
                    onClick={() => setSelectedFile(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                {/* File Content with Syntax Highlighting */}
                <div className="flex-1 overflow-auto bg-[#011627]">
                  {fileContent ? (
                    <CodeViewer code={fileContent} language={currentLanguage} />
                  ) : (
                    <div className="flex items-center justify-center h-32">
                      <RefreshCw className="h-5 w-5 text-cream/45 animate-spin" />
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="hidden md:flex flex-1 items-center justify-center text-cream/45 text-sm bg-card/20">
                <div className="text-center">
                  <FileCode className="h-12 w-12 mx-auto mb-3 text-cream/35" />
                  <p>Select a file to view</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
