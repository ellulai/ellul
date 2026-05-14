// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useRealtime } from "@/providers/realtime-provider";
import { Shield } from "lucide-react";
import { useAppsList, AppsListProvider, findApp, type ApiApp } from "@/contexts/AppsListContext";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { VpsBridgeProvider, useVpsBridge } from "@/lib/vps-bridge";
import { VpsCapabilitiesProvider } from "@/providers/VpsCapabilitiesProvider";
import { CodeTokenProvider } from "@/contexts/CodeTokenContext";
import { AuthWall } from "../AuthWall";
import { OnboardingFlow } from "../OnboardingFlow";
import { GateRequestDialog, GateStatusBar } from "../GateControls";
import { PermissionToastDispatcher } from "../PermissionToastDispatcher";
import { useWorkbenchOptional } from "@/contexts/WorkbenchContext";
import { useDashboard, type ServerStatus } from "@/contexts/DashboardContext";
import { OverviewPage } from "../OverviewPage";
import {
  getProductForTier,
  canShowContext,
  canShowSettingsTab,
  type Product,
} from "@/lib/tier-utils";
import { isContextVisible } from "@/lib/feature-flags";
import { getCodeApiUrl } from "@/lib/domains";
import { toast } from "sonner";
import * as kb from "@/lib/keybindings";
import { useWorkspaceConfig } from "@/hooks/useWorkspaceConfig";
import { resolveIconKey } from "@/lib/workspace-extension-registry";
import { useIntegrationGroups } from "@/hooks/useIntegrationGroups";
import { CreateGroupModal } from "../integrations/CreateGroupModal";

import {
  useDashboardNav,
  type AppContext,
} from "@/hooks/useDashboardNav";

import { DesktopHeader } from "./DesktopHeader";
import { DesktopTabBar } from "./DesktopTabBar";
import { MobileBottomNav } from "./MobileBottomNav";
import { WorkspaceContent } from "./WorkspaceContent";
import { ContextContent } from "./ContextContent";
import { ServerSettingsModal } from "./ServerSettingsModal";
import type {
  MainView,
  DesktopViewMode,
  ExtendedTabConfig,
  ContextConfig,
  AiQuota,
  PreviewInfo,
  CompanionInfo,
} from "./layout-types";

// ── Static data ─────────────────────────────────────────────────────────

import {
  Settings,
  Terminal,
  Smartphone,
  FileCode,
  Rocket,
  Key,
  Activity,
  Bot,
  FileText,
  Database,
  Table2,
  Code2,
  Trash2,
  Brain,
  BookOpen,
} from "lucide-react";

interface TabConfig {
  id: string;
  label: string;
  icon: typeof Settings;
}

const workspaceTabs: TabConfig[] = [
  { id: "chat", label: "Chat", icon: Terminal },
  { id: "code", label: "Code", icon: FileCode },
  { id: "preview", label: "Preview", icon: Smartphone },
];

const observabilityTabs: TabConfig[] = [
  { id: "health", label: "Health", icon: Activity },
  { id: "gates", label: "Gates", icon: Shield },
  { id: "development", label: "Development", icon: Terminal },
  { id: "production", label: "Production", icon: Rocket },
  { id: "claw", label: "ZeroClaw", icon: Bot },
];

const databaseTabs: TabConfig[] = [
  { id: "tables", label: "Tables", icon: Table2 },
  { id: "sql", label: "SQL", icon: Code2 },
  { id: "bin", label: "Bin", icon: Trash2 },
  { id: "settings", label: "Settings", icon: Settings },
];

const settingsTabs: TabConfig[] = [
  { id: "context", label: "Context", icon: Brain },
  { id: "secrets", label: "Secrets", icon: Key },
  { id: "security", label: "Security", icon: Shield },
];

function buildAppContexts(translate: (key: string) => string): ContextConfig[] {
  return [
    { id: "workspace", label: translate("workspace"), icon: Terminal },
    ...(isContextVisible("vault") ? [{ id: "vault" as const, label: translate("vault"), icon: BookOpen }] : []),
    { id: "integrations", label: translate("integrations"), icon: Rocket },
    { id: "database", label: translate("database"), icon: Database },
    { id: "observability", label: translate("observability"), icon: Activity },
    { id: "settings", label: translate("settings"), icon: Settings },
  ];
}

