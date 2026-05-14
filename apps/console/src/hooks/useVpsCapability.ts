// SPDX-License-Identifier: MIT
"use client";

// Gates UI on capabilities the VPS reports via its liveness ping.

import { useDashboard } from "@/contexts/DashboardContext";
import type { CapabilityId } from "@/lib/vps-capabilities";

export interface VpsCapabilityState {
  supported: boolean;
  requiresUpdate: boolean;
  reported: string[];
}

export function useVpsCapability(capability: CapabilityId): VpsCapabilityState {
  const { agentUpdate } = useDashboard();
  const reported = agentUpdate?.capabilities ?? [];
  const missing = agentUpdate?.lacksCapabilities ?? [];
  return {
    supported: reported.includes(capability),
    requiresUpdate: missing.includes(capability),
    reported,
  };
}

export function useVpsCapabilities(
  capabilities: readonly CapabilityId[],
): VpsCapabilityState {
  const { agentUpdate } = useDashboard();
  const reported = agentUpdate?.capabilities ?? [];
  const missing = agentUpdate?.lacksCapabilities ?? [];
  const reportedSet = new Set(reported);
  const missingSet = new Set(missing);
  return {
    supported: capabilities.every((c) => reportedSet.has(c)),
    requiresUpdate: capabilities.some((c) => missingSet.has(c)),
    reported,
  };
}
