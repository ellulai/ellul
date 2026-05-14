// SPDX-License-Identifier: MIT

// Workspace State Resolver - Pure, Deterministic Resolution Engine

import type { Product } from "./tier-utils";
import type {
  ResolvedContextState,
  ResolvedTab,
  ResolvedWorkspaceState,
  RuntimeMode,
  TabAvailability,
  WorkspaceConfigV1,
  WorkspaceContextConfig,
  WorkspaceDiagnostic,
  WorkspaceTabContribution,
  WorkspaceTabEntry,
} from "./workspace-extensions";
import { ManifestRegistry, qualifiedTabId } from "./workspace-extensions";
import { DEFAULT_PRESET_ID, expandPreset } from "./workspace-presets";
import { deriveRuntimeMode } from "./derive-runtime-mode";

// ─── Public Input Interface ────────────────────────────────────────────────

export interface ResolveInput {
  registry: ManifestRegistry;
  config: WorkspaceConfigV1 | null;
  activeContext: string;
  // From URL ?tab= param - null if not provided
  requestedTab: string | null;
  product: Product;
  capabilities?: string[];
}

// ─── Main Resolver ─────────────────────────────────────────────────────────

export function resolveWorkspaceState(input: ResolveInput): ResolvedWorkspaceState {
  const { registry, activeContext, requestedTab, product, capabilities = [] } = input;
  const diagnostics: WorkspaceDiagnostic[] = [];

  // Step 1: Expand null → default preset
  let config = input.config;
  if (config === null) {
    config = expandPreset(DEFAULT_PRESET_ID, registry);
    diagnostics.push({
      code: "preset_applied",
      message: `No config provided; expanded default preset "${DEFAULT_PRESET_ID}"`,
      metadata: { presetId: DEFAULT_PRESET_ID },
    });
  }

  // Step 2: Migrate version
  config = migrateConfig(config, registry, diagnostics);

  // Steps 3–6: Repair pipeline
  const repairResult = repairConfigInternal(config, registry);
  config = repairResult.config;
  diagnostics.push(...repairResult.diagnostics);

  // Step 7–10: Resolve contexts
  const resolvedContexts: Record<string, ResolvedContextState> = {};

  // Process all contexts that appear in the config OR registry
  const allContextIds = new Set<string>([
    ...Object.keys(config.contexts),
    ...registry.getAllContexts(),
  ]);

  for (const contextId of allContextIds) {
    const contextConfig = config.contexts[contextId];
    const orderedTabs = contextConfig?.orderedTabs ?? [];

    // Step 7: Apply availability/gating
    const resolvedTabs = resolveTabList(
      orderedTabs,
      contextId,
      registry,
      product,
      capabilities,
      diagnostics,
    );

    // Step 8: Compute active/default fallback
    const { activeTabId, defaultTabId } = computeActiveTab(
      resolvedTabs,
      contextId,
      contextId === activeContext ? requestedTab : null,
      diagnostics,
    );

    // Step 9: Ensure context viability
    const nonHiddenTabs = resolvedTabs.filter((t) => t.availability.state !== "hidden");
    const available = nonHiddenTabs.length > 0;
    if (!available) {
      diagnostics.push({
        code: "context_unavailable",
        contextId,
        message: `Context "${contextId}" has zero non-hidden tabs`,
      });
    }

    // Step 10: Compute available tabs (addable)
    const availableTabs = computeAvailableTabs(
      orderedTabs,
      contextId,
      registry,
      product,
      capabilities,
    );

    resolvedContexts[contextId] = {
      tabs: resolvedTabs,
      availableTabs,
      activeTabId,
      defaultTabId,
      available,
    };
  }

  // Step 11: Emit repaired canonical config
  const repairedConfig = buildRepairedConfig(config, resolvedContexts);

  // Compute derived mode from active context's resolved tabs
  const activeCtx = resolvedContexts[activeContext];
  const derivedMode: RuntimeMode = activeCtx
    ? deriveRuntimeMode(activeCtx.tabs, activeCtx.activeTabId)
    : "base";

  return {
    contexts: resolvedContexts,
    repairedConfig,
    derivedMode,
    diagnostics,
  };
}

// ─── Step 2: Migrate ───────────────────────────────────────────────────────

