// SPDX-License-Identifier: MIT

// Workspace Extension System - Manifest Layer

import type { Product } from "./tier-utils";
import type { WorkspaceConfigV1 } from "@ellul.ai/types";

// Re-export shared types for backward compatibility
export type {
  WorkspaceConfigV1,
  WorkspaceContextConfig,
  WorkspaceTabEntry,
} from "@ellul.ai/types";

// ─── Shell version ──────────────────────────────────────────────────────────

export const WORKSPACE_SHELL_VERSION = "1.0.0";

// ─── Extension Manifest ─────────────────────────────────────────────────────

export interface WorkspaceExtensionManifestV1 {
  // Namespaced extension ID. Format: "{namespace}.{name}" (e.g. "core.chat")
  id: string;
  // Semver version string
  version: string;
  // Human-readable name
  name: string;
  // Human-readable description
  description: string;
  // Author or organization
  author: string;
  // Tab contributions from this extension
  tabs: WorkspaceTabContribution[];
  // Compatibility metadata for migration and deprecation
  compatibility?: ExtensionCompatibility;
}

export interface ExtensionCompatibility {
  // Minimum shell version required
  minShellVersion?: string;
  // Whether this extension is deprecated
  deprecated?: boolean;
  // Extension ID that replaces this one
  replacedBy?: string;
  // Human-readable deprecation message
  deprecationMessage?: string;
}

// ─── Tab Contribution ───────────────────────────────────────────────────────

export type TabCategory =
  | "core"
  | "development"
  | "data"
  | "operations"
  | "collaboration";

export type UnavailableVisibility = "hidden" | "disabled";

export interface WorkspaceTabContribution {
  // Tab ID local to the extension (e.g. "main", "panel")
  tabId: string;
  // Which context this tab belongs to (e.g. "workspace", "vault", "settings")
  context: string;
  // Display label
  label: string;
  // Description shown in the customizer
  description: string;
  // Key used to resolve the icon from the runtime binding registry
  iconKey: string;
  // Categorization for UI grouping
  category: TabCategory;
  // URL search param value for this tab - MUST be unique per context across all extensions
  routeSegment: string;
  // Whether this tab is included in default configurations
  defaultEnabled: boolean;
  // Whether this tab cannot be removed by the user
  required: boolean;
  // How this tab appears when product/capability requirements are not met
  unavailableVisibility: UnavailableVisibility;
  // Product types required for this tab (empty = available to all)
  productRequirements?: Product[];
  // Future: capability/feature flag requirements
  capabilityRequirements?: string[];
  // Runtime mode this tab contributes when active (e.g. "preview", "deploy")
  contributesMode?: string;
  // If true, this tab contributes its mode even when not the active tab
  backgroundRuntime?: boolean;
}

// ─── Config Schema ──────────────────────────────────────────────────────────
// WorkspaceConfigV1, WorkspaceContextConfig, WorkspaceTabEntry are now defined

// ─── Resolved State Contract ────────────────────────────────────────────────

export type TabAvailabilityState = "enabled" | "disabled" | "hidden";

export type TabAvailabilityReason =
  | "available"
  | "missing_product"
  | "missing_capability"
  | "policy_blocked"
  | "deprecated"
  | "unknown";

export interface TabAvailability {
  state: TabAvailabilityState;
  reason: TabAvailabilityReason;
  // e.g. "cloud_platform" if product-gated
  upgradeTarget?: string;
}

export interface ResolvedTab {
  extensionId: string;
  tabId: string;
  // Fully qualified: "core.chat:main"
  qualifiedId: string;
  label: string;
  description: string;
  iconKey: string;
  category: TabCategory;
  routeSegment: string;
  enabled: boolean;
  required: boolean;
  availability: TabAvailability;
  contributesMode?: string;
  backgroundRuntime?: boolean;
}

export interface ResolvedContextState {
  // Ordered tabs for this context (after resolution + gating)
  tabs: ResolvedTab[];
  // Tabs available to add (in registry, not in config, not hidden)
  availableTabs: ResolvedTab[];
  // Currently active tab route segment
  activeTabId: string;
  // Default tab route segment (first enabled required tab)
  defaultTabId: string;
  // False if all tabs are hidden - context should not be shown
  available: boolean;
}

