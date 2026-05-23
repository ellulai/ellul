// SPDX-License-Identifier: MIT
"use client";

import { createContext, useContext } from "react";
import type { Session } from "@/lib/auth-client";

export type ServerState = "none" | "creating" | "provisioning" | "running" | "error" | "pending_deletion" | "hibernated" | "hibernating" | "waking" | "awaiting_unlock" | "upgrading" | "downgrading" | "frozen" | "pool_ready" | "pool_assigned";

// Server is actively transitioning — UI should poll rapidly as a safety net for SSE.
export function isTransitionalState(state: string | undefined | null): boolean {
  if (!state) return false;
  return (
    state === "creating" || state === "provisioning" || state === "waking" ||
    state === "hibernating" || state === "upgrading" || state === "downgrading"
  );
}

export interface ServerStatus {
  state: ServerState;
  // Server plan from API: "free", "hobby", or "pro"
  plan: "free" | "hobby" | "pro";
  frozenReason?: string | null;
  hasActiveSubscription?: boolean;
  server: {
    id: string;
    ipAddress: string | null;
    domain: string | null;
    createdAt: string;
    performanceStatus: "good" | "struggling";
    size: string;
    terminalEnabled?: boolean;
    sshEnabled?: boolean;
    preferredSession?: "main" | "claw" | "opencode" | "claude" | "codex" | "cursor" | "grok";
    preferredApp?: string | null;
    securityTier?: "standard" | "web_locked" | "private_locked";
    serverPlan?: "free" | "hobby" | "pro";
    runtimeTier?: "shared" | "dedicated";
    product?: string;
    platformVersion?: string | null;
    billingInterval?: "monthly" | "annual";
    volumeSecurityMode?: "standard" | "enhanced" | "sovereign" | null;
    subscriptionEndsAt?: string | null;
    pendingDowngrade?: {
      targetPlan: string | null;
      interval: string | null;
      effectiveDate: string | null;
    } | null;
    tierTransitionTarget?: string | null;
    tierTransitionLockedAt?: string | null;
    setupToken?: string | null;
  } | null;
  snapshot?: {
    available: boolean;
    createdAt?: string | null;
    expiresAt?: string | null;
  };
  operation?: {
    type: string | null;
    step: string | null;
    startedAt?: string | null;
    label?: string | null;
    isReady?: boolean;
  };
  // Agent manifest self-update snapshot. Populated from agent_reports
  agentUpdate?: {
    appliedManifestVersion: number | null;
    latestManifestVersion: number | null;
    installedEnforcerVersion: string | null;
    latestEnforcerVersion: string | null;
    pendingUpdateVersion: number | null;
    pendingUpdateStagedAt: string | null;
    autoUpdateEffective: boolean;
    healthStatus: "ok" | "degraded" | "failing" | "unknown";
    lastInstallOutcome:
      | "success"
      | "partial"
      | "failed"
      | "rolled_back"
      | "pending_approval"
      | null;
    lastInstallError: string | null;
    lastReportAt: string | null;
    // online/stale/offline. "unknown" means the VPS has never pinged.
    lastPingAt: string | null;
    liveness: "online" | "stale" | "offline" | "unknown";
    // True while a signed apply-pending-update command is in-flight
    applyInProgress: boolean;
    // Target manifest version the in-flight apply is attempting.
    applyInProgressVersion: number | null;
    // ── Capabilities ─────────────────────────
    // Namespaced + versioned capability strings the VPS advertises at
    capabilities: string[];
    // Capabilities the latest active manifest declares as required
    lacksCapabilities: string[];
    // Raw agentVersion as reported by the most recent liveness ping.
    pingedAgentVersion: string | null;
  } | null;
  adapterUpdates?: Record<string, {
    installedVersion: string;
    targetVersion: string | null;
    status: "current" | "updating" | "updated" | "failed";
  }>;
  deployments?: Array<{
    name: string;
    directory?: string;
    url: string;
    port: number;
    stack: string;
    summary: string;
    createdAt: string;
    project?: string;
    projectPath?: string;
  }>;
  aiQuota?: {
    used: number;
    limit: number;
    remaining: number;
    percentUsed: number;
    resetsIn: string;
    resetAt: string;
  };
  // Error context when state is "error" — extracted from reconciliation metadata
  errorReason?: string | null;
}

// Lightweight server record returned in the multi-server `servers` array.
export interface ServerSummary {
  state: ServerStatus["state"];
  plan?: string | null;
  server?: {
    id: string;
    name?: string | null;
    tier?: string | null;
    product?: string | null;
    region?: string | null;
    ipAddress?: string | null;
    domain?: string | null;
    createdAt?: string;
  } | null;
}

export interface DashboardContextValue {
  serverStatus: ServerStatus | undefined;
  isStatusLoading: boolean;
  session: Session | null;
  // Multi-server support
  allServers: Array<ServerSummary>;
  activeServerId: string | null;
  updateActiveServer: (id: string | null) => void;
  // Server actions
  onDeleteServer: () => void;
  isDeleting: boolean;
  onRebuildServer: () => void;
  isRebuilding: boolean;
  onRollbackServer?: () => void;
  isRollingBack: boolean;
  snapshotExpiresAt?: string | null;
  // Agent manifest snapshot for the active server.
  agentUpdate?: ServerStatus["agentUpdate"];
  // Enqueue POST /api/servers/:id/update. Defined only when the VPS has staged a pending manifest.
  onUpdateServer?: () => void;
  // Toggle the VPS's agent auto-update mode. Passkey-gated on web_locked.
  onSetAgentUpdateMode?: (mode: "auto" | "manual") => void;
  // True while the set-auto-update command is in flight.
  isSettingAgentUpdateMode?: boolean;
  isUpdating: boolean;
  // Tier change
  onChangeTier: (params: {
    newTier: string;
    newInterval?: string;
    region?: string;
    forceMigration?: boolean;
  }) => void;
  isChangingTier: boolean;
  changeTierError: Error | null;
  changeTierData: unknown | null;
  resetChangeTier: () => void;
  // Cancel downgrade
  onCancelDowngrade: () => void;
  isCancellingDowngrade: boolean;
  // Upgrade
  onUpgrade?: () => void;
}

export const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useDashboard() {
  const context = useContext(DashboardContext);
  if (!context) {
    throw new Error("useDashboard must be used within DashboardLayout");
  }
  return context;
}
