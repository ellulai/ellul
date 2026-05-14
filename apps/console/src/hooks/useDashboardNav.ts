// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";

// ────────────────────────────────────────────────────
// Dashboard navigation state — URL search params are
// ────────────────────────────────────────────────────

// ── Valid values ──

import { isContextVisible } from "@/lib/feature-flags";

const ALL_APP_CONTEXTS = ["workspace", "vault", "integrations", "database", "observability", "settings"] as const;
const APP_CONTEXTS = ALL_APP_CONTEXTS.filter(
  (c) => isContextVisible(c),
) as unknown as typeof ALL_APP_CONTEXTS;
const INTEGRATIONS_TABS = ["zeroclaw"] as const;
const VAULT_TABS = ["notes", "graph", "scopes"] as const;
const WORKSPACE_TABS = ["chat", "code", "preview"] as const;
const DATABASE_TABS = ["tables", "sql", "bin", "settings"] as const;
const OBSERVABILITY_TABS = ["health", "gates", "development", "production", "claw"] as const;
const SETTINGS_TABS = [
  "context", "git", "secrets", "claw", "security",
] as const;
const RIGHT_PANELS = ["preview", "code"] as const;

export type AppContext = (typeof APP_CONTEXTS)[number];
export type VaultTab = (typeof VAULT_TABS)[number];
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
export type DatabaseTab = (typeof DATABASE_TABS)[number];
export type IntegrationsTab = (typeof INTEGRATIONS_TABS)[number];
export type ObservabilityTab = (typeof OBSERVABILITY_TABS)[number];
export type SettingsTab = (typeof SETTINGS_TABS)[number];
type RightPanel = (typeof RIGHT_PANELS)[number];

// ── Defaults per context ──

const DEFAULT_TAB: Record<AppContext, string> = {
  workspace: "chat",
  vault: "notes",
  integrations: "zeroclaw",
  database: "tables",
  observability: "health",
  settings: "context",
};

// ── Validation helpers ──

function validContext(v: string | null, fallback: AppContext = "workspace"): AppContext {
  return v && (APP_CONTEXTS as readonly string[]).includes(v)
    ? (v as AppContext)
    : fallback;
}

function validTab(
  ctx: AppContext,
  v: string | null,
  overrides?: Partial<Record<string, readonly string[]>>,
): string {
  const allowed = tabsForContext(ctx, overrides);
  return v && allowed.includes(v) ? v : (allowed[0] ?? DEFAULT_TAB[ctx]);
}

function validRightPanel(v: string | null): RightPanel {
  return v && (RIGHT_PANELS as readonly string[]).includes(v)
    ? (v as RightPanel)
    : "preview";
}

function defaultTabsForContext(ctx: AppContext): readonly string[] {
  switch (ctx) {
    case "workspace":
      return WORKSPACE_TABS;
    case "vault":
      return VAULT_TABS;
    case "observability":
      return OBSERVABILITY_TABS;
    case "settings":
      return SETTINGS_TABS;
    case "database":
      return DATABASE_TABS;
    case "integrations":
      return INTEGRATIONS_TABS;
  }
}

// Get valid tab IDs for a context, using overrides if provided.
function tabsForContext(
  ctx: AppContext,
  overrides?: Partial<Record<string, readonly string[]>>,
): readonly string[] {
  const override = overrides?.[ctx];
  if (override && override.length > 0) return override;
  return defaultTabsForContext(ctx);
}

// Nav param keys owned by this hook — everything else is preserved.
const NAV_KEYS = new Set(["ctx", "tab", "rp"]);

// ── Build URL search string ──