export interface ResolvedWorkspaceState {
  contexts: Record<string, ResolvedContextState>;
  repairedConfig: WorkspaceConfigV1;
  derivedMode: RuntimeMode;
  diagnostics: WorkspaceDiagnostic[];
}

// ─── Runtime Mode ───────────────────────────────────────────────────────────

export type RuntimeMode = "base" | "preview";

// ─── Diagnostics ────────────────────────────────────────────────────────────

export type DiagnosticCode =
  | "unknown_tab_removed"
  | "required_tab_injected"
  | "tab_hidden_due_to_product"
  | "tab_disabled_due_to_product"
  | "active_tab_fell_back"
  | "deprecated_extension_replaced"
  | "config_repaired"
  | "preset_applied"
  | "context_unavailable"
  | "missing_runtime_binding"
  | "extension_render_error"
  | "duplicate_tab_deduped"
  | "config_migrated";

export interface WorkspaceDiagnostic {
  code: DiagnosticCode;
  contextId?: string;
  extensionId?: string;
  tabId?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

// ─── Manifest Registry ──────────────────────────────────────────────────────

export class ManifestRegistry {
  private manifests = new Map<string, WorkspaceExtensionManifestV1>();
  // routeSegment → extensionId:tabId for uniqueness enforcement
  private routeSegments = new Map<string, string>();

  // Register an extension manifest.
  register(manifest: WorkspaceExtensionManifestV1): void {
    for (const tab of manifest.tabs) {
      const key = `${tab.context}:${tab.routeSegment}`;
      const existing = this.routeSegments.get(key);
      if (existing && existing !== `${manifest.id}:${tab.tabId}`) {
        throw new Error(
          `Route segment "${tab.routeSegment}" in context "${tab.context}" is already registered by "${existing}". ` +
            `Extension "${manifest.id}" tab "${tab.tabId}" cannot reuse it.`,
        );
      }
    }

    // All checks passed - commit
    this.manifests.set(manifest.id, manifest);
    for (const tab of manifest.tabs) {
      const key = `${tab.context}:${tab.routeSegment}`;
      this.routeSegments.set(key, `${manifest.id}:${tab.tabId}`);
    }
  }

  getManifest(extensionId: string): WorkspaceExtensionManifestV1 | undefined {
    return this.manifests.get(extensionId);
  }

  getTab(
    extensionId: string,
    tabId: string,
  ): WorkspaceTabContribution | undefined {
    const manifest = this.manifests.get(extensionId);
    if (!manifest) return undefined;
    return manifest.tabs.find((t) => t.tabId === tabId);
  }

  getTabByRouteSegment(
    context: string,
    routeSegment: string,
  ): { extensionId: string; tab: WorkspaceTabContribution } | undefined {
    const key = `${context}:${routeSegment}`;
    const qualifiedId = this.routeSegments.get(key);
    if (!qualifiedId) return undefined;
    const colonIdx = qualifiedId.lastIndexOf(":");
    if (colonIdx === -1) return undefined;
    const extensionId = qualifiedId.slice(0, colonIdx);
    const tabId = qualifiedId.slice(colonIdx + 1);
    const tab = this.getTab(extensionId, tabId);
    if (!tab) return undefined;
    return { extensionId, tab };
  }

  getTabsForContext(
    context: string,
  ): Array<{ extensionId: string; tab: WorkspaceTabContribution }> {
    const results: Array<{
      extensionId: string;
      tab: WorkspaceTabContribution;
    }> = [];
    for (const manifest of this.manifests.values()) {
      for (const tab of manifest.tabs) {
        if (tab.context === context) {
          results.push({ extensionId: manifest.id, tab });
        }
      }
    }
    return results;
  }

  getAllExtensions(): WorkspaceExtensionManifestV1[] {
    return Array.from(this.manifests.values());
  }

  // All unique context IDs across all registered tabs
  getAllContexts(): string[] {
    const contexts = new Set<string>();
    for (const manifest of this.manifests.values()) {
      for (const tab of manifest.tabs) {
        contexts.add(tab.context);
      }
    }
    return Array.from(contexts);
  }

