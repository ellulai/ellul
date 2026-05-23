// SPDX-License-Identifier: MIT
"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type {
  WorkspaceConfigV1,
  ResolvedWorkspaceState,
  ResolvedTab,
  WorkspaceDiagnostic,
  RuntimeMode,
  ManifestRegistry,
} from "../lib/workspace-extensions";
import { createDefaultRegistry } from "../lib/workspace-extensions";
import {
  expandPreset,
  DEFAULT_PRESET_ID,
  isExactPresetMatch as checkPresetMatch,
} from "../lib/workspace-presets";
import { resolveWorkspaceState } from "../lib/resolve-workspace-state";
import type { ResolveInput } from "../lib/resolve-workspace-state";
import { reconcileRuntimeMode } from "../lib/derive-runtime-mode";
import type { Product } from "../lib/tier-utils";
import { API_URL } from "../lib/api";

// ─── Options ──────────────────────────────────────────────────────────────

export interface UseWorkspaceConfigOptions {
  serverId: string;
  product: Product;
  // Which sandbox (app) this config belongs to - null means no sandbox selected
  sandboxId: string | null;
  // Current context from useDashboardNav (e.g. "workspace")
  activeContext: string;
  // Current tab from URL (e.g. "chat")
  requestedTab: string | null;
  // For runtime mode reconciliation
  sendContextMode: (mode: string, app: string | null) => void;
  selectedApp: string | null;
  capabilities?: string[];
  isLocal?: boolean;
}

// ─── Return type ──────────────────────────────────────────────────────────

export interface WorkspaceConfigAPI {
  // Full resolved state from the pure resolver
  resolved: ResolvedWorkspaceState;
  // Shortcut: get resolved tabs for a context
  getTabsForContext: (ctx: string) => ResolvedTab[];
  // Shortcut: get available (addable) tabs for a context
  getAvailableTabs: (ctx: string) => ResolvedTab[];

  // Preset state
  activePresetId: string | null;
  isExactPresetMatch: boolean;

  // Mutations
  addTab: (ctx: string, extensionId: string, tabId: string, position?: number) => void;
  removeTab: (ctx: string, extensionId: string, tabId: string) => void;
  moveTab: (ctx: string, extensionId: string, tabId: string, newIndex: number) => void;
  applyPreset: (presetId: string) => void;
  resetContext: (ctx: string) => void;
  resetAll: () => void;

  // Loading state (fetching per-sandbox config)
  isLoading: boolean;
  // Persistence state
  isSaving: boolean;
  diagnostics: WorkspaceDiagnostic[];

  // The manifest registry instance
  registry: ManifestRegistry;

  // Tab overrides for useDashboardNav -- maps context -> routeSegment[]
  tabOverrides: Partial<Record<string, readonly string[]>>;
}

// ─── Debounce delay ───────────────────────────────────────────────────────

const SAVE_DEBOUNCE_MS = 500;

// ─── Empty arrays (stable references) ─────────────────────────────────────

const EMPTY_TABS: ResolvedTab[] = [];

// ─── Hook ─────────────────────────────────────────────────────────────────

