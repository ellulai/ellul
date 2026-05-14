// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Package,
  ChevronRight,
  Search,
  Plus,
  MoreVertical,
  Trash2,
  X,
  ArrowUpDown,
  GitBranch,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { SkeletonAppList, Skeleton } from "@/components/ui/skeleton";
import { useAppsList, type ApiSandbox } from "@/contexts/AppsListContext";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { OnboardingFlow } from "./OnboardingFlow";
import { API_URL } from "@/lib/api";

const FRAMEWORK_LABELS: Record<string, string> = {
  next: "Next.js",
  nextjs: "Next.js",
  vite: "Vite",
  astro: "Astro",
  remix: "Remix",
  express: "Express",
  fastify: "Fastify",
  hono: "Hono",
  nestjs: "NestJS",
  fastapi: "FastAPI",
  django: "Django",
  flask: "Flask",
  rails: "Rails",
  turbo: "Turborepo",
  nx: "Nx",
  lerna: "Lerna",
  "pnpm-workspace": "pnpm Workspaces",
  unknown: "Unknown",
};

interface Deployment {
  name: string;
  directory?: string;
  url: string;
  port: number;
  stack: string;
  summary: string;
  createdAt: string;
  project?: string;
  projectPath?: string;
}

interface GitRepoInfo {
  provider: string;
  repoFullName: string;
  repoUrl: string;
  isPrivate: boolean;
  linkedAt: string;
  lastPushAt: string | null;
}

interface OverviewPageProps {
  sandboxes: ApiSandbox[];
  deployments: Deployment[];
  isLoading: boolean;
  // Called with the target directory — a sandbox slug for empty sandboxes,
  onSelectApp: (directory: string) => void;
  serverId: string;
  serverDomain: string;
  // Forwarded to the Create Sandbox modal so its git flow knows whether to
  securityTier?: "standard" | "web_locked" | "private_locked";
}