function buildSearch(
  ctx: AppContext,
  tab: string,
  rp: RightPanel,
  currentSearch: string,
  defaultCtx: AppContext = "workspace",
): string {
  const params = new URLSearchParams(currentSearch);

  // Remove our keys first, then re-add non-default values
  for (const key of NAV_KEYS) params.delete(key);

  if (ctx !== defaultCtx) params.set("ctx", ctx);
  if (tab !== DEFAULT_TAB[ctx]) params.set("tab", tab);
  if (rp !== "preview") params.set("rp", rp);

  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// ── Hook ──

export interface DashboardNav {
  appContext: AppContext;
  vaultTab: VaultTab;
  workspaceTab: WorkspaceTab;
  databaseTab: DatabaseTab;
  observabilityTab: ObservabilityTab;
  settingsTab: SettingsTab;
  desktopRightPanel: RightPanel;

  setAppContext: (ctx: AppContext) => void;
  setVaultTab: (tab: VaultTab) => void;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  setDatabaseTab: (tab: DatabaseTab) => void;
  setObservabilityTab: (tab: ObservabilityTab) => void;
  setSettingsTab: (tab: SettingsTab) => void;
  setDesktopRightPanel: (panel: RightPanel) => void;

  // Change context and reset the sub-tab to its default.
  changeContext: (ctx: AppContext) => void;
  // Change the active sub-tab (dispatches to the right setter based on current context).
  changeTab: (tabId: string) => void;
  // Get the active tab id for the current context.
  currentTabId: string;
}

export interface DashboardNavOptions {
  // Default context when URL has no ?ctx= param. Defaults to "workspace".
  defaultContext?: AppContext;
  // Dynamic tab overrides from the workspace config system.
  tabOverrides?: Partial<Record<string, readonly string[]>>;
}

export function useDashboardNav(options?: DashboardNavOptions): DashboardNav {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fallbackContext = options?.defaultContext ?? "workspace";
  const tabOverridesOption = options?.tabOverrides;

  // ── Read initial state from URL ──

  const [appContext, _setAppContext] = useState<AppContext>(() =>
    validContext(searchParams.get("ctx"), fallbackContext)
  );
  const [tab, _setTab] = useState<string>(() =>
    validTab(validContext(searchParams.get("ctx"), fallbackContext), searchParams.get("tab"), tabOverridesOption)
  );
  const [desktopRightPanel, _setDesktopRightPanel] = useState<RightPanel>(() =>
    validRightPanel(searchParams.get("rp"))
  );

  // ── Sync URL on state changes ──

  const pendingRef = useRef(false);
  const ctxRef = useRef(appContext);
  const tabRef = useRef(tab);
  const rpRef = useRef(desktopRightPanel);

  ctxRef.current = appContext;
  tabRef.current = tab;
  rpRef.current = desktopRightPanel;

  const scheduleUrlSync = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    // Microtask so batched state updates merge into one URL write
    queueMicrotask(() => {
      pendingRef.current = false;
      const search = buildSearch(
        ctxRef.current,
        tabRef.current,
        rpRef.current,
        window.location.search,
        fallbackContext,
      );
      const target = `${pathname}${search}`;
      // Only replace if the URL actually changed
      const current = `${pathname}${window.location.search}`;
      if (target !== current) {
        router.replace(target, { scroll: false });
      }
    });
  }, [pathname, router, fallbackContext]);

  // ── Stable setters ──

  const setAppContext = useCallback((ctx: AppContext) => {
    ctxRef.current = ctx;
    _setAppContext(ctx);
    scheduleUrlSync();
  }, [scheduleUrlSync]);

  const setTab = useCallback((t: string) => {
    tabRef.current = t;
    _setTab(t);
    scheduleUrlSync();
  }, [scheduleUrlSync]);

  const setDesktopRightPanel = useCallback((rp: RightPanel) => {
    rpRef.current = rp;
    _setDesktopRightPanel(rp);
    scheduleUrlSync();
  }, [scheduleUrlSync]);

  // ── Typed sub-tab setters (validate before storing) ──

  const setVaultTab = useCallback((t: VaultTab | string) => {
    if (tabsForContext("vault", tabOverridesOption).includes(t)) setTab(t);
  }, [setTab, tabOverridesOption]);

  const setWorkspaceTab = useCallback((t: WorkspaceTab | string) => {
    if (tabsForContext("workspace", tabOverridesOption).includes(t)) setTab(t);
  }, [setTab, tabOverridesOption]);

  const setDatabaseTab = useCallback((t: DatabaseTab | string) => {
    if (tabsForContext("database", tabOverridesOption).includes(t)) setTab(t);
  }, [setTab, tabOverridesOption]);

  const setObservabilityTab = useCallback((t: ObservabilityTab | string) => {
    if (tabsForContext("observability", tabOverridesOption).includes(t)) setTab(t);
  }, [setTab, tabOverridesOption]);

  const setSettingsTab = useCallback((t: SettingsTab | string) => {
    if (tabsForContext("settings", tabOverridesOption).includes(t)) setTab(t);
  }, [setTab, tabOverridesOption]);

  // ── Compound actions ──

  const changeContext = useCallback((ctx: AppContext) => {
    const allowed = tabsForContext(ctx, tabOverridesOption);
    const defaultTab = allowed[0] ?? DEFAULT_TAB[ctx];
    ctxRef.current = ctx;
    tabRef.current = defaultTab;
    _setAppContext(ctx);
    _setTab(defaultTab);
    scheduleUrlSync();
  }, [scheduleUrlSync, tabOverridesOption]);

  const changeTab = useCallback((tabId: string) => {
    const allowed = tabsForContext(ctxRef.current, tabOverridesOption);
    if (allowed.includes(tabId)) {
      tabRef.current = tabId;
      _setTab(tabId);
      scheduleUrlSync();
    }
  }, [scheduleUrlSync, tabOverridesOption]);

  // ── Hydration sync: re-read URL params after SSR hydration ──

  const hydrationSyncedRef = useRef(false);
  useEffect(() => {
    if (hydrationSyncedRef.current) return;
    hydrationSyncedRef.current = true;
    const newCtx = validContext(searchParams.get("ctx"), fallbackContext);
    const newTab = validTab(newCtx, searchParams.get("tab"), tabOverridesOption);
    const newRp = validRightPanel(searchParams.get("rp"));
    if (newCtx !== ctxRef.current || newTab !== tabRef.current || newRp !== rpRef.current) {
      ctxRef.current = newCtx;
      tabRef.current = newTab;
      rpRef.current = newRp;
      _setAppContext(newCtx);
      _setTab(newTab);
      _setDesktopRightPanel(newRp);
    }
  }, [searchParams]);

  // ── Popstate: sync state when user navigates with browser back/forward ──

  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search);
      const newCtx = validContext(params.get("ctx"), fallbackContext);
      const newTab = validTab(newCtx, params.get("tab"), tabOverridesOption);
      const newRp = validRightPanel(params.get("rp"));
      // Eagerly update refs so any pending microtask won't overwrite
      ctxRef.current = newCtx;
      tabRef.current = newTab;
      rpRef.current = newRp;
      _setAppContext(newCtx);
      _setTab(newTab);
      _setDesktopRightPanel(newRp);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // ── Derive typed tabs from the shared `tab` state ──

  const currentTabId = validTab(appContext, tab, tabOverridesOption);

  return {
    appContext,
    vaultTab: (appContext === "vault" && tabsForContext("vault", tabOverridesOption).includes(tab)
      ? tab
      : (tabsForContext("vault", tabOverridesOption)[0] ?? "notes")) as VaultTab,
    workspaceTab: (appContext === "workspace" && tabsForContext("workspace", tabOverridesOption).includes(tab)
      ? tab
      : (tabsForContext("workspace", tabOverridesOption)[0] ?? "chat")) as WorkspaceTab,
    databaseTab: (appContext === "database" && tabsForContext("database", tabOverridesOption).includes(tab)
      ? tab
      : (tabsForContext("database", tabOverridesOption)[0] ?? "tables")) as DatabaseTab,
    observabilityTab: (appContext === "observability" && tabsForContext("observability", tabOverridesOption).includes(tab)
      ? tab
      : (tabsForContext("observability", tabOverridesOption)[0] ?? "health")) as ObservabilityTab,
    settingsTab: (appContext === "settings" && tabsForContext("settings", tabOverridesOption).includes(tab)
      ? tab
      : (tabsForContext("settings", tabOverridesOption)[0] ?? "context")) as SettingsTab,
    desktopRightPanel,

    setAppContext,
    setVaultTab,
    setWorkspaceTab,
    setDatabaseTab,
    setObservabilityTab,
    setSettingsTab,
    setDesktopRightPanel,

    changeContext,
    changeTab,
    currentTabId,
  };
}
