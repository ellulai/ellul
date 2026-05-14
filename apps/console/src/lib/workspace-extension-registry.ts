// SPDX-License-Identifier: MIT

// Missing bindings degrade gracefully - they never crash the shell.

"use client";

import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Terminal,
  FileCode,
  Smartphone,
  FileText,
  Network,
  Shield,
  Info,
  Table2,
  Code2,
  Trash2,
  Settings,
  Activity,
  Bot,
  Rocket,
  Brain,
  GitBranch,
  Key,
  Layers,
} from "lucide-react";
import { isExtensionVisible } from "./feature-flags";

// ─── Renderer Props ─────────────────────────────────────────────────────────

// Props passed to every tab renderer component.
export interface TabRendererProps {
  [key: string]: unknown;
}

// ─── Binding Types ──────────────────────────────────────────────────────────

export interface TabRendererBinding {
  extensionId: string;
  tabId: string;
  component: ComponentType<TabRendererProps>;
  icon: LucideIcon;
}

// ─── Runtime Binding Registry ───────────────────────────────────────────────

export class RuntimeBindingRegistry {
  private bindings = new Map<string, TabRendererBinding>();

  // Bind a tab to a React component and icon.
  bindTab(
    extensionId: string,
    tabId: string,
    component: ComponentType<TabRendererProps>,
    icon: LucideIcon,
  ): void {
    const key = `${extensionId}:${tabId}`;
    this.bindings.set(key, { extensionId, tabId, component, icon });
  }

  // Returns null if no binding exists - caller must show fallback UI.
  getRenderer(extensionId: string, tabId: string): TabRendererBinding | null {
    return this.bindings.get(`${extensionId}:${tabId}`) ?? null;
  }

  // Get the icon for a tab.
  getIcon(extensionId: string, tabId: string): LucideIcon | null {
    return this.bindings.get(`${extensionId}:${tabId}`)?.icon ?? null;
  }

  // Check if a binding exists
  has(extensionId: string, tabId: string): boolean {
    return this.bindings.has(`${extensionId}:${tabId}`);
  }
}

// ─── Icon Key → Icon Mapping ────────────────────────────────────────────────

// Maps iconKey strings from extension manifests to actual Lucide icon components.
const ICON_KEY_MAP: Record<string, LucideIcon> = {
  terminal: Terminal,
  "file-code": FileCode,
  smartphone: Smartphone,
  "file-text": FileText,
  network: Network,
  shield: Shield,
  info: Info,
  table: Table2,
  code: Code2,
  trash: Trash2,
  settings: Settings,
  activity: Activity,
  bot: Bot,
  rocket: Rocket,
  brain: Brain,
  "git-branch": GitBranch,
  key: Key,
  layers: Layers,
};

// Resolve an icon key from a manifest to an actual icon component.
export function resolveIconKey(iconKey: string): LucideIcon {
  return ICON_KEY_MAP[iconKey] ?? Terminal;
}

// ─── Default Registry Instance ──────────────────────────────────────────────

// from the layout to avoid circular dependencies.
export function createDefaultBindingRegistry(): RuntimeBindingRegistry {
  const registry = new RuntimeBindingRegistry();

  // the layout mounts, because tab components have heavy dependencies

  return registry;
}

// Bind all first-party tab components to the registry.
export function bindFirstPartyTabs(
  registry: RuntimeBindingRegistry,
  components: FirstPartyTabComponents,
): void {
  // Workspace
  registry.bindTab("core.chat", "main", components.TabEditor as ComponentType<TabRendererProps>, Terminal);
  registry.bindTab("core.code", "main", components.TabCode as ComponentType<TabRendererProps>, FileCode);
  registry.bindTab("core.preview", "main", components.TabPreview as ComponentType<TabRendererProps>, Smartphone);

  // Vault (release-gated)
  if (isExtensionVisible("core.vault.notes")) {
    registry.bindTab("core.vault.notes", "main", components.TabVault as ComponentType<TabRendererProps>, FileText);
    registry.bindTab("core.vault.graph", "main", components.TabVault as ComponentType<TabRendererProps>, Network);
    registry.bindTab("core.vault.scopes", "main", components.TabVault as ComponentType<TabRendererProps>, Shield);
  }

  // Database
  registry.bindTab("core.db.tables", "main", components.DatabaseBrowser as ComponentType<TabRendererProps>, Table2);
  registry.bindTab("core.db.sql", "main", components.DatabaseBrowser as ComponentType<TabRendererProps>, Code2);
  registry.bindTab("core.db.bin", "main", components.DatabaseBrowser as ComponentType<TabRendererProps>, Trash2);
  registry.bindTab("core.db.settings", "main", components.DatabaseBrowser as ComponentType<TabRendererProps>, Settings);

  // Observability
  registry.bindTab("core.obs.health", "main", components.ObservabilityHealth as ComponentType<TabRendererProps>, Activity);
  registry.bindTab("core.obs.gates", "main", components.TabMonitor as ComponentType<TabRendererProps>, Shield);
  registry.bindTab("core.obs.development", "main", components.ObservabilityDevelopment as ComponentType<TabRendererProps>, Terminal);
  // core.obs.production removed - production runs on external providers
  registry.bindTab("core.obs.claw", "main", components.ObservabilityClaw as ComponentType<TabRendererProps>, Bot);

  // Settings
  registry.bindTab("core.settings.context", "main", components.ContextSettings as ComponentType<TabRendererProps>, Brain);
  registry.bindTab("core.settings.secrets", "main", components.TabSecrets as ComponentType<TabRendererProps>, Key);
  registry.bindTab("core.settings.security", "main", components.TabPermissions as ComponentType<TabRendererProps>, Shield);
}

// Component references passed to bindFirstPartyTabs.
export interface FirstPartyTabComponents {
  // Workspace
  TabEditor: ComponentType<any>;
  TabCode: ComponentType<any>;
  TabPreview: ComponentType<any>;
  // Vault
  TabVault: ComponentType<any>;
  // Database
  DatabaseBrowser: ComponentType<any>;
  // Observability
  ObservabilityHealth: ComponentType<any>;
  TabMonitor: ComponentType<any>;
  ObservabilityDevelopment: ComponentType<any>;
  ObservabilityClaw: ComponentType<any>;
  // Settings
  ContextSettings: ComponentType<any>;
  TabSecrets: ComponentType<any>;
  TabPermissions: ComponentType<any>;
}
