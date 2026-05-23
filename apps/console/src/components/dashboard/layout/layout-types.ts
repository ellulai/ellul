// SPDX-License-Identifier: MIT

import type { Settings } from "lucide-react";
import type { AppContext, VaultTab, WorkspaceTab, DatabaseTab, ObservabilityTab, SettingsTab } from "@/hooks/useDashboardNav";
import type { WorkspaceConfigAPI } from "@/hooks/useWorkspaceConfig";
import type { IntegrationGroup } from "@/hooks/useIntegrationGroups";
import type { Product } from "@/lib/tier-utils";
import type { ServerStatus, ServerSummary } from "@/contexts/DashboardContext";
import type { ApiApp, ApiSandbox } from "@/contexts/AppsListContext";
import type { PreviewStatus, CompanionPreviewStatus } from "@/hooks/useCurrentApp";
import type { ReactNode } from "react";

// ── Tab / context config ────────────────────────────────────────────────

export interface TabConfig {
  id: string;
  label: string;
  icon: typeof Settings;
}

export interface ExtendedTabConfig extends TabConfig {
  required: boolean;
  extensionId: string;
  tabId: string;
}

export interface ContextConfig {
  id: AppContext;
  label: string;
  icon: typeof Settings;
}

// ── Desktop view mode ───────────────────────────────────────────────────

export type MainView = "overview" | "app";
export type DesktopViewMode = "focus" | "studio";

// ── App / server shape (imported from the props) ────────────────────────

export interface ServerInfo {
  id: string;
  ipAddress: string;
  domain?: string;
  state: string;
  performanceStatus: "good" | "struggling";
  size: string;
  createdAt: string;
  terminalEnabled: boolean;
  sshEnabled: boolean;
  preferredSession?: "main" | "claw" | "opencode" | "claude" | "codex" | "cursor" | "grok";
  preferredApp?: string | null;
  securityTier?: "standard" | "web_locked" | "private_locked";
  product?: string;
  serverPlan?: "free" | "hobby" | "pro";
  runtimeTier?: "shared" | "dedicated";
  volumeSecurityMode?: "standard" | "enhanced" | "sovereign" | null;
  region?: string | null;
}

// Re-export so sub-components can import from a single layer.
export type AppInfo = ApiApp;

// re-export the canonical names so callers never drift into a weaker subset.
export type PreviewInfo = PreviewStatus;
export type CompanionInfo = CompanionPreviewStatus;

export interface AiQuota {
  used: number;
  limit: number;
  remaining: number;
  percentUsed: number;
  resetsIn: string;
  resetAt: string;
}

// ── Shared state passed to sub-components ───────────────────────────────

export interface DashboardSharedState {
  // Data
  server: ServerInfo;
  app: AppInfo | undefined;
  sandboxes: ApiSandbox[];
  preview: PreviewInfo | null | undefined;
  companions: CompanionInfo[] | undefined;
  serverDomain: string;
  selectedApp: string | null;
  selectedAppName: string | null;

  // Navigation
  appContext: AppContext;
  mainView: MainView;
  currentTabId: string;
  workspaceTab: WorkspaceTab;
  vaultTab: VaultTab;
  databaseTab: DatabaseTab;
  observabilityTab: ObservabilityTab;
  settingsTab: SettingsTab;
  desktopRightPanel: "preview" | "code";
  desktopViewMode: DesktopViewMode;
  changeContext: (ctx: AppContext) => void;
  changeTab: (tabId: string) => void;
  setDesktopRightPanel: (panel: "preview" | "code") => void;
  setWorkspaceTab: (tab: WorkspaceTab) => void;

  // Workspace extension system
  workspaceConfig: WorkspaceConfigAPI;
  currentTabs: ExtendedTabConfig[];
  visibleContexts: ContextConfig[];

  // Tier info
  product: Product;

  // Viewport tracking
  isDesktopViewport: boolean;
}

// ── Desktop header props ────────────────────────────────────────────────

