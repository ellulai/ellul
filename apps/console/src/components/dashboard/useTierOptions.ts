// SPDX-License-Identifier: MIT
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, API_URL } from "@/lib/api";
import { isLockedTier } from "@/lib/tier-utils";

// Billing interval type
export type BillingInterval = "monthly" | "annual";

// Tier definition
export interface Tier {
  id: string;
  name: string;
  price: number;
  annualPrice: number;
  annualMonthlyRate: number;
  annualMonthlyEquivalent: number;
  description: string;
  specs?: {
    ram: string;
    cpu: number;
    disk: number;
    transfer: string;
  };
  capacity?: string;
  /** Optional: Cloud Platform omits this; shield_proxy keeps it for its own marketing. */
  features?: string[];
  engine?: "ephemeral" | "persistent" | null;
  product?: "shield_proxy" | "cloud_platform";
  [key: string]: unknown;
}

// Single tier change option
export interface TierOption {
  tier: Tier & Record<string, unknown>;
  type: string;
  priceChange: number;
  instant?: {
    provider: string;
    serverType: string;
    ramGb: number;
    downtimeSeconds: number;
  };
  migrate?: {
    provider: string;
    serverType: string;
    ramGb: number;
    downtimeSeconds: number;
    differentProvider: boolean;
  };
  migrationAvailable?: boolean;
  migrationBenefit?: string | null;
}

// Pending downgrade info
export interface PendingDowngrade {
  targetPlan: string;
  interval: string;
  effectiveDate: string;
}

// Pending upgrade info
export interface PendingUpgrade {
  targetPlan: string;
  interval: string | null;
}

// Response from GET /api/servers/:id/tier-options
export interface TierOptionsResponse {
  currentTier: {
    id: string;
    name: string;
    price: number;
  };
  currentInterval: BillingInterval;
  currentRegion: string;
  currentProvider: string;
  pendingDowngrade: PendingDowngrade | null;
  pendingUpgrade: PendingUpgrade | null;
  options: TierOption[];
}

// Response from POST /api/servers/:id/change-tier
export interface TierChangeResponse {
  success: boolean;
  message: string;
  // Present when upgrade is pending (resize happens via webhook)
  pending?: boolean;
  // Present for immediate upgrades
  tierChange?: {
    previous: {
      tier: string;
      provider: string;
      serverType: string;
      ramGb: number;
    };
    new: {
      tier: string;
      provider: string;
      serverType: string;
      ramGb: number;
    };
  };
  migrationType?: "resize" | "migration";
  downtimeSeconds?: number;
  billing?: {
    success: boolean;
    changeType: "upgrade" | "downgrade" | "same";
    amountCharged?: number;
    creditApplied?: number;
    nextBillingAmount?: number;
  };
  credentials?: {
    aiProxyToken: string;
    warning: string;
  };
  // Present for scheduled downgrades
  scheduled?: boolean;
  effectiveDate?: string;
  pendingDowngrade?: PendingDowngrade;
}

// Preview of what a tier change will cost
export interface TierChangePreview {
  changeType: "upgrade" | "downgrade";
  immediateCharge?: number;
  effectiveDate?: string;
  newRecurringAmount: number;
  newInterval: BillingInterval;
  currentPeriodEnd: string;
  description: string;
}

// Hook to fetch available tier options for a server
export function useTierOptions(serverId: string) {
  return useQuery({
    queryKey: ["tier-options", serverId],
    queryFn: async () => {
      const response = await api.api.servers[":id"]["tier-options"].$get({
        param: { id: serverId },
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Failed to fetch tier options" }));
        throw new Error((error as { error?: string }).error || "Failed to fetch tier options");
      }
      return response.json();
    },
    // Don't refetch too often since tiers don't change frequently
    staleTime: 60 * 1000, // 1 minute
    refetchOnWindowFocus: false,
  });
}

// Valid tier IDs
export type TierId = string;

// Error thrown when a passkey confirmation is required (web_locked tier)
export class PasskeyRequiredError extends Error {
  requiresPasskey = true as const;
  serverDomain: string;
  operation: string;

  constructor(serverDomain: string, operation: string) {
    super("PASSKEY_REQUIRED");
    this.name = "PasskeyRequiredError";
    this.serverDomain = serverDomain;
    this.operation = operation;
  }
}

// Hook to change server tier
export function useChangeTier(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation<
    TierChangeResponse,
    Error,
    { newTier: TierId; newInterval?: BillingInterval; forceMigration?: boolean; passkeyConfirmation?: string }
  >({
    mutationFn: async ({ newTier, newInterval, forceMigration, passkeyConfirmation }) => {
      const response = await fetch(
        `${API_URL}/api/servers/${serverId}/change-tier`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            ...(passkeyConfirmation && { "X-VPS-Confirm-Token": passkeyConfirmation }),
          },
          body: JSON.stringify({
            newTier,
            newInterval: newInterval || "monthly",
            forceMigration,
          }),
        },
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Failed to change tier" }));
        const errorObj = error as { error?: string; requiresPasskey?: boolean; serverDomain?: string; tier?: string; operation?: string };
        if (isLockedTier(errorObj.tier) && errorObj.requiresPasskey) {
          throw new PasskeyRequiredError(errorObj.serverDomain || "", errorObj.operation || "change-tier");
        }
        throw new Error(errorObj.error || "Failed to change tier");
      }

      return response.json() as Promise<TierChangeResponse>;
    },
    onSuccess: () => {
      // Invalidate queries to refresh server status
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
      queryClient.invalidateQueries({ queryKey: ["tier-options", serverId] });
    },
  });
}

// Hook to preview a tier change
export function usePreviewTierChange() {
  return useMutation<
    TierChangePreview,
    Error,
    { serverId: string; newPlan: string; newInterval: BillingInterval }
  >({
    mutationFn: async ({ serverId, newPlan, newInterval }) => {
      const response = await api.api.stripe["preview-change"].$post({
        json: { serverId, newPlan: newPlan as "hobby" | "pro", newInterval },
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Failed to preview change" }));
        throw new Error((error as { error?: string }).error || "Failed to preview change");
      }

      return response.json() as Promise<TierChangePreview>;
    },
  });
}

// Hook to cancel a pending downgrade
export function useCancelDowngrade(serverId: string) {
  const queryClient = useQueryClient();

  return useMutation<{ success: boolean; message: string }, Error, { passkeyConfirmation?: string }>({
    mutationFn: async ({ passkeyConfirmation } = {}) => {
      const response = await fetch(
        `${API_URL}/api/servers/${serverId}/cancel-downgrade`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            ...(passkeyConfirmation && { "X-VPS-Confirm-Token": passkeyConfirmation }),
          },
        },
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Failed to cancel downgrade" }));
        const errorObj = error as { error?: string; requiresPasskey?: boolean; serverDomain?: string; tier?: string; operation?: string };
        if (isLockedTier(errorObj.tier) && errorObj.requiresPasskey) {
          throw new PasskeyRequiredError(errorObj.serverDomain || "", errorObj.operation || "cancel-downgrade");
        }
        throw new Error(errorObj.error || "Failed to cancel downgrade");
      }

      return response.json() as Promise<{ success: boolean; message: string }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tier-options", serverId] });
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
    },
  });
}
