// SPDX-License-Identifier: MIT

// from the computed sets — consumers never reference specific flag names

// ─── Gate Definition ───────────────────────────────────────────────────────

interface ReleaseGate {
  // Whether this feature is enabled for release.
  enabled: boolean;
  // Navigation context IDs hidden when disabled (e.g. "vault").
  contexts?: string[];
  // Extension ID prefixes stripped from presets/bindings when disabled (e.g. "core.vault.").
  extensionPrefixes?: string[];
  // Integration provider IDs hidden when disabled (e.g. "vercel").
  providers?: string[];
  // Integration group route roles hidden when disabled (e.g. "deploy-default").
  routeRoles?: string[];
  // Built-in integration tab IDs hidden when disabled (e.g. "zeroclaw").
  integrationTabs?: string[];
}

// ─── Gate Registry ─────────────────────────────────────────────────────────

const RELEASE_GATES: Record<string, ReleaseGate> = {
  vault: {
    enabled: false,
    contexts: ["vault"],
    extensionPrefixes: ["core.vault."],
  },

  integrationsDeployProviders: {
    enabled: false,
    providers: ["vercel", "cloudflare_workers", "cloudflare-workers"],
    routeRoles: ["deploy-default", "cloudflare-default"],
  },

  integrationsDatabaseProviders: {
    enabled: false,
    providers: ["supabase", "neon", "planetscale", "turso"],
    routeRoles: ["db-default"],
  },

  integrationsPayments: {
    enabled: false,
    providers: ["stripe"],
    routeRoles: ["payments-default"],
  },

  integrationsCustomMcp: {
    enabled: false,
    providers: ["custom"],
  },

  // Launch phase: GitHub only. Re-enable when GitLab/Bitbucket OAuth apps are configured.
  integrationsGitNonGithub: {
    enabled: false,
    providers: ["gitlab", "bitbucket"],
  },

  // Launch phase: hide database + observability contexts entirely (sidebar, nav, presets).
  databaseContext: {
    enabled: false,
    contexts: ["database"],
  },
  observabilityContext: {
    enabled: false,
    contexts: ["observability"],
  },

  policies: {
    enabled: false,
  },
};

// ─── Security gate types ───────────────────────────────────────────────────
// Hidden gate types are filtered out of the Security tab's action/write/read lists.
// db_* and deploy gates ride along with the database/observability/deploy launch gates.
const _hiddenGateTypes = new Set<string>();
if (!RELEASE_GATES.databaseContext?.enabled) {
  ["db", "db_read", "db_write", "db_migrate", "db_full"].forEach((g) => _hiddenGateTypes.add(g));
}
if (!RELEASE_GATES.integrationsDeployProviders?.enabled) {
  _hiddenGateTypes.add("deploy");
}

export function isGateTypeVisible(gateType: string): boolean {
  return !_hiddenGateTypes.has(gateType);
}

// ─── Login providers (sign-in OAuth) ───────────────────────────────────────
// Keep in sync with apps/api/src/config/launch-flags.ts.
export const ENABLED_LOGIN_PROVIDERS = ["github", "google"] as const;

export function isLoginProviderEnabled(p: string): boolean {
  return (ENABLED_LOGIN_PROVIDERS as readonly string[]).includes(p);
}

// ─── Computed Hidden Sets ──────────────────────────────────────────────────
// never change at runtime — bundler can tree-shake when all gates are enabled.

const _hiddenContexts = new Set<string>();
const _hiddenExtPrefixes: string[] = [];
const _hiddenProviders = new Set<string>();
const _hiddenRouteRoles = new Set<string>();
const _hiddenIntTabs = new Set<string>();

for (const gate of Object.values(RELEASE_GATES)) {
  if (gate.enabled) continue;
  gate.contexts?.forEach((c) => _hiddenContexts.add(c));
  gate.extensionPrefixes?.forEach((p) => _hiddenExtPrefixes.push(p));
  gate.providers?.forEach((p) => _hiddenProviders.add(p));
  gate.routeRoles?.forEach((r) => _hiddenRouteRoles.add(r));
  gate.integrationTabs?.forEach((t) => _hiddenIntTabs.add(t));
}

// ─── Filter Functions ──────────────────────────────────────────────────────
// Generic predicates. Consumers call these — they never reference flag names.

// Whether a navigation context should appear in the sidebar/header.
export function isContextVisible(contextId: string): boolean {
  return !_hiddenContexts.has(contextId);
}

// Whether a workspace extension should appear in presets and bindings.
export function isExtensionVisible(extensionId: string): boolean {
  return !_hiddenExtPrefixes.some((p) => extensionId.startsWith(p));
}

// Whether an integration provider should appear in connection UIs.
export function isProviderVisible(providerId: string): boolean {
  return !_hiddenProviders.has(providerId);
}

// Whether an integration group route role should appear in the create-group modal.
export function isRouteRoleVisible(routeRole: string): boolean {
  if (!routeRole) return true;
  return !_hiddenRouteRoles.has(routeRole);
}

// Whether a built-in integration tab should appear in the tab bar.
export function isIntegrationTabVisible(tabId: string): boolean {
  return !_hiddenIntTabs.has(tabId);
}

export function isPoliciesVisible(): boolean {
  return RELEASE_GATES.policies?.enabled ?? true;
}
