// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  GitBranch,
  Shield,
  ArrowLeft,
  LogOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { API_URL } from "@/lib/api";
import { useVpsBridge } from "@/lib/vps-bridge";
import { useVpsFeature } from "@/hooks/useVpsFeature";
import { useAppsList } from "@/contexts/AppsListContext";
import { useCodeToken } from "@/contexts/CodeTokenContext";
import { ProviderCard, ProviderLogo, PROVIDER_INFO, type GitProvider } from "../git/ProviderCard";
import { isProviderVisible } from "@/lib/feature-flags";

const ENABLED_GIT_PROVIDERS = (["github", "gitlab", "bitbucket"] as const).filter(
  isProviderVisible,
) as readonly GitProvider[];
import { RepoPicker } from "../git/RepoPicker";
import { LinkedRepoCard } from "../git/LinkedRepoCard";
import { CreateRepoDialog } from "../git/CreateRepoDialog";
import type { ApiApp } from "@/contexts/AppsListContext";

type AppInfo = ApiApp;

interface TabGitProps {
  serverId: string;
  securityTier?: "standard" | "web_locked" | "private_locked";
  // App info from backend (props-based data flow)
  app?: AppInfo | null;
  onUpgrade?: () => void;
}

interface GitConnection {
  id: string;
  provider: GitProvider;
  providerUsername: string | null;
  providerAvatarUrl: string | null;
  scope: string | null;
  connectedAt: string;
}

interface LinkedRepo {
  id: string;
  provider: GitProvider;
  repoFullName: string;
  repoUrl: string;
  defaultBranch: string;
  isPrivate: boolean;
  credentialsSynced: boolean;
  linkedAt: string;
  lastPushAt: string | null;
  // Other apps on this server that share the same repository URL
  sharedWithApps?: string[];
}

interface NormalizedRepo {
  name: string;
  fullName: string;
  url: string;
  sshUrl: string;
  isPrivate: boolean;
  defaultBranch: string;
  description: string | null;
  updatedAt: string;
}

type ViewState = "providers" | "repos" | "linked";