export function useWorkspaceConfig(options: UseWorkspaceConfigOptions): WorkspaceConfigAPI {
  const {
    serverId,
    product,
    sandboxId,
    activeContext,
    requestedTab,
    sendContextMode,
    selectedApp,
    capabilities,
    isLocal,
  } = options;

  // 1. Static registry - created once
  const registry = useMemo(() => createDefaultRegistry(), []);

  // 2. Local config state - starts null, populated by fetch
  const [localConfig, setLocalConfig] = useState<WorkspaceConfigV1 | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!sandboxId || isLocal) {
      setLocalConfig(null);
      return;
    }

    let cancelled = false;
    const fetchConfig = async () => {
      setIsLoading(true);
      try {
        const res = await fetch(
          `${API_URL}/api/servers/${serverId}/workspace/${encodeURIComponent(sandboxId)}`,
          { credentials: "include" },
        );
        if (!res.ok) {
          if (!cancelled) setLocalConfig(null);
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setLocalConfig(data.config ?? null);
        }
      } catch {
        if (!cancelled) setLocalConfig(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    fetchConfig();
    return () => {
      cancelled = true;
    };
  }, [serverId, sandboxId, isLocal]);

  // 3. Resolve workspace state (pure, deterministic)
  const resolveInput: ResolveInput = useMemo(
    () => ({
      registry,
      config: localConfig,
      activeContext,
      requestedTab,
      product,
      capabilities,
    }),
    [registry, localConfig, activeContext, requestedTab, product, capabilities],
  );

  const resolved = useMemo(
    () => resolveWorkspaceState(resolveInput),
    [resolveInput],
  );

  // 4. Runtime mode reconciliation
  const prevModeRef = useRef<RuntimeMode>(resolved.derivedMode);

  useEffect(() => {
    reconcileRuntimeMode(
      prevModeRef.current,
      resolved.derivedMode,
      sendContextMode,
      selectedApp,
    );
    prevModeRef.current = resolved.derivedMode;
  }, [resolved.derivedMode, sendContextMode, selectedApp]);

  // 5. Persistence state
  const [isSaving, setIsSaving] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // Debounced save function - persists to per-sandbox endpoint
  const scheduleSave = useCallback(
    (config: WorkspaceConfigV1) => {
      if (!sandboxId || isLocal) return;
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = setTimeout(async () => {
        saveTimerRef.current = null;
        if (!mountedRef.current) return;
        setIsSaving(true);
        try {
          await fetch(
            `${API_URL}/api/servers/${serverId}/workspace/${encodeURIComponent(sandboxId)}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ config }),
            },
          );
        } catch {
          // Persistence failure is non-fatal - local state is still correct.
        } finally {
          if (mountedRef.current) {
            setIsSaving(false);
          }
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [serverId, sandboxId],
  );

  // Helper: apply a config mutation and schedule persistence
  const mutateConfig = useCallback(
    (updater: (prev: WorkspaceConfigV1) => WorkspaceConfigV1) => {
      setLocalConfig((prev) => {
        // If null or missing contexts (malformed), expand default preset
        const base = prev && prev.contexts ? prev : expandPreset(DEFAULT_PRESET_ID, registry);
        const next = updater(base);
        scheduleSave(next);
        return next;
      });
    },
    [registry, scheduleSave],
  );

  // ── Mutations ───────────────────────────────────────────────────────────

  const addTab = useCallback(
    (ctx: string, extensionId: string, tabId: string, position?: number) => {
      mutateConfig((config) => {
        const contextConfig = config.contexts[ctx] ?? { orderedTabs: [] };
        const orderedTabs = [...contextConfig.orderedTabs];

        // Don't add duplicates
        const exists = orderedTabs.some(
          (t) => t.extensionId === extensionId && t.tabId === tabId,
        );
        if (exists) return config;

        const entry = { extensionId, tabId, enabled: true };
        if (position !== undefined && position >= 0 && position <= orderedTabs.length) {
          orderedTabs.splice(position, 0, entry);
        } else {
          orderedTabs.push(entry);
        }

        return {
          ...config,
          revision: config.revision + 1,
          basedOnPresetId: null,
          contexts: {
            ...config.contexts,
            [ctx]: { orderedTabs },
          },
        };
      });
    },
    [mutateConfig],
  );

  const removeTab = useCallback(
    (ctx: string, extensionId: string, tabId: string) => {
      mutateConfig((config) => {
        const contextConfig = config.contexts[ctx];
        if (!contextConfig) return config;

        const orderedTabs = contextConfig.orderedTabs.filter(
          (t) => !(t.extensionId === extensionId && t.tabId === tabId),
        );

        // Nothing removed
        if (orderedTabs.length === contextConfig.orderedTabs.length) return config;

        return {
          ...config,
          revision: config.revision + 1,
          basedOnPresetId: null,
          contexts: {
            ...config.contexts,
            [ctx]: { orderedTabs },
          },
        };
      });
    },
    [mutateConfig],
  );

  const moveTab = useCallback(
    (ctx: string, extensionId: string, tabId: string, newIndex: number) => {
      mutateConfig((config) => {
        const contextConfig = config.contexts[ctx];
        if (!contextConfig) return config;

        const orderedTabs = [...contextConfig.orderedTabs];
        const currentIndex = orderedTabs.findIndex(
          (t) => t.extensionId === extensionId && t.tabId === tabId,
        );
        if (currentIndex === -1) return config;

        const clampedIndex = Math.max(0, Math.min(newIndex, orderedTabs.length - 1));
        if (currentIndex === clampedIndex) return config;

        const [removed] = orderedTabs.splice(currentIndex, 1);
        orderedTabs.splice(clampedIndex, 0, removed!);

        return {
          ...config,
          revision: config.revision + 1,
          basedOnPresetId: null,
          contexts: {
            ...config.contexts,
            [ctx]: { orderedTabs },
          },
        };
      });
    },
    [mutateConfig],
  );

  const applyPreset = useCallback(
    (presetId: string) => {
      mutateConfig((config) => {
        try {
          const expanded = expandPreset(presetId, registry);
          return {
            ...expanded,
            revision: config.revision + 1,
            basedOnPresetId: presetId,
          };
        } catch {
          // Unknown preset - no-op
          return config;
        }
      });
    },
    [mutateConfig, registry],
  );

  const resetContext = useCallback(
    (ctx: string) => {
      mutateConfig((config) => {
        // Expand the default preset and use its context config
        const defaultExpanded = expandPreset(DEFAULT_PRESET_ID, registry);
        const defaultContextConfig = defaultExpanded.contexts[ctx];
        if (!defaultContextConfig) return config;

        return {
          ...config,
          revision: config.revision + 1,
          basedOnPresetId: null,
          contexts: {
            ...config.contexts,
            [ctx]: defaultContextConfig,
          },
        };
      });
    },
    [mutateConfig, registry],
  );

  const resetAll = useCallback(() => {
    mutateConfig((config) => {
      const expanded = expandPreset(DEFAULT_PRESET_ID, registry);
      return {
        ...expanded,
        revision: config.revision + 1,
        basedOnPresetId: DEFAULT_PRESET_ID,
      };
    });
  }, [mutateConfig, registry]);

  // 7. Tab overrides: context -> routeSegment[] for enabled, non-hidden tabs
  const tabOverrides = useMemo(() => {
    const overrides: Partial<Record<string, readonly string[]>> = {};
    for (const [contextId, ctxState] of Object.entries(resolved.contexts)) {
      const segments = ctxState.tabs
        .filter((t) => t.enabled && t.availability.state !== "hidden")
        .map((t) => t.routeSegment);
      overrides[contextId] = segments;
    }
    return overrides;
  }, [resolved.contexts]);

  // 9. Preset match detection
  const effectiveConfig = localConfig ?? resolved.repairedConfig;

  const activePresetId = effectiveConfig.basedOnPresetId;

  const exactPresetMatch = useMemo(() => {
    if (!activePresetId) return false;
    try {
      return checkPresetMatch(effectiveConfig, activePresetId, registry);
    } catch {
      return false;
    }
  }, [effectiveConfig, activePresetId, registry]);

  // 10. Shortcut accessors
  const getTabsForContext = useCallback(
    (ctx: string): ResolvedTab[] => {
      return resolved.contexts[ctx]?.tabs ?? EMPTY_TABS;
    },
    [resolved.contexts],
  );

  const getAvailableTabs = useCallback(
    (ctx: string): ResolvedTab[] => {
      return resolved.contexts[ctx]?.availableTabs ?? EMPTY_TABS;
    },
    [resolved.contexts],
  );

  return {
    resolved,
    getTabsForContext,
    getAvailableTabs,

    activePresetId,
    isExactPresetMatch: exactPresetMatch,

    addTab,
    removeTab,
    moveTab,
    applyPreset,
    resetContext,
    resetAll,

    isLoading,
    isSaving,
    diagnostics: resolved.diagnostics,

    registry,
    tabOverrides,
  };
}