function getVisibleContextsFor(product: Product, translate: (key: string) => string): ContextConfig[] {
  return buildAppContexts(translate).filter(c => canShowContext(c.id, product));
}

function getVisibleSettingsTabs(product: Product): TabConfig[] {
  return settingsTabs.filter(t => canShowSettingsTab(t.id, product));
}

// ── Props ───────────────────────────────────────────────────────────────

interface MobileDashboardLayoutProps {
  server: {
    id: string;
    ipAddress: string;
    domain?: string;
    state: string;
    performanceStatus: "good" | "struggling";
    size: string;
    createdAt: string;
    terminalEnabled: boolean;
    sshEnabled: boolean;
    preferredSession?: "main" | "claw" | "opencode" | "claude" | "codex" | "cursor";
    preferredApp?: string | null;
    securityTier?: "standard" | "web_locked" | "private_locked";
    product?: string;
    serverPlan?: "free" | "hobby" | "pro";
    runtimeTier?: "shared" | "dedicated";
    volumeSecurityMode?: "standard" | "enhanced" | "sovereign" | null;
    region?: string | null;
  };
  plan: string;
  deployments?: Array<{
    name: string;
    directory?: string;
    url: string;
    port: number;
    stack: string;
    summary: string;
    createdAt: string;
  }>;
  aiQuota?: AiQuota;
  onDeleteServer: () => void;
  isDeleting?: boolean;
  onRebuildServer?: () => void;
  isRebuilding?: boolean;
  onRollbackServer?: () => void;
  isRollingBack?: boolean;
  snapshotExpiresAt?: string | null;
  agentUpdate?: ServerStatus["agentUpdate"];
  onUpdateServer?: () => void;
  isUpdating?: boolean;
  onSetAgentUpdateMode?: (mode: "auto" | "manual") => void;
  isSettingAgentUpdateMode?: boolean;
  view?: "overview" | "app";
  appDirectory?: string;
  app?: ApiApp | null;
  preview?: PreviewInfo | null;
  companions?: CompanionInfo[];
  onRetryApp?: () => void;
  onUpgrade?: () => void;
}

// ── Inner component that uses contexts ──────────────────────────────────