function migrateConfig(
  config: WorkspaceConfigV1,
  registry: ManifestRegistry,
  diagnostics: WorkspaceDiagnostic[],
): WorkspaceConfigV1 {
  if (config.version === 1) return config;

  // Unknown version - reset to default
  diagnostics.push({
    code: "config_migrated",
    message: `Unknown config version ${(config as { version: number }).version}; reset to default preset`,
    metadata: { fromVersion: (config as { version: number }).version },
  });

  return expandPreset(DEFAULT_PRESET_ID, registry);
}

// ─── Steps 3–6: Repair Pipeline (also exported standalone) ─────────────────

function repairConfigInternal(
  config: WorkspaceConfigV1,
  registry: ManifestRegistry,
): { config: WorkspaceConfigV1; diagnostics: WorkspaceDiagnostic[] } {
  const diagnostics: WorkspaceDiagnostic[] = [];
  let contexts = { ...config.contexts };

  // Process every context
  for (const contextId of Object.keys(contexts)) {
    let tabs = [...(contexts[contextId]?.orderedTabs ?? [])];

    // Step 3: Replace deprecated extensions
    tabs = replaceDeprecated(tabs, contextId, registry, diagnostics);

    // Step 4: Remove unknowns
    tabs = removeUnknowns(tabs, contextId, registry, diagnostics);

    // Step 5: Inject required
    tabs = injectRequired(tabs, contextId, registry, diagnostics);

    // Step 6: Canonicalize (deduplicate)
    tabs = deduplicateTabs(tabs, contextId, diagnostics);

    contexts = {
      ...contexts,
      [contextId]: { orderedTabs: tabs },
    };
  }

  // Also inject required tabs for contexts in the registry but not in config
  for (const contextId of registry.getAllContexts()) {
    if (contexts[contextId]) continue;

    const requiredTabs = registry
      .getTabsForContext(contextId)
      .filter((entry) => entry.tab.required)
      .map(
        (entry): WorkspaceTabEntry => ({
          extensionId: entry.extensionId,
          tabId: entry.tab.tabId,
          enabled: true,
        }),
      );

    if (requiredTabs.length > 0) {
      contexts = { ...contexts, [contextId]: { orderedTabs: requiredTabs } };
      for (const tab of requiredTabs) {
        diagnostics.push({
          code: "required_tab_injected",
          contextId,
          extensionId: tab.extensionId,
          tabId: tab.tabId,
          message: `Required tab "${tab.extensionId}:${tab.tabId}" injected for missing context "${contextId}"`,
        });
      }
    }
  }

  return {
    config: {
      ...config,
      contexts,
    },
    diagnostics,
  };
}

// ─── Step 3: Replace Deprecated ────────────────────────────────────────────

function replaceDeprecated(
  tabs: WorkspaceTabEntry[],
  contextId: string,
  registry: ManifestRegistry,
  diagnostics: WorkspaceDiagnostic[],
): WorkspaceTabEntry[] {
  return tabs.map((entry) => {
    const manifest = registry.getManifest(entry.extensionId);
    if (!manifest?.compatibility?.deprecated) return entry;

    const replacementId = manifest.compatibility.replacedBy;
    if (!replacementId) return entry;

    // Verify the replacement exists and has the same tab
    if (!registry.hasTab(replacementId, entry.tabId)) return entry;

    diagnostics.push({
      code: "deprecated_extension_replaced",
      contextId,
      extensionId: entry.extensionId,
      tabId: entry.tabId,
      message: `Deprecated extension "${entry.extensionId}" replaced by "${replacementId}"`,
      metadata: { from: entry.extensionId, to: replacementId },
    });

    return { ...entry, extensionId: replacementId };
  });
}

// ─── Step 4: Remove Unknowns ──────────────────────────────────────────────

function removeUnknowns(
  tabs: WorkspaceTabEntry[],
  contextId: string,
  registry: ManifestRegistry,
  diagnostics: WorkspaceDiagnostic[],
): WorkspaceTabEntry[] {
  return tabs.filter((entry) => {
    if (registry.hasTab(entry.extensionId, entry.tabId)) return true;

    diagnostics.push({
      code: "unknown_tab_removed",
      contextId,
      extensionId: entry.extensionId,
      tabId: entry.tabId,
      message: `Unknown tab "${entry.extensionId}:${entry.tabId}" removed from context "${contextId}"`,
    });
    return false;
  });
}