  // Look up the replacement extension ID for a deprecated extension.
  getReplacementFor(deprecatedId: string): string | undefined {
    // Check the deprecated manifest itself first
    const manifest = this.manifests.get(deprecatedId);
    if (manifest?.compatibility?.replacedBy) {
      return manifest.compatibility.replacedBy;
    }
    // Also check all manifests in case the deprecated one was already removed
    for (const m of this.manifests.values()) {
      if (m.compatibility?.replacedBy === deprecatedId) {
        // This manifest IS the replacement - but we want the reverse lookup
        continue;
      }
    }
    return undefined;
  }

  // Check if an extension ID exists
  has(extensionId: string): boolean {
    return this.manifests.has(extensionId);
  }

  // Check if a specific tab exists
  hasTab(extensionId: string, tabId: string): boolean {
    return this.getTab(extensionId, tabId) !== undefined;
  }
}

// ─── First-Party Extension Manifests ────────────────────────────────────────

export const CORE_CHAT: WorkspaceExtensionManifestV1 = {
  id: "core.chat",
  version: "1.0.0",
  name: "Chat",
  description: "AI chat interface for interacting with your workspace",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "workspace",
      label: "Chat",
      description: "AI-powered chat for building and iterating on your project",
      iconKey: "terminal",
      category: "core",
      routeSegment: "chat",
      defaultEnabled: true,
      required: true,
      unavailableVisibility: "disabled",
    },
  ],
};

export const CORE_CODE: WorkspaceExtensionManifestV1 = {
  id: "core.code",
  version: "1.0.0",
  name: "Code",
  description: "Code browser and editor",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "workspace",
      label: "Code",
      description: "Browse and edit your project files",
      iconKey: "file-code",
      category: "core",
      routeSegment: "code",
      defaultEnabled: true,
      required: false,
      unavailableVisibility: "disabled",
    },
  ],
};

export const CORE_PREVIEW: WorkspaceExtensionManifestV1 = {
  id: "core.preview",
  version: "1.0.0",
  name: "Live Preview",
  description: "Real-time preview of your running application",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "workspace",
      label: "Preview",
      description:
        "Live preview with hot reload - starts a dev server for your app",
      iconKey: "smartphone",
      category: "development",
      routeSegment: "preview",
      defaultEnabled: false,
      required: false,
      unavailableVisibility: "disabled",
      contributesMode: "preview",
      backgroundRuntime: false,
    },
  ],
};

export const CORE_VAULT_NOTES: WorkspaceExtensionManifestV1 = {
  id: "core.vault.notes",
  version: "1.0.0",
  name: "Vault Notes",
  description: "Persistent notes and knowledge base",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "vault",
      label: "Notes",
      description: "Persistent notes and documentation",
      iconKey: "file-text",
      category: "collaboration",
      routeSegment: "notes",
      defaultEnabled: true,
      required: true,
      unavailableVisibility: "disabled",
    },
  ],
};

export const CORE_VAULT_GRAPH: WorkspaceExtensionManifestV1 = {
  id: "core.vault.graph",
  version: "1.0.0",
  name: "Vault Graph",
  description: "Knowledge graph visualization",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "vault",
      label: "Graph",
      description: "Visual knowledge graph of your notes and connections",
      iconKey: "network",
      category: "collaboration",
      routeSegment: "graph",
      defaultEnabled: true,
      required: false,
      unavailableVisibility: "disabled",
    },
  ],
};

export const CORE_VAULT_SCOPES: WorkspaceExtensionManifestV1 = {
  id: "core.vault.scopes",
  version: "1.0.0",
  name: "Vault Scopes",
  description: "Scoped access control for vault entries",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "vault",
      label: "Scopes",
      description: "Manage access scopes for vault entries",
      iconKey: "shield",
      category: "collaboration",
      routeSegment: "scopes",
      defaultEnabled: true,
      required: false,
      unavailableVisibility: "disabled",
    },
  ],
};

