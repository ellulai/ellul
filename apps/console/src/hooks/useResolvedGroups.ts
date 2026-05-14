// SPDX-License-Identifier: MIT
"use client";

import { useMemo } from "react";
import { useIntegrationGroups } from "./useIntegrationGroups";
import type {
  IntegrationGroup,
  IntegrationGroupConnection,
} from "./useIntegrationGroups";

// ─── Resolved Group State ──────────────────────────────────────────────────

export type RouteStatus = "valid" | "missing_default" | "unhealthy" | "disabled";

export interface ToolSummary {
  approved: number;
  quarantined: number;
  rejected: number;
  total: number;
}

export interface ResolvedGroupState {
  groupId: string;
  name: string;
  routeRole: string | null;
  hasHealthyDefault: boolean;
  defaultConnectionId: string | null;
  defaultProviderKind: string | null;
  routeStatus: RouteStatus;
  toolSummary: ToolSummary;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function resolveRouteStatus(
  group: IntegrationGroup,
  defaultConn: IntegrationGroupConnection | undefined,
): RouteStatus {
  // No route role assigned — the group is just a UI grouping
  if (!group.routeRole) {
    return "disabled";
  }

  // Route role assigned but no default connection picked
  if (!defaultConn) {
    return "missing_default";
  }

  // Default connection exists but is not healthy
  if (defaultConn.connectionStatus !== "connected") {
    return "unhealthy";
  }

  return "valid";
}

function computeToolSummary(
  connections: IntegrationGroupConnection[],
): ToolSummary {
  // For now, tool counts are derived from agent exposure state.
  let approved = 0;
  let quarantined = 0;
  let rejected = 0;

  for (const conn of connections) {
    if (conn.agentExposure === "enabled") {
      if (conn.connectionStatus === "connected") {
        approved++;
      } else {
        quarantined++;
      }
    } else {
      rejected++;
    }
  }

  return { approved, quarantined, rejected, total: connections.length };
}

function resolveGroup(group: IntegrationGroup): ResolvedGroupState {
  const defaultConn = group.connections.find((c) => c.isDefaultRoute);
  const routeStatus = resolveRouteStatus(group, defaultConn);

  return {
    groupId: group.id,
    name: group.name,
    routeRole: group.routeRole,
    hasHealthyDefault:
      routeStatus === "valid",
    defaultConnectionId: defaultConn?.id ?? null,
    defaultProviderKind: defaultConn?.providerKind ?? null,
    routeStatus,
    toolSummary: computeToolSummary(group.connections),
  };
}

// ─── Hook ──────────────────────────────────────────────────────────────────

export interface UseResolvedGroupsResult {
  resolvedGroups: ResolvedGroupState[];
  getGroupByRole: (role: string) => ResolvedGroupState | undefined;
  hasValidRoute: (role: string) => boolean;
  isLoading: boolean;
}

// Resolved integration group state.
export function useResolvedGroups(
  serverId: string,
  sandboxId: string | null,
): UseResolvedGroupsResult {
  const { groups, isLoading } = useIntegrationGroups(serverId, sandboxId);

  const resolvedGroups = useMemo(
    () => groups.map(resolveGroup),
    [groups],
  );

  const getGroupByRole = useMemo(
    () => (role: string) => resolvedGroups.find((g) => g.routeRole === role),
    [resolvedGroups],
  );

  const hasValidRoute = useMemo(
    () => (role: string) => {
      const group = resolvedGroups.find((g) => g.routeRole === role);
      return group?.routeStatus === "valid";
    },
    [resolvedGroups],
  );

  return { resolvedGroups, getGroupByRole, hasValidRoute, isLoading };
}