export function OverviewPage({
  sandboxes,
  deployments,
  isLoading,
  onSelectApp,
  serverId,
  serverDomain,
  securityTier,
}: OverviewPageProps) {
  const t = useTranslations("console.overview");
  const { deleteSandbox, isDeletingSandbox } = useAppsList();
  const vh = useVisualViewport();

  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"recent" | "alpha" | "alpha-desc">("recent");

  const { data: gitLinksData } = useQuery<{ repos: Record<string, GitRepoInfo> }>({
    queryKey: ["git-links", serverId],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/git/servers/${serverId}/links`, {
        credentials: "include",
      });
      if (!res.ok) return { repos: {} };
      return res.json();
    },
    enabled: !!serverId,
    staleTime: 30000,
  });

  const gitReposByApp = gitLinksData?.repos || {};

  const [menuSandboxId, setMenuSandboxId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; displayName: string } | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [wizardFooterEl, setWizardFooterEl] = useState<HTMLDivElement | null>(null);

  // Body scroll is permanently locked by MobileDashboardLayout (position:fixed).
  // No per-modal lock needed.

  // orphaned (the OnboardingFlow's own restoration effect never runs because it
  // cosmetic remnant — removing it here would race OnboardingFlow's mount effect.
  const searchParams = useSearchParams();
  useEffect(() => {
    if (!searchParams?.get("connected")) return;
    try {
      const saved = sessionStorage.getItem("ps_onboarding_state");
      if (!saved) return;
      const state = JSON.parse(saved) as { flowType?: string; sandboxId?: string };
      if (state.flowType === "git" && state.sandboxId) {
        setShowCreateModal(true);
      }
    } catch {
      // Malformed sessionStorage — ignore, don't block the page
    }
  }, [searchParams]);

  const deployedByDir = new Map(
    deployments.filter((d) => d.directory).map((d) => [d.directory!, d]),
  );
  const deployedByName = new Map(deployments.map((d) => [d.name, d]));
  const findDeployment = (sandbox: ApiSandbox) =>
    deployedByDir.get(sandbox.id) || deployedByName.get(sandbox.displayName);

  // Navigate to the most-useful entry point for this sandbox:
  const targetForSandbox = (sandbox: ApiSandbox): string => {
    if (sandbox.apps.length === 1) return sandbox.apps[0]!.directory;
    return sandbox.id;
  };

  const filteredSandboxes = sandboxes
    .filter((sandbox) => {
      if (!searchQuery) return true;
      const q = searchQuery.toLowerCase();
      return (
        sandbox.displayName.toLowerCase().includes(q) ||
        sandbox.id.toLowerCase().includes(q) ||
        sandbox.apps.some((a) => a.framework.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
      );
    })
    .sort((a, b) => {
      const nameA = a.displayName.toLowerCase();
      const nameB = b.displayName.toLowerCase();
      if (sortBy === "alpha") return nameA.localeCompare(nameB);
      if (sortBy === "alpha-desc") return nameB.localeCompare(nameA);
      return 0;
    });

  if (isLoading) {
    return (
      <div className="flex-1 overflow-y-auto p-3 sm:p-4">
        <div className="flex items-center justify-between mb-4">
          <div className="space-y-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
        <SkeletonAppList count={3} />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto p-3 sm:p-4">
      {/* Header */}
      <div className="mb-4 space-y-3">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-sm font-semibold text-cream">{t("sandboxes")}</h1>
            <p className="text-xs text-cream/60 mt-1">
              {t("sandboxCount", { count: sandboxes.length })}
            </p>
          </div>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-ink bg-sodium rounded-lg shadow-neon-bright transition-all"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("newSandbox")}
          </button>
        </div>

        {sandboxes.length > 0 && (
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-cream/45" />
              <input
                type="text"
                placeholder={t("searchPlaceholder")}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm bg-card border border-border rounded-lg text-cream placeholder:text-cream/45 focus:outline-none focus:border-cream/[0.12] focus:ring-1 focus:ring-white/[0.06] transition-colors"
              />
            </div>
            <div className="relative">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                className="appearance-none pl-8 pr-6 py-2 text-sm bg-card border border-border rounded-lg text-cream/75 focus:outline-none focus:border-cream/[0.12] focus:ring-1 focus:ring-white/[0.06] transition-colors cursor-pointer"
              >
                <option value="recent">{t("sortRecent")}</option>
                <option value="alpha">{t("sortAlpha")}</option>
                <option value="alpha-desc">{t("sortAlphaDesc")}</option>
              </select>
              <ArrowUpDown className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-cream/45 pointer-events-none" />
            </div>
          </div>
        )}
      </div>

      {/* Sandbox Grid */}
      <div className="space-y-2">
        {filteredSandboxes.length === 0 && searchQuery ? (
          <div className="text-center py-8">
            <p className="text-sm text-cream/60">{t("noMatching")}</p>
            <button
              onClick={() => setSearchQuery("")}
              className="text-xs text-cream/60 hover:text-cream/75 mt-2 transition-colors font-medium"
            >
              {t("clearSearch")}
            </button>
          </div>
        ) : null}
        {filteredSandboxes.map((sandbox) => {
          const deployment = findDeployment(sandbox);
          const isDeployed = !!deployment;
          // Git repo lookup: try by sandbox slug first, then by any contained app path
          const gitRepo =
            gitReposByApp[sandbox.id] ||
            sandbox.apps.map((a) => gitReposByApp[a.directory] || gitReposByApp[a.path]).find(Boolean);
          const primary = sandbox.apps[0];

          // The card always shows the **sandbox** name — that's the user's
          const primaryLabel = sandbox.displayName;

          const subline = sandbox.apps.length === 0
            ? t("subline.empty")
            : sandbox.apps.length === 1 && primary
              ? `${primary.displayName || primary.name} · ${FRAMEWORK_LABELS[primary.framework] ?? primary.framework}`
              : t("subline.appsCount", { count: sandbox.apps.length });

          return (
            <button
              key={sandbox.id}
              onClick={() => onSelectApp(targetForSandbox(sandbox))}
              className="w-full text-left p-4 rounded-xl bg-card border border-border hover:border-border hover:bg-card/80 transition-all group cursor-pointer"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="w-10 h-10 rounded-lg bg-sodium/10 border border-border flex items-center justify-center shrink-0">
                    <Package className="h-5 w-5 text-sodium" />
                  </div>
                  <div className="min-w-0 text-left">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-cream truncate">{primaryLabel}</h3>
                      {isDeployed && (
                        <span className="flex items-center gap-1 text-[10px] text-sodium font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-sodium" />
                          {t("live")}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-cream/45">{subline}</span>
                      {gitRepo && (
                        <span className="flex items-center gap-1 text-[10px] text-sodium" title={gitRepo.repoFullName}>
                          <GitBranch className="h-3 w-3" />
                          <span className="truncate max-w-[120px]">{gitRepo.repoFullName.split("/").pop()}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <div
                    role="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      setMenuPosition({ top: rect.bottom + 4, left: rect.left - 140 });
                      setMenuSandboxId(menuSandboxId === sandbox.id ? null : sandbox.id);
                    }}
                    className="p-2 rounded-lg hover:bg-cream/10 text-cream/60 hover:text-cream transition-colors sm:opacity-0 sm:group-hover:opacity-100"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </div>
                  <div className="p-2 rounded-lg text-cream/45 group-hover:text-cream transition-colors">
                    <ChevronRight className="h-4 w-4" />
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Sandbox Menu Portal */}
      {menuSandboxId && menuPosition && createPortal(
        <>
          <div className="fixed inset-0 z-[100] animate-in fade-in-0 duration-150" onClick={() => setMenuSandboxId(null)} />
          <div
            className="fixed z-[110] w-44 bg-card border border-border rounded-lg shadow-2xl py-1 animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150"
            style={{ top: menuPosition.top, left: menuPosition.left }}
          >
            {(() => {
              const sandbox = sandboxes.find((s) => s.id === menuSandboxId);
              if (!sandbox) return null;
              return (
                <button
                  onClick={() => {
                    setDeleteConfirm({ id: sandbox.id, displayName: sandbox.displayName });
                    setDeleteConfirmText("");
                    setMenuSandboxId(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-terra hover:bg-secondary transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                  {t("delete")}
                </button>
              );
            })()}
          </div>
        </>,
        document.body,
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && createPortal(
        <div
          className="fixed inset-x-0 top-0 z-[120] flex items-end sm:items-center justify-center"
          style={{ height: vh }}
          onClick={() => {
            if (isDeletingSandbox) return;
            setDeleteConfirm(null);
            setDeleteError(null);
          }}
        >
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in-0 duration-200" />
          <div
            className="relative w-full sm:max-w-sm max-h-[calc(100%-0.5rem)] sm:max-h-[80vh] flex flex-col bg-card border border-border rounded-t-xl sm:rounded-xl shadow-2xl animate-in slide-in-from-bottom-4 sm:zoom-in-95 sm:slide-in-from-bottom-0 duration-200 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex-1 overflow-y-auto p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-lg font-semibold text-terra">{t("deleteSandboxTitle")}</h3>
                <button
                  onClick={() => {
                    if (isDeletingSandbox) return;
                    setDeleteConfirm(null);
                    setDeleteError(null);
                  }}
                  disabled={isDeletingSandbox}
                  className="p-1 rounded-lg hover:bg-cream/10 text-cream/60 hover:text-cream transition-colors disabled:opacity-50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <p className="text-sm text-cream/60 mb-4">
                {t.rich("deleteConfirmDescription", {
                  name: () => <span className="text-cream font-medium">{deleteConfirm.displayName}</span>,
                })}
              </p>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => {
                  setDeleteConfirmText(e.target.value);
                  if (deleteError) setDeleteError(null);
                }}
                className="w-full px-3 py-2 bg-secondary/50 border border-border rounded-lg text-cream placeholder:text-cream/45 focus:outline-none focus:border-terra/50"
                placeholder={deleteConfirm.displayName}
                autoFocus
              />
              {deleteError && (
                <div className="mt-4 px-3 py-2 bg-terra/10 border border-terra/30 rounded-lg text-sm text-terra">
                  {deleteError}
                </div>
              )}
            </div>
            <div className="shrink-0 flex gap-2 justify-end px-4 py-3 border-t border-border">
              <button
                onClick={() => {
                  setDeleteConfirm(null);
                  setDeleteError(null);
                }}
                disabled={isDeletingSandbox}
                className="px-4 py-2 text-sm text-cream/60 hover:text-cream transition-colors disabled:opacity-50"
              >
                {t("cancel")}
              </button>
              <button
                onClick={async () => {
                  if (deleteConfirmText !== deleteConfirm.displayName) return;
                  setDeleteError(null);
                  const result = await deleteSandbox(deleteConfirm.id);
                  if (result.success) {
                    setDeleteConfirm(null);
                    setDeleteConfirmText("");
                  } else {
                    setDeleteError(result.error || t("deleteFailed"));
                  }
                }}
                disabled={deleteConfirmText !== deleteConfirm.displayName || isDeletingSandbox}
                className="px-4 py-2 text-sm bg-terra hover:bg-terra disabled:bg-terra/50 disabled:cursor-not-allowed text-cream rounded-lg transition-colors flex items-center gap-2"
              >
                {isDeletingSandbox && <Spinner size="sm" delay={300} />}
                {t("delete")}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Create Sandbox Modal */}
      {showCreateModal && createPortal(
        <div className="fixed inset-x-0 top-0 z-[100] flex items-end sm:items-center justify-center" style={{ height: vh }} onClick={() => setShowCreateModal(false)}>
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in-0 duration-200" />
          <div
            className="relative w-full sm:max-w-md h-[calc(100%-0.5rem)] sm:h-auto sm:max-h-[80vh] bg-card border border-border rounded-t-xl sm:rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in slide-in-from-bottom-4 sm:zoom-in-95 sm:slide-in-from-bottom-0 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Plus className="h-5 w-5 text-sodium" />
                <h2 className="text-lg font-semibold text-cream">{t("createSandboxTitle")}</h2>
              </div>
              <button
                onClick={() => setShowCreateModal(false)}
                className="p-1.5 rounded-lg hover:bg-cream/10 text-cream/60 hover:text-cream transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              <OnboardingFlow
                serverId={serverId}
                serverDomain={serverDomain}
                securityTier={securityTier}
                onComplete={() => {
                  setShowCreateModal(false);
                }}
                isModal
                footerEl={wizardFooterEl}
              />
            </div>
            <div ref={setWizardFooterEl} className="shrink-0" />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