export interface DesktopHeaderProps {
  server: ServerInfo;
  mainView: MainView;
  serverDomain: string;
  selectedApp: string | null;
  // Directory of the app currently being previewed.
  previewApp?: string | null;
  // Called when the user starts a preview from the scope selector.
  onPreviewStart?: (directory: string) => void;
  appContext: AppContext;
  visibleContexts: ContextConfig[];
  onContextChange: (ctx: AppContext) => void;
  onBackToOverview?: () => void;
  onShowServerSettings: () => void;
  allServers: ServerSummary[];
  activeServerId: string | null;
  updateActiveServer: (id: string | null) => void;
}

// ── Desktop tab bar props ───────────────────────────────────────────────

export interface DesktopTabBarProps {
  currentTabs: ExtendedTabConfig[];
  currentTabId: string;
  appContext: AppContext;
  onTabChange: (tabId: string) => void;
  workspaceConfig: WorkspaceConfigAPI;
}

// ── Mobile bottom nav props ─────────────────────────────────────────────

export interface MobileBottomNavProps {
  currentTabs: ExtendedTabConfig[];
  currentTabId: string;
  appContext: AppContext;
  onTabChange: (tabId: string) => void;
  workspaceConfig: WorkspaceConfigAPI;
}

// ── Workspace content props ─────────────────────────────────────────────

export interface WorkspaceContentProps {
  server: ServerInfo;
  app: AppInfo | null | undefined;
  // Route-supplied directory — always a sandbox slug or nested path, used
  selectedDirectory: string | null;
  preview: PreviewInfo | null | undefined;
  companions: CompanionInfo[] | undefined;
  serverDomain: string;
  workspaceTab: WorkspaceTab;
  desktopViewMode: DesktopViewMode;
  desktopRightPanel: "preview" | "code";
  setDesktopRightPanel: (panel: "preview" | "code") => void;
  isDesktopViewport: boolean;
  onUpgrade?: () => void;
  onPreviewStart?: (directory: string) => void;
  onPreviewClear?: () => void;
  // Directory requested for preview by the scope dropdown play button.
  requestedPreviewApp?: string | null;
}

// ── Context content props ───────────────────────────────────────────────

export interface ContextContentProps {
  server: ServerInfo;
  app: AppInfo | null | undefined;
  sandboxes: ApiSandbox[];
  serverDomain: string;
  selectedApp: string | null;
  selectedAppName: string | null;
  appContext: AppContext;
  currentTabId: string;
  vaultTab: VaultTab;
  databaseTab: DatabaseTab;
  observabilityTab: ObservabilityTab;
  settingsTab: SettingsTab;
  product: Product;
  onUpgrade?: () => void;
  onBackToOverview: () => void;
  // Dynamic integration groups
  integrationGroups: IntegrationGroup[];
  // Sandbox-scoped deletion (sandbox is the billing unit)
  deleteSandbox?: (sandboxId: string) => Promise<{ success: boolean; error?: string }>;
  isDeletingSandbox?: boolean;
}

// ── Server settings modal props ─────────────────────────────────────────

export interface ServerSettingsModalProps {
  server: ServerInfo;
  plan: string;
  aiQuota?: AiQuota;
  serverDomain: string;
  product: Product;
  desktopViewMode: DesktopViewMode;
  onSetViewMode: (mode: DesktopViewMode) => void;
  onClose: () => void;
  onDeleteServer: () => void;
  isDeleting?: boolean;
  onRebuildServer?: () => void;
  isRebuilding?: boolean;
  onRollbackServer?: () => void;
  isRollingBack?: boolean;
  snapshotExpiresAt?: string | null;
  agentUpdate?: ServerStatus["agentUpdate"];
  adapterUpdates?: ServerStatus["adapterUpdates"];
  onUpdateServer?: () => void;
  isUpdating?: boolean;
  onSetAgentUpdateMode?: (mode: "auto" | "manual") => void;
  isSettingAgentUpdateMode?: boolean;
  onUpgrade?: () => void;
  onResetWorkspace?: () => Promise<void>;
}