export function TabGit({ serverId, securityTier, app, onUpgrade }: TabGitProps) {
  const t = useTranslations("console.tabGit");
  const queryClient = useQueryClient();
  const [viewState, setViewState] = useState<ViewState>("providers");
  const [activeProvider, setActiveProvider] = useState<GitProvider | null>(null);
  const hasAutoSelected = useRef(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  // App info comes from props (backend-driven architecture)
  const { isLoading: appsLoading, codeApiUrl } = useAppsList();
  const { fetchWithCodeToken } = useCodeToken();
  const selectedApp = app?.directory ?? null;
  const selectedAppName = app?.name ?? null;

  // VPS bridge for passkey communication (Web Locked tier)
  const { send: vpsSend } = useVpsBridge();
  const hasGitLinkPasskey = useVpsFeature("git-link-passkey");
  const hasBridgeOps = useVpsFeature("bridge-operations");

  // Fetch connected providers
  const { data: connectionsData, isLoading: loadingConnections } = useQuery<{
    connections: GitConnection[];
    availableProviders: GitProvider[];
  }>({
    queryKey: ["git-connections"],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/git/connections`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load connections");
      return res.json();
    },
  });

  // Fetch linked repo for this app (per-app Git linking)
  const { data: linkData, isLoading: loadingLink } = useQuery<{
    linked: boolean;
    repo?: LinkedRepo;
  }>({
    queryKey: ["git-link", serverId, selectedApp],
    queryFn: async () => {
      const url = new URL(`${API_URL}/api/git/servers/${serverId}/link`);
      if (selectedApp) {
        // Use directory as the app identifier for the API
        url.searchParams.set("app", selectedApp);
      }
      const res = await fetch(url.toString(), {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load linked repo");
      return res.json();
    },
    enabled: !!selectedApp,
  });

  // Disconnect provider
  const disconnectMutation = useMutation({
    mutationFn: async (provider: GitProvider) => {
      const res = await fetch(`${API_URL}/api/git/connections/${provider}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to disconnect");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["git-connections"] });
      queryClient.invalidateQueries({ queryKey: ["git-link", serverId, selectedApp] });
      setViewState("providers");
      setActiveProvider(null);
    },
  });

  // Link repo to server
  const linkMutation = useMutation({
    mutationFn: async (repo: NormalizedRepo) => {
      if (!activeProvider) throw new Error("No provider selected");

      // Web Locked tier: require passkey authorization before linking
      let vpsConfirmToken: string | undefined;
      if (securityTier !== "standard" && hasGitLinkPasskey) {
        const authResult = await vpsSend<{
          authorized: boolean;
          token: string | null;
        }>("authorize_git_link", {
          repoFullName: repo.fullName,
          provider: activeProvider,
        });

        if (!authResult.authorized || !authResult.token) {
          throw new Error(t("passkeyFailed"));
        }
        vpsConfirmToken = authResult.token;
      }

      // Step 1: Link the repo
      const linkHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (vpsConfirmToken) {
        linkHeaders["X-VPS-Confirm-Token"] = vpsConfirmToken;
      }

      const linkRes = await fetch(`${API_URL}/api/git/servers/${serverId}/link`, {
        method: "POST",
        credentials: "include",
        headers: linkHeaders,
        body: JSON.stringify({
          provider: activeProvider,
          repoFullName: repo.fullName,
          repoUrl: repo.url,
          defaultBranch: repo.defaultBranch,
          isPrivate: repo.isPrivate,
          sandboxId: selectedApp, // Per-app Git linking - use directory as identifier
        }),
      });
      if (!linkRes.ok) {
        const err = await linkRes.json().catch(() => ({})) as { error?: string; message?: string; requiresPasskey?: boolean };
        if (err.requiresPasskey) {
          throw new Error(t("passkeyRequired"));
        }
        throw new Error(err.error || err.message || t("linkFailed"));
      }

      const linkData = await linkRes.json() as {
        linked: boolean;
        provider: string;
        providerUsername: string;
      };

      // Secrets are now encrypted and stored server-side by the link API.
      if (selectedApp) {
        if (hasBridgeOps) {
          try {
            await vpsSend("git_action", { action: "setup", sandboxId: selectedApp });
          } catch (e) {
            console.warn("[TabGit] Git setup on VPS failed (will retry on next access):", (e as Error).message);
          }
        }
        // User will explicitly pull via the "Import Code" button in LinkedRepoCard
      }

      return linkData;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["git-link", serverId, selectedApp] });
      queryClient.invalidateQueries({ queryKey: ["file-tree", selectedApp] });
      queryClient.invalidateQueries({ queryKey: ["git-status", selectedApp] });
      setViewState("linked");
    },
  });

  // Unlink repo
  const unlinkMutation = useMutation({
    mutationFn: async () => {
      // Web Locked tier: require passkey authorization
      let vpsConfirmToken: string | undefined;
      if (securityTier !== "standard" && hasGitLinkPasskey) {
        const authResult = await vpsSend<{
          authorized: boolean;
          token: string | null;
        }>("authorize_git_unlink");

        if (!authResult.authorized || !authResult.token) {
          throw new Error(t("passkeyFailed"));
        }
        vpsConfirmToken = authResult.token;
      }

      const headers: Record<string, string> = {};
      if (vpsConfirmToken) {
        headers["X-VPS-Confirm-Token"] = vpsConfirmToken;
      }

      const url = new URL(`${API_URL}/api/git/servers/${serverId}/link`);
      if (selectedApp) {
        url.searchParams.set("app", selectedApp);
      }
      const res = await fetch(url.toString(), {
        method: "DELETE",
        credentials: "include",
        headers,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error || "Failed to unlink repo");
      }
      const result = await res.json();

      // Teardown git on VPS via bridge (removes remote + credential helper)
      if (hasBridgeOps) {
        try {
          await vpsSend("git_action", { action: "teardown", sandboxId: selectedApp ?? undefined });
        } catch (e) {
          console.warn("[TabGit] Bridge git teardown:", (e as Error).message);
        }
      }

      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["git-link", serverId, selectedApp] });
      setViewState("repos");
    },
  });

  const connections = connectionsData?.connections || [];
  const availableProviders = connectionsData?.availableProviders || [];
  const linkedRepo = linkData?.linked ? linkData.repo : null;

  // Determine current view state based on data
  const effectiveView = (() => {
    if (linkedRepo && viewState !== "repos") return "linked";
    if (activeProvider && connections.some((c) => c.provider === activeProvider))
      return viewState === "repos" ? "repos" : connections.length > 0 ? "repos" : "providers";
    return "providers";
  })();

  // Save app context to sessionStorage before OAuth redirect
  const saveStateForOAuth = useCallback(() => {
    if (selectedApp) {
      sessionStorage.setItem("ellul-git-oauth", JSON.stringify({ appDirectory: selectedApp }));
    }
  }, [selectedApp]);

  const handleProviderConnected = useCallback(
    (provider: GitProvider) => {
      setActiveProvider(provider);
      setViewState("repos");
    },
    []
  );

  const handleSelectRepo = useCallback(
    (repo: NormalizedRepo) => {
      linkMutation.mutate(repo);
    },
    [linkMutation]
  );

  const handleRepoCreated = useCallback(
    (repo: NormalizedRepo) => {
      linkMutation.mutate(repo);
    },
    [linkMutation]
  );

  // Auto-select provider if only one is connected (only on initial load)
  if (
    !hasAutoSelected.current &&
    connections.length > 0 &&
    !activeProvider &&
    !linkedRepo &&
    !loadingLink &&
    viewState === "providers"
  ) {
    hasAutoSelected.current = true;
    const firstConnected = connections[0];
    if (firstConnected) {
      setActiveProvider(firstConnected.provider);
      setViewState("repos");
    }
  }

  // Show loading while apps or link data is being fetched
  if (loadingConnections || (selectedApp && loadingLink) || (appsLoading && selectedApp)) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="default" color="muted" delay={300} />
      </div>
    );
  }

  // Show explanation when no app is selected (and not loading)
  if (!selectedAppName && !selectedApp) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="flex flex-col items-center justify-center text-center max-w-xs">
          <div className="w-10 h-10 rounded-lg bg-cream/[0.02] border border-cream/[0.06] flex items-center justify-center mb-3">
            <GitBranch className="h-5 w-5 text-cream/45" />
          </div>
          <h3 className="text-sm font-medium text-cream/75 mb-1">{t("selectSandboxTitle")}</h3>
          <p className="text-xs text-cream/60 leading-relaxed mb-3">
            {t("selectSandboxHint")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 px-4 py-4 overflow-y-auto">
      {/* Integrations redirect notice */}
      <div className="p-4 rounded-lg border border-blue-500/20 bg-blue-500/5 mb-4">
        <p className="text-sm text-blue-300">
          {t.rich("redirectNotice", { strong: (chunks) => <strong>{chunks}</strong> })}
        </p>
      </div>

      <div>
      {/* Header */}
      <div className="mb-4">
        <h2 className="text-sm font-medium text-cream">
          {linkedRepo ? t("headerRepository") : t("headerGit")}
        </h2>
        <p className="text-xs text-cream/60 mt-0.5">
          {linkedRepo
            ? t("subtitleConnected")
            : t("subtitleDisconnected")}
        </p>
      </div>

      {/* State 1: No provider connected — show connect cards */}
      {effectiveView === "providers" && connections.length === 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 mb-1">
            <Shield className="h-3 w-3 text-cream/35" />
            <span className="text-[10px] text-cream/45">
              {t("encryptedNote")}
            </span>
          </div>
          {ENABLED_GIT_PROVIDERS.map((provider) => (
            <ProviderCard
              key={provider}
              provider={provider}
              available={availableProviders.includes(provider)}
              onBeforeConnect={saveStateForOAuth}
              appDirectory={selectedApp}
            />
          ))}
        </div>
      )}

      {/* Provider connected but showing provider list (to connect more or switch) */}
      {effectiveView === "providers" && connections.length > 0 && (
        <div className="space-y-3">
          {/* Connected providers */}
          <div className="space-y-1.5">
            <span className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">
              {t("connected")}
            </span>
            {connections.map((conn) => (
              <div
                key={conn.provider}
                className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-cream/[0.06] bg-cream/[0.02]"
              >
                <button
                  onClick={() => {
                    setActiveProvider(conn.provider);
                    setViewState("repos");
                  }}
                  className="flex items-center gap-2.5 text-left flex-1 min-w-0"
                >
                  <div className={PROVIDER_INFO[conn.provider].color}>
                    <ProviderLogo provider={conn.provider} className="h-4 w-4" />
                  </div>
                  <span className="text-sm font-medium text-cream truncate">
                    {PROVIDER_INFO[conn.provider].name}
                  </span>
                  {conn.providerUsername && (
                    <span className="text-xs text-cream/60 truncate">
                      @{conn.providerUsername}
                    </span>
                  )}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => disconnectMutation.mutate(conn.provider)}
                  disabled={disconnectMutation.isPending}
                  className="text-cream/35 hover:text-terra h-7 w-7 p-0"
                >
                  <LogOut className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>

          {/* Add more providers */}
          {availableProviders.filter(
            (p) => !connections.some((c) => c.provider === p)
          ).length > 0 && (
            <div className="space-y-1.5">
              <span className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">
                {t("addProvider")}
              </span>
              {ENABLED_GIT_PROVIDERS
                .filter(
                  (p) =>
                    availableProviders.includes(p) &&
                    !connections.some((c) => c.provider === p)
                )
                .map((provider) => (
                  <ProviderCard
                    key={provider}
                    provider={provider}
                    available={true}
                    onBeforeConnect={saveStateForOAuth}
                    appDirectory={selectedApp}
                  />
                ))}
            </div>
          )}
        </div>
      )}

      {/* State 2: Provider connected, picking a repo */}
      {effectiveView === "repos" && activeProvider && (
        <div className="space-y-3">
          {/* Back + connected provider info */}
          <div className="flex items-center justify-between">
            <button
              onClick={() => {
                if (linkedRepo) {
                  // Return to linked repo view
                  setViewState("linked");
                } else {
                  setViewState("providers");
                }
                setActiveProvider(null);
              }}
              className="flex items-center gap-1 text-xs text-cream/60 hover:text-cream/75 transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t("back")}
            </button>
            {(() => {
              const conn = connections.find(
                (c) => c.provider === activeProvider
              );
              if (!conn) return null;
              return (
                <div className="flex items-center gap-1.5">
                  {conn.providerAvatarUrl && (
                    <img
                      src={conn.providerAvatarUrl}
                      alt=""
                      className="h-4 w-4 rounded-full"
                    />
                  )}
                  <span className="text-[11px] text-cream/45">
                    @{conn.providerUsername}
                  </span>
                </div>
              );
            })()}
          </div>

          <h3 className="text-xs font-medium text-cream/60">
            {t("selectRepo")}
          </h3>

          {linkMutation.isPending && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-sodium/10 border border-sodium/15">
              <Spinner size="xs" color="primary" />
              <span className="text-xs text-sodium">
                {t("connecting")}
              </span>
            </div>
          )}

          {linkMutation.error && (
            <div className="px-3 py-2 rounded-lg bg-terra/10 border border-terra/15">
              <span className="text-xs text-terra">
                {linkMutation.error instanceof Error
                  ? linkMutation.error.message
                  : t("linkFailed")}
              </span>
            </div>
          )}

          {!linkMutation.isPending && (
            <RepoPicker
              provider={activeProvider}
              serverId={serverId}
              onSelectRepo={handleSelectRepo}
              onCreateNew={() => setShowCreateDialog(true)}
            />
          )}

          <CreateRepoDialog
            open={showCreateDialog}
            onOpenChange={setShowCreateDialog}
            provider={activeProvider}
            serverId={serverId}
            onCreated={handleRepoCreated}
          />
        </div>
      )}

      {/* State 3: Repo linked */}
      {effectiveView === "linked" && linkedRepo && (
        <LinkedRepoCard
          serverId={serverId}
          repo={linkedRepo}
          sandboxId={selectedAppName}
          codeApiUrl={codeApiUrl}
          fetchWithCodeToken={fetchWithCodeToken}
          onUnlink={() => unlinkMutation.mutate()}
          onChangeRepo={() => {
            setActiveProvider(linkedRepo.provider);
            setViewState("repos");
          }}
        />
      )}
      </div>{/* end disabled wrapper */}
    </div>
  );
}
