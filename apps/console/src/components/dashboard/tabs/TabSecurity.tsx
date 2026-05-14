// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Shield,
  Lock,
  Unlock,
  ChevronDown,
  Check,
  X,
  Fingerprint,
  Copy,
  AlertTriangle,
  Trash2,
  BookOpen,
  Plus,
  Eye,
  Plug,
  ArrowRight,
  RotateCcw,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { GATE_CONFIG, formatRemaining } from "../GateControls";
import { AuditLogViewer } from "../AuditLogViewer";
import { CrossProjectAccess } from "../CrossProjectAccess";
import {
  tryParseSandboxId,
  sandboxIdFromPath,
  type SandboxId,
} from "@ellul.ai/types";
import { PoliciesCard } from "../PoliciesCard";
import { PolicyProposalsCard } from "../PolicyProposalsCard";
import { isPoliciesVisible } from "@/lib/feature-flags";
import { useWorkbenchOptional, type GateType, type GatePermission } from "@/contexts/WorkbenchContext";
import { api } from "@/lib/api";
import { useIntegrationGroups, type IntegrationGroup, type IntegrationGroupConnection } from "@/hooks/useIntegrationGroups";
import { useToolPermissions, type ToolPermissionLevel } from "@/hooks/useToolPermissions";
import { isContextVisible, isProviderVisible, isGateTypeVisible } from "@/lib/feature-flags";
import type { ApiApp } from "@/contexts/AppsListContext";

type SecurityTier = "standard" | "web_locked" | "private_locked";

type AppInfo = ApiApp;

interface TabProps {
  serverId: string;
  securityTier: SecurityTier;
  serverDomain: string;
  app?: AppInfo | null;
  allProjects?: string[];
  // Danger zone props — when provided, renders delete app section at the bottom
  dangerZone?: {
    sandboxId: string;
    onDelete: (appDir: string) => Promise<{ success: boolean }>;
    isDeleting: boolean;
    appDirectory: string;
    onDeleteSuccess: () => void;
  };
}

// ── Security Tab (Settings) ──

export function TabPermissions({ serverId, securityTier, serverDomain, app, allProjects = [], dangerZone }: TabProps) {
  // Security features are sandbox-scoped — fold the currently-selected app's
  // directory (`sbx-xxx/my-app`) up to the enclosing sandbox slug. Same for
  const currentSandboxId: SandboxId | null = app
    ? (() => {
        try {
          return sandboxIdFromPath(app.directory);
        } catch {
          return null;
        }
      })()
    : null;

  const sandboxIds = Array.from(
    new Set(
      allProjects
        .map((p) => tryParseSandboxId(p.split("/")[0] ?? ""))
        .filter((x): x is SandboxId => x !== null),
    ),
  );

  return (
    <div className="p-4 space-y-4">
      <ActionPermissionsCard app={app} />
      <McpToolPermissionsCard serverId={serverId} app={app} />
      <ReadAccessCard app={app} />
      {isPoliciesVisible() && (
        <>
          <PoliciesCard serverDomain={serverDomain} tier={securityTier} />
          <PolicyProposalsCard serverDomain={serverDomain} tier={securityTier} />
        </>
      )}
      {currentSandboxId && sandboxIds.length > 1 && (
        <CrossProjectAccess
          serverDomain={serverDomain}
          currentSandboxId={currentSandboxId}
          otherSandboxIds={sandboxIds.filter((s) => s !== currentSandboxId)}
          tier={securityTier}
        />
      )}
      {currentSandboxId && isContextVisible("vault") && (
        <VaultScopesCard
          serverDomain={serverDomain}
          project={currentSandboxId}
        />
      )}
      {dangerZone && <DangerZone {...dangerZone} />}
    </div>
  );
}

// ── Gates Tab (Observability) ──

export function TabMonitor({ securityTier, serverDomain }: TabProps) {
  return (
    <div className="p-4 space-y-4 overflow-y-auto flex-1">
      <GateStatusCard />
      <AuditLogViewer serverDomain={serverDomain} tier={securityTier} />
    </div>
  );
}

// ── Permission Dropdown ──

function usePermissionOptions(): { value: GatePermission; label: string }[] {
  const t = useTranslations("console.security");
  return [
    { value: "ask", label: t("permissionAsk") },
    { value: "allow_always", label: t("permissionAllowAlways") },
    { value: "never", label: t("permissionNever") },
  ];
}

