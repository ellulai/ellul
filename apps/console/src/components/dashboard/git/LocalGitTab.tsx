// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import {
  GitBranch,
  Shield,
  ExternalLink,
  Loader2,
  LogOut,
  Search,
  Lock,
  Globe,
  Check,
  Copy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ProviderLogo } from "./ProviderCard";

interface LocalGitTabProps {
  app?: { directory: string; name: string } | null;
}

interface LocalConnection {
  connected: boolean;
  provider?: string;
  username?: string;
  avatarUrl?: string | null;
  linkedRepo?: LinkedRepo | null;
}

interface LinkedRepo {
  fullName: string;
  url: string;
  isPrivate: boolean;
  defaultBranch: string;
  description: string | null;
}

interface Repo {
  name: string;
  fullName: string;
  url: string;
  isPrivate: boolean;
  defaultBranch: string;
  description: string | null;
  updatedAt: string;
}

type ViewState = "connect" | "repos" | "linked";

export function LocalGitTab({ app }: LocalGitTabProps) {
  const t = useTranslations("console.tabGit");
  const [viewState, setViewState] = useState<ViewState>("connect");
  const [connection, setConnection] = useState<LocalConnection | null>(null);
  const [loading, setLoading] = useState(true);

  const [deviceFlow, setDeviceFlow] = useState<{
    ref: string;
    userCode: string;
    verificationUri: string;
    interval: number;
  } | null>(null);
  const [deviceFlowError, setDeviceFlowError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoSearch, setRepoSearch] = useState("");
  const [repoLoading, setRepoLoading] = useState(false);
  const [linkedRepo, setLinkedRepo] = useState<LinkedRepo | null>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Restore state from shield on mount ──

  const checkConnection = useCallback(async () => {
    try {
      const res = await fetch("/_auth/git/connection");
      if (res.ok) {
        const data: LocalConnection = await res.json();
        setConnection(data);
        if (data.connected && data.linkedRepo) {
          setLinkedRepo(data.linkedRepo);
          setViewState("linked");
        } else if (data.connected) {
          setViewState("repos");
        }
      }
    } catch {
      setConnection({ connected: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  // ── Device Flow ──

  const startDeviceFlow = async () => {
    setDeviceFlowError(null);
    try {
      const res = await fetch("/_auth/git/device-flow/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Device flow start failed");
      }
      const data = await res.json();
      setDeviceFlow(data);
      startPolling(data.ref, data.interval);
    } catch (e: any) {
      setDeviceFlowError(e?.message || t("deviceFlowStartFailed"));
    }
  };

  const cancelDeviceFlow = () => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
    setDeviceFlow(null);
    setDeviceFlowError(null);
  };

  const startPolling = (ref: string, interval: number) => {
    if (pollRef.current) clearTimeout(pollRef.current);

    const poll = async () => {
      try {
        const res = await fetch("/_auth/git/device-flow/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ref }),
        });
        const data = await res.json();

        if (data.status === "authorized") {
          setConnection({
            connected: true,
            provider: "github",
            username: data.username,
            avatarUrl: data.avatarUrl,
          });
          setDeviceFlow(null);
          setViewState("repos");
          return;
        }

        if (data.status === "expired" || data.status === "error") {
          setDeviceFlow(null);
          setDeviceFlowError(data.error || t("deviceFlowExpired"));
          return;
        }

        const nextInterval = (data.interval || interval) * 1000;
        pollRef.current = setTimeout(poll, nextInterval);
      } catch {
        pollRef.current = setTimeout(poll, interval * 1000);
      }
    };

    pollRef.current = setTimeout(poll, interval * 1000);
  };

  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  // ── Repo Picker ──

  const fetchRepos = useCallback(async (search: string) => {
    setRepoLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      const res = await fetch(`/_auth/git/repos?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setRepos(data.repos || []);
      }
    } catch {
      setRepos([]);
    } finally {
      setRepoLoading(false);
    }
  }, []);

  useEffect(() => {
    if (viewState === "repos" && connection?.connected) {
      fetchRepos("");
    }
  }, [viewState, connection?.connected, fetchRepos]);

  const handleSearchChange = (value: string) => {
    setRepoSearch(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => fetchRepos(value), 300);
  };

  const handleSelectRepo = async (repo: Repo) => {
    const linked: LinkedRepo = {
      fullName: repo.fullName,
      url: repo.url,
      isPrivate: repo.isPrivate,
      defaultBranch: repo.defaultBranch,
      description: repo.description,
    };

    try {
      await fetch("/_auth/git/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(linked),
      });
    } catch {
      // Non-fatal — credentials are still stored
    }

    setLinkedRepo(linked);
    setViewState("linked");
  };

  const handleChangeRepo = async () => {
    try {
      await fetch("/_auth/git/link", { method: "DELETE" });
    } catch {
      // Non-fatal
    }
    setLinkedRepo(null);
    setViewState("repos");
  };

  const handleDisconnect = async () => {
    try {
      await fetch("/_auth/git/connection", { method: "DELETE" });
    } catch {
      // Best-effort
    }
    setConnection({ connected: false });
    setLinkedRepo(null);
    setViewState("connect");
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner size="default" color="muted" delay={300} />
      </div>
    );
  }

  if (!app) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="flex flex-col items-center justify-center text-center max-w-xs">
          <div className="w-10 h-10 rounded-lg bg-cream/[0.02] border border-cream/[0.06] flex items-center justify-center mb-3">
            <GitBranch className="h-5 w-5 text-cream/45" />
          </div>
          <h3 className="text-sm font-medium text-cream/75 mb-1">{t("selectSandboxTitle")}</h3>
          <p className="text-xs text-cream/60 leading-relaxed">{t("selectSandboxHint")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 px-4 py-4 overflow-y-auto">
      <div className="mb-4">
        <h2 className="text-sm font-medium text-cream">
          {linkedRepo ? t("headerRepository") : t("headerGit")}
        </h2>
        <p className="text-xs text-cream/60 mt-0.5">
          {linkedRepo ? t("subtitleConnected") : t("subtitleDisconnected")}
        </p>
      </div>

      {/* ── Connect GitHub ── */}
      {viewState === "connect" && !connection?.connected && (
        <div className="space-y-3">
          <div className="flex items-center gap-1.5 mb-1">
            <Shield className="h-3 w-3 text-cream/35" />
            <span className="text-[10px] text-cream/45">{t("encryptedNote")}</span>
          </div>

          {!deviceFlow ? (
            <button
              onClick={startDeviceFlow}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-cream/[0.02] hover:bg-cream/[0.04] transition-colors"
            >
              <div className="text-cream shrink-0">
                <ProviderLogo provider="github" />
              </div>
              <div className="flex-1 min-w-0 text-left">
                <span className="text-sm font-medium text-cream/85">GitHub</span>
              </div>
              <span className="shrink-0 px-3 py-1 text-xs font-medium text-cream/75 bg-cream/[0.06] border border-cream/[0.08] rounded-md">
                {t("connectButton")}
              </span>
            </button>
          ) : (
            <div className="rounded-lg border border-sodium/20 bg-sodium/5 p-4 space-y-3">
              <p className="text-sm text-cream/80">
                {t("deviceFlowPrompt")}
              </p>
              <div className="flex items-center justify-center gap-2">
                <code className="text-2xl font-mono font-bold text-sodium tracking-[0.2em] px-4 py-2 rounded-lg bg-cream/[0.04] border border-cream/[0.08]">
                  {deviceFlow.userCode}
                </code>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(deviceFlow.userCode);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                  className="p-2 rounded-md bg-cream/[0.04] border border-cream/[0.08] hover:bg-cream/[0.08] transition-colors"
                >
                  {copied ? <Check className="h-4 w-4 text-sodium" /> : <Copy className="h-4 w-4 text-cream/50" />}
                </button>
              </div>
              <div className="flex items-center justify-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-cream/45" />
                <span className="text-xs text-cream/50">{t("deviceFlowWaiting")}</span>
              </div>
              <button
                onClick={() => {
                  const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
                  if (invoke) {
                    invoke("open_external", { url: deviceFlow.verificationUri }).catch(() => {
                      window.open(deviceFlow.verificationUri, "_blank");
                    });
                  } else {
                    window.open(deviceFlow.verificationUri, "_blank");
                  }
                }}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-sodium bg-sodium/10 hover:bg-sodium/15 border border-sodium/20 rounded-md transition-colors"
              >
                {t("deviceFlowOpenGitHub")}
                <ExternalLink className="h-3 w-3" />
              </button>
              <button
                onClick={cancelDeviceFlow}
                className="w-full text-center text-xs text-cream/40 hover:text-cream/60 transition-colors py-1"
              >
                {t("deviceFlowCancel")}
              </button>
            </div>
          )}

          {deviceFlowError && (
            <div className="px-3 py-2 rounded-lg bg-terra/10 border border-terra/15">
              <span className="text-xs text-terra">{deviceFlowError}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Connected: Repo Picker ── */}
      {viewState === "repos" && connection?.connected && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="text-cream">
                <ProviderLogo provider="github" className="h-4 w-4" />
              </div>
              {connection.avatarUrl && (
                <img src={connection.avatarUrl} alt="" className="h-5 w-5 rounded-full" />
              )}
              <span className="text-xs text-cream/60">@{connection.username}</span>
              <Check className="h-3 w-3 text-sodium" />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDisconnect}
              className="text-cream/35 hover:text-terra h-7 w-7 p-0"
            >
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-cream/30" />
            <input
              type="text"
              value={repoSearch}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder={t("searchRepos")}
              className="w-full pl-8 pr-3 py-2 text-xs bg-cream/[0.03] border border-cream/[0.08] rounded-md text-cream/80 placeholder:text-cream/30 focus:outline-none focus:border-cream/[0.15]"
            />
          </div>

          {repoLoading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner size="default" color="muted" />
            </div>
          ) : repos.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-xs text-cream/40">
                {repoSearch ? t("noReposFound") : t("noReposAvailable")}
              </p>
            </div>
          ) : (
            <div className="space-y-1 max-h-[300px] overflow-y-auto">
              {repos.map((repo) => (
                <button
                  key={repo.fullName}
                  onClick={() => handleSelectRepo(repo)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md hover:bg-cream/[0.04] transition-colors text-left"
                >
                  {repo.isPrivate ? (
                    <Lock className="h-3.5 w-3.5 text-cream/30 shrink-0" />
                  ) : (
                    <Globe className="h-3.5 w-3.5 text-cream/30 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-cream/80 truncate">{repo.fullName}</div>
                    {repo.description && (
                      <div className="text-[10px] text-cream/40 truncate">{repo.description}</div>
                    )}
                  </div>
                  <span className="text-[10px] text-cream/30 shrink-0">{repo.defaultBranch}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Linked Repo ── */}
      {viewState === "linked" && linkedRepo && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="text-cream">
                <ProviderLogo provider="github" className="h-4 w-4" />
              </div>
              <span className="text-xs text-cream/60">@{connection?.username}</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDisconnect}
              className="text-cream/35 hover:text-terra h-7 w-7 p-0"
            >
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="p-3 rounded-lg border border-cream/[0.08] bg-cream/[0.02] space-y-2">
            <div className="flex items-center gap-2">
              {linkedRepo.isPrivate ? (
                <Lock className="h-3.5 w-3.5 text-cream/40" />
              ) : (
                <Globe className="h-3.5 w-3.5 text-cream/40" />
              )}
              <span className="text-sm font-medium text-cream/85">{linkedRepo.fullName}</span>
            </div>
            {linkedRepo.description && (
              <p className="text-xs text-cream/50">{linkedRepo.description}</p>
            )}
            <div className="flex items-center gap-3 text-[10px] text-cream/40">
              <span>{t("branchLabel", { branch: linkedRepo.defaultBranch })}</span>
            </div>
            <div className="pt-2 border-t border-cream/[0.06]">
              <p className="text-[11px] text-cream/50">
                {t("credentialsStored")}
              </p>
              <code className="block mt-1.5 text-[11px] text-sodium/70 bg-cream/[0.03] px-2 py-1.5 rounded font-mono">
                git clone {linkedRepo.url}
              </code>
            </div>
          </div>

          <button
            onClick={handleChangeRepo}
            className="text-xs text-cream/50 hover:text-cream/70 transition-colors"
          >
            {t("changeRepo")}
          </button>
        </div>
      )}
    </div>
  );
}