// ─── Step 5: Inject Required ───────────────────────────────────────────────

function injectRequired(
  tabs: WorkspaceTabEntry[],
  contextId: string,
  registry: ManifestRegistry,
  diagnostics: WorkspaceDiagnostic[],
): WorkspaceTabEntry[] {
  const requiredFromRegistry = registry
    .getTabsForContext(contextId)
    .filter((entry) => entry.tab.required);

  const presentKeys = new Set(
    tabs.map((t) => qualifiedTabId(t.extensionId, t.tabId)),
  );

  const toInject: WorkspaceTabEntry[] = [];
  for (const required of requiredFromRegistry) {
    const qid = qualifiedTabId(required.extensionId, required.tab.tabId);
    if (presentKeys.has(qid)) continue;

    toInject.push({
      extensionId: required.extensionId,
      tabId: required.tab.tabId,
      enabled: true,
    });

    diagnostics.push({
      code: "required_tab_injected",
      contextId,
      extensionId: required.extensionId,
      tabId: required.tab.tabId,
      message: `Required tab "${qid}" injected into context "${contextId}"`,
    });
  }

  return [...toInject, ...tabs];
}

// ─── Step 6: Canonicalize (Deduplicate) ────────────────────────────────────

function deduplicateTabs(
  tabs: WorkspaceTabEntry[],
  contextId: string,
  diagnostics: WorkspaceDiagnostic[],
): WorkspaceTabEntry[] {
  const seen = new Set<string>();
  const result: WorkspaceTabEntry[] = [];

  for (const entry of tabs) {
    const qid = qualifiedTabId(entry.extensionId, entry.tabId);
    if (seen.has(qid)) {
      diagnostics.push({
        code: "duplicate_tab_deduped",
        contextId,
        extensionId: entry.extensionId,
        tabId: entry.tabId,
        message: `Duplicate tab "${qid}" removed from context "${contextId}"`,
      });
      continue;
    }
    seen.add(qid);
    result.push(entry);
  }

  return result;
}

// ─── Step 7: Resolve Tab List with Availability ────────────────────────────

function resolveTabList(
  tabs: WorkspaceTabEntry[],
  contextId: string,
  registry: ManifestRegistry,
  product: Product,
  capabilities: string[],
  diagnostics: WorkspaceDiagnostic[],
): ResolvedTab[] {
  return tabs.map((entry) => {
    const tabContrib = registry.getTab(entry.extensionId, entry.tabId);
    const manifest = registry.getManifest(entry.extensionId);

    // This should not happen after repair, but be defensive
    if (!tabContrib || !manifest) {
      return buildFallbackResolvedTab(entry);
    }

    const availability = computeAvailability(
      tabContrib,
      manifest.compatibility?.deprecated ?? false,
      product,
      capabilities,
    );

    // Emit diagnostics for gated tabs
    if (availability.state === "hidden" && availability.reason === "missing_product") {
      diagnostics.push({
        code: "tab_hidden_due_to_product",
        contextId,
        extensionId: entry.extensionId,
        tabId: entry.tabId,
        message: `Tab "${entry.extensionId}:${entry.tabId}" hidden - requires product [${(tabContrib.productRequirements ?? []).join(", ")}]`,
        metadata: {
          requiredProducts: tabContrib.productRequirements,
          currentProduct: product,
          upgradeTarget: availability.upgradeTarget,
        },
      });
    } else if (availability.state === "disabled" && availability.reason === "missing_product") {
      diagnostics.push({
        code: "tab_disabled_due_to_product",
        contextId,
        extensionId: entry.extensionId,
        tabId: entry.tabId,
        message: `Tab "${entry.extensionId}:${entry.tabId}" disabled - requires product [${(tabContrib.productRequirements ?? []).join(", ")}]`,
        metadata: {
          requiredProducts: tabContrib.productRequirements,
          currentProduct: product,
          upgradeTarget: availability.upgradeTarget,
        },
      });
    }

    return {
      extensionId: entry.extensionId,
      tabId: entry.tabId,
      qualifiedId: qualifiedTabId(entry.extensionId, entry.tabId),
      label: tabContrib.label,
      description: tabContrib.description,
      iconKey: tabContrib.iconKey,
      category: tabContrib.category,
      routeSegment: tabContrib.routeSegment,
      enabled: entry.enabled,
      required: tabContrib.required,
      availability,
      contributesMode: tabContrib.contributesMode,
      backgroundRuntime: tabContrib.backgroundRuntime,
    };
  });
}