function PermissionDropdown({
  value,
  onChange,
}: {
  value: GatePermission;
  onChange: (v: GatePermission) => void;
}) {
  const PERMISSION_OPTIONS = usePermissionOptions();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const current = PERMISSION_OPTIONS.find((o) => o.value === value) ?? PERMISSION_OPTIONS[0]!;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs border border-cream/[0.1] rounded-md px-2.5 py-1.5 text-cream/75 hover:border-cream/[0.2] hover:bg-cream/[0.03] transition-colors focus:outline-none focus:ring-1 focus:ring-sodium/50 min-w-[150px] justify-between"
      >
        <span>{current.label}</span>
        <ChevronDown className={`h-3 w-3 text-cream/45 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-full bg-card border border-cream/[0.08] rounded-lg shadow-2xl z-50 py-1 backdrop-blur-xl">
          {PERMISSION_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
              className="flex items-center justify-between w-full px-3 py-1.5 text-xs text-left hover:bg-cream/[0.06] transition-colors text-cream/75"
            >
              <span>{option.label}</span>
              {option.value === value && <Check className="h-3 w-3 text-sodium" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tool Permission Dropdown (with inherit + reset) ──

function useToolPermissionOptions(): { value: ToolPermissionLevel; label: string }[] {
  const t = useTranslations("console.security");
  return [
    { value: "inherit", label: t("permissionInherit") },
    { value: "ask", label: t("permissionAsk") },
    { value: "allow_session", label: t("permissionAllowSession") },
    { value: "allow_always", label: t("permissionAllowAlways") },
    { value: "never", label: t("permissionNever") },
  ];
}

function ToolPermissionDropdown({
  value,
  gateDefault,
  onChange,
  onReset,
  isInherited,
}: {
  value: ToolPermissionLevel;
  gateDefault: GatePermission;
  onChange: (v: ToolPermissionLevel) => void;
  onReset: () => void;
  isInherited: boolean;
}) {
  const t = useTranslations("console.security");
  const TOOL_PERMISSION_OPTIONS = useToolPermissionOptions();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const current = TOOL_PERMISSION_OPTIONS.find((o) => o.value === value) ?? TOOL_PERMISSION_OPTIONS[0]!;

  // For display: show what the inherited permission resolves to
  const gateLabelMap: Record<GatePermission, string> = {
    ask: t("permissionAsk"),
    allow_session: t("permissionAllowSession"),
    allow_always: t("permissionAllowAlways"),
    never: t("permissionNever"),
  };

  return (
    <div className="flex items-center gap-1.5">
      <div className="relative" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-xs border border-cream/[0.1] rounded-md px-2.5 py-1.5 text-cream/75 hover:border-cream/[0.2] hover:bg-cream/[0.03] transition-colors focus:outline-none focus:ring-1 focus:ring-sodium/50 min-w-[150px] justify-between"
        >
          <span>
            {isInherited ? (
              <span className="text-cream/60">
                {gateLabelMap[gateDefault]}
                <span className="text-cream/35 ml-1">{t("inheritedSuffix")}</span>
              </span>
            ) : (
              current.label
            )}
          </span>
          <ChevronDown className={`h-3 w-3 text-cream/45 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <div className="absolute right-0 top-full mt-1 w-[200px] bg-card border border-cream/[0.08] rounded-lg shadow-2xl z-50 py-1 backdrop-blur-xl">
            {TOOL_PERMISSION_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className="flex items-center justify-between w-full px-3 py-1.5 text-xs text-left hover:bg-cream/[0.06] transition-colors text-cream/75"
              >
                <span>
                  {option.label}
                  {option.value === "inherit" && (
                    <span className="text-cream/35 ml-1">({gateLabelMap[gateDefault]})</span>
                  )}
                </span>
                {option.value === value && <Check className="h-3 w-3 text-sodium" />}
              </button>
            ))}
            {!isInherited && (
              <>
                <div className="border-t border-cream/[0.06] my-1" />
                <button
                  type="button"
                  onClick={() => {
                    onReset();
                    setOpen(false);
                  }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-cream/[0.06] transition-colors text-cream/60"
                >
                  <RotateCcw className="h-3 w-3" />
                  {t("resetToDefault")}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shared gate permissions hook ──

function useGatePermissions(app?: AppInfo | null) {
  const ctx = useWorkbenchOptional();
  // Gate permissions are sandbox-scoped. Fold the selected app path to its
  const sandboxId = app ? tryParseSandboxId(app.directory.split("/")[0] ?? "") : null;

  useEffect(() => {
    if (sandboxId) ctx?.fetchGatePermissions(sandboxId);
  }, [sandboxId]); // eslint-disable-line react-hooks/exhaustive-deps

  const defaults: Record<GateType, GatePermission> = {
    logs: "ask",
    env: "ask",
    db: "ask",
    db_read: "ask",
    db_write: "ask",
    db_migrate: "ask",
    db_full: "ask",
    git: "ask",
    deploy: "ask",
  };
  const gatePerms: Record<GateType, GatePermission> =
    (sandboxId && ctx?.appGatePermissions[sandboxId]) || defaults;

  const handleChange = (gate: GateType, permission: GatePermission) => {
    if (sandboxId) ctx?.setGatePermission(gate, sandboxId, permission);
  };

  return { sandboxId, gatePerms, handleChange };
}

// ── Gate list renderer ──

function GateList({ gates, gatePerms, handleChange }: {
  gates: GateType[];
  gatePerms: Record<GateType, GatePermission>;
  handleChange: (gate: GateType, perm: GatePermission) => void;
}) {
  const tGates = useTranslations("console.gates");
  return (
    <>
      {gates.map((gate) => {
        const config = GATE_CONFIG[gate];
        const Icon = config.icon;
        return (
          <div key={gate} className="flex items-center justify-between rounded-lg border border-cream/[0.06] bg-cream/[0.02] px-3 py-2.5">
            <div className="flex items-center gap-2.5">
              <div className={`rounded-full p-1.5 ${config.bgRing}`}>
                <Icon className={`h-3.5 w-3.5 ${config.iconColor}`} />
              </div>
              <div>
                <span className="text-xs font-medium text-cream/85">{tGates(`${gate}.label` as "logs.label")}</span>
                <p className="text-[10px] text-cream/45">{tGates(`${gate}.description` as "logs.description")}</p>
              </div>
            </div>
            <PermissionDropdown value={gatePerms[gate] || "ask"} onChange={(v) => handleChange(gate, v)} />
          </div>
        );
      })}
    </>
  );
}

// ── Action Permissions Card (for Permissions tab) ──

function ActionPermissionsCard({ app }: { app?: AppInfo | null }) {
  const t = useTranslations("console.security");
  const { sandboxId, gatePerms, handleChange } = useGatePermissions(app);

  if (!sandboxId) {
    return (
      <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4">
        <div className="flex items-center gap-2 mb-2">
          <Shield className="h-4 w-4 text-cream/60" />
          <span className="text-sm font-medium text-cream">{t("agentPermissionsTitle")}</span>
        </div>
        <p className="text-xs text-cream/60">{t("selectSandbox")}</p>
      </div>
    );
  }

  const actionGates = (["git", "deploy", "db_migrate", "db_full"] as GateType[]).filter(isGateTypeVisible);
  const writeGates = (["db", "db_write"] as GateType[]).filter(isGateTypeVisible);

  return (
    <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Shield className="h-4 w-4 text-cream/60" />
          <span className="text-sm font-medium text-cream">{t("agentPermissionsTitle")}</span>
        </div>
        <p className="text-xs text-cream/60">{t("agentPermissionsSubtitle")}</p>
      </div>

      {/* Actions group */}
      <div className="space-y-2">
        <div>
          <p className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">{t("oneTimeActions")}</p>
          <p className="text-[10px] text-cream/45 mt-0.5">
            {t("oneTimeActionsHint")}
          </p>
        </div>
        <GateList gates={actionGates} gatePerms={gatePerms} handleChange={handleChange} />
      </div>

      {/* Write access group */}
      <div className="space-y-2">
        <div>
          <p className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">{t("writeAccess")}</p>
          <p className="text-[10px] text-cream/45 mt-0.5">
            {t("writeAccessHint")}
          </p>
        </div>
        <GateList gates={writeGates} gatePerms={gatePerms} handleChange={handleChange} />
      </div>
    </div>
  );
}

// ── Read Access Card (for Monitor tab) ──

function ReadAccessCard({ app }: { app?: AppInfo | null }) {
  const t = useTranslations("console.security");
  const { sandboxId, gatePerms, handleChange } = useGatePermissions(app);

  if (!sandboxId) {
    return null;
  }

  const readGates = (["env", "logs", "db_read"] as GateType[]).filter(isGateTypeVisible);

  return (
    <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Shield className="h-4 w-4 text-cream/60" />
          <span className="text-sm font-medium text-cream">{t("readAccessTitle")}</span>
        </div>
        <p className="text-xs text-cream/60">{t("readAccessSubtitle")}</p>
      </div>

      <div className="space-y-2">
        <div>
          <p className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">{t("timeLimitedAccess")}</p>
          <p className="text-[10px] text-cream/45 mt-0.5">
            {t("timeLimitedAccessHint")}
          </p>
        </div>
        <GateList gates={readGates} gatePerms={gatePerms} handleChange={handleChange} />
      </div>
    </div>
  );
}

// ── Capability → Gate Mapping ──

function useCapabilityLabels(): Record<string, string> {
  const t = useTranslations("console.security");
  return {
    "database:read": t("capabilityDatabaseRead"),
    "database:write": t("capabilityDatabaseWrite"),
    "database:schema": t("capabilityDatabaseSchema"),
    "execution:shell": t("capabilityExecutionShell"),
    "network:egress": t("capabilityNetworkEgress"),
    "deployment:trigger": t("capabilityDeploymentTrigger"),
    "secrets:read": t("capabilitySecretsRead"),
    "secrets:write": t("capabilitySecretsWrite"),
    "git:read": t("capabilityGitRead"),
    "git:write": t("capabilityGitWrite"),
    "filesystem:read": t("capabilityFilesystemRead"),
    "filesystem:write": t("capabilityFilesystemWrite"),
    "external:read": t("capabilityExternalRead"),
    "external:write": t("capabilityExternalWrite"),
    "external:admin": t("capabilityExternalAdmin"),
  };
}

const CAPABILITY_TO_GATE: Record<string, GateType> = {
  "database:read": "db_read",
  "database:write": "db_write",
  "database:schema": "db_migrate",
  "execution:shell": "env",
  "network:egress": "env",
  "deployment:trigger": "deploy",
  "git:read": "git",
  "git:write": "git",
  "secrets:read": "env",
  "secrets:write": "env",
  "external:read": "env",
  "external:write": "env",
  "external:admin": "env",
};

// Human-readable label for a provider kind
function useProviderLabel(): (kind: string) => string {
  const t = useTranslations("console.security");
  return (kind: string) => {
    const labels: Record<string, string> = {
      neon: t("providerNeon"),
      supabase: t("providerSupabase"),
      stripe: t("providerStripe"),
      vercel: t("providerVercel"),
      github: t("providerGithub"),
      turso: t("providerTurso"),
      planetscale: t("providerPlanetscale"),
    };
    return labels[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
  };
}

// ── MCP Tool Permissions Card ──

interface McpToolPermissionsCardProps {
  serverId: string;
  app?: AppInfo | null;
}

// Per-connection capability row with its governing gate and editable permission
interface CapabilityRow {
  capability: string;
  capabilityLabel: string;
  gate: GateType;
}

function getConnectionCapabilities(
  conn: IntegrationGroupConnection,
  capabilityLabels: Record<string, string>,
): CapabilityRow[] {
  // Infer capabilities from the provider kind
  const capsByProvider: Record<string, string[]> = {
    neon: ["database:read", "database:write", "database:schema"],
    supabase: ["database:read", "database:write", "database:schema"],
    turso: ["database:read", "database:write"],
    planetscale: ["database:read", "database:write", "database:schema"],
    stripe: ["external:read", "external:write"],
    vercel: ["deployment:trigger"],
    github: ["git:read", "git:write"],
  };

  const caps = capsByProvider[conn.providerKind] ?? ["external:read"];
  return caps.map((cap) => ({
    capability: cap,
    capabilityLabel: capabilityLabels[cap] ?? cap,
    gate: CAPABILITY_TO_GATE[cap] ?? "env" as GateType,
  }));
}

function McpToolPermissionsCard({ serverId, app }: McpToolPermissionsCardProps) {
  const t = useTranslations("console.security");
  const sandboxId = app?.directory ?? null;
  const { groups, isLoading } = useIntegrationGroups(serverId, sandboxId);
  const { gatePerms } = useGatePermissions(app);

  // Filter to groups that have at least one agent-enabled connection
  const agentGroups = groups.filter((g) =>
    g.connections.some((c) => c.agentExposure === "enabled"),
  );

  if (!sandboxId || isLoading || agentGroups.length === 0) return null;

  return (
    <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Plug className="h-4 w-4 text-cream/60" />
          <span className="text-sm font-medium text-cream">{t("connectedToolPermissionsTitle")}</span>
        </div>
        <p className="text-xs text-cream/60">
          {t("connectedToolPermissionsSubtitle")}
        </p>
      </div>

      {agentGroups.map((group) => (
        <McpGroupSection
          key={group.id}
          serverId={serverId}
          sandboxId={sandboxId}
          group={group}
          gatePerms={gatePerms}
        />
      ))}
    </div>
  );
}

function McpGroupSection({ serverId, sandboxId, group, gatePerms }: {
  serverId: string;
  sandboxId: string | null;
  group: IntegrationGroup;
  gatePerms: Record<GateType, GatePermission>;
}) {
  const enabledConns = group.connections.filter(
    (c) => c.agentExposure === "enabled" && isProviderVisible(c.providerKind),
  );

  return (
    <div className="space-y-2">
      <p className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">
        {group.name}
        {group.routeRole && (
          <span className="ml-1.5 text-[9px] font-normal text-cream/45 normal-case">
            {group.routeRole}
          </span>
        )}
      </p>

      {enabledConns.map((conn) => (
        <McpConnectionToolRows
          key={conn.id}
          serverId={serverId}
          sandboxId={sandboxId}
          groupId={group.id}
          conn={conn}
          gatePerms={gatePerms}
        />
      ))}

      {/* Quarantined / disabled connections warning */}
      <QuarantinedConnectionsNotice group={group} />
    </div>
  );
}

// Renders per-tool permission rows for a single connection
function McpConnectionToolRows({ serverId, sandboxId, groupId, conn, gatePerms }: {
  serverId: string;
  sandboxId: string | null;
  groupId: string;
  conn: IntegrationGroupConnection;
  gatePerms: Record<GateType, GatePermission>;
}) {
  const t = useTranslations("console.security");
  const capabilityLabels = useCapabilityLabels();
  const providerLabel = useProviderLabel();
  const caps = getConnectionCapabilities(conn, capabilityLabels);
  const isHealthy = conn.connectionStatus === "connected";
  const ctx = useWorkbenchOptional();

  const {
    getToolPermission,
    setPermission,
    resetPermission,
  } = useToolPermissions(serverId, sandboxId, groupId, conn.id);

  const handleToolPermissionChange = (
    toolCapability: string,
    toolName: string,
    gate: GateType,
    newValue: ToolPermissionLevel,
  ) => {
    if (newValue === "inherit") {
      // Remove the per-tool override
      resetPermission.mutate(toolName);
      // Notify VPS via WebSocket
      ctx?.sendToolPermissionReset?.(conn.id, toolName);
    } else {
      // Set a per-tool override
      setPermission.mutate({
        toolName,
        capability: toolCapability,
        permission: newValue,
      });
      // Notify VPS via WebSocket
      ctx?.sendToolPermissionSet?.(conn.id, toolName, newValue);
    }
  };

  return (
    <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.015] overflow-hidden">
      {/* Connection header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-cream/[0.04]">
        <div className={`h-1.5 w-1.5 rounded-full ${isHealthy ? "bg-sodium" : "bg-sodium"}`} />
        <span className="text-xs font-medium text-cream/75">
          {conn.displayName || providerLabel(conn.providerKind)}
        </span>
        {conn.isDefaultRoute && (
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-sodium/10 text-sodium font-medium">
            {t("defaultBadge")}
          </span>
        )}
      </div>

      {/* Capability → per-tool permission rows */}
      <div className="divide-y divide-cream/[0.03]">
        {caps.map((row) => {
          const resolved = getToolPermission(row.capability);
          const gateDefault = gatePerms[row.gate] || "ask";

          return (
            <div key={row.capability} className="flex items-center justify-between px-3 py-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-[10px] text-cream/45 font-mono shrink-0">{row.capabilityLabel}</span>
              </div>
              <ToolPermissionDropdown
                value={resolved.permission}
                gateDefault={gateDefault}
                isInherited={resolved.isInherited}
                onChange={(v) => handleToolPermissionChange(row.capability, row.capability, row.gate, v)}
                onReset={() => {
                  resetPermission.mutate(row.capability);
                  ctx?.sendToolPermissionReset?.(conn.id, row.capability);
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function QuarantinedConnectionsNotice({ group }: { group: IntegrationGroup }) {
  const t = useTranslations("console.security");
  const disabledCount = group.connections.filter((c) => c.agentExposure === "disabled").length;
  const unhealthyCount = group.connections.filter(
    (c) => c.agentExposure === "enabled" && c.connectionStatus !== "connected",
  ).length;

  if (disabledCount === 0 && unhealthyCount === 0) return null;

  const parts: string[] = [];
  if (unhealthyCount > 0) parts.push(t("quarantinedUnhealthy", { count: unhealthyCount }));
  if (disabledCount > 0) parts.push(t("quarantinedDisabled", { count: disabledCount }));

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-sodium/5 border border-sodium/10">
      <AlertTriangle className="h-3 w-3 text-sodium shrink-0" />
      <span className="text-[10px] text-sodium">
        {t("quarantinedSuffix", { summary: parts.join(", "), count: disabledCount + unhealthyCount })}
      </span>
    </div>
  );
}

// ── Active Gates Card ──

function GateStatusCard() {
  const t = useTranslations("console.security");
  const tGatesNs = useTranslations("console.gates");
  const gates = (["env", "logs", "db", "db_read", "db_write", "db_migrate", "db_full"] as GateType[]).filter(isGateTypeVisible);
  const ctx = useWorkbenchOptional();
  const [now, setNow] = useState(Date.now());

  const gateStatus = ctx?.gateStatus;
  const revokeGate = ctx?.revokeGate;

  const openCount = gateStatus
    ? Object.values(gateStatus).filter((info) => info.active).length
    : 0;

  useEffect(() => {
    if (openCount === 0) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [openCount]);

  return (
    <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {openCount > 0 ? (
            <Unlock className="h-4 w-4 text-sodium" />
          ) : (
            <Lock className="h-4 w-4 text-cream/60" />
          )}
          <span className="text-sm font-medium text-cream">{t("gateStatusTitle")}</span>
        </div>
        {openCount > 0 && (
          <Badge variant="warning" className="text-[10px]">
            {t("gateOpenBadge", { count: openCount })}
          </Badge>
        )}
      </div>

      <div className="space-y-1.5">
        {gates.map((gate) => {
          const config = GATE_CONFIG[gate];
          const Icon = config.icon;
          const gateLabel = tGatesNs(`${gate}.label` as "logs.label");
          const info = gateStatus?.[gate];
          const isOpen = info?.active ?? false;
          const remaining = isOpen && info?.expiresAt ? info.expiresAt - now : null;
          const isUrgent = remaining !== null && remaining < 30_000;
          const isExpired = remaining !== null && remaining <= 0;
          const effectivelyOpen = isOpen && !isExpired;

          return (
            <div
              key={gate}
              className={`flex items-center justify-between rounded-lg border px-3 py-2 transition-colors ${
                effectivelyOpen
                  ? isUrgent
                    ? "border-terra/30 bg-terra/5"
                    : "border-sodium/20 bg-sodium/5"
                  : "border-cream/[0.06] bg-cream/[0.02]"
              }`}
            >
              <div className="flex items-center gap-2.5">
                {effectivelyOpen ? (
                  <Unlock className={`h-3.5 w-3.5 ${isUrgent ? "text-terra" : "text-sodium"}`} />
                ) : (
                  <Lock className="h-3.5 w-3.5 text-cream/45" />
                )}
                <Icon className={`h-3.5 w-3.5 ${config.iconColor}`} />
                <span className="text-xs font-medium text-cream/85">{gateLabel}</span>
              </div>

              {effectivelyOpen ? (
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-mono tabular-nums ${isUrgent ? "text-terra" : "text-sodium"}`}>
                    {remaining !== null ? formatRemaining(remaining) : t("openLabel")}
                  </span>
                  <button
                    type="button"
                    onClick={() => revokeGate?.(gate)}
                    className="flex items-center gap-1 text-[10px] text-cream/60 hover:text-terra border border-cream/[0.08] hover:border-terra/30 rounded-md px-1.5 py-0.5 transition-colors"
                  >
                    <X className="h-2.5 w-2.5" />
                    {t("revoke")}
                  </button>
                </div>
              ) : (
                <span className="text-[10px] text-cream/45">{t("lockedLabel")}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Encryption Fingerprint Card ──

export function EncryptionFingerprintCard({ serverId }: { serverId: string }) {
  const t = useTranslations("console.security");
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const { data } = useQuery<{ fingerprint: string }>({
    queryKey: ["publicKey", serverId],
    queryFn: async () => {
      const response = await api.api.servers[":id"]["public-key"].$get({
        param: { id: serverId },
      });
      if (!response.ok) throw new Error("Failed to fetch");
      return response.json() as Promise<{ fingerprint: string }>;
    },
    retry: false,
  });

  const fingerprint = data?.fingerprint;
  if (!fingerprint) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fingerprint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not available
    }
  };

  return (
    <div className="rounded-xl border border-cream/[0.04] bg-cream/[0.01] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-cream/[0.02] transition-colors"
      >
        <Fingerprint className="h-3.5 w-3.5 text-cream/45" />
        <span className="text-xs text-cream/45 flex-1">{t("encryptionFingerprintTitle")}</span>
        <ChevronDown className={`h-3 w-3 text-cream/35 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          <p className="text-[10px] text-cream/45 leading-relaxed">
            {t("encryptionFingerprintHint")}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[10px] font-mono text-cream/45 break-all bg-black/20 rounded-lg px-3 py-2 border border-cream/[0.04]">
              {fingerprint}
            </code>
            <button
              onClick={handleCopy}
              className="shrink-0 p-2 rounded-lg hover:bg-cream/[0.06] text-cream/45 hover:text-cream transition-colors"
              title={t("copyFingerprint")}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-sodium" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Danger Zone ──

function DangerZone({ sandboxId, onDelete, isDeleting, appDirectory, onDeleteSuccess }: {
  sandboxId: string;
  onDelete: (appDir: string) => Promise<{ success: boolean; error?: string }>;
  isDeleting: boolean;
  appDirectory: string;
  onDeleteSuccess: () => void;
}) {
  const t = useTranslations("console.security");
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  return (
    <div className="border border-terra/30 rounded-xl bg-terra/5 p-4 mt-8">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="h-4 w-4 text-terra" />
        <h3 className="text-sm font-medium text-terra">{t("dangerZoneTitle")}</h3>
      </div>
      <div className="space-y-4">
        <div>
          <h4 className="text-sm font-medium text-cream mb-1">{t("deleteSandboxTitle")}</h4>
          <p className="text-xs text-cream/60 mb-3">
            {t("deleteSandboxBodyPrefix")}{" "}
            <code className="text-terra bg-terra/10 px-1 rounded">{sandboxId}</code> {t("deleteSandboxBodySuffix")}
          </p>
          {!showConfirm ? (
            <button
              onClick={() => setShowConfirm(true)}
              className="px-4 py-2 text-sm font-medium text-terra border border-terra/50 rounded-lg hover:bg-terra/10 transition-colors"
            >
              {t("deleteSandboxButton")}
            </button>
          ) : (
            <div className="space-y-3 p-3 border border-terra/30 rounded-lg bg-card">
              <p className="text-xs text-cream/75">
                {t("deleteConfirmTypePrefix")} <code className="text-terra bg-terra/10 px-1 rounded font-bold">{sandboxId}</code> {t("deleteConfirmTypeSuffix")}
              </p>
              <input
                type="text"
                value={confirmName}
                onChange={(e) => {
                  setConfirmName(e.target.value);
                  if (deleteError) setDeleteError(null);
                }}
                placeholder={t("deleteConfirmPlaceholder")}
                className="w-full px-3 py-2 text-sm bg-[#0B0B0F] border border-terra/30 rounded-md text-cream placeholder:text-cream/45 focus:outline-none focus:ring-1 focus:ring-terra"
              />
              {deleteError && (
                <div className="px-3 py-2 bg-terra/10 border border-terra/30 rounded-md text-xs text-terra">
                  {deleteError}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => { setShowConfirm(false); setConfirmName(""); setDeleteError(null); }}
                  disabled={isDeleting}
                  className="flex-1 px-3 py-2 text-sm text-cream/60 hover:text-cream bg-secondary hover:bg-secondary/80 rounded-md transition-colors disabled:opacity-50"
                >
                  {t("cancel")}
                </button>
                <button
                  onClick={async () => {
                    if (confirmName !== sandboxId) return;
                    setDeleteError(null);
                    const result = await onDelete(appDirectory);
                    if (result.success) {
                      setShowConfirm(false);
                      setConfirmName("");
                      onDeleteSuccess();
                    } else {
                      setDeleteError(result.error || t("deleteFailed"));
                    }
                  }}
                  disabled={confirmName !== sandboxId || isDeleting}
                  className="flex-1 px-3 py-2 text-sm font-medium text-cream bg-terra hover:bg-terra disabled:opacity-50 disabled:cursor-not-allowed rounded-md transition-colors flex items-center justify-center gap-2"
                >
                  {isDeleting ? (
                    <>
                      <Spinner size="sm" delay={300} />
                      {t("deleting")}
                    </>
                  ) : (
                    <>
                      <Trash2 className="h-4 w-4" />
                      {t("deletePermanently")}
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Vault Scopes Card (Settings > Security) ──

function VaultScopesCard({ serverDomain, project }: { serverDomain: string; project: string }) {
  const t = useTranslations("console.vault.scopes");
  const [scopes, setScopes] = useState<Array<{
    id: number;
    name: string;
    description: string | null;
    isAgentDefault: boolean;
    version: number;
    rules: { default: string; rules: any[]; boundary_disclosure: boolean };
  }>>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `https://${serverDomain}/_auth/vault/scopes?project=${encodeURIComponent(project)}`,
          { credentials: "include" },
        );
        if (res.ok && !cancelled) {
          const data = await res.json();
          setScopes(data.scopes || []);
        }
      } catch {}
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [serverDomain, project]);

  return (
    <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <BookOpen className="h-4 w-4 text-cream/60" />
            <span className="text-sm font-medium text-cream">{t("settingsTitle")}</span>
          </div>
          <p className="text-xs text-cream/60">
            {t("settingsSubtitle")}
          </p>
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="p-1.5 rounded-lg hover:bg-cream/[0.04] text-cream/60 hover:text-cream transition-colors"
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
      </div>

      {expanded && (
        <div className="space-y-2 pt-1">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-cream/45">
              <Spinner className="h-3 w-3" /> {t("settingsLoading")}
            </div>
          ) : scopes.length === 0 ? (
            <div className="text-xs text-cream/45 italic py-2">
              {t("settingsNoScopes")}
            </div>
          ) : (
            scopes.map((scope) => (
              <div key={scope.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-cream/[0.02] border border-cream/[0.04]">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-cream">{scope.name}</span>
                    {scope.isAgentDefault && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-sodium/10 text-sodium font-medium">
                        {t("agentDefaultBadge")}
                      </span>
                    )}
                    {scope.rules.boundary_disclosure && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-sodium/10 text-sodium font-medium">
                        <Eye className="h-2.5 w-2.5 inline mr-0.5" />
                        {t("settingsBoundaryBadge")}
                      </span>
                    )}
                  </div>
                  {scope.description && (
                    <p className="text-[10px] text-cream/45 mt-0.5 truncate">{scope.description}</p>
                  )}
                </div>
                <div className="text-[10px] text-cream/35 shrink-0 ml-3">
                  {t("settingsScopeMeta", { version: scope.version, count: scope.rules.rules.length, default: scope.rules.default })}
                </div>
              </div>
            ))
          )}

          <p className="text-[10px] text-cream/35 pt-1">
            {t("settingsManageHintPrefix")} <span className="text-cream/60">{t("settingsManageHintLink")}</span> {t("settingsManageHintSuffix")}
          </p>
        </div>
      )}
    </div>
  );
}
