// SPDX-License-Identifier: MIT
"use client";

import { useTranslations } from "next-intl";

// All known extension IDs. Source: workspace-extensions.ts FIRST_PARTY_MANIFESTS.
// Keep this list in sync; fallback to extensionId if unknown.
const KNOWN_EXTENSION_IDS = [
  "core.chat",
  "core.code",
  "core.preview",
  "core.vault.notes",
  "core.vault.graph",
  "core.vault.scopes",
  "core.db.tables",
  "core.db.sql",
  "core.db.bin",
  "core.db.settings",
  "core.obs.health",
  "core.obs.gates",
  "core.obs.development",
  "core.obs.claw",
  "core.settings.context",
  "core.settings.secrets",
  "core.settings.security",
  "core.int.zeroclaw",
] as const;

export type KnownExtensionId = (typeof KNOWN_EXTENSION_IDS)[number];

function isKnownExtensionId(id: string): id is KnownExtensionId {
  return (KNOWN_EXTENSION_IDS as readonly string[]).includes(id);
}

// next-intl treats `.` in a key path as a node separator. The literal
// extension id "core.chat" cannot be resolved against an i18n object
// whose own key is the string "core.chat" — t() would try to navigate
// console.workspaceExtensions → core → chat, which doesn't exist.
// JSON keys are stored with `.` swapped for `_` (e.g. "core_chat"); this
// helper applies the same swap at lookup time.
function keyOf(extensionId: string): string {
  return extensionId.replace(/\./g, "_");
}

export interface ExtensionLabels {
  name: string;
  description: string;
  tabs: Record<string, { label: string; description: string }>;
}

/**
 * Resolve translated labels for workspace extension manifests.
 *
 * Manifests in `workspace-extensions.ts` carry English fallbacks for
 * `name`, `description`, and `tabs[].{label,description}`. UI components
 * should read the translated form via this hook keyed by extension id +
 * tab id, falling back to the manifest values when the id is unknown
 * (e.g. third-party extensions or new ids not yet in the i18n catalog).
 */
export function useWorkspaceExtensionLabels() {
  const t = useTranslations("console.workspaceExtensions");

  return {
    extensionName(extensionId: string, fallback: string): string {
      if (!isKnownExtensionId(extensionId)) return fallback;
      // The cast is required because TS widens `${KnownExtensionId}.name`
      // to the dotted form, but we resolve via the underscore form.
      const path = `${keyOf(extensionId)}.name`;
      return t(path as unknown as "core_chat.name");
    },

    extensionDescription(extensionId: string, fallback: string): string {
      if (!isKnownExtensionId(extensionId)) return fallback;
      const path = `${keyOf(extensionId)}.description`;
      return t(path as unknown as "core_chat.description");
    },

    tabLabel(extensionId: string, tabId: string, fallback: string): string {
      if (!isKnownExtensionId(extensionId)) return fallback;
      try {
        const path = `${keyOf(extensionId)}.tabs.${tabId}.label`;
        return t(path as unknown as "core_chat.tabs.main.label");
      } catch {
        return fallback;
      }
    },

    tabDescription(extensionId: string, tabId: string, fallback: string): string {
      if (!isKnownExtensionId(extensionId)) return fallback;
      try {
        const path = `${keyOf(extensionId)}.tabs.${tabId}.description`;
        return t(path as unknown as "core_chat.tabs.main.description");
      } catch {
        return fallback;
      }
    },
  };
}