function computeAvailability(
  tab: WorkspaceTabContribution,
  deprecated: boolean,
  product: Product,
  capabilities: string[],
): TabAvailability {
  // Deprecated extension → disabled
  if (deprecated) {
    return { state: "disabled", reason: "deprecated" };
  }

  // Product gating
  const requiredProducts = tab.productRequirements ?? [];
  if (requiredProducts.length > 0 && !requiredProducts.includes(product)) {
    const upgradeTarget = requiredProducts[0];
    if (tab.unavailableVisibility === "hidden") {
      return { state: "hidden", reason: "missing_product", upgradeTarget };
    }
    return { state: "disabled", reason: "missing_product", upgradeTarget };
  }

  // Capability gating (future)
  const requiredCaps = tab.capabilityRequirements ?? [];
  if (requiredCaps.length > 0 && !requiredCaps.every((c) => capabilities.includes(c))) {
    if (tab.unavailableVisibility === "hidden") {
      return { state: "hidden", reason: "missing_capability" };
    }
    return { state: "disabled", reason: "missing_capability" };
  }

  return { state: "enabled", reason: "available" };
}

function buildFallbackResolvedTab(entry: WorkspaceTabEntry): ResolvedTab {
  return {
    extensionId: entry.extensionId,
    tabId: entry.tabId,
    qualifiedId: qualifiedTabId(entry.extensionId, entry.tabId),
    label: entry.tabId,
    description: "",
    iconKey: "help-circle",
    category: "core",
    routeSegment: entry.tabId,
    enabled: entry.enabled,
    required: false,
    availability: { state: "disabled", reason: "unknown" },
  };
}

// ─── Step 8: Compute Active/Default Tab ────────────────────────────────────

function computeActiveTab(
  resolvedTabs: ResolvedTab[],
  contextId: string,
  requestedTab: string | null,
  diagnostics: WorkspaceDiagnostic[],
): { activeTabId: string; defaultTabId: string } {
  const enabledNonHidden = resolvedTabs.filter(
    (t) => t.enabled && t.availability.state !== "hidden",
  );

  // Default = first enabled required tab, or first enabled tab
  const firstEnabledRequired = enabledNonHidden.find((t) => t.required);
  const firstEnabled = enabledNonHidden[0];
  const defaultTab = firstEnabledRequired ?? firstEnabled;
  const defaultTabId = defaultTab?.routeSegment ?? "";

  // Active = requested tab if it matches an enabled non-hidden tab
  if (requestedTab !== null) {
    const match = enabledNonHidden.find((t) => t.routeSegment === requestedTab);
    if (match) {
      return { activeTabId: match.routeSegment, defaultTabId };
    }

    // Requested tab was invalid - fall back
    diagnostics.push({
      code: "active_tab_fell_back",
      contextId,
      message: `Requested tab "${requestedTab}" not found or not available in context "${contextId}"; fell back to "${defaultTabId}"`,
      metadata: { requestedTab, fallbackTab: defaultTabId },
    });
  }

  return { activeTabId: defaultTabId, defaultTabId };
}

// ─── Step 10: Compute Available (Addable) Tabs ────────────────────────────