export const CORE_DB_TABLES: WorkspaceExtensionManifestV1 = {
  id: "core.db.tables",
  version: "1.0.0",
  name: "Database Tables",
  description: "Browse database tables and data",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "database",
      label: "Tables",
      description: "Browse and manage your database tables",
      iconKey: "table",
      category: "data",
      routeSegment: "tables",
      defaultEnabled: true,
      required: true,
      unavailableVisibility: "disabled",
      productRequirements: ["cloud_platform"],
    },
  ],
};

export const CORE_DB_SQL: WorkspaceExtensionManifestV1 = {
  id: "core.db.sql",
  version: "1.0.0",
  name: "SQL Editor",
  description: "Execute SQL queries",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "database",
      label: "SQL",
      description: "Interactive SQL query editor",
      iconKey: "code",
      category: "data",
      routeSegment: "sql",
      defaultEnabled: true,
      required: false,
      unavailableVisibility: "disabled",
      productRequirements: ["cloud_platform"],
    },
  ],
};

export const CORE_DB_BIN: WorkspaceExtensionManifestV1 = {
  id: "core.db.bin",
  version: "1.0.0",
  name: "Database Bin",
  description: "Recycle bin for deleted database records",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "database",
      label: "Bin",
      description: "View and restore deleted records",
      iconKey: "trash",
      category: "data",
      routeSegment: "bin",
      defaultEnabled: true,
      required: false,
      unavailableVisibility: "hidden",
      productRequirements: ["cloud_platform"],
    },
  ],
};

export const CORE_DB_SETTINGS: WorkspaceExtensionManifestV1 = {
  id: "core.db.settings",
  version: "1.0.0",
  name: "Database Settings",
  description: "Database configuration and management",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "database",
      label: "Settings",
      description: "Database connection, roles, and configuration",
      iconKey: "settings",
      category: "data",
      routeSegment: "settings",
      defaultEnabled: true,
      required: false,
      unavailableVisibility: "hidden",
      productRequirements: ["cloud_platform"],
    },
  ],
};

export const CORE_OBS_HEALTH: WorkspaceExtensionManifestV1 = {
  id: "core.obs.health",
  version: "1.0.0",
  name: "Health Monitor",
  description: "Server health and performance metrics",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "observability",
      label: "Health",
      description: "CPU, memory, and server health metrics",
      iconKey: "activity",
      category: "operations",
      routeSegment: "health",
      defaultEnabled: true,
      required: true,
      unavailableVisibility: "disabled",
    },
  ],
};

export const CORE_OBS_GATES: WorkspaceExtensionManifestV1 = {
  id: "core.obs.gates",
  version: "1.0.0",
  name: "Gate Monitor",
  description: "Monitor sovereign gate activity",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "observability",
      label: "Gates",
      description: "View gate requests, approvals, and audit trail",
      iconKey: "shield",
      category: "operations",
      routeSegment: "gates",
      defaultEnabled: true,
      required: false,
      unavailableVisibility: "disabled",
    },
  ],
};

export const CORE_OBS_DEV: WorkspaceExtensionManifestV1 = {
  id: "core.obs.development",
  version: "1.0.0",
  name: "Development Logs",
  description: "Dev server logs - visible when Preview is enabled",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "observability",
      label: "Development",
      description: "Dev server and build logs (requires Preview tab)",
      iconKey: "terminal",
      category: "operations",
      routeSegment: "development",
      defaultEnabled: false,
      required: false,
      unavailableVisibility: "hidden",
    },
  ],
};

export const CORE_OBS_CLAW: WorkspaceExtensionManifestV1 = {
  id: "core.obs.claw",
  version: "1.0.0",
  name: "ZeroClaw Monitor",
  description: "ZeroClaw agent activity monitoring",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "observability",
      label: "ZeroClaw",
      description: "Monitor AI agent sessions and activity",
      iconKey: "bot",
      category: "operations",
      routeSegment: "claw",
      defaultEnabled: true,
      required: false,
      unavailableVisibility: "disabled",
    },
  ],
};

export const CORE_SETTINGS_CONTEXT: WorkspaceExtensionManifestV1 = {
  id: "core.settings.context",
  version: "1.0.0",
  name: "Context Settings",
  description: "AI context file management",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "settings",
      label: "Context",
      description: "Manage AI context files (CLAUDE.md, etc.)",
      iconKey: "brain",
      category: "core",
      routeSegment: "context",
      defaultEnabled: true,
      required: true,
      unavailableVisibility: "disabled",
    },
  ],
};

