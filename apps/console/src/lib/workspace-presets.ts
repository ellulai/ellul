// SPDX-License-Identifier: MIT

// Workspace Presets - Named tab configurations for common use cases.

import type {
  WorkspaceConfigV1,
  WorkspaceContextConfig,
  WorkspaceTabEntry,
} from "./workspace-extensions";
import { ManifestRegistry } from "./workspace-extensions";
import { isContextVisible, isExtensionVisible } from "./feature-flags";

// ─── Preset Interface ──────────────────────────────────────────────────────

export interface WorkspacePreset {
  id: string;
  label: string;
  description: string;
  iconKey: string;
  // Default desktop layout when this preset is selected during onboarding.
  defaultViewMode: "focus" | "studio";
  contexts: Record<string, Array<{ extensionId: string; tabId: string }>>;
}

// ─── Preset Tab Shorthand ──────────────────────────────────────────────────

type PresetTab = { extensionId: string; tabId: string };

function tab(extensionId: string, tabId: string = "main"): PresetTab {
  return { extensionId, tabId };
}

// ─── Shared Context Definitions ────────────────────────────────────────────

const DEVELOPER_WORKSPACE: PresetTab[] = [
  tab("core.chat"),
  tab("core.code"),
];

const DEVELOPER_VAULT: PresetTab[] = [
  tab("core.vault.notes"),
  tab("core.vault.graph"),
  tab("core.vault.scopes"),
];

const PREVIEW_OBSERVABILITY: PresetTab[] = [
  tab("core.obs.health"),
  tab("core.obs.gates"),
  tab("core.obs.development"),
  tab("core.obs.claw"),
];

const DEVELOPER_SETTINGS: PresetTab[] = [
  tab("core.settings.context"),
  tab("core.settings.secrets"),
  tab("core.settings.security"),
];

const DEVELOPER_DATABASE: PresetTab[] = [
  tab("core.db.tables"),
  tab("core.db.sql"),
  tab("core.db.bin"),
  tab("core.db.settings"),
];

// ─── Preset Definitions ───────────────────────────────────────────────────

const SHARED_CONTEXTS: WorkspacePreset["contexts"] = {
  workspace: [...DEVELOPER_WORKSPACE, tab("core.preview")],
  vault: DEVELOPER_VAULT,
  observability: PREVIEW_OBSERVABILITY,
  settings: DEVELOPER_SETTINGS,
  database: DEVELOPER_DATABASE,
};

const PRESET_DEVELOPER: WorkspacePreset = {
  id: "developer",
  label: "Developer",
  description: "Full dev workflow with code, terminal, and every tool",
  iconKey: "terminal",
  defaultViewMode: "focus",
  contexts: SHARED_CONTEXTS,
};

const PRESET_STUDIO: WorkspacePreset = {
  id: "studio",
  label: "Studio",
  description: "Streamlined chat and preview for quick iteration",
  iconKey: "rocket",
  defaultViewMode: "studio",
  contexts: SHARED_CONTEXTS,
};

// ─── Exports ───────────────────────────────────────────────────────────────

export const DEFAULT_PRESET_ID = "developer";

// Strip gated contexts and extensions from a preset.
function applyReleaseGates(preset: WorkspacePreset): WorkspacePreset {
  const contexts: typeof preset.contexts = {};
  let changed = false;
  for (const [key, tabs] of Object.entries(preset.contexts)) {
    if (!isContextVisible(key)) { changed = true; continue; }
    const filtered = tabs.filter((t) => isExtensionVisible(t.extensionId));
    if (filtered.length !== tabs.length) changed = true;
    if (filtered.length > 0) contexts[key] = filtered;
  }
  return changed ? { ...preset, contexts } : preset;
}

export const ALL_PRESETS: readonly WorkspacePreset[] = [
  PRESET_DEVELOPER,
  PRESET_STUDIO,
].map(applyReleaseGates);

export const WORKSPACE_PRESETS: ReadonlyMap<string, WorkspacePreset> = new Map([
  ...ALL_PRESETS.map((p) => [p.id, p] as const),
  // Back-compat: existing workspaces may have basedOnPresetId: "vibe-coder" persisted.
  ["vibe-coder", ALL_PRESETS.find((p) => p.id === "studio") ?? PRESET_STUDIO] as const,
]);

// ─── Expansion ─────────────────────────────────────────────────────────────

// Build default tabs for a context from the registry.
function defaultTabsForContext(
  context: string,
  registry: ManifestRegistry,
): WorkspaceTabEntry[] {
  return registry
    .getTabsForContext(context)
    .filter((entry) => entry.tab.required || entry.tab.defaultEnabled)
    .map((entry) => ({
      extensionId: entry.extensionId,
      tabId: entry.tab.tabId,
      enabled: true,
    }));
}

// Expand a preset into a full `WorkspaceConfigV1`.
export function expandPreset(
  presetId: string,
  registry: ManifestRegistry,
): WorkspaceConfigV1 {
  const preset = WORKSPACE_PRESETS.get(presetId);
  if (!preset) {
    throw new Error(`Unknown workspace preset: "${presetId}"`);
  }

  const allContexts = registry.getAllContexts();
  const contexts: Record<string, WorkspaceContextConfig> = {};

  for (const context of allContexts) {
    const presetTabs = preset.contexts[context];
    if (presetTabs) {
      // Preset explicitly defines this context - use its tab list
      contexts[context] = {
        orderedTabs: presetTabs.map(
          (t): WorkspaceTabEntry => ({
            extensionId: t.extensionId,
            tabId: t.tabId,
            enabled: true,
          }),
        ),
      };
    } else {
      // Context not in the preset - fill from registry defaults
      contexts[context] = {
        orderedTabs: defaultTabsForContext(context, registry),
      };
    }
  }

  return {
    version: 1,
    revision: 0,
    basedOnPresetId: presetId,
    contexts,
  };
}

// ─── Comparison ────────────────────────────────────────────────────────────

// Check whether a config exactly matches the expanded form of a preset.
export function isExactPresetMatch(
  config: WorkspaceConfigV1,
  presetId: string,
  registry: ManifestRegistry,
): boolean {
  const preset = WORKSPACE_PRESETS.get(presetId);
  if (!preset) return false;

  const expanded = expandPreset(presetId, registry);

  // Both must have the exact same set of context keys
  const configContexts = Object.keys(config.contexts).sort();
  const expandedContexts = Object.keys(expanded.contexts).sort();

  if (configContexts.length !== expandedContexts.length) return false;
  for (let i = 0; i < configContexts.length; i++) {
    if (configContexts[i] !== expandedContexts[i]) return false;
  }

  // Every context must have identical ordered tabs
  for (const context of configContexts) {
    const configTabs = config.contexts[context]?.orderedTabs ?? [];
    const expandedTabs = expanded.contexts[context]?.orderedTabs ?? [];

    if (configTabs.length !== expandedTabs.length) return false;

    for (let i = 0; i < configTabs.length; i++) {
      const a = configTabs[i]!;
      const b = expandedTabs[i]!;
      if (
        a.extensionId !== b.extensionId ||
        a.tabId !== b.tabId ||
        a.enabled !== b.enabled
      ) {
        return false;
      }
    }
  }

  return true;
}
