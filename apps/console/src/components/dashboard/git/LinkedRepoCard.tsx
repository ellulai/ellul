// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import {
  ExternalLink,
  Upload,
  Download,
  Unlink,
  Clock,
  Check,
  AlertCircle,
  Info,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { API_URL } from "@/lib/api";
import { ProviderLogo, PROVIDER_INFO, type GitProvider } from "./ProviderCard";

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

interface LinkedRepoCardProps {
  serverId: string;
  repo: LinkedRepo;
  // The app name for app-aware Git operations
  sandboxId?: string | null;
  // VPS code API base URL for direct file-api calls
  codeApiUrl?: string | null;
  // Authenticated fetch for VPS code API
  fetchWithCodeToken?: (url: string, init?: RequestInit) => Promise<Response>;
  onUnlink: () => void;
  onChangeRepo: () => void;
}

function getProviderUrl(provider: GitProvider, repoFullName: string): string {
  switch (provider) {
    case "github":
      return `https://github.com/${repoFullName}`;
    case "gitlab":
      return `https://gitlab.com/${repoFullName}`;
    case "bitbucket":
      return `https://bitbucket.org/${repoFullName}`;
  }
}

function formatTimestamp(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export function LinkedRepoCard({
  serverId,
  repo,
  sandboxId,
  codeApiUrl,
  fetchWithCodeToken,
  onUnlink,
  onChangeRepo,
}: LinkedRepoCardProps) {
  const queryClient = useQueryClient();
  const [pushSuccess, setPushSuccess] = useState(false);
  const [importSuccess, setImportSuccess] = useState(false);

  const providerInfo = PROVIDER_INFO[repo.provider];
  const providerUrl = getProviderUrl(repo.provider, repo.repoFullName);
  const neverPulled = !repo.lastPushAt;

  // Build URL with optional app parameter
  const buildApiUrl = (endpoint: string) => {
    const url = new URL(`${API_URL}/api/git/servers/${serverId}/${endpoint}`);
    if (sandboxId) {
      url.searchParams.set("app", sandboxId);
    }
    return url.toString();
  };

  // Import from remote — calls VPS file-api directly (with retry for credential sync)
  const importMutation = useMutation({
    mutationFn: async () => {
      if (!codeApiUrl || !fetchWithCodeToken || !sandboxId) {
        throw new Error("Import not available");
      }
      const maxRetries = 3;
      for (let i = 0; i < maxRetries; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 3000));
        const res = await fetchWithCodeToken(
          `${codeApiUrl}/api/app/${encodeURIComponent(sandboxId)}/git-pull`,
          { method: "POST", credentials: "include" }
        );
        if (res.ok) return res.json();
        const data = await res.json().catch(() => ({})) as { error?: string };
        if (res.status === 409 && i < maxRetries - 1) continue; // credentials still syncing
        throw new Error(data.error || "Import failed");
      }
    },
    onSuccess: () => {
      setImportSuccess(true);
      setTimeout(() => setImportSuccess(false), 5000);
      queryClient.invalidateQueries({ queryKey: ["git-link", serverId, sandboxId] });
      queryClient.invalidateQueries({ queryKey: ["file-tree", sandboxId] });
      queryClient.invalidateQueries({ queryKey: ["git-status", sandboxId] });
    },
  });

  const pushMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(buildApiUrl("push"), {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(err.message || "Push failed");
      }
      return res.json();
    },
    onSuccess: () => {
      setPushSuccess(true);
      setTimeout(() => setPushSuccess(false), 3000);
      queryClient.invalidateQueries({ queryKey: ["git-link", serverId, sandboxId] });
    },
  });

  const pullMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(buildApiUrl("pull"), {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(err.message || "Pull failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["git-link", serverId, sandboxId] });
    },
  });

  const forcePushMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(buildApiUrl("force-push"), {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(err.message || "Force push failed");
      }
      return res.json();
    },
    onSuccess: () => {
      setPushSuccess(true);
      setTimeout(() => setPushSuccess(false), 3000);
      queryClient.invalidateQueries({ queryKey: ["git-link", serverId, sandboxId] });
    },
  });

  const isPushing = pushMutation.isPending || forcePushMutation.isPending;
  const isPulling = pullMutation.isPending;
  const isImporting = importMutation.isPending;
  const pushRejected = pushMutation.isError;

  return (
    <div className="space-y-3">
      {/* Linked repo info */}
      <div className="px-3 py-2.5 rounded-lg border border-border bg-cream/[0.02]">
        <div className="flex items-center gap-2.5">
          <div className={providerInfo.color}>
            <ProviderLogo provider={repo.provider} className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-cream/85 truncate">
                {repo.repoFullName}
              </span>
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 h-4 border-border bg-cream/[0.03] text-cream/45 shrink-0"
              >
                {repo.isPrivate ? "Private" : "Public"}
              </Badge>
            </div>
            {repo.lastPushAt && (
              <span className="text-[10px] text-cream/45 flex items-center gap-1 mt-0.5">
                <Clock className="h-2.5 w-2.5" />
                Last backup {formatTimestamp(repo.lastPushAt)}
              </span>
            )}
          </div>
          <a
            href={providerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 p-1.5 rounded hover:bg-cream/[0.05] transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5 text-cream/45 hover:text-cream/60" />
          </a>
        </div>
      </div>

      {/* Shared repo notice */}
      {repo.sharedWithApps && repo.sharedWithApps.length > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
          <Info className="h-3.5 w-3.5 text-blue-400 shrink-0 mt-0.5" />
          <span className="text-[11px] text-blue-300">
            <span className="font-medium">Shared:</span>{" "}
            {repo.sharedWithApps.length === 1
              ? `"${repo.sharedWithApps[0]}" also uses this repo`
              : `${repo.sharedWithApps.length} other apps also use this repo`}
          </span>
        </div>
      )}

      {/* Import from remote — shown for fresh links */}
      {neverPulled && codeApiUrl && fetchWithCodeToken && sandboxId && (
        <div className="space-y-2">
          <Button
            onClick={() => importMutation.mutate()}
            disabled={isImporting || importSuccess}
            size="sm"
            className={`w-full transition-all ${
              importSuccess
                ? "bg-sodium/15 text-sodium border border-sodium/20 hover:bg-sodium/15"
                : "bg-blue-600 hover:bg-blue-500 text-cream"
            }`}
          >
            {isImporting ? (
              <>
                <Spinner size="xs" className="mr-1.5" />
                Importing...
              </>
            ) : importSuccess ? (
              <>
                <Check className="h-3.5 w-3.5 mr-1.5" />
                Imported
              </>
            ) : (
              <>
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Import from remote
              </>
            )}
          </Button>
          {importMutation.error && (
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-terra/10 border border-terra/20">
              <AlertCircle className="h-3 w-3 text-terra shrink-0" />
              <span className="text-[11px] text-terra">
                {importMutation.error instanceof Error
                  ? importMutation.error.message
                  : "Failed to import code"}
              </span>
            </div>
          )}
          <p className="text-[10px] text-cream/35 text-center">
            Existing files will be backed up before importing
          </p>
        </div>
      )}

      {/* Actions row */}
      <div className="flex gap-2">
        <Button
          onClick={() => pushMutation.mutate()}
          disabled={isPushing || pushSuccess}
          size="sm"
          className={`flex-1 transition-all ${
            pushSuccess
              ? "bg-sodium/15 text-sodium border border-sodium/20 hover:bg-sodium/15"
              : "bg-sodium hover:bg-sodium text-ink"
          }`}
        >
          {isPushing ? (
            <>
              <Spinner size="xs" className="mr-1.5" />
              Pushing...
            </>
          ) : pushSuccess ? (
            <>
              <Check className="h-3.5 w-3.5 mr-1.5" />
              Pushed
            </>
          ) : (
            <>
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Push
            </>
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => pullMutation.mutate()}
          disabled={isPulling}
          className="border-border text-cream/60 hover:text-cream/75"
        >
          {isPulling ? (
            <Spinner size="xs" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {/* Error + force push */}
      {(pushMutation.error || forcePushMutation.error) && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-2.5 py-1.5 rounded bg-terra/10 border border-terra/20">
            <AlertCircle className="h-3 w-3 text-terra shrink-0" />
            <span className="text-[11px] text-terra">
              {pushMutation.error instanceof Error
                ? pushMutation.error.message
                : forcePushMutation.error instanceof Error
                  ? forcePushMutation.error.message
                  : "Push failed"}
            </span>
          </div>
          {pushRejected && (
            <Button
              onClick={() => forcePushMutation.mutate()}
              disabled={forcePushMutation.isPending}
              variant="outline"
              size="sm"
              className="w-full border-sodium/20 text-sodium hover:bg-sodium/10"
            >
              {forcePushMutation.isPending ? (
                <>
                  <Spinner size="xs" className="mr-1.5" />
                  Force pushing...
                </>
              ) : (
                <>
                  <Upload className="h-3.5 w-3.5 mr-1.5" />
                  Force push (overwrite remote)
                </>
              )}
            </Button>
          )}
        </div>
      )}

      {pushSuccess && (
        <a
          href={providerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1.5 text-[11px] text-cream/45 hover:text-cream/60 transition-colors"
        >
          View on {PROVIDER_INFO[repo.provider].name}
          <ExternalLink className="h-3 w-3" />
        </a>
      )}

      {/* Management actions */}
      <div className="flex items-center gap-3 pt-1 border-t border-cream/[0.04]">
        <button
          onClick={onChangeRepo}
          className="text-[11px] text-cream/45 hover:text-cream/60 transition-colors"
        >
          Change repository
        </button>
        <span className="text-cream/85">|</span>
        <button
          onClick={onUnlink}
          className="text-[11px] text-terra/60 hover:text-terra transition-colors flex items-center gap-1"
        >
          <Unlink className="h-3 w-3" />
          Disconnect
        </button>
      </div>
    </div>
  );
}
