// SPDX-License-Identifier: MIT
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { API_URL } from "@/lib/api";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface IntegrationGroupConnection {
  id: string;
  providerKind: string;
  adapterType: string;
  displayName: string;
  agentExposure: "enabled" | "disabled";
  isDefaultRoute: boolean;
  connectionStatus: string;
  mcpUrl?: string | null;
  oauthProvider?: string | null;
}

export interface IntegrationGroup {
  id: string;
  name: string;
  iconKey: string;
  routeRole: string | null;
  position: number;
  isSystemDefined: boolean;
  connections: IntegrationGroupConnection[];
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useIntegrationGroups(serverId: string, sandboxId: string | null, isLocal = false) {
  const queryClient = useQueryClient();

  const { data: groups = [], isLoading } = useQuery<IntegrationGroup[]>({
    queryKey: ["integration-groups", serverId, sandboxId],
    queryFn: async () => {
      if (!sandboxId) return [];
      const res = await fetch(
        `${API_URL}/api/servers/${serverId}/groups?sandboxId=${encodeURIComponent(sandboxId)}`,
        { credentials: "include" },
      );
      if (!res.ok) return [];
      const data = await res.json();
      return data.groups ?? [];
    },
    enabled: !!sandboxId && !isLocal,
    staleTime: 30_000,
  });

  // Create group mutation
  const createGroup = useMutation({
    mutationFn: async (body: {
      sandboxId: string;
      name: string;
      iconKey: string;
      routeRole?: string;
    }) => {
      const res = await fetch(`${API_URL}/api/servers/${serverId}/groups`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok)
        throw new Error((await res.json()).error || "Failed to create group");
      return res.json();
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["integration-groups"] }),
  });

  // Delete (archive) group mutation
  const deleteGroup = useMutation({
    mutationFn: async (groupId: string) => {
      const res = await fetch(
        `${API_URL}/api/servers/${serverId}/groups/${groupId}`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );
      if (!res.ok) throw new Error("Failed to delete group");
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["integration-groups"] }),
  });

  // Compute dynamic tab IDs for useDashboardNav
  const dynamicTabIds = groups.map((g) => g.id);

  return { groups, isLoading, createGroup, deleteGroup, dynamicTabIds };
}