function DashboardContent({
  server,
  plan,
  deployments,
  aiQuota,
  onDeleteServer,
  isDeleting,
  onRebuildServer,
  isRebuilding,
  onRollbackServer,
  isRollingBack,
  snapshotExpiresAt,
  agentUpdate,
  onUpdateServer,
  isUpdating,
  onSetAgentUpdateMode,
  isSettingAgentUpdateMode,
  view: routeView,
  appDirectory: routeDirectory,
  app,
  preview,
  companions,
  onUpgrade,
}: MobileDashboardLayoutProps) {
  const t = useTranslations("console.mobileDashboard");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const product = (server.product as Product) || getProductForTier(server.product);
  const { allServers, activeServerId, updateActiveServer } = useDashboard();

  // Use AppsListContext for global sandbox list and management
  const { sandboxes, isLoading: appsLoading, deleteSandbox, isDeletingSandbox, refresh: refreshApps } = useAppsList();

  // The route directory is authoritative — it's the exact path the user navigated
  const selectedApp = routeDirectory ?? app?.directory ?? null;
  const selectedAppInfo = app ?? (selectedApp ? findApp(sandboxes, selectedApp) : null);

  // the previous useState+useEffect shape fought itself whenever (2) and
  // leak into subsequent routes.
  const [userPreviewOverride, setUserPreviewOverride] = useState<string | null>(null);

  useEffect(() => {
    setUserPreviewOverride(null);
  }, [selectedApp]);

  const visiblePreviewApp = useMemo<string | null>(() => {
    if (userPreviewOverride !== null) return userPreviewOverride;
    if (selectedApp && selectedAppInfo?.previewable) return selectedApp;
    if (preview?.active && preview.app) return preview.app;
    return null;
  }, [userPreviewOverride, selectedApp, selectedAppInfo?.previewable, preview?.active, preview?.app]);

  const handlePreviewStart = useCallback((dir: string) => {
    setUserPreviewOverride(dir);
  }, []);

  const handlePreviewClear = useCallback(() => {
    setUserPreviewOverride(null);
  }, []);

  // VPS auth state for web_locked tier
  const { needsVpsAuth, ready: bridgeReady, send: vpsSend } = useVpsBridge();

  // Desktop view mode (focus/studio/grid), persisted on VPS
  const [desktopViewMode, setDesktopViewMode] = useState<DesktopViewMode>("focus");
  useEffect(() => {
    if (!bridgeReady) return;
    vpsSend<{ desktopViewMode?: DesktopViewMode }>("get_settings")
      .then((result) => {
        if (result.desktopViewMode && ["focus", "studio"].includes(result.desktopViewMode)) {
          setDesktopViewMode(result.desktopViewMode);
        }
      })
      .catch(() => {});
  }, [bridgeReady, vpsSend]);

  const handleSetViewMode = useCallback(async (mode: DesktopViewMode) => {
    try { await vpsSend("set_view_mode", { mode }); } catch {}
    setDesktopViewMode(mode);
  }, [vpsSend]);

  // App-centric navigation state
  const [internalMainView, setInternalMainView] = useState<MainView>(server.preferredApp ? "app" : "overview");
  const mainView: MainView = routeView || internalMainView;
  const setMainView = (newView: MainView) => {
    if (routeView) {
      if (newView === "overview") {
        router.push("/dashboard");
      }
    } else {
      setInternalMainView(newView);
    }
  };

  // ── Workspace Extension System ──
  const workbench = useWorkbenchOptional();
  const sendContextMode = useCallback((mode: string, app: string | null) => {
    workbench?.sendContextMode(mode as "base" | "preview" | "deploy", app);
  }, [workbench]);
  const workspaceConfig = useWorkspaceConfig({
    serverId: server.id,
    product,
    sandboxId: selectedApp,
    activeContext: searchParams.get("ctx") || (product === "cloud_platform" ? "workspace" : "settings"),
    requestedTab: searchParams.get("tab"),
    sendContextMode,
    selectedApp,
  });

  // ── Dynamic integration groups ──
  const { groups: integrationGroups, dynamicTabIds, createGroup, deleteGroup } = useIntegrationGroups(server.id, selectedApp);
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const existingRoles = integrationGroups
    .filter(g => g.routeRole)
    .map(g => g.routeRole as string);

  // Merge dynamic integration group IDs into tab overrides so useDashboardNav
  const mergedTabOverrides = (() => {
    const base = { ...workspaceConfig.tabOverrides };
    const staticIntTabs = base.integrations ?? [];
    // Append dynamic group IDs after the static zeroclaw tab
    base.integrations = [...staticIntTabs, ...dynamicTabIds.filter(id => !staticIntTabs.includes(id))];
    return base;
  })();

  const {
    appContext, vaultTab, workspaceTab, databaseTab, observabilityTab, settingsTab, desktopRightPanel,
    setAppContext, setVaultTab, setWorkspaceTab, setDatabaseTab, setObservabilityTab, setSettingsTab, setDesktopRightPanel,
    changeContext, changeTab, currentTabId,
  } = useDashboardNav({
    defaultContext: product === "cloud_platform" ? "workspace" : "settings",
    tabOverrides: mergedTabOverrides,
  });

  // Action execution lives in the chat iframe (vps-ui) and is forwarded to the

  // Track viewport to avoid rendering duplicate TabEditor iframes.
  const [isDesktopViewport, setIsDesktopViewport] = useState(
    typeof window !== "undefined" ? window.matchMedia("(min-width: 768px)").matches : false
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktopViewport(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const [showServerSettings, setShowServerSettings] = useState(false);

  const serverDomain = server.domain || `${server.ipAddress.replace(/\./g, "-")}.sslip.io`;
  const selectedAppName = selectedAppInfo?.name || null;

  // Context mode
  const projectMode = selectedApp ? workbench?.projectContextModes[selectedApp] : undefined;

  // ── Workspace-config-driven tabs ──
  const tNav = useTranslations("console.navContexts");
  const visibleContexts = getVisibleContextsFor(product, (k) => tNav(k as "workspace"));

  const currentTabs: ExtendedTabConfig[] = (() => {
    const resolved = workspaceConfig.resolved.contexts[appContext];
    const staticTabs = resolved
      ? resolved.tabs
          .filter(t => t.availability.state !== "hidden")
          .map(t => ({
            id: t.routeSegment,
            label: t.label,
            icon: resolveIconKey(t.iconKey),
            required: t.required,
            extensionId: t.extensionId,
            tabId: t.tabId,
          }))
      : [];

    // For integrations context: append user-created groups as dynamic tabs
    if (appContext === "integrations" && integrationGroups.length > 0) {
      const dynamicTabs: ExtendedTabConfig[] = integrationGroups.map(g => ({
        id: g.id,
        label: g.name,
        icon: resolveIconKey(g.iconKey),
        required: false,
        extensionId: `user.group.${g.id}`,
        tabId: g.id,
      }));
      return [...staticTabs, ...dynamicTabs];
    }

    return staticTabs;
  })();

  // Handle app selection from Overview. Encode each path segment so nested
  const handleSelectApp = (appDir: string) => {
    const encoded = appDir.split("/").map(encodeURIComponent).join("/");
    router.push(`/dashboard/app/${encoded}`);
  };

  // Handle back to Overview
  const handleBackToOverview = useCallback(() => {
    if (routeView) {
      router.push("/dashboard");
    } else {
      setMainView("overview");
      changeContext("workspace");
    }
  }, [routeView, router, changeContext]);

  // Handle context change
  const handleContextChange = (context: AppContext) => {
    changeContext(context);
  };

  // Handle tab change within context
  const handleTabChange = (tabId: string) => changeTab(tabId);

  // Reset context if current one is not available
  useEffect(() => {
    const visibleContextIds = visibleContexts.map(c => c.id);
    if (!visibleContextIds.includes(appContext)) {
      setAppContext(visibleContextIds[0] || "workspace");
    }
  }, [visibleContexts, appContext, setAppContext]);

  // Reset tab if current one is not available
  useEffect(() => {
    const tabIds = currentTabs.map(t => t.id);
    if (tabIds.length > 0 && !tabIds.includes(currentTabId)) {
      changeTab(tabIds[0]!);
    }
  }, [currentTabs, currentTabId, changeTab]);

  // OAuth redirect: detect ?connected= param, refresh UI state, and reload MCP integrations
  useEffect(() => {
    const connected = searchParams.get("connected");
    if (!connected) return;

    // Navigate to the right context/tab based on where the OAuth was initiated.
    const explicitTab = searchParams.get("tab");
    if (routeView === "app" && !explicitTab) {
      setAppContext("settings");
      setSettingsTab("git");
    }

    queryClient.invalidateQueries({ queryKey: ["git-connections"] });
    queryClient.invalidateQueries({ queryKey: ["integration-groups"] });

    // Trigger MCP gateway reload so newly connected tools become available
    if (bridgeReady) {
      vpsSend("reload_integrations").catch(() => {});
    }

    sessionStorage.removeItem("ellul-git-oauth");
    const cleaned = new URLSearchParams(searchParams.toString());
    cleaned.delete("connected");
    const qs = cleaned.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [searchParams, routeView, queryClient, router, pathname, setAppContext, setSettingsTab, bridgeReady, vpsSend]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showServerSettings) {
          setShowServerSettings(false);
        }
        return;
      }

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (mainView === "app" && appContext === "workspace" && desktopViewMode === "focus") {
        if (kb.switchChat.match(e)) {
          e.preventDefault();
          setWorkspaceTab("chat");
        } else if (kb.switchCode.match(e)) {
          e.preventDefault();
          setWorkspaceTab("code");
        } else if (kb.switchPreview.match(e)) {
          e.preventDefault();
          setWorkspaceTab("preview");
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showServerSettings, mainView, appContext, desktopViewMode, serverDomain, server.preferredSession]);

  // Real-time server status via WebSocket
  const [realtimeStatus, setRealtimeStatus] = useState<{
    terminalEnabled: boolean;
    sshEnabled: boolean;
    activeSessions: string[];
  }>({
    terminalEnabled: server.terminalEnabled,
    sshEnabled: server.sshEnabled,
    activeSessions: [],
  });

  const { serverStatus: realtimeServerStatus } = useRealtime();

  useEffect(() => {
    if (realtimeServerStatus) {
      setRealtimeStatus({
        terminalEnabled: realtimeServerStatus.terminalEnabled,
        sshEnabled: realtimeServerStatus.sshEnabled,
        activeSessions: realtimeServerStatus.activeSessions,
      });
    }
  }, [realtimeServerStatus]);

  const vh = useVisualViewport();

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  useEffect(() => {
    const isKbTarget = (el: Element): boolean => {
      if (el.tagName === "TEXTAREA") return true;
      if (el.getAttribute("contenteditable") === "true") return true;
      if (el.tagName === "INPUT") {
        const t = (el as HTMLInputElement).type;
        return !["checkbox", "radio", "hidden", "range", "file", "button", "submit", "reset", "image"].includes(t);
      }
      return false;
    };

    const scrollToActive = () => {
      const el = document.activeElement;
      if (el && isKbTarget(el)) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    };

    let debounce: ReturnType<typeof setTimeout>;
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Element && isKbTarget(e.target)) {
        clearTimeout(debounce);
        debounce = setTimeout(scrollToActive, 400);
      }
    };

    const vv = window.visualViewport;
    let prevH = vv?.height ?? window.innerHeight;
    const onVvResize = () => {
      const h = vv?.height ?? window.innerHeight;
      if (h < prevH - 50) {
        clearTimeout(debounce);
        debounce = setTimeout(scrollToActive, 150);
      }
      prevH = h;
    };

    document.addEventListener("focusin", onFocusIn);
    vv?.addEventListener("resize", onVvResize);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      vv?.removeEventListener("resize", onVvResize);
      clearTimeout(debounce);
    };
  }, []);

  return (
    <div style={vh ? { height: vh } : undefined} className="fixed inset-x-0 top-0 flex flex-col text-cream p-3 sm:p-4 gap-3 sm:gap-4 overflow-hidden">
      {/* Sovereign Gates — thread-scoped modal. Opens only for the currently
          focused thread; cross-thread requests surface via the toast +
          sidebar dots so the user isn't interrupted mid-task. */}
      <GateRequestDialog />

      {/* Permission toast dispatcher — cross-thread notifications for
          requests that land while the user is focused elsewhere. The
          toast routes them back to the relevant thread, where the
          thread-scoped modal takes over. */}
      <PermissionToastDispatcher
        activeThreadId={workbench?.activeThreadId ?? null}
        onReview={(threadId) => {
          if (workbench) {
            workbench.selectThread(threadId);
            workbench.chatIframeSendRef.current?.({ type: "select_thread", threadId });
          }
        }}
      />

      {/* Create Integration Group Modal */}
      <CreateGroupModal
        open={showCreateGroupModal}
        onClose={() => setShowCreateGroupModal(false)}
        onSubmit={(data) => {
          if (selectedApp) {
            createGroup.mutate(
              { sandboxId: selectedApp, ...data },
              {
                onSuccess: () => {
                  setShowCreateGroupModal(false);
                  toast.success(t("groups.created", { name: data.name }));
                },
                onError: (err) => toast.error(err instanceof Error ? err.message : t("groups.createFailed")),
              },
            );
          }
        }}
        existingRoles={existingRoles}
        isCreating={createGroup.isPending}
      />

      {/* Enterprise Header */}
      <header className="shrink-0 panel-ascente !overflow-visible relative z-50" style={{ filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.2))" }}>
        <DesktopHeader
          server={server}
          mainView={mainView}
          serverDomain={serverDomain}
          selectedApp={selectedApp}
          previewApp={visiblePreviewApp}
          onPreviewStart={handlePreviewStart}
          appContext={appContext}
          visibleContexts={visibleContexts}
          onContextChange={handleContextChange}
          onBackToOverview={handleBackToOverview}
          onShowServerSettings={() => setShowServerSettings(true)}
          allServers={allServers}
          activeServerId={activeServerId}
          updateActiveServer={updateActiveServer}
        />

        {/* Desktop Tab Navigation */}
        {mainView === "app" && currentTabs.length > 0 && !(appContext === "workspace" && desktopViewMode === "studio") && (
          <DesktopTabBar
            currentTabs={currentTabs}
            currentTabId={currentTabId}
            appContext={appContext}
            onTabChange={handleTabChange}
            workspaceConfig={workspaceConfig}
            onCreateIntegrationGroup={() => setShowCreateGroupModal(true)}
            onDeleteIntegrationGroup={(groupId) => {
              deleteGroup.mutate(groupId, {
                onSuccess: () => {
                  toast.success(t("groups.deleted"));
                  if (currentTabId === groupId) {
                    const fallback = currentTabs[0]?.id ?? "zeroclaw";
                    changeTab(fallback);
                  }
                },
                onError: () => toast.error(t("groups.deleteFailed")),
              });
            }}
            integrationGroups={integrationGroups}
          />
        )}
      </header>

      {/* Tier banners */}
      {product === "shield_proxy" && onUpgrade && (
        <div className="shrink-0 relative z-10 px-4 pt-2">
          <div className="rounded-xl border border-sodium/40 bg-sodium/[0.08]/80 px-4 py-2.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <Shield className="h-4 w-4 text-sodium shrink-0" />
              <div className="min-w-0">
                <span className="text-sm font-medium text-sodium">{t("governanceTier")}</span>
                <span className="text-xs text-sodium/60 ml-2 hidden sm:inline">
                  {t("governanceHint")}
                </span>
              </div>
            </div>
            <button
              onClick={onUpgrade}
              className="px-3 py-1.5 bg-sodium hover:bg-sodium text-ink text-xs font-medium rounded-lg transition-colors shrink-0"
            >
              {t("upgrade")}
            </button>
          </div>
        </div>
      )}

      {/* Sovereign Gates status bar */}
      {product !== "shield_proxy" && <GateStatusBar />}

      {/* Main Content */}
      <main className="flex-1 relative z-10 flex flex-col min-h-0 overflow-hidden">
        {/* Auth Gate */}
        {server.securityTier !== "standard" && (needsVpsAuth || !bridgeReady) ? (
          <div className="flex-1 relative">
            {needsVpsAuth ? (
              <AuthWall
                show={true}
                message={t("passkeyAuthMessage")}
                onReauthenticated={refreshApps}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center space-y-4">
                  <div className="relative mx-auto w-12 h-12">
                    <div className="absolute inset-0 rounded-full border-2 border-cream/[0.06]" />
                    <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-sodium animate-spin" />
                    <div className="absolute inset-2 rounded-full border-2 border-transparent border-b-sodium/40 animate-spin" style={{ animationDirection: "reverse", animationDuration: "1.5s" }} />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-cream/80">{t("establishingSession")}</p>
                    <p className="text-[11px] text-cream/45 mt-1">{t("verifyingCredentials")}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : !appsLoading && sandboxes.length === 0 ? (
          <div className="flex-1 flex items-start justify-center overflow-y-auto px-4 py-10 sm:py-16">
            <div className="w-full max-w-xl">
              <OnboardingFlow
                serverId={server.id}
                serverDomain={serverDomain}
                securityTier={server.securityTier}
                onComplete={async (targetDirectory) => {
                  await refreshApps();
                  if (targetDirectory) handleSelectApp(targetDirectory);
                }}
              />
            </div>
          </div>
        ) : mainView === "overview" ? (
          <OverviewPage
            sandboxes={sandboxes}
            deployments={[]}
            isLoading={appsLoading}
            onSelectApp={handleSelectApp}
            serverId={server.id}
            serverDomain={serverDomain}
            securityTier={server.securityTier}
          />
        ) : (
          <div className="flex-1 flex flex-col min-h-0">
            {/* Workspace Context */}
            {appContext === "workspace" && (
              <WorkspaceContent
                server={server}
                app={app}
                selectedDirectory={selectedApp}
                preview={preview}
                companions={companions}
                serverDomain={serverDomain}
                workspaceTab={workspaceTab}
                desktopViewMode={desktopViewMode}
                desktopRightPanel={desktopRightPanel}
                setDesktopRightPanel={setDesktopRightPanel}
                isDesktopViewport={isDesktopViewport}
                onUpgrade={onUpgrade}
                onPreviewStart={handlePreviewStart}
                onPreviewClear={handlePreviewClear}
                requestedPreviewApp={visiblePreviewApp}
              />
            )}

            {/* Non-workspace contexts */}
            <ContextContent
              server={server}
              app={app}
              sandboxes={sandboxes}
              serverDomain={serverDomain}
              selectedApp={selectedApp}
              selectedAppName={selectedAppName}
              appContext={appContext}
              currentTabId={currentTabId}
              vaultTab={vaultTab}
              databaseTab={databaseTab}
              observabilityTab={observabilityTab}
              settingsTab={settingsTab}
              product={product}
              onUpgrade={onUpgrade}
              onBackToOverview={handleBackToOverview}
              integrationGroups={integrationGroups}
              deleteSandbox={deleteSandbox}
              isDeletingSandbox={isDeletingSandbox}
            />
          </div>
        )}
      </main>

      {/* Mobile Bottom Navigation */}
      {mainView === "app" && currentTabs.length > 0 && (
        <MobileBottomNav
          currentTabs={currentTabs}
          currentTabId={currentTabId}
          appContext={appContext}
          onTabChange={handleTabChange}
          workspaceConfig={workspaceConfig}
          onCreateGroup={() => setShowCreateGroupModal(true)}
          onDeleteGroup={(groupId) => {
            deleteGroup.mutate(groupId, {
              onSuccess: () => {
                toast.success(t("groups.deleted"));
                if (currentTabId === groupId) {
                  const fallback = currentTabs[0]?.id ?? "zeroclaw";
                  changeTab(fallback);
                }
              },
              onError: () => toast.error(t("groups.deleteFailed")),
            });
          }}
          integrationGroups={integrationGroups}
        />
      )}

      {/* Server Settings Modal */}
      {showServerSettings && (
        <ServerSettingsModal
          server={server}
          plan={plan}
          aiQuota={aiQuota}
          serverDomain={serverDomain}
          product={product}
          desktopViewMode={desktopViewMode}
          onSetViewMode={handleSetViewMode}
          onClose={() => setShowServerSettings(false)}
          onDeleteServer={onDeleteServer}
          isDeleting={isDeleting}
          onRebuildServer={onRebuildServer}
          isRebuilding={isRebuilding}
          onRollbackServer={onRollbackServer}
          isRollingBack={isRollingBack}
          snapshotExpiresAt={snapshotExpiresAt}
          agentUpdate={agentUpdate}
          onUpdateServer={onUpdateServer}
          isUpdating={isUpdating}
          onSetAgentUpdateMode={onSetAgentUpdateMode}
          isSettingAgentUpdateMode={isSettingAgentUpdateMode}
          onUpgrade={onUpgrade}
        />
      )}
    </div>
  );
}

// ── Outer wrapper: providers ────────────────────────────────────────────

export function MobileDashboardLayout(props: MobileDashboardLayoutProps) {
  const serverDomain =
    props.server.domain || `${props.server.ipAddress.replace(/\./g, "-")}.sslip.io`;

  // When view prop is provided (route-controlled), layout.tsx provides the providers
  if (props.view) {
    return <DashboardContent {...props} />;
  }

  // Legacy mode: wrap with providers for backward compatibility
  return (
    <VpsBridgeProvider hostname={serverDomain}>
      <VpsCapabilitiesProvider hostname={serverDomain} serverStatus={props.server.state}>
        <CodeTokenProvider securityTier={props.server.securityTier} codeApiUrl={getCodeApiUrl(serverDomain)} serverId={props.server.id} srvUrl={`https://${serverDomain}`}>
          <AppsListProvider
            serverDomain={serverDomain}
            securityTier={props.server.securityTier}
            serverStatus={props.server.state}
          >
            <DashboardContent {...props} />
          </AppsListProvider>
        </CodeTokenProvider>
      </VpsCapabilitiesProvider>
    </VpsBridgeProvider>
  );
}
