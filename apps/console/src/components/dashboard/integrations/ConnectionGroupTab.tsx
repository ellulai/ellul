// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  X,
  Pencil,
  Trash2,
  Plus,
  Check,
  Loader2,
  AlertTriangle,
  Star,
  Eye,
  EyeOff,
  Terminal,
  Database,
  Rocket,
  GitBranch,
  KeyRound,
  Shield,
  Bot,
  Layers,
  Network,
  Activity,
  Server,
  Search,
  ChevronDown,
  ChevronUp,
  GitCommit,
  Lock,
  Globe,
  ExternalLink,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { API_URL } from "@/lib/api";
import { isLocalhost } from "@/lib/cloud-auth";
import { toast } from "sonner";
import type {
  IntegrationGroup,
  IntegrationGroupConnection,
} from "@/hooks/useIntegrationGroups";
import { ToolReview } from "./ToolReview";
import type { DiscoveredTool } from "./ToolReview";
import { CreateRepoDialog } from "../git/CreateRepoDialog";
import { useVpsBridge } from "@/lib/vps-bridge";

// ─── Types ──────────────────────────────────────────────────────────────────

interface ConnectionGroupTabProps {
  group: IntegrationGroup;
  serverId: string;
  serverDomain: string;
  selectedApp?: string | null;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  terminal: Terminal,
  database: Database,
  rocket: Rocket,
  "git-branch": GitBranch,
  key: KeyRound,
  shield: Shield,
  bot: Bot,
  layers: Layers,
  network: Network,
  activity: Activity,
};

function useRouteRoleLabels(): Record<string, string> {
  const t = useTranslations("console.connectionGroup");
  return {
    "db-default": t("routeRoleDbDefault"),
    "deploy-default": t("routeRoleDeployDefault"),
    "git-default": t("routeRoleGitDefault"),
  };
}

function useRoleDeleteWarnings(): Record<string, string[]> {
  const t = useTranslations("console.connectionGroup");
  return {
    "db-default": [
      t("deleteWarningStopDb"),
      t("deleteWarningRemoveDb"),
      t("deleteWarningRemoveAgentDb"),
    ],
    "deploy-default": [
      t("deleteWarningStopDeploy"),
      t("deleteWarningRemoveDeploy"),
      t("deleteWarningRemoveAgentDeploy"),
    ],
    "git-default": [
      t("deleteWarningStopGit"),
      t("deleteWarningRemoveGit"),
      t("deleteWarningRemoveAgentGit"),
    ],
  };
}

interface ProviderEntry {
  id: string;
  label: string;
  roles: string[];
}

import { isProviderVisible } from "@/lib/feature-flags";
import { useVisualViewport } from "@/hooks/useVisualViewport";

// Filter providers to those compatible with the group's route role. No role = show all.
function getProvidersForRole(providers: ProviderEntry[], routeRole: string | null) {
  // First, gate by release flags
  const visible = providers.filter(p => isProviderVisible(p.id));
  if (!routeRole) return visible;
  return visible.filter(p => p.roles.includes(routeRole));
}

function useProviderLabel(): Record<string, string> {
  const t = useTranslations("console.connectionGroup");
  return {
    github: "GitHub",
    gitlab: "GitLab",
    bitbucket: "Bitbucket",
    vercel: "Vercel",
    cloudflare_workers: "Cloudflare",
    "cloudflare-workers": "Cloudflare",
    supabase: "Supabase",
    neon: "Neon",
    planetscale: "PlanetScale",
    turso: "Turso",
    stripe: "Stripe",
    custom: t("providerCustom"),
  };
}

const TRANSPORT_OPTIONS = ["SSE", "Streamable HTTP", "stdio"] as const;

const PROVIDER_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  github: GitBranch,
  gitlab: GitBranch,
  bitbucket: GitBranch,
  vercel: Rocket,
  supabase: Database,
  neon: Database,
  "cloudflare-workers": Terminal,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const color =
    status === "connected"
      ? "bg-sodium"
      : status === "error"
        ? "bg-terra"
        : "bg-ink-1";
  return (
    <span
      className={cn("w-2 h-2 rounded-full shrink-0", color)}
      title={status}
    />
  );
}

function AdapterBadge({ adapter }: { adapter: string }) {
  const isMcp = adapter === "mcp";
  return (
    <span
      className={cn(
        "px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wider border",
        isMcp
          ? "bg-sodium/10 text-cream/65 border-sodium/20"
          : "bg-blue-500/10 text-blue-400 border-blue-500/20",
      )}
    >
      {isMcp ? "MCP" : "OAuth"}
    </span>
  );
}

