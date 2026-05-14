// SPDX-License-Identifier: MIT
"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import {
  Folder,
  ChevronsUpDown,
  GitBranch,
  Search,
  RefreshCw,
} from "lucide-react";
import { TabEditor } from "../tabs/TabEditor";
import { TabCode, type CodeView, type CodeStateSnapshot, type CodeProjectList } from "../tabs/TabCode";
import { TabPreview } from "../tabs/TabPreview";
import { InstallingBanner } from "../workspace/InstallingBanner";
import type { WorkspaceContentProps } from "./layout-types";

export function WorkspaceContent({
  server,
  app,
  selectedDirectory,
  preview,
  companions,
  serverDomain,
  workspaceTab,
  desktopViewMode,
  desktopRightPanel,
  setDesktopRightPanel,
  isDesktopViewport,
  onUpgrade,
  onPreviewStart,
  onPreviewClear,
  requestedPreviewApp,
}: WorkspaceContentProps) {
  // Cross-panel communication: TabCode "Ask AI" → TabEditor chat iframe.
  const sendToChatRef = useRef<((msg: Record<string, unknown>) => void) | null>(null);
  const handleRegisterSendToChat = useCallback((send: ((msg: Record<string, unknown>) => void) | null) => {
    sendToChatRef.current = send;
  }, []);
  const handleCodeContext = useCallback((data: { file: string; line?: number; endLine?: number; snippet?: string; context: string }) => {
    sendToChatRef.current?.({ type: "code_context", ...data });
  }, []);
  // Preview-panel → chat: when a user hits "Ask agent to fix" on a crashed
  const handlePreviewFixRequest = useCallback((data: { scope: string; error: string; logTail?: string; kind: "install_failed" | "unit_failed" }) => {
    sendToChatRef.current?.({ type: "preview_fix_request", ...data });
  }, []);

  // Studio-mode code chrome state. Lifted up from the iframe so the column
  const [studioCodeView, setStudioCodeView] = useState<CodeView>("tree");
  const [studioRefreshKey, setStudioRefreshKey] = useState(0);
  const [studioCodeState, setStudioCodeState] = useState<CodeStateSnapshot>({
    view: "tree",
    changesCount: 0,
    loading: false,
  });
  const [studioProjectList, setStudioProjectList] = useState<CodeProjectList>({ apps: [], active: null });
  const [studioDirectory, setStudioDirectory] = useState<string | null>(null);
  // The preview's toolbar portals into this element when studio mode is
  const [previewToolbarHost, setPreviewToolbarHost] = useState<HTMLDivElement | null>(null);
  const handleStudioCodeState = useCallback((s: CodeStateSnapshot) => {
    setStudioCodeState(s);
    setStudioCodeView(s.view);
  }, []);
  const handleStudioProjectList = useCallback((list: CodeProjectList) => {
    setStudioProjectList(list);
    setStudioDirectory((prev) => prev ?? list.active);
  }, []);
  const studioActiveDirectory = studioDirectory ?? studioProjectList.active ?? selectedDirectory ?? null;

  // Empty-sandbox handling lives one layer up: the route page renders
  const isInstalling = preview?.phase === "installing";

  // Defensive guard: if the workspace mounts without an app (shouldn't
  if (!app) return null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {isInstalling && <InstallingBanner />}
      {/* Mobile: existing tab-based layout (unchanged) */}
      <div className="md:hidden flex-1 flex flex-col min-h-0">
        <div className={workspaceTab === "chat" ? "flex-1 flex flex-col min-h-0" : "hidden"}>
          {!isDesktopViewport && (
            <TabEditor
              serverId={server.id}
              ipAddress={server.ipAddress}
              domain={server.domain}
              preferredSession={server.preferredSession}
              visible={workspaceTab === "chat"}
              app={app}
              fallbackDirectory={selectedDirectory}
              onUpgrade={onUpgrade}
              onRegisterSendToChat={handleRegisterSendToChat}
            />
          )}
        </div>
        <div className={workspaceTab === "code" ? "flex-1 flex flex-col min-h-0" : "hidden"}>
          <TabCode serverDomain={serverDomain} app={app} selectedDirectory={selectedDirectory} onCodeContext={handleCodeContext} />
        </div>
        <div className={workspaceTab === "preview" ? "flex-1 flex flex-col min-h-0" : "hidden"}>
          <TabPreview ipAddress={server.ipAddress} domain={server.domain} serverId={server.id} app={app} selectedDirectory={selectedDirectory} preview={preview} companions={companions} onPreviewStart={onPreviewStart} onPreviewClear={onPreviewClear} requestedPreviewApp={requestedPreviewApp} onFixRequest={handlePreviewFixRequest} onUpgrade={onUpgrade} />
        </div>
      </div>

      {/* Desktop: Studio mode - 50/50 split-pane */}
      {desktopViewMode === "studio" && (
        <div className="hidden md:flex flex-1 min-h-0 gap-1.5">
          {/* Left: Chat (always visible) */}
          <div className="w-1/2 flex flex-col min-h-0">
            {isDesktopViewport && (
              <TabEditor
                serverId={server.id}
                ipAddress={server.ipAddress}
                domain={server.domain}
                preferredSession={server.preferredSession}
                visible={true}
                app={app}
                fallbackDirectory={selectedDirectory}
                onUpgrade={onUpgrade}
                onRegisterSendToChat={handleRegisterSendToChat}
              />
            )}
          </div>

          {/* Right: unified column chrome + Preview/Code panels beneath.
              All chrome for the active panel lives in this one row — no
              floating overlays, no iframe-owned header in studio. */}
          <div className="w-1/2 flex flex-col min-h-0">
            <StudioColumnChrome
              activePanel={desktopRightPanel}
              onSelectPanel={setDesktopRightPanel}
              projectList={studioProjectList}
              activeDirectory={studioActiveDirectory}
              onSelectDirectory={setStudioDirectory}
              codeView={studioCodeView}
              onSelectCodeView={setStudioCodeView}
              changesCount={studioCodeState.changesCount}
              onRefresh={() => setStudioRefreshKey((k) => k + 1)}
              isLoading={studioCodeState.loading}
              setPreviewToolbarHost={setPreviewToolbarHost}
            />
            <div className="flex-1 flex flex-col min-h-0">
              <div className={desktopRightPanel === "preview" ? "flex-1 flex flex-col min-h-0" : "hidden"}>
                <TabPreview
                  ipAddress={server.ipAddress}
                  domain={server.domain}
                  serverId={server.id}
                  app={app}
                  preview={preview}
                  companions={companions}
                  toolbarHost={previewToolbarHost}
                  onFixRequest={handlePreviewFixRequest}
                  onUpgrade={onUpgrade}
                />
              </div>
              <div className={desktopRightPanel === "code" ? "flex-1 flex flex-col min-h-0" : "hidden"}>
                <TabCode
                  serverDomain={serverDomain}
                  app={app}
                  selectedDirectory={studioActiveDirectory}
                  studio
                  codeView={studioCodeView}
                  refreshKey={studioRefreshKey}
                  onCodeStateChange={handleStudioCodeState}
                  onProjectList={handleStudioProjectList}
                  onCodeContext={handleCodeContext}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Desktop: Focus mode - full-width tabs */}
      {desktopViewMode === "focus" && (
        <div className="hidden md:flex flex-1 min-h-0">
          <div className="flex-1 flex flex-col min-h-0">
            <div className={workspaceTab === "chat" ? "flex-1 flex flex-col min-h-0" : "hidden"}>
              {isDesktopViewport && (
                <TabEditor
                  serverId={server.id}
                  ipAddress={server.ipAddress}
                  domain={server.domain}
                  preferredSession={server.preferredSession}
                  visible={workspaceTab === "chat"}
                  app={app}
                  fallbackDirectory={selectedDirectory}
                  onUpgrade={onUpgrade}
                  viewMode="focus"
                  onRegisterSendToChat={handleRegisterSendToChat}
                />
              )}
            </div>
            <div className={workspaceTab === "code" ? "flex-1 flex flex-col min-h-0" : "hidden"}>
              <TabCode serverDomain={serverDomain} app={app} selectedDirectory={selectedDirectory} onCodeContext={handleCodeContext} />
            </div>
            <div className={workspaceTab === "preview" ? "flex-1 flex flex-col min-h-0" : "hidden"}>
              <TabPreview ipAddress={server.ipAddress} domain={server.domain} serverId={server.id} app={app} selectedDirectory={selectedDirectory} preview={preview} companions={companions} onPreviewStart={onPreviewStart} onPreviewClear={onPreviewClear} requestedPreviewApp={requestedPreviewApp} onFixRequest={handlePreviewFixRequest} onUpgrade={onUpgrade} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Studio column chrome ──

function StudioColumnChrome({
  activePanel,
  onSelectPanel,
  projectList,
  activeDirectory,
  onSelectDirectory,
  codeView,
  onSelectCodeView,
  changesCount,
  onRefresh,
  isLoading,
  setPreviewToolbarHost,
}: {
  activePanel: "preview" | "code";
  onSelectPanel: (panel: "preview" | "code") => void;
  projectList: CodeProjectList;
  activeDirectory: string | null;
  onSelectDirectory: (dir: string) => void;
  codeView: CodeView;
  onSelectCodeView: (view: CodeView) => void;
  changesCount: number;
  onRefresh: () => void;
  isLoading: boolean;
  setPreviewToolbarHost: (el: HTMLDivElement | null) => void;
}) {
  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-card/60 border-b border-border">
      {/* Panel switcher — constant across modes */}
      <PreviewCodeSwitcher active={activePanel} onSelect={onSelectPanel} />

      {/* Mode-specific chrome fills the rest of the row. Only one mode is
          mounted at a time to keep layout reasoning simple. */}
      {activePanel === "preview" ? (
        <div
          ref={setPreviewToolbarHost}
          className="flex-1 flex items-center min-w-0"
        />
      ) : (
        <CodePanelChrome
          projectList={projectList}
          activeDirectory={activeDirectory}
          onSelectDirectory={onSelectDirectory}
          codeView={codeView}
          onSelectCodeView={onSelectCodeView}
          changesCount={changesCount}
          onRefresh={onRefresh}
          isLoading={isLoading}
        />
      )}
    </div>
  );
}

function CodePanelChrome({
  projectList,
  activeDirectory,
  onSelectDirectory,
  codeView,
  onSelectCodeView,
  changesCount,
  onRefresh,
  isLoading,
}: {
  projectList: CodeProjectList;
  activeDirectory: string | null;
  onSelectDirectory: (dir: string) => void;
  codeView: CodeView;
  onSelectCodeView: (view: CodeView) => void;
  changesCount: number;
  onRefresh: () => void;
  isLoading: boolean;
}) {
  const t = useTranslations("console.workspaceContent");
  return (
    <div className="flex-1 flex items-center justify-between gap-2 min-w-0">
      <ProjectSwitcher
        projects={projectList.apps}
        active={activeDirectory}
        onSelect={onSelectDirectory}
      />
      <div className="flex items-center gap-1.5 shrink-0">
        <div className="flex rounded-lg overflow-hidden border border-cream/[0.06]">
          <ToolbarIconButton
            active={codeView === "tree"}
            onClick={() => onSelectCodeView("tree")}
            title={t("files")}
          >
            <Folder className="h-3 w-3" />
          </ToolbarIconButton>
          <ToolbarIconButton
            active={codeView === "changes"}
            onClick={() => onSelectCodeView("changes")}
            title={t("changes")}
          >
            <GitBranch className="h-3 w-3" />
            {changesCount > 0 && (
              <span className="ml-1 h-4 px-1 text-[10px] rounded border border-sodium/30 bg-sodium/10 text-sodium font-medium leading-4">
                {changesCount}
              </span>
            )}
          </ToolbarIconButton>
          <ToolbarIconButton
            active={codeView === "search"}
            onClick={() => onSelectCodeView("search")}
            title={t("search")}
          >
            <Search className="h-3 w-3" />
          </ToolbarIconButton>
        </div>
        <button
          className="h-7 w-7 flex items-center justify-center rounded-lg border border-cream/[0.06] text-cream/60 hover:text-cream hover:bg-cream/[0.06] transition-colors disabled:opacity-40"
          onClick={onRefresh}
          title={t("refresh")}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
        </button>
      </div>
    </div>
  );
}

function PreviewCodeSwitcher({
  active,
  onSelect,
}: {
  active: "preview" | "code";
  onSelect: (panel: "preview" | "code") => void;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border overflow-hidden shrink-0">
      <button
        onClick={() => onSelect("preview")}
        className={`px-2.5 py-1 text-xs font-medium transition-colors ${
          active === "preview"
            ? "bg-sodium/10 text-sodium"
            : "text-cream/60 hover:text-cream/75"
        }`}
      >
        Preview
      </button>
      <button
        onClick={() => onSelect("code")}
        className={`px-2.5 py-1 text-xs font-medium transition-colors ${
          active === "code"
            ? "bg-sodium/10 text-sodium"
            : "text-cream/60 hover:text-cream/75"
        }`}
      >
        Code
      </button>
    </div>
  );
}

function displayAppLabel(dir: string | null): string {
  if (!dir) return "";
  const parts = dir.split("/").filter(Boolean);
  if (parts.length <= 1) return dir;
  return parts.slice(1).join(" / ");
}

function ProjectSwitcher({
  projects,
  active,
  onSelect,
}: {
  projects: ReadonlyArray<string>;
  active: string | null;
  onSelect: (dir: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onClick = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!active) return null;
  const multi = projects.length > 1;
  return (
    <div className="flex items-center min-w-0 relative">
      <button
        onClick={(e) => { e.stopPropagation(); if (multi) setOpen((v) => !v); }}
        className={`flex items-center gap-1.5 text-[13px] font-medium text-cream/85 hover:text-cream truncate max-w-[180px] transition-colors ${multi ? "cursor-pointer" : "cursor-default"}`}
        title={active}
      >
        <Folder className="h-3.5 w-3.5 text-sodium shrink-0" />
        <span className="truncate">{displayAppLabel(active)}</span>
        {multi && <ChevronsUpDown className="h-3 w-3 text-cream/45 shrink-0" />}
      </button>
      {open && multi && (
        <div className="absolute left-0 top-full mt-1 min-w-[180px] bg-card border border-cream/[0.08] rounded-lg shadow-2xl z-50 py-1 backdrop-blur-xl">
          {projects.map((dir) => (
            <button
              key={dir}
              onClick={() => { onSelect(dir); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left hover:bg-cream/[0.06] transition-colors ${
                dir === active ? "text-cream font-medium" : "text-cream/60"
              }`}
              title={dir}
            >
              <Folder className={`h-3.5 w-3.5 shrink-0 ${dir === active ? "text-sodium" : ""}`} />
              <span className="truncate">{displayAppLabel(dir)}</span>
              {dir === active && <span className="w-1.5 h-1.5 rounded-full bg-sodium ml-auto shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolbarIconButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`px-2.5 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5 ${
        active ? "bg-cream/[0.08] text-cream" : "text-cream/60 hover:text-cream/75"
      }`}
    >
      {children}
    </button>
  );
}
