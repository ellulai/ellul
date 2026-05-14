// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import {
  Database,
  Plus,
  Trash2,
  Check,
  X,
  HardDrive,
  Pencil,
  ShieldCheck,
  AlertCircle,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { DbApi, DbEntry } from "./database-types";
import { formatBytes } from "./database-types";

interface DatabaseBrowserLiteProps {
  serverDomain: string;
  sandboxId: string;
  api: DbApi;
}

export function DatabaseBrowserLite({ serverDomain, sandboxId, api }: DatabaseBrowserLiteProps) {
  const t = useTranslations("console.database.lite");
  const queryClient = useQueryClient();
  const [renameLabel, setRenameLabel] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const { data: pgStatus, isLoading: isCheckingPg } = useQuery<{ available: boolean }>({
    queryKey: ["db-status", serverDomain], queryFn: () => api.checkStatus(), staleTime: 30_000, retry: 1,
  });

  const pgAvailable = pgStatus?.available ?? false;

  const { data: databases, isLoading: isLoadingDbs } = useQuery<DbEntry[]>({
    queryKey: ["db-list", serverDomain, sandboxId], queryFn: () => api.listDatabases(sandboxId), staleTime: 15_000, enabled: pgAvailable,
  });

  const dbList = databases ?? [];
  const hasDatabase = dbList.length > 0;
  const primaryDb = dbList[0] ?? null;

  const createMutation = useMutation({
    mutationFn: async () => {
      await api.createDb(sandboxId, "main");
      await api.assignDb(sandboxId, "main", "preview");
      await api.assignDb(sandboxId, "main", "deployed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["db-list", serverDomain, sandboxId] });
      toast.success(t("createSuccess"));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      for (const db of dbList) {
        await api.dropDb(sandboxId, db.label);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["db-list", serverDomain, sandboxId] });
      setDeleteConfirm(false);
      toast.success(t("deleteSuccess"));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isCheckingPg || isLoadingDbs) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex items-center gap-2.5 text-xs text-cream/60">
          <Spinner size="sm" />
          {t("loading")}
        </div>
      </div>
    );
  }

  if (!pgAvailable) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <div className="w-10 h-10 rounded-xl bg-cream/[0.03] border border-cream/[0.06] flex items-center justify-center mb-3">
          <Database className="h-5 w-5 text-cream/45" />
        </div>
        <p className="text-xs text-cream/60 text-center">{t("pgUnavailable")}</p>
        <p className="text-[10px] text-cream/45 mt-1 text-center">{t("pgUnavailableHint")}</p>
      </div>
    );
  }

  if (!hasDatabase) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <form
          className="flex flex-col items-center"
          onSubmit={(e) => { e.preventDefault(); if (!createMutation.isPending) createMutation.mutate(); }}
        >
          <div className="w-14 h-14 rounded-2xl bg-sodium/5 border border-sodium/10 flex items-center justify-center mb-5">
            <Database className="h-7 w-7 text-sodium/60" />
          </div>
          <h3 className="text-sm font-medium text-cream mb-1">{t("addDatabaseTitle")}</h3>
          <p className="text-xs text-cream/45 text-center max-w-[240px] mb-6 leading-relaxed">
            {t.rich("addDatabaseHint", {
              code: (chunks) => <code className="text-sodium/80">{chunks}</code>,
            })}
          </p>
          <button
            type="submit"
            disabled={createMutation.isPending}
            className={cn(
              "flex items-center gap-2 h-10 px-6 rounded-lg text-sm font-medium transition-all",
              "bg-sodium text-ink hover:bg-sodium",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {createMutation.isPending ? (
              <><Spinner size="sm" delay={300} /> {t("creating")}</>
            ) : (
              <><Plus className="h-4 w-4" /> {t("createDatabase")}</>
            )}
          </button>
          {createMutation.error && (
            <div className="flex items-center gap-2 mt-4 px-3 py-2 rounded-lg bg-terra/5 border border-terra/15">
              <AlertCircle className="h-3 w-3 text-terra shrink-0" />
              <span className="text-[10px] text-terra">{createMutation.error.message}</span>
            </div>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-sodium/10 border border-sodium/20 flex items-center justify-center">
              <HardDrive className="h-5 w-5 text-sodium" />
            </div>
            <div className="flex-1 min-w-0">
              {renameLabel !== null ? (
                <form
                  className="flex items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setRenameLabel(null);
                    toast.success(t("renameSuccess"));
                  }}
                >
                  <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} className="h-7 text-xs" autoFocus />
                  <button type="submit" className="text-sodium hover:text-sodium"><Check className="h-4 w-4" /></button>
                  <button type="button" onClick={() => setRenameLabel(null)} className="text-cream/45 hover:text-cream/75"><X className="h-4 w-4" /></button>
                </form>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-cream truncate">{primaryDb?.label || "main"}</span>
                  <button
                    type="button"
                    onClick={() => { setRenameLabel(primaryDb?.label || "main"); setRenameValue(primaryDb?.label || "main"); }}
                    className="text-cream/45 hover:text-cream/75 transition-colors"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </div>
              )}
              <div className="text-[10px] text-cream/45 mt-0.5">
                PostgreSQL {primaryDb?.sizeBytes !== undefined ? `· ${formatBytes(primaryDb.sizeBytes)}` : ""}
              </div>
            </div>
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-sodium/10 border border-sodium/20">
              <ShieldCheck className="h-3 w-3 text-sodium" />
              <span className="text-[10px] font-medium text-sodium">{t("active")}</span>
            </div>
          </div>

          <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-cream/[0.02] border border-cream/[0.04]">
            <Database className="h-3.5 w-3.5 text-cream/45 shrink-0 mt-0.5" />
            <p className="text-[10px] text-cream/45 leading-relaxed">
              {t("infoBanner")}
            </p>
          </div>
        </div>

        {deleteConfirm ? (
          <div className="rounded-xl border border-terra/20 bg-terra/5 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-terra" />
              <span className="text-xs font-medium text-terra">{t("deleteConfirmTitle")}</span>
            </div>
            <p className="text-[10px] text-cream/60">{t("deleteConfirmBody")}</p>
            <div className="flex items-center gap-2">
              <button onClick={() => setDeleteConfirm(false)} className="flex-1 h-8 rounded-lg text-xs font-medium text-cream/75 bg-cream/[0.04] border border-cream/[0.08] hover:bg-cream/[0.06] transition-colors">{t("cancel")}</button>
              <button onClick={() => deleteMutation.mutate()} disabled={deleteMutation.isPending} className="flex-1 h-8 rounded-lg text-xs font-medium text-cream bg-terra/80 hover:bg-terra disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5">
                {deleteMutation.isPending ? <Spinner size="xs" /> : <Trash2 className="h-3 w-3" />}
                {t("deleteForever")}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setDeleteConfirm(true)}
            className="w-full flex items-center justify-center gap-1.5 h-9 rounded-lg text-xs font-medium text-terra/70 hover:text-terra hover:bg-terra/5 border border-transparent hover:border-terra/10 transition-colors"
          >
            <Trash2 className="h-3 w-3" />
            {t("deleteDatabase")}
          </button>
        )}
      </div>
    </div>
  );
}
