// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Database,

  Plus,
  Trash2,
  AlertCircle,
  ShieldCheck,
  HardDrive,
  Users,
  Info,
  Zap,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useVpsBridge } from "@/lib/vps-bridge";

interface DatabaseCardProps {
  serverDomain: string;
  sandboxId: string;
  tier?: "standard" | "web_locked" | "private_locked";
}

interface DatabaseInfo {
  database: string;
  ownerRole: string;
  appRole: string;
  readonlyRole: string;
  exists: boolean;
  sizeBytes?: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function DatabaseCard({ serverDomain, sandboxId, tier }: DatabaseCardProps) {
  if (tier !== "standard") {
    return <DatabaseCardBridge serverDomain={serverDomain} sandboxId={sandboxId} />;
  }
  return <DatabaseCardDirect serverDomain={serverDomain} sandboxId={sandboxId} />;
}

// ── Bridge-based (web_locked tier) ──

function DatabaseCardBridge({ serverDomain, sandboxId }: { serverDomain: string; sandboxId: string }) {
  const t = useTranslations("console.database.card");
  const { send } = useVpsBridge();
  const queryClient = useQueryClient();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const { data: statusData, isLoading: isLoadingStatus, refetch: refetchStatus, isRefetching: isRetryingStatus } = useQuery<{ available: boolean }>({
    queryKey: ["db-status", serverDomain],
    queryFn: () => send<{ available: boolean }>("db_status"),
    staleTime: 30_000,
    // Auto-retry once if PG reports unavailable (backend triggers recovery on each attempt)
    retry: (failureCount, error) => failureCount < 1,
    retryDelay: 5_000,
  });

  const { data: dbInfo, isLoading: isLoadingInfo } = useQuery<DatabaseInfo>({
    queryKey: ["db-info", serverDomain, sandboxId],
    queryFn: () => send<DatabaseInfo>("db_info", { sandboxId }),
    enabled: !!statusData?.available && !!sandboxId,
    staleTime: 30_000,
  });

  const handleRetryStatus = useCallback(() => {
    refetchStatus();
  }, [refetchStatus]);

  const provisionMutation = useMutation({
    mutationFn: () => send("db_provision", { sandboxId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["db-info", serverDomain, sandboxId] });
      toast.success(t("createSuccess"));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => send("db_delete", { sandboxId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["db-info", serverDomain, sandboxId] });
      setShowDeleteConfirm(false);
      toast.success(t("deleteSuccess"));
    },
  });

  return (
    <DatabaseCardUI
      isLoading={isLoadingStatus || isLoadingInfo}
      pgAvailable={statusData?.available ?? false}
      dbInfo={dbInfo}
      provisionMutation={provisionMutation}
      deleteMutation={deleteMutation}
      showDeleteConfirm={showDeleteConfirm}
      setShowDeleteConfirm={setShowDeleteConfirm}
      onRetryStatus={handleRetryStatus}
      isRetrying={isRetryingStatus}
    />
  );
}

// ── Direct fetch (standard tier) ──