// CORE_SETTINGS_GIT removed - git connections moved to Integrations → Source Control

export const CORE_SETTINGS_SECRETS: WorkspaceExtensionManifestV1 = {
  id: "core.settings.secrets",
  version: "1.0.0",
  name: "Secrets Manager",
  description: "Environment variables and secret management",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "settings",
      label: "Secrets",
      description: "Manage environment variables and API keys",
      iconKey: "key",
      category: "core",
      routeSegment: "secrets",
      defaultEnabled: true,
      required: false,
      unavailableVisibility: "disabled",
    },
  ],
};

// CORE_SETTINGS_CLAW removed - AI agent config moved to Integrations → AI Agents

export const CORE_SETTINGS_SECURITY: WorkspaceExtensionManifestV1 = {
  id: "core.settings.security",
  version: "1.0.0",
  name: "Security Settings",
  description: "Security tier, passkeys, and access control",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "settings",
      label: "Security",
      description: "Manage security tier, passkeys, SSH keys, and permissions",
      iconKey: "shield",
      category: "core",
      routeSegment: "security",
      defaultEnabled: true,
      required: true,
      unavailableVisibility: "disabled",
    },
  ],
};

// CORE_INT_SOURCE_CONTROL removed — source control is now a dynamic integration group

export const CORE_INT_ZEROCLAW: WorkspaceExtensionManifestV1 = {
  id: "core.int.zeroclaw",
  version: "1.0.0",
  name: "ZeroClaw",
  description: "ZeroClaw agent configuration - API keys, channels, and core files",
  author: "ellul",
  tabs: [
    {
      tabId: "main",
      context: "integrations",
      label: "ZeroClaw",
      description:
        "Configure ZeroClaw API keys, communication channels, and core context files",
      iconKey: "bot",
      category: "operations",
      routeSegment: "zeroclaw",
      defaultEnabled: true,
      required: false,
      unavailableVisibility: "disabled",
    },
  ],
};

// ─── All First-Party Manifests ──────────────────────────────────────────────

export const FIRST_PARTY_MANIFESTS: WorkspaceExtensionManifestV1[] = [
  // Workspace
  CORE_CHAT,
  CORE_CODE,
  CORE_PREVIEW,
  // Vault
  CORE_VAULT_NOTES,
  CORE_VAULT_GRAPH,
  CORE_VAULT_SCOPES,
  // Database
  CORE_DB_TABLES,
  CORE_DB_SQL,
  CORE_DB_BIN,
  CORE_DB_SETTINGS,
  // Observability
  CORE_OBS_HEALTH,
  CORE_OBS_GATES,
  CORE_OBS_DEV,
  CORE_OBS_CLAW,
  // Settings
  CORE_SETTINGS_CONTEXT,
  CORE_SETTINGS_SECRETS,
  CORE_SETTINGS_SECURITY,
  // Integrations (dynamic groups replace source-control, deploy, data)
  CORE_INT_ZEROCLAW,
];

// ─── Default Registry Instance ──────────────────────────────────────────────

// Create and populate a manifest registry with all first-party extensions.
export function createDefaultRegistry(): ManifestRegistry {
  const registry = new ManifestRegistry();
  for (const manifest of FIRST_PARTY_MANIFESTS) {
    registry.register(manifest);
  }
  return registry;
}

// ─── Qualified ID Helpers ───────────────────────────────────────────────────

// Build a qualified tab ID: "core.chat:main"
export function qualifiedTabId(extensionId: string, tabId: string): string {
  return `${extensionId}:${tabId}`;
}

// Parse a qualified tab ID back to components
export function parseQualifiedTabId(
  qualifiedId: string,
): { extensionId: string; tabId: string } | null {
  const colonIdx = qualifiedId.lastIndexOf(":");
  if (colonIdx === -1) return null;
  return {
    extensionId: qualifiedId.slice(0, colonIdx),
    tabId: qualifiedId.slice(colonIdx + 1),
  };
}
