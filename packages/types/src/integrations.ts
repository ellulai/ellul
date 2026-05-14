// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Integration state & workspace action types — the single source of truth
 * shared between the control plane (apps/api), the VPS (packages/vps), and
 * the chat SPA (packages/vps-ui).
 *
 * Data flow:
 *   1. `integration_groups` + `integration_group_connections` in the control
 *      plane describe which providers the user has connected per (server, app).
 *   2. `apps/api` joins both tables and resolves them into `IntegrationState`
 *      (healthy-default view of each route role) plus per-category connection
 *      details. Response shape: `IntegrationsResponse`.
 *   3. `packages/vps` file-api fetches that over the VPS bearer, then augments
 *      with local project signals (`hasLinkedRepo`, `hasMigrations`,
 *      `hasDatabase`) that only the VPS can observe.
 *   4. `packages/vps-ui` feeds the final `IntegrationState` to the action
 *      resolver (`chat/actions/resolver.ts`) which returns the `ResolvedAction`
 *      list the chat Actions dropdown renders.
 *
 * Any new action category, severity, or connection field is added HERE FIRST.
 * All three consumers compile against this file — drift becomes a TS error at
 * build time instead of a silent rendering bug in production.
 */

import type { GateType } from "./gate";

// ─── Integration state ──────────────────────────────────────────────────────

/**
 * Integration category. Mirrors the route-role taxonomy used by
 * `integration_groups.route_role` (with the `-default` suffix stripped).
 * Extending the set requires a schema change + a route-role migration, so
 * adding a value here is intentional and coordinated.
 */
export type IntegrationCategory =
  | "deploy"
  | "data"
  | "git"
  | "cloudflare"
  | "payments";

/** Connection health mirror of `integration_group_connections.connection_status`. */
export type ConnectionHealth = "connected" | "disconnected" | "error";

/**
 * A single provider connection inside a category. The agent-enable state
 * (`integration_group_connections.agent_exposure`) is folded into `available`
 * at resolver time so downstream consumers only see actionable connections.
 */
export interface IntegrationConnection {
  /**
   * Provider kind — free-form string matching
   * `integration_group_connections.provider_kind` (e.g. "github", "flyio",
   * "supabase", "stripe"). Kept as string so adding a new provider never
   * requires a types release.
   */
  providerKind: string;
  /** User-visible name, e.g. "GitHub — octocat". */
  displayName: string;
  /** Current health from the control plane. */
  status: ConnectionHealth;
  /** Whether this connection is the category's default route. */
  isDefault: boolean;
}

/**
 * Aggregated per-(server, app) integration state used by the action resolver.
 *
 * Each `*Providers` field is the *healthy-default* provider-kind list for the
 * category (`.length === 0` ⇒ no route available). The `has*` booleans capture
 * VPS-local signals the control plane cannot observe on its own.
 */
export interface IntegrationState {
  /** Deploy providers with a healthy default connection. */
  deployProviders: string[];
  /** Data/database providers with a healthy default connection. */
  dataProviders: string[];
  /** Git providers with a healthy default connection. */
  gitProviders: string[];
  /** Cloudflare providers with a healthy default connection. */
  cloudflareProviders: string[];
  /** Payment providers with a healthy default connection. */
  paymentProviders: string[];

  /** True when the project has a git remote *and* a healthy git provider is connected. */
  hasLinkedRepo: boolean;
  /** True when the deploy-default route is valid (group + healthy default connection). */
  hasDeployConfig: boolean;
  /** True when a database has been provisioned for this app (verified via shield). */
  hasDatabase: boolean;
  /** True when migration-runner scripts/files are detected in the project tree. */
  hasMigrations: boolean;
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Visual severity — drives color and any confirmation treatment. */
export type ActionSeverity = "normal" | "warning" | "destructive";

/**
 * UI context the action belongs to. The chat Actions dropdown is always
 * `workspace`; `database` / `integrations` exist so the registry is
 * complete and can be re-used by other surfaces without a types change.
 */
export type ActionContextKind = "workspace" | "database" | "integrations";

/** Selection scoping inside a context (e.g. a specific table). */
export type ActionSelectionKind = "table" | "app" | "file" | "migration";

/**
 * An immutable action definition. Entries form a pure registry consumed by
 * the resolver; runtime availability is computed, not stored.
 */
export interface ChatAction {
  /** Stable ID used on the parent/iframe wire (e.g. "deploy", "git-push"). */
  id: string;
  /** Display label. */
  label: string;
  /** Short description shown under the label. */
  description: string;
  /** Icon identifier — resolved to a lucide component by the consumer. */
  iconKey: string;
  /** Severity — drives color and confirmation rendering. */
  severity: ActionSeverity;
  /** Context this action appears in. */
  context: ActionContextKind;
  /** Category whose healthy-default route must exist for availability. */
  integrationCategory: IntegrationCategory;
  /** Specific provider requirement — omit to allow any provider in the category. */
  requiredProvider?: string;
  /** Gate the agent must pass through to invoke this action. */
  gateType: GateType;
  /** Required runtime selection kind (e.g. "table"). */
  requiresSelection?: ActionSelectionKind;
  /** True when the UI must confirm before dispatch. */
  requiresConfirmation?: boolean;
}

/**
 * Runtime context supplied to the resolver at call time. `currentContext`
 * is intentionally widened to `string` — consumers may pass in any UI tab
 * identifier (including tabs that have no actions defined, like `"vault"`
 * or `"settings"`). The resolver simply returns an empty list for any
 * value the registry does not recognise.
 */
export interface ActionContext {
  currentContext: string;
  selection?: {
    type: ActionSelectionKind;
    name: string;
  };
}

/** Action definition + its resolved availability. */
export interface ResolvedAction extends ChatAction {
  /** True when every prerequisite is met. */
  available: boolean;
  /** Human-readable reason — used by debug surfaces only. */
  unavailableReason?: string;
}

// ─── Transport shapes ───────────────────────────────────────────────────────

/**
 * Response body of `GET /api/project/:directory/integrations` served by the
 * VPS file-api. The VPS fetches `IntegrationsResponse` from the control plane,
 * augments the `state` with local signals, and returns the result to vps-ui.
 */
export interface IntegrationsResponse {
  /** Sandbox slug (`sbx-xxxxxxx`) the state applies to. */
  sandboxId: string;
  /** Aggregated state — drives action availability. */
  state: IntegrationState;
  /** Per-category connections (for richer surfaces like tooltips and audit logs). */
  connections: {
    deploy: IntegrationConnection[];
    data: IntegrationConnection[];
    git: IntegrationConnection[];
    cloudflare: IntegrationConnection[];
    payments: IntegrationConnection[];
  };
  /** Epoch-ms at which the snapshot was computed — for cache ordering / debugging. */
  computedAt: number;
}