function DatabaseCardDirect({ serverDomain, sandboxId }: { serverDomain: string; sandboxId: string }) {
  const t = useTranslations("console.database.card");
  const vpsUrl = `https://${serverDomain}`;
  const queryClient = useQueryClient();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const { data: statusData, isLoading: isLoadingStatus, refetch: refetchStatus, isRefetching: isRetryingStatus } = useQuery<{ available: boolean }>({
    queryKey: ["db-status", serverDomain],
    queryFn: async () => {
      const res = await fetch(`${vpsUrl}/_auth/db/status`, { credentials: "include", headers: { Accept: "application/json" } });
      if (!res.ok) return { available: false };
      return res.json();
    },
    staleTime: 30_000,
    retry: (failureCount, error) => failureCount < 1,
    retryDelay: 5_000,
  });

  const { data: dbInfo, isLoading: isLoadingInfo } = useQuery<DatabaseInfo>({
    queryKey: ["db-info", serverDomain, sandboxId],
    queryFn: async () => {
      const res = await fetch(`${vpsUrl}/_auth/db/info?sandboxId=${encodeURIComponent(sandboxId)}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(t("fetchInfoFailed"));
      return res.json();
    },
    enabled: !!statusData?.available && !!sandboxId,
    staleTime: 30_000,
  });

  const handleRetryStatus = useCallback(() => {
    refetchStatus();
  }, [refetchStatus]);

  const provisionMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${vpsUrl}/_auth/db/provision`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error || t("createDefaultError"));
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["db-info", serverDomain, sandboxId] });
      toast.success(t("createSuccess"));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${vpsUrl}/_auth/db/delete`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error || t("deleteDefaultError"));
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["db-info", serverDomain, sandboxId] });
      setShowDeleteConfirm(false);
      toast.success(t("deleteSuccess"));
    },
  });

  return (
    <DatabaseCardUI
      isLoading={isLoadingStatus || isLoadingInfo}
      pgAvailable={statusData?.available ?? false}
      dbInfo={dbInfo}
      provisionMutation={provisionMutation}
      deleteMutation={deleteMutation}
      showDeleteConfirm={showDeleteConfirm}
      setShowDeleteConfirm={setShowDeleteConfirm}
      onRetryStatus={handleRetryStatus}
      isRetrying={isRetryingStatus}
    />
  );
}

// ── Shared UI ──

interface MutationLike {
  mutate: () => void;
  isPending: boolean;
  error: Error | null;
}

interface DatabaseCardUIProps {
  isLoading: boolean;
  pgAvailable: boolean;
  dbInfo?: DatabaseInfo;
  provisionMutation: MutationLike;
  deleteMutation: MutationLike;
  showDeleteConfirm: boolean;
  setShowDeleteConfirm: (v: boolean) => void;
  onRetryStatus?: () => void;
  isRetrying?: boolean;
}

// Role metadata for display (labels/descs come from t())
const ROLE_META: { key: keyof Pick<DatabaseInfo, "appRole" | "readonlyRole" | "ownerRole">; labelKey: "roleApp" | "roleReadonly" | "roleOwner"; descKey: "roleAppDesc" | "roleReadonlyDesc" | "roleOwnerDesc"; color: string }[] = [
  { key: "appRole", labelKey: "roleApp", descKey: "roleAppDesc", color: "#22c55e" },
  { key: "readonlyRole", labelKey: "roleReadonly", descKey: "roleReadonlyDesc", color: "#38bdf8" },
  { key: "ownerRole", labelKey: "roleOwner", descKey: "roleOwnerDesc", color: "#f59e0b" },
];

function DatabaseCardUI({
  isLoading,
  pgAvailable,
  dbInfo,
  provisionMutation,
  deleteMutation,
  showDeleteConfirm,
  setShowDeleteConfirm,
  onRetryStatus,
  isRetrying,
}: DatabaseCardUIProps) {
  const t = useTranslations("console.database.card");
  const dbExists = dbInfo?.exists ?? false;

  // ── Loading state ──
  if (isLoading) {
    return (
      <div className="flex flex-col min-h-0">
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-cream/45" />
            <span className="text-sm font-medium text-cream">{t("heading")}</span>
          </div>
        </div>
        <div className="flex-1 flex items-center justify-center py-12">
          <div className="flex items-center gap-2.5 text-xs text-cream/60">
            <Spinner size="sm" delay={300} />
            {t("loading")}
          </div>
        </div>
      </div>
    );
  }

  // ── PostgreSQL not available ──
  if (!pgAvailable) {
    return (
      <div className="flex flex-col min-h-0">
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-cream/45" />
            <span className="text-sm font-medium text-cream">{t("heading")}</span>
          </div>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center py-12 px-6">
          <div className="w-10 h-10 rounded-xl bg-cream/[0.03] border border-cream/[0.06] flex items-center justify-center mb-3">
            <Database className="h-5 w-5 text-cream/45" />
          </div>
          <p className="text-xs text-cream/60 text-center">{t("pgUnavailable")}</p>
          <p className="text-[10px] text-cream/45 mt-1 text-center">{t("pgUnavailableHint")}</p>
          {onRetryStatus && (
            <button
              type="button"
              onClick={onRetryStatus}
              disabled={isRetrying}
              className={cn(
                "mt-3 flex items-center gap-1.5 h-7 px-3 rounded-md text-[10px] font-medium transition-all",
                "bg-cream/[0.04] text-cream/60 border border-cream/[0.06]",
                "hover:bg-cream/[0.06] hover:text-cream/75",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              {isRetrying ? <Spinner size="xs" /> : <Database className="h-3 w-3" />}
              {isRetrying ? t("checking") : t("retry")}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Database exists — info panel ──
  if (dbExists && dbInfo) {
    return (
      <div className="flex flex-col min-h-0">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-sodium" />
            <span className="text-sm font-medium text-cream">{t("heading")}</span>
          </div>
          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-sodium/10 border border-sodium/20">
            <ShieldCheck className="h-3 w-3 text-sodium" />
            <span className="text-[10px] font-medium text-sodium">{t("active")}</span>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {/* Database instance */}
          <div className="group flex items-center gap-2.5 px-2.5 py-2.5 rounded-lg bg-cream/[0.03] border border-cream/[0.06] transition-colors hover:bg-cream/[0.05]">
            <div className="w-8 h-8 rounded-lg bg-sodium/10 border border-sodium/20 flex items-center justify-center shrink-0">
              <HardDrive className="h-4 w-4 text-sodium" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="truncate text-xs font-medium text-cream">{dbInfo.database}</div>
              <div className="text-[10px] text-cream/45">
                {dbInfo.sizeBytes !== undefined ? formatBytes(dbInfo.sizeBytes) : t("psqlVersion")}
              </div>
            </div>
          </div>

          {/* Roles */}
          <div className="px-1">
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <Users className="h-3 w-3 text-cream/45" />
              <span className="text-[10px] font-medium text-cream/45 uppercase tracking-[0.08em]">{t("rolesLabel")}</span>
            </div>
            <div className="space-y-0.5">
              {ROLE_META.map((role) => (
                <div
                  key={role.key}
                  className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-colors hover:bg-cream/[0.03]"
                >
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: role.color }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-cream/75">{t(role.labelKey)}</div>
                    <div className="text-[10px] text-cream/45">{t(role.descKey)}</div>
                  </div>
                  <code className="text-[10px] text-cream/60 font-mono truncate max-w-[120px]">
                    {dbInfo[role.key]}
                  </code>
                </div>
              ))}
            </div>
          </div>

          {/* Info banner */}
          <div className="flex items-start gap-2.5 px-2.5 py-2 rounded-lg bg-cream/[0.02] border border-cream/[0.04]">
            <Info className="h-3.5 w-3.5 text-cream/45 shrink-0 mt-0.5" />
            <p className="text-[10px] text-cream/45 leading-relaxed">
              {t("infoBanner")}
            </p>
          </div>

          {/* Delete */}
          {showDeleteConfirm ? (
            <div className="rounded-lg border border-terra/20 bg-terra/5 p-3 space-y-2.5">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-3.5 w-3.5 text-terra" />
                <span className="text-xs font-medium text-terra">{t("deleteConfirmTitle")}</span>
              </div>
              <p className="text-[10px] text-cream/60">
                {t.rich("deleteConfirmBody", {
                  database: dbInfo.database,
                  strong: (chunks) => <strong className="text-cream">{chunks}</strong>,
                })}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1 h-7 rounded-lg text-[11px] font-medium text-cream/75 bg-cream/[0.04] border border-cream/[0.08] hover:bg-cream/[0.06] transition-colors"
                >
                  {t("cancel")}
                </button>
                <button
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                  className="flex-1 h-7 rounded-lg text-[11px] font-medium text-cream bg-terra/80 hover:bg-terra disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5"
                >
                  {deleteMutation.isPending ? (
                    <Spinner size="xs" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                  {t("deleteForever")}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="w-full flex items-center justify-center gap-1.5 h-8 rounded-lg text-xs font-medium text-terra/70 hover:text-terra hover:bg-terra/5 border border-transparent hover:border-terra/10 transition-colors"
            >
              <Trash2 className="h-3 w-3" />
              {t("deleteDatabase")}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── No database — creation panel ──
  return (
    <div className="flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-sodium" />
          <span className="text-sm font-medium text-cream">{t("heading")}</span>
        </div>
      </div>

      {/* Empty state */}
      <form
        className="flex-1 flex flex-col items-center justify-center py-10 px-6"
        onSubmit={(e) => { e.preventDefault(); if (!provisionMutation.isPending) provisionMutation.mutate(); }}
      >
        <div className="w-12 h-12 rounded-xl bg-sodium/5 border border-sodium/10 flex items-center justify-center mb-4">
          <Database className="h-6 w-6 text-sodium/60" />
        </div>
        <p className="text-xs font-medium text-cream mb-1">{t("noDatabase")}</p>
        <p className="text-[10px] text-cream/45 text-center mb-5 max-w-[200px] leading-relaxed">
          {t.rich("noDatabaseHint", {
            code: (chunks) => <code className="text-sodium/80">{chunks}</code>,
          })}
        </p>

        <button
          type="submit"
          disabled={provisionMutation.isPending}
          className={cn(
            "flex items-center gap-2 h-9 px-5 rounded-lg text-xs font-medium transition-all",
            "bg-sodium/10 text-sodium border border-sodium/20",
            "hover:bg-sodium/15 hover:border-sodium/30",
            "disabled:opacity-50 disabled:cursor-not-allowed"
          )}
        >
          {provisionMutation.isPending ? (
            <>
              <Spinner size="xs" />
              {t("creating")}
            </>
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" />
              {t("addDatabase")}
            </>
          )}
        </button>

        <div className="flex items-start gap-2 mt-5 px-3 py-2 rounded-lg bg-cream/[0.02] border border-cream/[0.04] max-w-[260px]">
          <Zap className="h-3 w-3 text-cream/45 shrink-0 mt-0.5" />
          <p className="text-[10px] text-cream/45 leading-relaxed">
            {t("isolationHint")}
          </p>
        </div>

        {provisionMutation.error && (
          <div className="flex items-center gap-2 mt-3 px-3 py-2 rounded-lg bg-terra/5 border border-terra/15 max-w-[260px]">
            <AlertCircle className="h-3 w-3 text-terra shrink-0" />
            <span className="text-[10px] text-terra">
              {provisionMutation.error instanceof Error
                ? provisionMutation.error.message
                : t("createDefaultError")}
            </span>
          </div>
        )}
      </form>
    </div>
  );
}
