// SPDX-License-Identifier: MIT
"use client";

// Per-tool permission management hook.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { API_URL } from "@/lib/api";
import type { GatePermission } from "@/contexts/WorkbenchContext";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ToolPermissionLevel = GatePermission | "inherit";

export interface ToolPermissionEntry {
  id: string;
  toolName: string;
  capability: string;
  permission: GatePermission;
  allowedEnvironments: string[] | null;
  setBy: string;
  setAt: string;
}

export interface ResolvedToolPermission {
  permission: ToolPermissionLevel;
  allowedEnvironments: string[] | null;
  isInherited: boolean;
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useToolPermissions(
  serverId: string,
  sandboxId: string | null,
  groupId: string,
  connectionId: string,
) {
  const queryClient = useQueryClient();
  const queryKey = ["tool-permissions", serverId, groupId, connectionId];

  const { data: permissions = [], isLoading } = useQuery<ToolPermissionEntry[]>({
    queryKey,
    queryFn: async () => {
      if (!sandboxId) return [];
      const res = await fetch(
        `${API_URL}/api/servers/${serverId}/groups/${groupId}/connections/${connectionId}/permissions`,
        { credentials: "include" },
      );
      if (!res.ok) return [];
      const data = await res.json();
      return data.permissions ?? [];
    },
    enabled: !!sandboxId && !!connectionId,
    staleTime: 30_000,
  });

  // Build a lookup map: toolName -> ToolPermissionEntry
  const permissionsByTool = new Map<string, ToolPermissionEntry>();
  for (const perm of permissions) {
    permissionsByTool.set(perm.toolName, perm);
  }

  // Resolve the effective permission for a tool.
  function getToolPermission(toolName: string): ResolvedToolPermission {
    const entry = permissionsByTool.get(toolName);
    if (entry) {
      return {
        permission: entry.permission,
        allowedEnvironments: entry.allowedEnvironments,
        isInherited: false,
      };
    }
    return {
      permission: "inherit",
      allowedEnvironments: null,
      isInherited: true,
    };
  }

  // Set a per-tool permission override
  const setPermission = useMutation({
    mutationFn: async (args: {
      toolName: string;
      capability: string;
      permission: GatePermission;
      allowedEnvironments?: string[] | null;
    }) => {
      const res = await fetch(
        `${API_URL}/api/servers/${serverId}/groups/${groupId}/connections/${connectionId}/permissions/${encodeURIComponent(args.toolName)}`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            permission: args.permission,
            capability: args.capability,
            allowedEnvironments: args.allowedEnvironments ?? null,
          }),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error(data.error || "Failed to set tool permission");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  // Reset a per-tool permission (remove override, revert to gate default)
  const resetPermission = useMutation({
    mutationFn: async (toolName: string) => {
      const res = await fetch(
        `${API_URL}/api/servers/${serverId}/groups/${groupId}/connections/${connectionId}/permissions/${encodeURIComponent(toolName)}`,
        {
          method: "DELETE",
          credentials: "include",
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Request failed" }));
        throw new Error(data.error || "Failed to reset tool permission");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });

  return {
    permissions,
    permissionsByTool,
    isLoading,
    getToolPermission,
    setPermission,
    resetPermission,
  };
}