function computeAvailableTabs(
  configTabs: WorkspaceTabEntry[],
  contextId: string,
  registry: ManifestRegistry,
  product: Product,
  capabilities: string[],
): ResolvedTab[] {
  const presentKeys = new Set(
    configTabs.map((t) => qualifiedTabId(t.extensionId, t.tabId)),
  );

  const allInContext = registry.getTabsForContext(contextId);
  const addable: ResolvedTab[] = [];

  for (const { extensionId, tab } of allInContext) {
    const qid = qualifiedTabId(extensionId, tab.tabId);
    if (presentKeys.has(qid)) continue;

    const manifest = registry.getManifest(extensionId);
    const deprecated = manifest?.compatibility?.deprecated ?? false;
    const availability = computeAvailability(tab, deprecated, product, capabilities);

    // Hidden tabs are not addable
    if (availability.state === "hidden") continue;

    addable.push({
      extensionId,
      tabId: tab.tabId,
      qualifiedId: qid,
      label: tab.label,
      description: tab.description,
      iconKey: tab.iconKey,
      category: tab.category,
      routeSegment: tab.routeSegment,
      enabled: false,
      required: tab.required,
      availability,
      contributesMode: tab.contributesMode,
      backgroundRuntime: tab.backgroundRuntime,
    });
  }

  return addable;
}

// ─── Step 11: Build Repaired Config ────────────────────────────────────────

function buildRepairedConfig(
  config: WorkspaceConfigV1,
  resolvedContexts: Record<string, ResolvedContextState>,
): WorkspaceConfigV1 {
  const contexts: Record<string, WorkspaceContextConfig> = {};

  for (const [contextId, resolved] of Object.entries(resolvedContexts)) {
    contexts[contextId] = {
      orderedTabs: resolved.tabs.map(
        (t): WorkspaceTabEntry => ({
          extensionId: t.extensionId,
          tabId: t.tabId,
          enabled: t.enabled,
        }),
      ),
    };
  }

  return {
    version: 1,
    revision: config.revision,
    basedOnPresetId: config.basedOnPresetId,
    contexts,
  };
}

// ─── Exported Helpers ──────────────────────────────────────────────────────

// Normalize a config for canonical comparison.
export function normalizeConfig(config: WorkspaceConfigV1): WorkspaceConfigV1 {
  const sortedKeys = Object.keys(config.contexts).sort();
  const contexts: Record<string, WorkspaceContextConfig> = {};

  for (const key of sortedKeys) {
    const ctx = config.contexts[key];
    if (!ctx) continue;

    // Deduplicate: keep first occurrence
    const seen = new Set<string>();
    const deduped: WorkspaceTabEntry[] = [];
    for (const entry of ctx.orderedTabs) {
      const qid = qualifiedTabId(entry.extensionId, entry.tabId);
      if (seen.has(qid)) continue;
      seen.add(qid);
      deduped.push(entry);
    }

    contexts[key] = { orderedTabs: deduped };
  }

  return {
    version: 1,
    revision: config.revision,
    basedOnPresetId: config.basedOnPresetId,
    contexts,
  };
}

// Type guard: validates that a raw value conforms to WorkspaceConfigV1 shape.
export function validateConfigShape(raw: unknown): raw is WorkspaceConfigV1 {
  if (raw === null || raw === undefined || typeof raw !== "object") return false;

  const obj = raw as Record<string, unknown>;

  if (obj.version !== 1) return false;
  if (typeof obj.revision !== "number" || !Number.isInteger(obj.revision) || obj.revision < 0) {
    return false;
  }
  if (obj.basedOnPresetId !== null && typeof obj.basedOnPresetId !== "string") return false;
  if (typeof obj.contexts !== "object" || obj.contexts === null || Array.isArray(obj.contexts)) {
    return false;
  }

  const contexts = obj.contexts as Record<string, unknown>;
  for (const key of Object.keys(contexts)) {
    const ctx = contexts[key];
    if (typeof ctx !== "object" || ctx === null || Array.isArray(ctx)) return false;

    const ctxObj = ctx as Record<string, unknown>;
    if (!Array.isArray(ctxObj.orderedTabs)) return false;

    for (const tab of ctxObj.orderedTabs as unknown[]) {
      if (typeof tab !== "object" || tab === null || Array.isArray(tab)) return false;
      const tabObj = tab as Record<string, unknown>;
      if (typeof tabObj.extensionId !== "string") return false;
      if (typeof tabObj.tabId !== "string") return false;
      if (typeof tabObj.enabled !== "boolean") return false;
    }
  }

  return true;
}

// Standalone repair: applies steps 3–6 of the pipeline.
export function repairConfig(
  config: WorkspaceConfigV1,
  registry: ManifestRegistry,
): { config: WorkspaceConfigV1; diagnostics: WorkspaceDiagnostic[] } {
  return repairConfigInternal(config, registry);
}
