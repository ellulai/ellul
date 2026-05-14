// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery } from "@tanstack/react-query";
import {
  Search,
  Lock,
  Globe,
  Plus,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { API_URL } from "@/lib/api";
import type { GitProvider } from "./ProviderCard";

export interface NormalizedRepo {
  name: string;
  fullName: string;
  url: string;
  sshUrl: string;
  isPrivate: boolean;
  defaultBranch: string;
  description: string | null;
  updatedAt: string;
}

interface RepoPickerProps {
  provider: GitProvider;
  serverId: string;
  onSelectRepo: (repo: NormalizedRepo) => void;
  onCreateNew: () => void;
}

export function RepoPicker({ provider, serverId, onSelectRepo, onCreateNew }: RepoPickerProps) {
  const t = useTranslations("console.git.repoPicker");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Debounce search
  const handleSearch = (value: string) => {
    setSearch(value);
    setTimeout(() => setDebouncedSearch(value), 300);
  };

  const { data, isLoading, error } = useQuery<{ repos: NormalizedRepo[] }>({
    queryKey: ["git-repos", provider, debouncedSearch],
    queryFn: async () => {
      const params = debouncedSearch ? `?search=${encodeURIComponent(debouncedSearch)}` : "";
      const res = await fetch(`${API_URL}/api/git/servers/${serverId}/repos/${provider}${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load repos");
      return res.json();
    },
  });

  const repos = data?.repos || [];

  // Filter client-side for instant feedback
  const filteredRepos = search
    ? repos.filter(
        (r) =>
          r.name.toLowerCase().includes(search.toLowerCase()) ||
          r.fullName.toLowerCase().includes(search.toLowerCase())
      )
    : repos;

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return t("today");
    if (days === 1) return t("yesterday");
    if (days < 30) return t("daysAgo", { count: days });
    if (days < 365) return t("monthsAgo", { count: Math.floor(days / 30) });
    return t("yearsAgo", { count: Math.floor(days / 365) });
  };

  return (
    <div className="space-y-2">
      {/* Search + create */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-cream/45" />
          <Input
            placeholder={t("search")}
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-8 h-8 bg-cream/[0.03] border-border text-xs"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onCreateNew}
          className="shrink-0 h-8 px-2.5 border-border text-cream/60 hover:text-cream/75"
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          <span className="text-xs">{t("newButton")}</span>
        </Button>
      </div>

      {/* Repo list */}
      <div className="border border-border rounded-lg overflow-hidden divide-y divide-cream/[0.04]">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Spinner size="sm" color="muted" />
          </div>
        )}

        {error && (
          <div className="px-3 py-6 text-center text-xs text-terra">
            {t("loadFailed")}
          </div>
        )}

        {!isLoading && !error && filteredRepos.length === 0 && (
          <div className="px-3 py-6 text-center">
            <p className="text-xs text-cream/45">
              {search ? t("noMatching") : t("noRepos")}
            </p>
            <button
              onClick={onCreateNew}
              className="text-xs text-sodium hover:text-sodium mt-1.5 transition-colors"
            >
              {t("createNew")}
            </button>
          </div>
        )}

        {filteredRepos.map((repo) => (
          <button
            key={repo.fullName}
            onClick={() => onSelectRepo(repo)}
            className="w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-cream/[0.03] transition-colors group"
          >
            <div className="shrink-0">
              {repo.isPrivate ? (
                <Lock className="h-3 w-3 text-cream/45" />
              ) : (
                <Globe className="h-3 w-3 text-cream/45" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-cream/75 truncate">
                {repo.name}
              </div>
              {repo.description && (
                <div className="text-[10px] text-cream/45 truncate mt-0.5">
                  {repo.description}
                </div>
              )}
            </div>
            <div className="shrink-0 flex items-center gap-1.5">
              <span className="text-[10px] text-cream/35">
                {formatDate(repo.updatedAt)}
              </span>
              <ChevronRight className="h-3 w-3 text-cream/35 group-hover:text-cream/60 transition-colors" />
            </div>
          </button>
        ))}
      </div>

      {/* Provider-side access management hint.
          GitHub Apps are scoped to an installation-level repo list chosen by
          the user at install time; neither the app token nor the OAuth scope
          can see outside it. If a repo is missing, the fix lives on github.com,
          not in our UI — so surface a direct link to the installation's
          "select repositories" page instead of leaving the user to guess why
          their repo list looks short. GitLab/Bitbucket use OAuth scopes and
          list every accessible repo, so this affordance is GitHub-only. */}
      {provider === "github" && !isLoading && !error && (
        <a
          href="https://github.com/settings/installations"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] text-cream/45 hover:text-cream/75 transition-colors"
        >
          <span>{t("githubManageAccess")}</span>
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}