function getProviderIcon(providerKind: string): React.ComponentType<{ className?: string }> {
  return PROVIDER_ICONS[providerKind] ?? Server;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ConnectionGroupTab({
  group,
  serverId,
  serverDomain,
  selectedApp,
}: ConnectionGroupTabProps) {
  const t = useTranslations("console.connectionGroup");
  const ROUTE_ROLE_LABELS = useRouteRoleLabels();
  const queryClient = useQueryClient();

  // Fetch available providers (only configured ones — dynamic, not hardcoded)
  const { data: providersData } = useQuery<{ providers: ProviderEntry[] }>({
    queryKey: ["available-providers", serverId],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/servers/${serverId}/available-providers`, {
        credentials: "include",
      });
      if (!res.ok) return { providers: [] };
      return res.json();
    },
  });
  const availableProviders = providersData?.providers ?? [];

  const isEmptyGitGroup = group.routeRole === "git-default" && group.connections.length === 0;
  const { data: gitConnsData } = useQuery<{ connections: Array<{ provider: string; providerUsername: string | null }> }>({
    queryKey: ["git-connections-check"],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/git/connections`, { credentials: "include" });
      if (!res.ok) return { connections: [] };
      return res.json();
    },
    enabled: isEmptyGitGroup,
  });
  const existingGitConns = gitConnsData?.connections ?? [];

  const wireGitMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_URL}/api/servers/${serverId}/groups/${group.id}/wire-git`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to wire git connection");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["integration-groups"] });
      toast.success(t("connect"));
    },
    onError: () => toast.error(t("addConnectionFailed")),
  });

  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(group.name);
  const [showDeleteWarning, setShowDeleteWarning] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addMode, setAddMode] = useState<"select" | "custom">("select");
  const [customName, setCustomName] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customTransport, setCustomTransport] = useState("SSE");
  const [customAuthToken, setCustomAuthToken] = useState("");
  const [viewingToolsFor, setViewingToolsFor] = useState<string | null>(null);
  const [discoveredTools, setDiscoveredTools] = useState<Record<string, DiscoveredTool[]>>({});

  const GroupIcon = ICON_MAP[group.iconKey] ?? Terminal;
  const isRoleGroup = !!group.routeRole;

  // ── Mutations ──

  const invalidateGroups = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["integration-groups"] }),
    [queryClient],
  );

  const updateGroupMutation = useMutation({
    mutationFn: async (body: { name?: string; iconKey?: string; routeRole?: string }) => {
      const res = await fetch(
        `${API_URL}/api/servers/${serverId}/groups/${group.id}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error("Failed to update group");
      return res.json();
    },
    onSuccess: () => {
      invalidateGroups();
      toast.success(t("groupUpdated"));
    },
    onError: () => toast.error(t("updateGroupFailed")),
  });

  const deleteGroupMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `${API_URL}/api/servers/${serverId}/groups/${group.id}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to delete group");
    },
    onSuccess: () => {
      invalidateGroups();
      toast.success(t("groupDeleted"));
    },
    onError: () => toast.error(t("deleteGroupFailed")),
  });

  const setDefaultMutation = useMutation({
    mutationFn: async (connectionId: string) => {
      const res = await fetch(
        `${API_URL}/api/servers/${serverId}/groups/${group.id}/connections/${connectionId}/set-default`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      if (!res.ok) throw new Error("Failed to set default");
      return res.json();
    },
    onSuccess: () => {
      invalidateGroups();
      toast.success(t("defaultUpdated"));
    },
    onError: () => toast.error(t("setDefaultFailed")),
  });

  const toggleAgentMutation = useMutation({
    mutationFn: async ({ connectionId, enabled }: { connectionId: string; enabled: boolean }) => {
      const action = enabled ? "enable-agent" : "disable-agent";
      const res = await fetch(
        `${API_URL}/api/servers/${serverId}/groups/${group.id}/connections/${connectionId}/${action}`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      if (!res.ok) throw new Error("Failed to update agent exposure");
      return res.json();
    },
    onSuccess: () => {
      invalidateGroups();
    },
    onError: () => toast.error(t("agentExposureFailed")),
  });

  const removeConnectionMutation = useMutation({
    mutationFn: async (connectionId: string) => {
      const res = await fetch(
        `${API_URL}/api/servers/${serverId}/groups/${group.id}/connections/${connectionId}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to remove connection");
    },
    onSuccess: () => {
      invalidateGroups();
      toast.success(t("connectionRemoved"));
    },
    onError: () => toast.error(t("removeConnectionFailed")),
  });

  const addMcpConnectionMutation = useMutation({
    mutationFn: async (body: { displayName: string; mcpUrl: string; mcpTransport: string; authToken?: string }) => {
      const res = await fetch(
        `${API_URL}/api/servers/${serverId}/groups/${group.id}/connections`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerKind: "custom",
            adapterType: "mcp",
            displayName: body.displayName,
            mcpUrl: body.mcpUrl,
            mcpTransport: body.mcpTransport,
          }),
        },
      );
      if (!res.ok) throw new Error("Failed to add connection");
      return res.json();
    },
    onSuccess: () => {
      invalidateGroups();
      toast.success(t("mcpAdded"));
      setCustomName("");
      setCustomUrl("");
      setCustomTransport("SSE");
      setCustomAuthToken("");
      setAddMode("select");
      setShowAddForm(false);
    },
    onError: () => toast.error(t("addConnectionFailed")),
  });

  const discoverToolsMutation = useMutation({
    mutationFn: async (connectionId: string) => {
      const res = await fetch(
        `${API_URL}/api/servers/${serverId}/groups/${group.id}/connections/${connectionId}/discover`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? t("discoveryNotAvailable"));
      }
      return res.json() as Promise<{ tools: DiscoveredTool[]; message?: string }>;
    },
    onSuccess: (data) => {
      // Tools are discovered on the VPS bridge, not the API.
      toast.success(t("discoverySuccess"));
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : t("discoveryFailed")),
  });

  // ── Handlers ──

  const handleSaveName = useCallback(() => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== group.name) {
      updateGroupMutation.mutate({ name: trimmed });
    }
    setIsEditingName(false);
  }, [editName, group.name, updateGroupMutation]);

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSaveName();
      } else if (e.key === "Escape") {
        setEditName(group.name);
        setIsEditingName(false);
      }
    },
    [handleSaveName, group.name],
  );

  const handleProviderClick = useCallback(
    async (provider: string) => {
      let connectPath: string;
      if (["github", "gitlab", "bitbucket"].includes(provider)) {
        connectPath = `/api/git/connect/${provider}`;
      } else if (provider === "cloudflare-workers") {
        connectPath = `/api/integrations/cloudflare/connect`;
      } else {
        connectPath = `/api/integrations/connect/${provider}`;
      }
      const params = new URLSearchParams({
        groupId: group.id,
        return_origin: window.location.origin,
        return_path: window.location.pathname + window.location.search,
      });
      const url = `${API_URL}${connectPath}?${params.toString()}`;

      if (isLocalhost()) {
        window.location.href = `${API_URL}/api/auth/native/start?provider=google&chain_redirect=${encodeURIComponent(url)}`;
        return;
      }
      window.location.href = url;
    },
    [group.id],
  );

  const handleCustomSubmit = useCallback(() => {
    if (!customName.trim() || !customUrl.trim()) return;
    // Map UI transport labels to API enum values
    const transportMap: Record<string, string> = {
      SSE: "sse",
      "Streamable HTTP": "streamable-http",
      stdio: "stdio",
    };
    addMcpConnectionMutation.mutate({
      displayName: customName.trim(),
      mcpUrl: customUrl.trim(),
      mcpTransport: transportMap[customTransport] ?? "sse",
      authToken: customAuthToken.trim() || undefined,
    });
  }, [customName, customUrl, customTransport, customAuthToken, addMcpConnectionMutation]);

  const handleDeleteGroup = useCallback(() => {
    setShowDeleteWarning(false);
    deleteGroupMutation.mutate();
  }, [deleteGroupMutation]);

  // Suppress unused var (serverDomain reserved for future use)
  void serverDomain;

  return (
    <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-4">
      {/* Group Header */}
      <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] overflow-hidden">
        <div className="px-4 py-3 flex items-center gap-3">
          <div className="p-2 rounded-lg bg-cream/[0.04]">
            <GroupIcon className="h-5 w-5 text-cream/75" />
          </div>

          <div className="flex-1 min-w-0">
            {isEditingName ? (
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleSaveName}
                onKeyDown={handleNameKeyDown}
                className="text-sm font-medium text-cream bg-cream/[0.03] border border-sodium/50 rounded-lg px-2 py-1 focus:outline-none w-full"
                autoFocus
              />
            ) : (
              <button
                onClick={() => {
                  setEditName(group.name);
                  setIsEditingName(true);
                }}
                className="text-sm font-semibold text-cream uppercase tracking-wider hover:text-sodium transition-colors text-left"
                title={t("editName")}
              >
                {group.name}
              </button>
            )}
            <div className="flex items-center gap-2 mt-0.5">
              {group.routeRole && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-sodium/10 text-sodium border border-sodium/20">
                  <Star className="h-2.5 w-2.5" />
                  {ROUTE_ROLE_LABELS[group.routeRole] ?? group.routeRole}
                </span>
              )}
              <span className="text-xs text-cream/60">
                {group.connections.length === 0
                  ? t("noConnectionsConfigured")
                  : t("connectionCount", { count: group.connections.length })}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => {
                setEditName(group.name);
                setIsEditingName(true);
              }}
              disabled={updateGroupMutation.isPending}
              className="p-1.5 rounded-md text-cream/45 hover:text-cream hover:bg-cream/[0.05] transition-colors disabled:opacity-50"
              title={t("editGroup")}
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              onClick={() => {
                if (isRoleGroup) {
                  setShowDeleteWarning(true);
                } else {
                  deleteGroupMutation.mutate();
                }
              }}
              disabled={deleteGroupMutation.isPending}
              className="p-1.5 rounded-md text-cream/45 hover:text-terra hover:bg-terra/5 transition-colors disabled:opacity-50"
              title={t("deleteGroup")}
            >
              {deleteGroupMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Connections List */}
      {group.connections.length === 0 ? (
        <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-8 text-center">
          <Server className="h-8 w-8 text-cream/35 mx-auto mb-2" />
          <p className="text-sm text-cream/60">{t("noConnectionsYet")}</p>
          <p className="text-xs text-cream/35 mt-1">
            {t("addToStart")}
          </p>
          {group.routeRole === "git-default" && existingGitConns.length > 0 ? (
            <button
              onClick={() => wireGitMutation.mutate()}
              disabled={wireGitMutation.isPending}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sodium/10 hover:bg-sodium/20 text-sm text-sodium border border-sodium/20 transition-colors disabled:opacity-50"
            >
              {wireGitMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <GitBranch className="h-4 w-4" />
              )}
              Use {existingGitConns[0]!.providerUsername ?? existingGitConns[0]!.provider}
            </button>
          ) : group.routeRole === "git-default" ? (
            <button
              onClick={() => handleProviderClick("github")}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-cream/[0.08] hover:bg-cream/[0.14] text-sm text-cream/80 hover:text-cream transition-colors"
            >
              <Plus className="h-4 w-4" />
              Connect GitHub
            </button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          {group.connections.map((conn) => (
            <div key={conn.id} className="space-y-0">
              <ConnectionCard
                conn={conn}
                isRoleGroup={isRoleGroup}
                serverId={serverId}
                selectedApp={selectedApp ?? null}
                onSetDefault={() => setDefaultMutation.mutate(conn.id)}
                onToggleAgent={(enabled) =>
                  toggleAgentMutation.mutate({ connectionId: conn.id, enabled })
                }
                onRemove={() => removeConnectionMutation.mutate(conn.id)}
                onViewTools={() =>
                  setViewingToolsFor(viewingToolsFor === conn.id ? null : conn.id)
                }
                isSettingDefault={setDefaultMutation.isPending}
                isViewingTools={viewingToolsFor === conn.id}
              />
              {viewingToolsFor === conn.id && (
                <div className="mt-2 rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-medium text-cream/75 uppercase tracking-wider">
                      {t("tools")}
                    </h4>
                    <button
                      onClick={() => discoverToolsMutation.mutate(conn.id)}
                      disabled={discoverToolsMutation.isPending}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-cream/75 border border-cream/[0.08] hover:border-cream/[0.15] hover:text-cream transition-colors disabled:opacity-50"
                    >
                      {discoverToolsMutation.isPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Search className="h-3 w-3" />
                      )}
                      {t("discoverTools")}
                    </button>
                  </div>
                  <ToolReview
                    connectionId={conn.id}
                    serverId={serverId}
                    tools={discoveredTools[conn.id] ?? []}
                    onApprove={() => {}}
                    onReject={() => {}}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showAddForm ? (
        <AddConnectionForm
          routeRole={group.routeRole}
          allProviders={availableProviders}
          connectedProviders={new Set(group.connections.map(c => c.providerKind))}
          addMode={addMode}
          setAddMode={setAddMode}
          customName={customName}
          setCustomName={setCustomName}
          customUrl={customUrl}
          setCustomUrl={setCustomUrl}
          customTransport={customTransport}
          setCustomTransport={setCustomTransport}
          customAuthToken={customAuthToken}
          setCustomAuthToken={setCustomAuthToken}
          onClose={() => setShowAddForm(false)}
          onProviderClick={handleProviderClick}
          onCustomSubmit={handleCustomSubmit}
          isSubmitting={addMcpConnectionMutation.isPending}
        />
      ) : (
        <button
          onClick={() => {
            setAddMode("select");
            setShowAddForm(true);
          }}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed border-cream/[0.08] bg-cream/[0.01] hover:bg-cream/[0.04] hover:border-cream/[0.15] text-sm text-cream/60 hover:text-cream transition-all"
        >
          <Plus className="h-4 w-4" />
          Add Connection
        </button>
      )}

      {/* Delete Warning Modal */}
      {showDeleteWarning &&
        createPortal(
          <DeleteWarningModal
            routeRole={group.routeRole}
            isDeleting={deleteGroupMutation.isPending}
            onCancel={() => setShowDeleteWarning(false)}
            onConfirm={handleDeleteGroup}
          />,
          document.body,
        )}
    </div>
  );
}

// ─── Connection Card ──────────────────────────────────────────────────────

const GIT_PROVIDERS = new Set(["github", "gitlab", "bitbucket"]);

interface NormalizedRepo {
  name: string;
  fullName: string;
  url: string;
  isPrivate: boolean;
  defaultBranch: string;
  description: string | null;
}

interface LinkedRepo {
  linked: boolean;
  repo?: {
    repoFullName: string;
    repoUrl: string;
    defaultBranch: string;
    isPrivate: boolean;
    provider: string;
  };
}

interface ConnectionCardProps {
  conn: IntegrationGroupConnection;
  isRoleGroup: boolean;
  serverId: string;
  selectedApp: string | null;
  onSetDefault: () => void;
  onToggleAgent: (enabled: boolean) => void;
  onRemove: () => void;
  onViewTools: () => void;
  isSettingDefault: boolean;
  isViewingTools?: boolean;
}

function ConnectionCard({
  conn,
  isRoleGroup,
  serverId,
  selectedApp,
  onSetDefault,
  onRemove,
  onViewTools,
  isViewingTools,
}: ConnectionCardProps) {
  const t = useTranslations("console.connectionGroup");
  const PROVIDER_LABEL = useProviderLabel();
  const queryClient = useQueryClient();
  const { send: vpsSend } = useVpsBridge();
  const ProviderIcon = getProviderIcon(conn.providerKind);
  const isGitProvider = GIT_PROVIDERS.has(conn.providerKind);
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [repoSearch, setRepoSearch] = useState("");

  // Fetch linked repo (git providers only)
  const { data: linkData } = useQuery<LinkedRepo>({
    queryKey: ["git-link", serverId, selectedApp],
    queryFn: async () => {
      const res = await fetch(
        `${API_URL}/api/git/servers/${serverId}/link?app=${encodeURIComponent(selectedApp!)}`,
        { credentials: "include" },
      );
      if (!res.ok) return { linked: false };
      return res.json();
    },
    enabled: isGitProvider && !!selectedApp,
  });

  // Fetch available repos (git providers only, when picker is open)
  const { data: reposData, isLoading: loadingRepos } = useQuery<{ repos: NormalizedRepo[] }>({
    queryKey: ["git-repos", conn.providerKind, repoSearch],
    queryFn: async () => {
      const params = repoSearch ? `?search=${encodeURIComponent(repoSearch)}` : "";
      const res = await fetch(
        `${API_URL}/api/git/servers/${serverId}/repos/${conn.providerKind}${params}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to load repos");
      return res.json();
    },
    enabled: isGitProvider && showRepoPicker,
  });

  // Link repo mutation
  const linkMutation = useMutation({
    mutationFn: async (repo: NormalizedRepo) => {
      const res = await fetch(`${API_URL}/api/git/servers/${serverId}/link`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: conn.providerKind,
          repoFullName: repo.fullName,
          repoUrl: repo.url,
          defaultBranch: repo.defaultBranch,
          isPrivate: repo.isPrivate,
          sandboxId: selectedApp,
        }),
      });
      if (!res.ok) throw new Error("Failed to link repo");
      return res.json();
    },
    onSuccess: async () => {
      setShowRepoPicker(false);
      setShowCreateDialog(false);
      queryClient.invalidateQueries({ queryKey: ["git-link", serverId, selectedApp] });
      toast.success(t("repositoryLinked"));
      if (selectedApp) {
        try {
          await vpsSend("git_action", { action: "setup", sandboxId: selectedApp });
        } catch (e) {
          console.warn("[ConnectionGroupTab] Git setup on VPS failed:", (e as Error).message);
        }
      }
    },
    onError: () => toast.error(t("repositoryLinkFailed")),
  });

  const linkedRepo = linkData?.repo;

  return (
    <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4 transition-all hover:border-cream/[0.1]">
      {/* Connection header */}
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-cream/[0.04] shrink-0">
          <ProviderIcon className="h-4 w-4 text-cream/75" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-cream/60 uppercase tracking-wider">
              {PROVIDER_LABEL[conn.providerKind] ?? conn.providerKind}
            </span>
            <StatusDot status={conn.connectionStatus} />
          </div>
          <span className="text-sm text-cream truncate block mt-0.5">
            {conn.displayName}
          </span>
        </div>
      </div>

      {/* Linked repo display (git providers) */}
      {isGitProvider && selectedApp && linkedRepo && (
        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-cream/[0.03] border border-cream/[0.06]">
          <GitBranch className="h-3.5 w-3.5 text-cream/60 shrink-0" />
          <span className="text-sm text-cream font-mono truncate flex-1">{linkedRepo.repoFullName}</span>
          <span className="text-[10px] text-cream/45 shrink-0">{linkedRepo.defaultBranch}</span>
          {linkedRepo.isPrivate ? (
            <Lock className="h-3 w-3 text-cream/45 shrink-0" />
          ) : (
            <Globe className="h-3 w-3 text-cream/45 shrink-0" />
          )}
        </div>
      )}

      {/* Controls */}
      <div className="mt-3 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Default route toggle (only for role groups) */}
          {isRoleGroup && (
            <button
              onClick={() => {
                if (!conn.isDefaultRoute) {
                  onSetDefault();
                }
              }}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border",
                conn.isDefaultRoute
                  ? "border-sodium/30 bg-sodium/10 text-sodium"
                  : "border-cream/[0.06] bg-cream/[0.02] text-cream/60 hover:text-cream hover:bg-cream/[0.04]",
              )}
            >
              {conn.isDefaultRoute ? (
                <Check className="h-3 w-3" />
              ) : (
                <Star className="h-3 w-3" />
              )}
              {conn.isDefaultRoute ? t("default") : t("setAsDefault")}
            </button>
          )}

          {/* Repo picker toggle (git providers only) */}
          {isGitProvider && selectedApp && (
            <button
              onClick={() => setShowRepoPicker(!showRepoPicker)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border",
                showRepoPicker
                  ? "border-sodium/30 bg-sodium/10 text-cream/65"
                  : linkedRepo
                    ? "text-cream/75 border-cream/[0.08] hover:border-cream/[0.15] hover:text-cream"
                    : "border-sodium/30 bg-sodium/10 text-sodium",
              )}
            >
              <GitCommit className="h-3 w-3" />
              {linkedRepo ? t("changeRepo") : t("selectRepo")}
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={onViewTools}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border",
              isViewingTools
                ? "border-sodium/30 bg-sodium/10 text-sodium"
                : "text-cream/75 border-cream/[0.08] hover:border-cream/[0.15] hover:text-cream",
            )}
          >
            {isViewingTools ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            {isViewingTools ? t("hideTools") : t("viewTools")}
          </button>
          <button
            onClick={onRemove}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-terra/70 border border-terra/15 hover:border-terra/30 hover:text-terra hover:bg-terra/5 transition-colors"
          >
            <Trash2 className="h-3 w-3" />
            {t("remove")}
          </button>
        </div>
      </div>

      {/* Repo picker dropdown (git providers only) */}
      {isGitProvider && showRepoPicker && (
        <div className="mt-3 rounded-lg border border-cream/[0.08] bg-cream/[0.02] overflow-hidden">
          <div className="p-2 border-b border-cream/[0.06] flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-cream/45" />
              <input
                type="text"
                value={repoSearch}
                onChange={(e) => setRepoSearch(e.target.value)}
                placeholder={t("searchRepos")}
                className="w-full pl-8 pr-3 py-1.5 text-sm bg-transparent text-cream placeholder-cream/40 border-none outline-none"
              />
            </div>
            <button
              onClick={() => setShowCreateDialog(true)}
              className="shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium border border-cream/[0.08] text-cream/60 hover:text-cream hover:bg-cream/[0.04] transition-colors"
            >
              <Plus className="h-3 w-3" />
              {t("newRepo")}
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {loadingRepos ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-cream/60" />
              </div>
            ) : reposData?.repos.length === 0 ? (
              <div className="py-4 text-center">
                <p className="text-xs text-cream/45">{t("noReposFound")}</p>
                <button
                  onClick={() => setShowCreateDialog(true)}
                  className="text-xs text-sodium hover:text-sodium mt-1.5 transition-colors"
                >
                  {t("createNewRepo")}
                </button>
              </div>
            ) : (
              reposData?.repos.map((repo) => (
                <button
                  key={repo.fullName}
                  onClick={() => linkMutation.mutate(repo)}
                  disabled={linkMutation.isPending}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-cream/[0.04] transition-colors border-b border-cream/[0.04] last:border-b-0",
                    linkedRepo?.repoFullName === repo.fullName && "bg-cream/[0.04]",
                  )}
                >
                  {repo.isPrivate ? (
                    <Lock className="h-3 w-3 text-cream/45 shrink-0" />
                  ) : (
                    <Globe className="h-3 w-3 text-cream/45 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-cream font-mono truncate block">{repo.fullName}</span>
                    {repo.description && (
                      <span className="text-[11px] text-cream/45 truncate block">{repo.description}</span>
                    )}
                  </div>
                  <span className="text-[10px] text-cream/45 shrink-0">{repo.defaultBranch}</span>
                  {linkedRepo?.repoFullName === repo.fullName && (
                    <Check className="h-3 w-3 text-sodium shrink-0" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* Create repo dialog (git providers only) */}
      {isGitProvider && (
        <CreateRepoDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          provider={conn.providerKind as "github" | "gitlab" | "bitbucket"}
          serverId={serverId}
          onCreated={(repo) => linkMutation.mutate(repo)}
        />
      )}
    </div>
  );
}

// ─── Add Connection Form ──────────────────────────────────────────────────

interface AddConnectionFormProps {
  routeRole: string | null;
  allProviders: ProviderEntry[];
  connectedProviders: Set<string>;
  addMode: "select" | "custom";
  setAddMode: (mode: "select" | "custom") => void;
  customName: string;
  setCustomName: (v: string) => void;
  customUrl: string;
  setCustomUrl: (v: string) => void;
  customTransport: string;
  setCustomTransport: (v: string) => void;
  customAuthToken: string;
  setCustomAuthToken: (v: string) => void;
  onClose: () => void;
  onProviderClick: (provider: string) => void;
  onCustomSubmit: () => void;
  isSubmitting: boolean;
}

function AddConnectionForm({
  routeRole,
  allProviders,
  connectedProviders,
  addMode,
  setAddMode,
  customName,
  setCustomName,
  customUrl,
  setCustomUrl,
  customTransport,
  setCustomTransport,
  customAuthToken,
  setCustomAuthToken,
  onClose,
  onProviderClick,
  onCustomSubmit,
  isSubmitting,
}: AddConnectionFormProps) {
  const t = useTranslations("console.connectionGroup");
  // Filter: compatible with role + not already connected + actually configured
  const compatibleProviders = getProvidersForRole(allProviders, routeRole)
    .filter(p => !connectedProviders.has(p.id));

  if (addMode === "select") {
    return (
      <div className="rounded-xl border border-sodium/20 bg-sodium/[0.02] p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-cream">
            {t("whatToConnect")}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-cream/[0.06] text-cream/60 hover:text-cream transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {compatibleProviders.map((provider) => {
            const ProvIcon = getProviderIcon(provider.id);
            return (
              <button
                key={provider.id}
                onClick={() => onProviderClick(provider.id)}
                className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-cream/[0.06] bg-cream/[0.02] hover:bg-cream/[0.06] hover:border-cream/[0.12] text-sm text-cream/75 hover:text-cream transition-all"
              >
                <ProvIcon className="h-4 w-4 shrink-0" />
                {provider.label}
              </button>
            );
          })}
          <button
            onClick={() => setAddMode("custom")}
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-dashed border-cream/[0.08] bg-cream/[0.01] hover:bg-cream/[0.04] hover:border-cream/[0.15] text-sm text-cream/60 hover:text-cream transition-all"
          >
            <Server className="h-4 w-4 shrink-0" />
            {t("customMcpServer")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-sodium/20 bg-sodium/[0.02] p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-cream">
          {t("customMcpServer")}
        </h3>
        <button
          onClick={() => setAddMode("select")}
          className="text-xs text-cream/60 hover:text-cream transition-colors"
        >
          {t("back")}
        </button>
      </div>

      <div className="space-y-3">
        {/* Name */}
        <div>
          <label className="text-[10px] text-cream/45 uppercase tracking-wider mb-1.5 block">
            {t("name")}
          </label>
          <input
            type="text"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            placeholder={t("namePlaceholder")}
            className="w-full px-3 py-2 rounded-lg border border-cream/[0.08] bg-cream/[0.03] text-sm text-cream placeholder:text-cream/45 focus:border-sodium/50 focus:outline-none transition-colors"
          />
        </div>

        {/* URL */}
        <div>
          <label className="text-[10px] text-cream/45 uppercase tracking-wider mb-1.5 block">
            {t("url")}
          </label>
          <input
            type="text"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            placeholder={t("urlPlaceholder")}
            className="w-full px-3 py-2 rounded-lg border border-cream/[0.08] bg-cream/[0.03] text-sm text-cream placeholder:text-cream/45 focus:border-sodium/50 focus:outline-none transition-colors font-mono text-xs"
          />
        </div>

        {/* Transport */}
        <div>
          <label className="text-[10px] text-cream/45 uppercase tracking-wider mb-1.5 block">
            {t("transport")}
          </label>
          <select
            value={customTransport}
            onChange={(e) => setCustomTransport(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-cream/[0.08] bg-cream/[0.03] text-sm text-cream focus:border-sodium/50 focus:outline-none transition-colors appearance-none"
          >
            {TRANSPORT_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>

        {/* Auth Token */}
        <div>
          <label className="text-[10px] text-cream/45 uppercase tracking-wider mb-1.5 block">
            {t("authToken")}{" "}
            <span className="text-cream/35 normal-case tracking-normal">
              {t("authTokenOptional")}
            </span>
          </label>
          <input
            type="password"
            value={customAuthToken}
            onChange={(e) => setCustomAuthToken(e.target.value)}
            placeholder={t("authTokenPlaceholder")}
            className="w-full px-3 py-2 rounded-lg border border-cream/[0.08] bg-cream/[0.03] text-sm text-cream placeholder:text-cream/45 focus:border-sodium/50 focus:outline-none transition-colors"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={onCustomSubmit}
            disabled={!customName.trim() || !customUrl.trim() || isSubmitting}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-all",
              !customName.trim() || !customUrl.trim() || isSubmitting
                ? "bg-cream/[0.05] text-cream/45 cursor-not-allowed"
                : "bg-sodium text-ink shadow-sm shadow-sodium/10",
            )}
          >
            {isSubmitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {t("connect")}
          </button>
          <button
            onClick={() => setAddMode("select")}
            className="px-3 py-2 rounded-lg text-xs text-cream/60 hover:text-cream transition-colors"
          >
            {t("cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Delete Warning Modal ─────────────────────────────────────────────────

interface DeleteWarningModalProps {
  routeRole: string | null;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteWarningModal({
  routeRole,
  isDeleting,
  onCancel,
  onConfirm,
}: DeleteWarningModalProps) {
  const t = useTranslations("console.connectionGroup");
  const vh = useVisualViewport();
  const ROUTE_ROLE_LABELS = useRouteRoleLabels();
  const ROLE_DELETE_WARNINGS = useRoleDeleteWarnings();
  const warnings = ROLE_DELETE_WARNINGS[routeRole ?? ""] ?? [
    t("deleteWarningGenericConnections"),
    t("deleteWarningGenericTools"),
  ];

  return (
    <div
      className="fixed inset-x-0 top-0 z-[130] flex items-end sm:items-center justify-center"
      style={{ height: vh }}
      onClick={onCancel}
    >
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in-0 duration-200" />

      {/* Modal */}
      <div
        className="relative w-full sm:max-w-sm max-h-[90%] overflow-y-auto bg-card border border-border rounded-t-xl sm:rounded-xl p-5 shadow-2xl animate-in slide-in-from-bottom-4 sm:zoom-in-95 sm:slide-in-from-bottom-0 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-sodium/10 flex items-center justify-center">
            <AlertTriangle className="h-5 w-5 text-sodium" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-cream">{t("deleteRoleGroupTitle")}</h3>
            <p className="text-xs text-sodium">
              {t("deleteRoleGroupSubtitle", { role: ROUTE_ROLE_LABELS[routeRole ?? ""] ?? routeRole ?? t("roleGroupFallback") })}
            </p>
          </div>
        </div>

        <div className="rounded-lg bg-sodium/5 border border-sodium/10 p-3 mb-4">
          <p className="text-xs text-sodium font-medium mb-2">
            {t("deletingWill")}
          </p>
          <ul className="space-y-1">
            {warnings.map((warning) => (
              <li key={warning} className="flex items-start gap-2 text-xs text-sodium/80">
                <span className="text-sodium mt-0.5 shrink-0">&bull;</span>
                {warning}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm text-cream/60 hover:text-cream transition-colors"
          >
            {t("cancel")}
          </button>
          <button
            onClick={onConfirm}
            disabled={isDeleting}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium bg-terra hover:bg-terra text-cream transition-colors disabled:opacity-50"
          >
            {isDeleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {t("delete")}
          </button>
        </div>
      </div>
    </div>
  );
}
