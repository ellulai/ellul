// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Pure resolver shared between the chat iframe and the console workspace.
 *
 * Given an `IntegrationState` + `ActionContext`, produce the full
 * `ResolvedAction` list (available + unavailable). Call `getAvailableActions`
 * to filter down to those that pass every prerequisite.
 *
 * Side-effect-free — no DOM, fetch, timers, or globals. Safe to import
 * anywhere the types package is already resolvable.
 */

import type {
  ActionContext,
  ChatAction,
  IntegrationState,
  ResolvedAction,
} from "@ellul.ai/types";
import { ACTIONS } from "./registry";

export function resolveActions(
  integrations: IntegrationState,
  ctx: ActionContext,
): ResolvedAction[] {
  return ACTIONS.filter((a) => a.context === ctx.currentContext).map(
    (action) => {
      const check = checkAvailability(action, integrations, ctx);
      return {
        ...action,
        available: check.available,
        unavailableReason: check.reason,
      };
    },
  );
}

export function getAvailableActions(
  integrations: IntegrationState,
  ctx: ActionContext,
): ResolvedAction[] {
  return resolveActions(integrations, ctx).filter((a) => a.available);
}

// ─── Availability rules ─────────────────────────────────────────────────────

function checkAvailability(
  action: ChatAction,
  integrations: IntegrationState,
  ctx: ActionContext,
): { available: boolean; reason?: string } {
  switch (action.integrationCategory) {
    case "deploy":
      if (integrations.deployProviders.length === 0) {
        return { available: false, reason: "No deploy provider connected" };
      }
      if (!integrations.hasDeployConfig && action.id === "deploy") {
        return {
          available: false,
          reason: "No deploy configuration for this app",
        };
      }
      break;
    case "data":
      if (
        integrations.dataProviders.length === 0 &&
        !integrations.hasDatabase
      ) {
        return { available: false, reason: "No database connected" };
      }
      break;
    case "git":
      if (integrations.gitProviders.length === 0) {
        return { available: false, reason: "No git provider connected" };
      }
      if (!integrations.hasLinkedRepo) {
        return { available: false, reason: "No repository linked to this app" };
      }
      break;
    case "cloudflare":
      if (integrations.cloudflareProviders.length === 0) {
        return {
          available: false,
          reason: "No Cloudflare account connected",
        };
      }
      break;
    case "payments":
      if (integrations.paymentProviders.length === 0) {
        return { available: false, reason: "No payment provider connected" };
      }
      break;
  }

  if (action.requiredProvider) {
    const providerMap: Record<string, string[]> = {
      deploy: integrations.deployProviders,
      data: integrations.dataProviders,
      git: integrations.gitProviders,
      cloudflare: integrations.cloudflareProviders,
      payments: integrations.paymentProviders,
    };
    const providers = providerMap[action.integrationCategory] ?? [];
    if (!providers.includes(action.requiredProvider)) {
      return {
        available: false,
        reason: `Requires ${action.requiredProvider}`,
      };
    }
  }

  if (action.requiresSelection) {
    if (!ctx.selection || ctx.selection.type !== action.requiresSelection) {
      return {
        available: false,
        reason: `Select a ${action.requiresSelection} first`,
      };
    }
  }

  if (action.id === "db-push" && !integrations.hasMigrations) {
    return { available: false, reason: "No migration files found" };
  }

  return { available: true };
}
